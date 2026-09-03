import { describe, expect, test } from "bun:test"
import { planJump } from "../src/core/actions.js"
import { resultCandidates } from "../src/core/cropplan.js"
import { foldJournal, type JournalEntry } from "../src/core/journal.js"
import { buildTreeView, type Row } from "../src/core/tree.js"
import { assistant, buildFixture, buildOffPathFixture, copyPrefix, EARLY, LATE, OPEN, SQUASHED, TRUNK, user } from "./fixtures/tree.js"

const shape = (rows: Row[]) =>
  rows.map((r) => (r.kind === "branch" ? `${r.gutter}${r.name}` : r.kind === "separator" ? "┈" : r.kind === "turn" ? `T${r.turn}` : `${r.gutter}${r.glyph}`))

/** the rows that own a message — branch headers and separators do not */
const owned = (r: Row): r is Extract<Row, { kind: "turn" | "step" }> => r.kind === "turn" || r.kind === "step"
const isSeparator = (r: Row): r is Extract<Row, { kind: "separator" }> => r.kind === "separator"

describe("buildTreeView from the trunk", () => {
  const f = buildFixture()
  const view = buildTreeView({ state: f.state, transcripts: f.transcripts, currentSessionID: TRUNK, expanded: new Set(), filter: "default" })

  test("row order matches the §7.2 mockup: T1 steps, T2 steps, branch rows, T3", () => {
    expect(shape(view.rows)).toEqual(["T1", "⚙", "○", "T2", "○", "├⎇try-redis", "╰⎇fix-flaky-test", "T3", "○"])
  })
  test("branch rows carry status, model, turn and token counts of their own tail only", () => {
    const branches = view.rows.filter((r) => r.kind === "branch")
    expect(branches.map((b) => b.kind === "branch" && [b.status, b.turns, b.model])).toEqual([["squashed", 1, undefined], ["open", 2, "mock/mock-b"]])
    const open = branches[1]!
    expect(open.kind === "branch" && open.tokens).toBeGreaterThan(5000)
  })
  test("step rows: tool step has duration, warn flag for ≥10k, ids include owning session", () => {
    const tool = view.rows.find((r) => r.kind === "step" && r.glyph === "⚙")!
    expect(tool.kind === "step" && tool.durationMs).toBe(21)
    expect(tool.kind === "step" && tool.sessionID).toBe(TRUNK)
    expect(tool.id.startsWith(`${TRUNK}:a1:`)).toBe(true)
    expect(tool.kind === "step" && tool.warn).toBe(false)
  })
  test("a fat tool result is estimated, never a share of the assistant's tokens.output", () => {
    const trunk = f.transcripts[TRUNK]!
    const fat = assistant("a9", { text: "read it", tool: { name: "bash", input: { command: "cat big.log" }, output: "z".repeat(80_000) }, input: 4000, output: 60 })
    const transcripts = { ...f.transcripts, [TRUNK]: { ...trunk, messages: [...trunk.messages, user("m9", "read the log"), fat] } }
    const rows = buildTreeView({ state: f.state, transcripts, currentSessionID: TRUNK, expanded: new Set(), filter: "default" }).rows.filter((r) => r.kind === "step" && r.messageID === "a9")
    const tool = rows.find((r) => r.kind === "step" && r.glyph === "⚙")!
    expect(tool.kind === "step" && [tool.tokens, tool.estimated, tool.warn]).toEqual([20_000, true, true])
    // the model's own output still splits across the text/reasoning parts it generated
    const text = rows.find((r) => r.kind === "step" && r.glyph === "○")!
    expect(text.kind === "step" && [text.tokens, text.estimated]).toEqual([60, false])
  })
  test("current row is the last row of the current session; totalTokens counts the last turn's own output", () => {
    expect(view.currentRowId).toBe(view.rows.at(-1)!.id)
    expect(view.totalTokens).toBe(3010) // a3's tokens.input + its own tokens.output
    expect(view.totalEstimated).toBe(false) // the provider counted every token in it
  })
  test("the total is only flagged ~ once a chars/4 guess is really part of it", () => {
    const trunk = f.transcripts[TRUNK]!
    const pending = { ...f.transcripts, [TRUNK]: { ...trunk, messages: [...trunk.messages, user("m4", "and now?")] } }
    const v = buildTreeView({ state: f.state, transcripts: pending, currentSessionID: TRUNK, expanded: new Set(), filter: "default" })
    expect(v.totalEstimated).toBe(true)
    expect(v.totalTokens).toBeGreaterThan(3010)
  })
  test("isTip marks the last user turn of the session", () => {
    const turns = view.rows.filter((r) => r.kind === "turn")
    expect(turns.map((t) => t.kind === "turn" && t.isTip)).toEqual([false, false, true])
  })
})

