import { describe, expect, test } from "bun:test"
import { buildTreeView, type Row } from "../src/core/tree.js"
import { buildFixture, OPEN, SQUASHED, TRUNK } from "./fixtures/tree.js"

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
  test("current row is the last row of the current session; totalTokens = last assistant input", () => {
    expect(view.currentRowId).toBe(view.rows.at(-1)!.id)
    expect(view.totalTokens).toBe(3000)
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
    expect(shape(view.rows)).toEqual(["T1", "⚙", "○", "T2", "○", "╰⎇try-redis", "T3", "⚙", "○", "T4", "○"])
    const t1 = view.rows[0]!
    expect(t1.sessionID).toBe(TRUNK)
    expect(t1.kind === "turn" && t1.messageID).toBe("m1")
    const t3 = view.rows.find((r) => r.kind === "turn" && r.turn === 3)!
    expect(t3.sessionID).toBe(OPEN)
    expect(t3.kind === "turn" && t3.messageID).toBe("om1")
    expect(view.totalTokens).toBe(6000)
    expect(view.currentRowId).toBe(view.rows.at(-1)!.id)
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
