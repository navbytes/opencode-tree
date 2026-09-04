import { describe, expect, test } from "bun:test"
import { abandonedTail, planJump } from "../src/core/actions.js"
import { buildTreeView, type Row } from "../src/core/tree.js"
import { describeTail, jumpDialogOptions, jumpDialogTitle } from "../src/tui/actions.js"
import { buildFixture, OPEN, SQUASHED, TRUNK } from "./fixtures/tree.js"

const f = buildFixture()
const view = (currentSessionID: string) =>
  buildTreeView({ state: f.state, transcripts: f.transcripts, currentSessionID, expanded: new Set([TRUNK, OPEN, SQUASHED]), filter: "all" })
const row = (currentSessionID: string, pick: (r: Row) => boolean) => view(currentSessionID).rows.find(pick)!

const ids = (currentSessionID: string, r: Row) =>
  abandonedTail({ state: f.state, transcripts: f.transcripts, currentSessionID, plan: planJump(r, { transcripts: f.transcripts, currentSessionID }) }).messages.map((m) => m.id)

describe("abandonedTail — Pi's 'everything below that point'", () => {
  test("redoing a trunk turn abandons that turn and everything after it", () => {
    const m2 = row(TRUNK, (r) => r.kind === "turn" && r.messageID === "m2")
    expect(ids(TRUNK, m2)).toEqual(["m2", "a2", "m3", "a3"])
  })

  test("continuing from a step abandons everything after that step's message", () => {
    const step = row(TRUNK, (r) => r.kind === "step" && r.messageID === "a1")
    expect(ids(TRUNK, step)).toEqual(["m2", "a2", "m3", "a3"])
  })

  test("switching from a branch to a sibling abandons only the branch's own turns", () => {
    const sib = row(OPEN, (r) => r.kind === "branch" && r.sessionID === SQUASHED)
    expect(ids(OPEN, sib)).toEqual(["om1", "oa1", "om2", "oa2"])
  })

  test("switching from the trunk into a branch abandons the trunk turns past the fork point", () => {
    const branch = row(TRUNK, (r) => r.kind === "branch" && r.sessionID === OPEN)
    expect(ids(TRUNK, branch)).toEqual(["m3", "a3"])
  })

  test("forking an ancestor from inside a branch abandons the whole branch path below it", () => {
    const m1 = row(OPEN, (r) => r.kind === "turn" && r.sessionID === TRUNK && r.messageID === "m1")
    expect(ids(OPEN, m1)).toEqual(["o-m1", "o-a1", "o-m2", "o-a2", "om1", "oa1", "om2", "oa2"])
  })

  test("a noop plan abandons nothing", () => {
    expect(abandonedTail({ state: f.state, transcripts: f.transcripts, currentSessionID: TRUNK, plan: { kind: "noop", reason: "already here" } })).toEqual({ messages: [], turns: 0, tokens: 0 })
  })

  test("turns and tokens describe the tail", () => {
    const m2 = row(TRUNK, (r) => r.kind === "turn" && r.messageID === "m2")
    const tail = abandonedTail({ state: f.state, transcripts: f.transcripts, currentSessionID: TRUNK, plan: planJump(m2, { transcripts: f.transcripts, currentSessionID: TRUNK }) })
    expect(tail.turns).toBe(2)
    expect(tail.tokens).toBeGreaterThan(0)
  })
})

describe("the ⏎ dialog (Pi's tree-selector question)", () => {
  const label = (id: string) => (id === OPEN ? "⎇ fix-flaky-test" : id)

  test("the title says what ⏎ will do, so the choice is also the confirmation", () => {
    expect(jumpDialogTitle({ kind: "switch", sessionID: OPEN }, label)).toBe("Switch to ⎇ fix-flaky-test?")
    expect(jumpDialogTitle({ kind: "fork", sessionID: TRUNK, messageID: "m2", mode: "redo" }, label)).toBe("Fork & prefill this turn?")
    expect(jumpDialogTitle({ kind: "fork", sessionID: TRUNK, messageID: "a2", mode: "continue" }, label)).toBe("Fork after this step?")
    expect(jumpDialogTitle({ kind: "noop", reason: "already here" }, label)).toBe("Nothing to go to")
  })

  test("three answers in Pi's order, 'No summary' first", () => {
    const opts = jumpDialogOptions({ messages: [], turns: 3, tokens: 14_200 }, "fork")
    expect(opts.map((o) => o.value)).toEqual(["none", "summarize", "custom"])
    expect(opts[0]!.description).toBe("start clean · nothing carried over")
    expect(opts[1]!.description).toBe("carry the 3 turns · ~14.2k over as one ≣ summary")
    expect(opts[1]!.title).toBe("Summarize everything below this point")
  })

  test("a switch names the path it leaves, not a point in it", () => {
    expect(jumpDialogOptions({ messages: [], turns: 2, tokens: 800 }, "switch")[1]!.title).toBe("Summarize what you are leaving")
  })

  test("a tail with no user turn is counted in messages", () => {
    expect(describeTail({ messages: [{} as never, {} as never], turns: 0, tokens: 900 })).toBe("2 messages · ~900")
    expect(describeTail({ messages: [{} as never], turns: 1, tokens: 1_000 })).toBe("1 turn · ~1k")
  })
})