describe("buildTreeView expanded + from a branch", () => {
  const f = buildFixture()
  test("expanding the open branch inserts its post-anchor rows indented with │", () => {
    const view = buildTreeView({ state: f.state, transcripts: f.transcripts, currentSessionID: TRUNK, expanded: new Set([OPEN]), filter: "default" })
    expect(shape(view.rows)).toEqual(["T1", "⚙", "○", "T2", "○", "├⎇try-redis", "╰⎇fix-flaky-test", "T3", "│ ⚙", "│ ○", "T4", "│ ○", "T3", "○"])
    const nested = view.rows.filter((r) => r.depth === 1)
    expect(nested.every((r) => owned(r) && r.sessionID === OPEN)).toBe(true)
    // the branch's own rows use the branch's message IDs, not the copied prefix
    expect(nested.find((r) => r.kind === "turn")!.messageID).toBe("om1")
  })
  test("viewing from a branch draws the whole tree: trunk, your branch open, its sibling folded", () => {
    const view = buildTreeView({ state: f.state, transcripts: f.transcripts, currentSessionID: OPEN, expanded: new Set(), filter: "default" })
    // the branch you are on is open (on the current path), its rows nested; the trunk keeps
    // going after the fork (m3/a3) and is drawn inline, and try-redis stays folded at the anchor
    expect(shape(view.rows)).toEqual(["T1", "⚙", "○", "T2", "○", "├⎇try-redis", "╰⎇fix-flaky-test", "T3", "│ ⚙", "│ ○", "T4", "│ ○", "┈", "T3", "○"])
    const marker = view.rows.find((r) => r.kind === "branch" && r.isCurrent)!
    expect(marker.kind === "branch" && [marker.name, marker.turns, marker.expanded]).toEqual(["fix-flaky-test", 2, true])
    expect(view.rows.filter((r) => r.kind === "branch" && r.sessionID === OPEN).length).toBe(1)
    const t1 = view.rows[0]!
    expect(owned(t1) && t1.sessionID).toBe(TRUNK)
    expect(t1.kind === "turn" && t1.messageID).toBe("m1")
    const t3 = view.rows.find((r) => r.kind === "turn" && r.turn === 3)!
    expect(owned(t3) && t3.sessionID).toBe(OPEN)
    expect(t3.kind === "turn" && t3.messageID).toBe("om1")
    expect(view.totalTokens).toBe(6012) // oa2's tokens.input + its own tokens.output
    // currentRowId is the current session's tip — the last OPEN row, not the trunk's tail
    const openTip = view.rows.filter((r) => owned(r) && r.sessionID === OPEN).at(-1)!
    expect(view.currentRowId).toBe(openTip.id)
  })
  test("a fork with no messages of its own is still visible, and is where the cursor lands", () => {
    const prefixOnly = { ...f.transcripts[OPEN]!, messages: f.transcripts[OPEN]!.messages.slice(0, 4) }
    const view = buildTreeView({ state: f.state, transcripts: { ...f.transcripts, [OPEN]: prefixOnly }, currentSessionID: OPEN, expanded: new Set(), filter: "default" })
    expect(shape(view.rows)).toEqual(["T1", "⚙", "○", "T2", "○", "├⎇try-redis", "╰⎇fix-flaky-test", "┈", "T3", "○"])
    const marker = view.rows.find((r) => r.kind === "branch" && r.isCurrent)!
    expect(marker.kind === "branch" && [marker.turns, marker.tokens]).toEqual([0, 0])
    expect(view.currentRowId).toBe(marker.id)
  })
  test("a filter that hides branches keeps only the current path, flat and un-indented", () => {
    const view = buildTreeView({ state: f.state, transcripts: f.transcripts, currentSessionID: OPEN, expanded: new Set(), filter: "user-only" })
    // trunk turns T1/T2, the current branch's own turns T3/T4, and the trunk's own last turn
    expect(shape(view.rows)).toEqual(["T1", "T2", "T3", "T4", "┈", "T3"])
    expect(view.rows.every((r) => r.gutter === "")).toBe(true)
  })
})

