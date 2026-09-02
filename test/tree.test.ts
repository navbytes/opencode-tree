import { describe, expect, test } from "bun:test"
import { planJump } from "../src/core/actions.js"
import { resultCandidates } from "../src/core/cropplan.js"
import { foldJournal, type JournalEntry } from "../src/core/journal.js"
import { buildTreeView, type Row } from "../src/core/tree.js"
import { assistant, buildFixture, buildOffPathFixture, copyPrefix, EARLY, LATE, OPEN, SQUASHED, TRUNK, user } from "./fixtures/tree.js"

const shape = (rows: Row[]) => rows.map((r) => (r.kind === "branch" ? `${r.gutter}${r.name}` : r.kind === "turn" ? `T${r.turn}` : `${r.gutter}${r.glyph}`))

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
    expect(tool.sessionID).toBe(TRUNK)
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
    expect(nested.every((r) => r.sessionID === OPEN)).toBe(true)
    // the branch's own rows use the branch's message IDs, not the copied prefix
    expect(nested.find((r) => r.kind === "turn")!.messageID).toBe("om1")
  })
  test("viewing from the open branch: spine = trunk segment (trunk IDs) + own tail, sibling branch still shown", () => {
    const view = buildTreeView({ state: f.state, transcripts: f.transcripts, currentSessionID: OPEN, expanded: new Set(), filter: "default" })
    // the branch you are on is marked at its anchor, its own rows nested under it; the trunk
    // kept going after the fork (m3/a3), so it is offered as an "elsewhere" row
    expect(shape(view.rows)).toEqual(["T1", "⚙", "○", "T2", "○", "├⎇try-redis", "╰⎇fix-flaky-test", "T3", "│ ⚙", "│ ○", "T4", "│ ○", "┆⎇Fix flaky test"])
    const marker = view.rows.find((r) => r.kind === "branch" && r.isCurrent)!
    expect(marker.kind === "branch" && [marker.name, marker.turns, marker.expanded]).toEqual(["fix-flaky-test", 2, true])
    expect(view.rows.filter((r) => r.kind === "branch" && r.sessionID === OPEN).length).toBe(1)
    const t1 = view.rows[0]!
    expect(t1.sessionID).toBe(TRUNK)
    expect(t1.kind === "turn" && t1.messageID).toBe("m1")
    const t3 = view.rows.find((r) => r.kind === "turn" && r.turn === 3)!
    expect(t3.sessionID).toBe(OPEN)
    expect(t3.kind === "turn" && t3.messageID).toBe("om1")
    expect(view.totalTokens).toBe(6012) // oa2's tokens.input + its own tokens.output
    expect(view.currentRowId).toBe(view.rows.at(-2)!.id)
  })
  test("a fork with no messages of its own is still visible, and is where the cursor lands", () => {
    const prefixOnly = { ...f.transcripts[OPEN]!, messages: f.transcripts[OPEN]!.messages.slice(0, 4) }
    const view = buildTreeView({ state: f.state, transcripts: { ...f.transcripts, [OPEN]: prefixOnly }, currentSessionID: OPEN, expanded: new Set(), filter: "default" })
    expect(shape(view.rows)).toEqual(["T1", "⚙", "○", "T2", "○", "├⎇try-redis", "╰⎇fix-flaky-test", "┆⎇Fix flaky test"])
    const marker = view.rows.find((r) => r.kind === "branch" && r.isCurrent)!
    expect(marker.kind === "branch" && [marker.turns, marker.tokens]).toEqual([0, 0])
    expect(view.currentRowId).toBe(marker.id)
  })
  test("a filter that hides branches hides the marker row and its indentation too", () => {
    const view = buildTreeView({ state: f.state, transcripts: f.transcripts, currentSessionID: OPEN, expanded: new Set(), filter: "user-only" })
    expect(shape(view.rows)).toEqual(["T1", "T2", "T3", "T4"])
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

  test("the trunk tail and the branch anchored past the fork point are offered below the path", () => {
    expect(shape(view.rows)).toEqual(["T1", "⚙", "○", "T2", "○", "╰⎇early", "T3", "│ ○", "┆⎇Fix flaky test", "┆⎇late"])
    const elsewhere = view.rows.filter((r) => r.kind === "branch" && !r.isCurrent)
    expect(elsewhere.map((r) => r.kind === "branch" && [r.sessionID, r.status, r.turns, r.last])).toEqual([
      [TRUNK, "open", 1, false],
      [LATE, "open", 1, true],
    ])
    expect(elsewhere[0]!.kind === "branch" && elsewhere[0]!.tokens).toBeGreaterThan(0)
    // the trunk's own continuation is not a branch of itself: the route labels it differently
    expect(elsewhere.map((r) => r.kind === "branch" && r.ancestor)).toEqual([true, undefined])
  })
  test("⏎ on one of them switches to that session, and is a noop on your own marker row", () => {
    for (const row of view.rows.filter((r) => r.kind === "branch")) {
      expect(planJump(row, { transcripts: f.transcripts, currentSessionID: EARLY })).toEqual(
        row.sessionID === EARLY ? { kind: "noop", reason: "you are here" } : { kind: "switch", sessionID: row.sessionID },
      )
    }
  })
  test("expanding the trunk row shows its post-fork turns inline, with `late` back at its anchor", () => {
    const expanded = buildTreeView({ state: f.state, transcripts: f.transcripts, currentSessionID: EARLY, expanded: new Set([TRUNK]), filter: "default" })
    expect(shape(expanded.rows).slice(-4)).toEqual(["┆⎇Fix flaky test", "T3", "│ ○", "╰⎇late"])
    expect(expanded.rows.at(-2)!.sessionID).toBe(TRUNK)
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

  test("every fork point on the path is marked, once, and row ids stay unique", () => {
    expect(shape(view.rows)).toEqual(["T1", "⚙", "○", "T2", "○", "╰⎇fix-flaky-test", "T3", "│ ⚙", "│ ○", "╰⎇deeper", "T4", "│ ○", "┆⎇Fix flaky test", "┆⎇⎇ fix-flaky-test"])
    expect(view.rows.filter((r) => r.kind === "branch" && r.isCurrent).map((r) => r.sessionID)).toEqual([DEEP])
    // the middle branch is both a fork point on the path and a session that kept going
    expect(new Set(view.rows.map((r) => r.id)).size).toBe(view.rows.length)
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
