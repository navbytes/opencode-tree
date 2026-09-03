import { describe, expect, test } from "bun:test"
import { planJump } from "../src/core/actions.js"
import { buildTreeView } from "../src/core/tree.js"
import { buildFixture, OPEN, SQUASHED, TRUNK } from "./fixtures/tree.js"

const f = buildFixture()
const view = buildTreeView({ state: f.state, transcripts: f.transcripts, currentSessionID: TRUNK, expanded: new Set([OPEN]), filter: "default" })
const row = (pred: (r: (typeof view.rows)[number]) => boolean) => view.rows.find(pred)!

describe("planJump", () => {
  test("branch row → switch", () => {
    expect(planJump(row((r) => r.kind === "branch" && r.sessionID === SQUASHED), { transcripts: f.transcripts, currentSessionID: TRUNK })).toEqual({ kind: "switch", sessionID: SQUASHED })
  })
  test("middle user turn → fork at that message with prefill (redo)", () => {
    const t2 = row((r) => r.kind === "turn" && r.messageID === "m2")
    expect(planJump(t2, { transcripts: f.transcripts, currentSessionID: TRUNK })).toEqual({ kind: "fork", sessionID: TRUNK, messageID: "m2", prefill: "decompress the session and inspect it", mode: "redo" })
  })
  test("step row → fork at the next message (continue)", () => {
    const step = row((r) => r.kind === "step" && r.messageID === "a1")
    expect(planJump(step, { transcripts: f.transcripts, currentSessionID: TRUNK })).toEqual({ kind: "fork", sessionID: TRUNK, messageID: "m2", mode: "continue" })
  })
  test("tip of the current session → noop; tip of another session → switch", () => {
    expect(planJump(view.rows[view.indexById[view.currentRowId!]!]!, { transcripts: f.transcripts, currentSessionID: TRUNK }).kind).toBe("noop")
    const openTip = [...view.rows].reverse().find((r) => (r.kind === "turn" || r.kind === "step") && r.sessionID === OPEN)!
    expect(planJump(openTip, { transcripts: f.transcripts, currentSessionID: TRUNK })).toEqual({ kind: "switch", sessionID: OPEN })
  })
  test("from inside a branch, a prefix row forks the trunk, not the copy", () => {
    const inner = buildTreeView({ state: f.state, transcripts: f.transcripts, currentSessionID: OPEN, expanded: new Set(), filter: "default" })
    const t1 = inner.rows.find((r) => r.kind === "turn" && r.turn === 1)!
    expect(planJump(t1, { transcripts: f.transcripts, currentSessionID: OPEN })).toMatchObject({ kind: "fork", sessionID: TRUNK, messageID: "m1", mode: "redo" })
  })
})

describe("planJump ignores filters", () => {
  test("a searched-out tail does not turn a mid-session turn into a switch", () => {
    const filtered = buildTreeView({ state: f.state, transcripts: f.transcripts, currentSessionID: TRUNK, expanded: new Set([OPEN]), filter: "default", search: "flakes" })
    const t3 = filtered.rows.find((r) => r.kind === "turn" && r.messageID === "om1")!
    expect(planJump(t3, { transcripts: f.transcripts, currentSessionID: TRUNK })).toMatchObject({ kind: "fork", sessionID: OPEN, messageID: "om1", mode: "redo" })
  })
})