/** The transcript the TUI crop e2e produces, where `g` then `j` must land on the tool
 *  result: user → assistant(step-start, tool, text, step-finish) → user → assistant. */
describe("the crop e2e's row/candidate alignment", () => {
  const messages = [
    user("t1u", "run the tool"),
    assistant("t1a", { tool: { name: "bash", input: { command: "echo mock-tool-output" }, output: "mock-tool-output\n" }, text: "mock reply", input: 100, output: 5 }),
    user("t2u", "second"),
    assistant("t2a", { text: "mock reply", input: 100, output: 5 }),
  ]
  const transcripts = { [TRUNK]: { sessionID: TRUNK, title: "mock reply", status: "available" as const, messages } }
  const base = { state: foldJournal([], "t_e2e"), transcripts, currentSessionID: TRUNK, expanded: new Set<string>() }

  test("the row below T1 is the tool result and is the one crop candidate", () => {
    const rows = buildTreeView({ ...base, filter: "default" }).rows
    expect(shape(rows)).toEqual(["T1", "⚙", "○", "T2", "○"])
    const cands = resultCandidates(transcripts[TRUNK])
    expect(cands.map((c) => [c.partID, c.turn, c.protections])).toEqual([[(rows[1] as Row & { kind: "step" }).partID, 1, ["latest-per-tool"]]])
  })
  test("only `all` shows step-start/finish, which is what moves that row out from under the cursor", () => {
    expect(shape(buildTreeView({ ...base, filter: "all" }).rows).slice(0, 3)).toEqual(["T1", "○", "⚙"])
  })
})

describe("branches off the rendered path", () => {
  const f = buildOffPathFixture()
  const view = buildTreeView({ state: f.state, transcripts: f.transcripts, currentSessionID: EARLY, expanded: new Set(), filter: "default" })

  test("the whole tree is drawn from the root: your branch open, siblings folded at their own anchors", () => {
    // `early` forked at a2 (open, on the path); the trunk keeps going to T3/a3; `late` forked
    // at a3 so it now hangs off the trunk's own T3, folded — no separate 'elsewhere' group
    expect(shape(view.rows)).toEqual(["T1", "⚙", "○", "T2", "○", "╰⎇early", "T3", "│ ○", "┈", "T3", "○", "╰⎇late"])
    const branches = view.rows.filter((r) => r.kind === "branch")
    expect(branches.map((r) => r.kind === "branch" && [r.name, r.status, r.turns, r.isCurrent])).toEqual([
      ["early", "open", 1, true],
      ["late", "open", 1, false],
    ])
    const late = branches.find((r) => r.kind === "branch" && r.name === "late")!
    expect(late.kind === "branch" && [late.gutter, late.expanded, late.last]).toEqual(["╰⎇", false, true])
    expect(late.kind === "branch" && late.tokens).toBeGreaterThan(0)
  })
  test("⏎ on a branch header switches to that session, and is a noop on your own", () => {
    for (const row of view.rows.filter((r) => r.kind === "branch")) {
      expect(planJump(row, { transcripts: f.transcripts, currentSessionID: EARLY })).toEqual(
        row.sessionID === EARLY ? { kind: "noop", reason: "you are here" } : { kind: "switch", sessionID: row.sessionID },
      )
    }
  })
  test("expanding a folded sibling shows its post-fork turns inline under its own anchor", () => {
    const expanded = buildTreeView({ state: f.state, transcripts: f.transcripts, currentSessionID: EARLY, expanded: new Set([LATE]), filter: "default" })
    expect(shape(expanded.rows).slice(-3)).toEqual(["╰⎇late", "T4", "│ ○"])
    expect(expanded.rows.filter(owned).at(-1)!.sessionID).toBe(LATE)
  })
  test("nothing is duplicated when every branch is already on the path", () => {
    const g = buildFixture()
    const trunkView = buildTreeView({ state: g.state, transcripts: g.transcripts, currentSessionID: TRUNK, expanded: new Set(), filter: "default" })
    expect(trunkView.rows.filter((r) => r.kind === "branch").map((r) => r.gutter)).toEqual(["├⎇", "╰⎇"])
  })
})

describe("a fork of a fork", () => {
  const f = buildFixture()
  const DEEP = "ses_deep"
  const state = foldJournal(
    [
      { v: 1, id: "e1", ts: 1, type: "tree.created", actor: "tui", data: { rootSessionID: TRUNK } },
      { v: 1, id: "e2", ts: 2, type: "branch.opened", actor: "tui", data: { sessionID: OPEN, parentSessionID: TRUNK, anchorMessageID: "a2", name: "fix-flaky-test", kind: "explicit" } },
      { v: 1, id: "e3", ts: 3, type: "branch.opened", actor: "tui", data: { sessionID: DEEP, parentSessionID: OPEN, anchorMessageID: "oa1", name: "deeper", kind: "explicit" } },
    ] satisfies JournalEntry[],
    "t_deep",
  )
  const deep = [...copyPrefix(f.transcripts[OPEN]!.messages.slice(0, 6), "d"), user("dm1", "deeper idea"), assistant("da1", { text: "Deep done.", input: 7000, output: 15 })]
  const transcripts = { ...f.transcripts, [DEEP]: { sessionID: DEEP, title: "⎇ deeper", status: "available" as const, messages: deep } }
  const view = buildTreeView({ state, transcripts, currentSessionID: DEEP, expanded: new Set(), filter: "default" })

  test("the fork-of-fork nests: fix-flaky-test one level in, deeper two, gutters and ids consistent", () => {
    expect(shape(view.rows)).toEqual(["T1", "⚙", "○", "T2", "○", "╰⎇fix-flaky-test", "T3", "│ ⚙", "│ ○", "│ ╰⎇deeper", "T4", "│ │ ○", "┈", "T4", "│ ○", "┈", "T3", "○"])
    expect(view.rows.filter((r) => r.kind === "branch" && r.isCurrent).map((r) => (r.kind === "branch" ? r.sessionID : ""))).toEqual([DEEP])
    expect(new Set(view.rows.map((r) => r.id)).size).toBe(view.rows.length)
    // gutter connectors carry the topology: deeper's header rides the open fix-flaky-test spine
    // (one │), and its own rows carry two │ levels
    const deeper = view.rows.find((r) => r.kind === "branch" && r.sessionID === DEEP)!
    expect(deeper.gutter).toBe("│ ╰⎇")
    expect(view.rows.filter((r) => r.kind === "step" && r.sessionID === DEEP).every((r) => r.gutter === "│ │ ")).toBe(true)
    // currentRowId is DEEP's tip (its last own row) — the route marks it `← here`
    const deepTip = view.rows.filter((r) => owned(r) && r.sessionID === DEEP).at(-1)!
    expect(view.currentRowId).toBe(deepTip.id)
  })
})

describe("the current session survives an unloaded on-path ancestor (P0)", () => {
  const f = buildFixture()
  const DEEP = "ses_deep"
  const state = foldJournal(
    [
      { v: 1, id: "e1", ts: 1, type: "tree.created", actor: "tui", data: { rootSessionID: TRUNK } },
      { v: 1, id: "e2", ts: 2, type: "branch.opened", actor: "tui", data: { sessionID: OPEN, parentSessionID: TRUNK, anchorMessageID: "a2", name: "fix-flaky-test", kind: "explicit" } },
      { v: 1, id: "e3", ts: 3, type: "branch.opened", actor: "tui", data: { sessionID: DEEP, parentSessionID: OPEN, anchorMessageID: "oa1", name: "deeper", kind: "explicit" } },
    ] satisfies JournalEntry[],
    "t_deep_p0",
  )
  const deep = [...copyPrefix(f.transcripts[OPEN]!.messages.slice(0, 6), "d"), user("dm1", "deeper idea"), assistant("da1", { text: "Deep done.", input: 7000, output: 15 })]
  const withDeep = { sessionID: DEEP, title: "⎇ deeper", status: "available" as const, messages: deep }
  const base = { state, currentSessionID: DEEP, expanded: new Set<string>(), filter: "default" as const }
  // fetchTranscript hands back this shape when a closed ancestor's one fetch failed (transcripts.ts)
  const openDeleted = { sessionID: OPEN, title: "⎇ fix-flaky-test", status: "deleted" as const, messages: [] }

  for (const [label, openTr] of [["absent", undefined], ["deleted/empty", openDeleted]] as const) {
    test(`OPEN ${label}: DEEP's own rows and cursor still render, without replaying the prefix`, () => {
      const transcripts = { [TRUNK]: f.transcripts[TRUNK]!, [DEEP]: withDeep, ...(openTr ? { [OPEN]: openTr } : {}) }
      const view = buildTreeView({ ...base, transcripts })
      const deepRows = view.rows.filter((r) => owned(r) && r.sessionID === DEEP)
      expect(deepRows.length).toBeGreaterThan(0)
      expect(view.currentRowId).toBe(deepRows.at(-1)!.id)
      // DEEP fills the gap the unloaded OPEN left with its own copies (T3/T4), never the trunk's T1/T2
      expect(deepRows.filter((r) => r.kind === "turn").map((r) => (r.kind === "turn" ? r.turn : 0))).toEqual([3, 4])
      // its rows still nest under the headers-only OPEN spine (two gutter levels)
      expect(deepRows.every((r) => r.gutter.startsWith("│ │ "))).toBe(true)
      // OPEN itself contributes only a placeholder header, no rows of its own
      expect(view.rows.some((r) => owned(r) && r.sessionID === OPEN)).toBe(false)
    })
  }

  test("every transcript present is the control: same current tip", () => {
    const view = buildTreeView({ ...base, transcripts: { ...f.transcripts, [DEEP]: withDeep } })
    const deepTip = view.rows.filter((r) => owned(r) && r.sessionID === DEEP).at(-1)!
    expect(view.currentRowId).toBe(deepTip.id)
  })
})

describe("an unresolvable anchor never replays the copied prefix (P2)", () => {
  test("a branch whose anchor is absent from its loaded parent contributes an empty tail", () => {
    const f = buildFixture()
    const MID = "ses_mid"
    const CUR = "ses_cur"
    const state = foldJournal(
      [
        { v: 1, id: "e1", ts: 1, type: "tree.created", actor: "tui", data: { rootSessionID: TRUNK } },
        // "ghost" is not a message in the trunk transcript, so MID's own tail cannot be located
        { v: 1, id: "e2", ts: 2, type: "branch.opened", actor: "tui", data: { sessionID: MID, parentSessionID: TRUNK, anchorMessageID: "ghost", name: "mid", kind: "explicit" } },
        { v: 1, id: "e3", ts: 3, type: "branch.opened", actor: "tui", data: { sessionID: CUR, parentSessionID: MID, anchorMessageID: "mm1", name: "cur", kind: "explicit" } },
      ] satisfies JournalEntry[],
      "t_p2",
    )
    const midMsgs = [...copyPrefix(f.transcripts[TRUNK]!.messages, "mid"), user("mm1", "mid idea"), assistant("ma1", { text: "mid done", input: 900, output: 9 })]
    const curMsgs = [...copyPrefix(midMsgs.slice(0, 7), "c"), user("cm1", "cur idea"), assistant("ca1", { text: "cur done", input: 950, output: 9 })]
    const transcripts = {
      [TRUNK]: f.transcripts[TRUNK]!,
      [MID]: { sessionID: MID, title: "mid", status: "available" as const, messages: midMsgs },
      [CUR]: { sessionID: CUR, title: "cur", status: "available" as const, messages: curMsgs },
    }
    const view = buildTreeView({ state, transcripts, currentSessionID: CUR, expanded: new Set(), filter: "default" })
    const mid = view.rows.find((r) => r.kind === "branch" && r.sessionID === MID)!
    expect(mid.kind === "branch" && mid.turns).toBe(0)
    // the bug sliced from 0, replaying MID's whole copied prefix as its own turns — it must not
    expect(view.rows.some((r) => owned(r) && r.sessionID === MID)).toBe(false)
    // the current session hanging off it is still reached
    expect(view.currentRowId).toBeDefined()
    expect(view.rows.some((r) => owned(r) && r.sessionID === CUR)).toBe(true)
  })

  test('a branch forked before the parent\'s first message (anchor "") still shows its whole tail', () => {
    const TR = "ses_tr"
    const B = "ses_pre"
    const state = foldJournal(
      [
        { v: 1, id: "e1", ts: 1, type: "tree.created", actor: "tui", data: { rootSessionID: TR } },
        { v: 1, id: "e2", ts: 2, type: "branch.opened", actor: "tui", data: { sessionID: B, parentSessionID: TR, anchorMessageID: "", name: "pre", kind: "explicit" } },
      ] satisfies JournalEntry[],
      "t_pre",
    )
    const transcripts = {
      [TR]: { sessionID: TR, title: "tr", status: "available" as const, messages: [user("u1", "hi"), assistant("a1", { text: "yo", input: 10, output: 2 })] },
      [B]: { sessionID: B, title: "pre", status: "available" as const, messages: [user("bu1", "branch q"), assistant("ba1", { text: "branch a", input: 10, output: 2 })] },
    }
    const view = buildTreeView({ state, transcripts, currentSessionID: TR, expanded: new Set([B]), filter: "default" })
    const b = view.rows.find((r) => r.kind === "branch" && r.sessionID === B)!
    // no shared prefix, so its whole transcript is legitimately its own tail (slice from 0 is right here)
    expect(b.kind === "branch" && b.turns).toBe(1)
    expect(view.rows.filter((r) => owned(r) && r.sessionID === B).length).toBe(2)
  })
})

describe("headless /ctree command turns", () => {
  const f = buildFixture()
  const trunk = f.transcripts[TRUNK]!
  const command = () => [
    user("cm", "[context tree]\ntree t_fixture\nthis session is the trunk\n\n(Acknowledge in one short line; do not act on this.)"),
    assistant("ca", { text: "Acknowledged.", input: 3100, output: 4 }),
  ]
  const withMessages = (messages: typeof trunk.messages) => ({
    state: f.state,
    transcripts: { ...f.transcripts, [TRUNK]: { ...trunk, messages } },
    currentSessionID: TRUNK,
    expanded: new Set<string>(),
  })
  const midway = withMessages([...trunk.messages, ...command(), user("m4", "keep going"), assistant("a4", { text: "Sure.", input: 3400, output: 6 })])

  test("default hides the command turn and its acknowledgement, and T<n> does not skip", () => {
    const view = buildTreeView({ ...midway, filter: "default" })
    expect(shape(view.rows)).toEqual(["T1", "⚙", "○", "T2", "○", "├⎇try-redis", "╰⎇fix-flaky-test", "T3", "○", "T4", "○"])
    const t4 = view.rows.find((r) => r.kind === "turn" && r.turn === 4)!
    expect(t4.kind === "turn" && t4.messageID).toBe("m4")
    expect(view.rows.some((r) => owned(r) && (r.messageID === "cm" || r.messageID === "ca"))).toBe(false)
  })
  test("`all` keeps it, so the plumbing stays inspectable", () => {
    const rows = buildTreeView({ ...midway, filter: "all" }).rows
    expect(rows.some((r) => r.kind === "turn" && r.messageID === "cm")).toBe(true)
    expect(rows.some((r) => r.kind === "step" && r.messageID === "ca")).toBe(true)
  })
  test("a trailing command turn does not steal isTip from the last real turn", () => {
    const view = buildTreeView({ ...withMessages([...trunk.messages, ...command()]), filter: "default" })
    const tips = view.rows.filter((r) => r.kind === "turn" && r.isTip)
    expect(tips.map((r) => (r.kind === "turn" ? r.messageID : ""))).toEqual(["m3"])
  })
})

describe("filters, search, labels, crops", () => {
  const f = buildFixture()
  const base = { state: f.state, transcripts: f.transcripts, currentSessionID: TRUNK, expanded: new Set<string>() }
  test("no-tools hides ⚙ rows; user-only keeps only turns; all includes step-start/finish", () => {
    expect(shape(buildTreeView({ ...base, filter: "no-tools" }).rows)).toEqual(["T1", "○", "T2", "○", "├⎇try-redis", "╰⎇fix-flaky-test", "T3", "○"])
    expect(shape(buildTreeView({ ...base, filter: "user-only" }).rows)).toEqual(["T1", "T2", "T3"])
    expect(buildTreeView({ ...base, filter: "all" }).rows.filter((r) => r.kind === "step").length).toBeGreaterThan(4)
  })
  test("labeled shows only labelled turns", () => {
    const view = buildTreeView({ ...base, filter: "labeled", labels: { m2: "⎇ checkpoint" } })
    expect(shape(view.rows)).toEqual(["T2"])
    expect(view.rows[0]!.kind === "turn" && view.rows[0]!.label).toBe("⎇ checkpoint")
  })
  test("search keeps matching rows plus their owning turn / branch", () => {
    const view = buildTreeView({ ...base, filter: "default", search: "ls -la" })
    expect(shape(view.rows)).toEqual(["T1", "⚙"])
    const byName = buildTreeView({ ...base, filter: "default", search: "redis" })
    expect(shape(byName.rows)).toEqual(["├⎇try-redis"])
  })
  test("crops mark step rows", () => {
    const view = buildTreeView({ ...base, filter: "default", crops: [{ messageID: "a1", partID: "a1-tool" }] })
    const tool = view.rows.find((r) => r.kind === "step" && r.glyph === "⚙")!
    expect(tool.kind === "step" && tool.isCropped).toBe(true)
  })
})

describe("thinking parts collapse into the step they belong to", () => {
  const messages = [
    user("k1u", "why does it flake?"),
    assistant("k1a", { think: { ms: 9800 }, tool: { name: "bash", input: { command: "bun test" }, output: "3 failed" }, text: "a timing assumption", input: 100, output: 40 }),
    user("k2u", "and now?"),
    assistant("k2a", { think: { ms: 1200 }, input: 200, output: 10 }),
  ]
  const transcripts = { [TRUNK]: { sessionID: TRUNK, title: "flake", status: "available" as const, messages } }
  const base = { state: foldJournal([], "t_think"), transcripts, currentSessionID: TRUNK, expanded: new Set<string>() }
  const stepTokens = (rows: Row[], partID: string) => rows.filter(owned).find((r) => r.kind === "step" && r.partID === partID)?.tokens

  test("no reasoning row outside `all`: the duration rides the message's first real step", () => {
    const rows = buildTreeView({ ...base, filter: "default" }).rows
    expect(shape(rows)).toEqual(["T1", "⚙", "○", "T2", "○"])
    expect(rows.some((r) => r.kind === "step" && r.partID === "k1a-think")).toBe(false)
    const first = rows.find((r) => r.kind === "step" && r.messageID === "k1a")!
    expect(first.kind === "step" && [first.partID, first.thinkingMs]).toEqual(["k1a-tool", 9800])
    // exactly one row carries it, so the route appends `· 9.8s thought` once per message
    expect(rows.filter((r) => r.kind === "step" && r.thinkingMs !== undefined).length).toBe(1)
  })
  test("a message that is nothing but thinking keeps one row, timed for the whole message", () => {
    const only = buildTreeView({ ...base, filter: "default" }).rows.filter((r) => r.kind === "step" && r.messageID === "k2a")
    expect(only.length).toBe(1)
    expect(only[0]!.kind === "step" && [only[0]!.preview, only[0]!.durationMs]).toEqual(["(thinking)", 1200])
  })
  test("`all` keeps the separate reasoning rows, unfolded", () => {
    const rows = buildTreeView({ ...base, filter: "all" }).rows
    expect(rows.some((r) => r.kind === "step" && r.partID === "k1a-think")).toBe(true)
    expect(rows.every((r) => r.kind !== "step" || r.thinkingMs === undefined)).toBe(true)
  })
  test("token math is untouched: only the rows changed", () => {
    const collapsed = buildTreeView({ ...base, filter: "default" })
    const all = buildTreeView({ ...base, filter: "all" })
    expect(stepTokens(collapsed.rows, "k1a-text")).toBe(stepTokens(all.rows, "k1a-text"))
    expect(stepTokens(collapsed.rows, "k1a-tool")).toBe(stepTokens(all.rows, "k1a-tool"))
    expect(collapsed.totalTokens).toBe(all.totalTokens)
  })
})

describe("rows the current session does not send are marked and divided", () => {
  const f = buildFixture()
  const base = { state: f.state, transcripts: f.transcripts, expanded: new Set<string>(), filter: "default" as const }
  const fromBranch = buildTreeView({ ...base, currentSessionID: OPEN })

  test("from a branch: one separator, and the trunk's rows past the fork are out of context", () => {
    const seps = fromBranch.rows.filter(isSeparator)
    expect(seps.length).toBe(1)
    expect(seps[0]!.text).toBe("── not in this branch's context ──")
    // drawn in the ancestor it leaves, so it sits at the ancestor's depth
    expect([seps[0]!.depth, seps[0]!.gutter]).toEqual([0, ""])
    const at = fromBranch.rows.indexOf(seps[0]!)
    expect(fromBranch.rows.slice(0, at).filter(owned).every((r) => r.inContext)).toBe(true)
    expect(fromBranch.rows.slice(at + 1).filter(owned).map((r) => [r.sessionID, r.inContext])).toEqual([
      [TRUNK, false],
      [TRUNK, false],
    ])
  })
  test("from the trunk: everything on screen is in context, and nothing is divided", () => {
    const view = buildTreeView({ ...base, currentSessionID: TRUNK })
    expect(view.rows.some(isSeparator)).toBe(false)
    expect(view.rows.filter(owned).every((r) => r.inContext)).toBe(true)
  })
  test("another branch's rows are never in context, expanded or not", () => {
    const view = buildTreeView({ ...base, currentSessionID: TRUNK, expanded: new Set([OPEN]) })
    const other = view.rows.filter(owned).filter((r) => r.sessionID === OPEN)
    expect(other.length).toBeGreaterThan(0)
    expect(other.some((r) => r.inContext)).toBe(false)
    expect(view.rows.some(isSeparator)).toBe(false)
  })
})
