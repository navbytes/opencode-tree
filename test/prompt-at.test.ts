import { describe, expect, test } from "bun:test"
import { buildTreeView, formatPromptAt, promptAtRow, type Row } from "../src/core/tree.js"
import { buildFixture, OPEN, TRUNK } from "./fixtures/tree.js"

const f = buildFixture()
const view = buildTreeView({ state: f.state, transcripts: f.transcripts, currentSessionID: TRUNK, expanded: new Set([TRUNK, OPEN]), filter: "all" })
const row = (pick: (r: Row) => boolean) => view.rows.find(pick)!
const at = (r: Row) => promptAtRow(r, f.transcripts)

describe("promptAtRow — what the provider was really sent here", () => {
  test("an assistant step reports its own message's prompt", () => {
    // fixture a2: input 2400, no cache
    expect(at(row((r) => r.kind === "step" && r.messageID === "a2"))).toEqual({ kind: "prompt", prompt: 2400, cached: 0 })
  })

  test("every step of one message carries the same figure", () => {
    const steps = view.rows.filter((r) => r.kind === "step" && r.messageID === "a1")
    expect(steps.length).toBeGreaterThan(1)
    for (const s of steps) expect(at(s)).toEqual({ kind: "prompt", prompt: 1200, cached: 0 })
  })

  test("a user turn takes the reply to it — the first prompt that included it", () => {
    expect(at(row((r) => r.kind === "turn" && r.messageID === "m2"))).toEqual({ kind: "prompt", prompt: 2400, cached: 0 })
  })

  test("a branch header has none; its own column is already a subtree total", () => {
    expect(at(row((r) => r.kind === "branch"))).toEqual({ kind: "none" })
  })

  test("the figure sums input + cache read + write, as the header gauge does", () => {
    const cached = { ...f.transcripts[TRUNK]!, messages: f.transcripts[TRUNK]!.messages.map((m) => (m.id === "a2" ? { ...m, tokens: { input: 400, output: 60, reasoning: 0, cache: { read: 1800, write: 200 } } } : m)) }
    // a step row carries its own message's report, so the view has to be rebuilt to see it
    const transcripts = { ...f.transcripts, [TRUNK]: cached }
    const v = buildTreeView({ state: f.state, transcripts, currentSessionID: TRUNK, expanded: new Set([TRUNK]), filter: "all" })
    const step = v.rows.find((r) => r.kind === "step" && r.messageID === "a2")!
    expect(promptAtRow(step, transcripts)).toEqual({ kind: "prompt", prompt: 2400, cached: 1800 })
    // and the user turn it answers reads the same figure through the transcript
    expect(promptAtRow(v.rows.find((r) => r.kind === "turn" && r.messageID === "m2")!, transcripts)).toEqual({ kind: "prompt", prompt: 2400, cached: 1800 })
  })
})

describe("promptAtRow — nothing sent yet", () => {
  const trailing = { ...f.transcripts[TRUNK]!, messages: f.transcripts[TRUNK]!.messages.slice(0, 4).concat({ id: "m9", role: "user" as const, time: { created: 1 }, parts: [{ id: "m9-p0", type: "text" as const, text: "unanswered" }] }) }
  const transcripts = { ...f.transcripts, [TRUNK]: trailing }
  const v = buildTreeView({ state: f.state, transcripts, currentSessionID: TRUNK, expanded: new Set([TRUNK]), filter: "all" })

  test("a turn with no reply after it is pending, not zero", () => {
    expect(promptAtRow(v.rows.find((r) => r.kind === "turn" && r.messageID === "m9")!, transcripts)).toEqual({ kind: "pending" })
  })
})

describe("formatPromptAt", () => {
  test("reads against the gauge above it", () => {
    expect(formatPromptAt({ kind: "prompt", prompt: 43_700, cached: 30_100 }, { turn: 2, what: "reply" })).toBe("T2 reply · prompt 43.7k · 30.1k cached")
  })
  test("a tool step is named by its tool", () => {
    expect(formatPromptAt({ kind: "prompt", prompt: 43_700, cached: 0 }, { turn: 2, what: "bash" })).toBe("T2 bash · prompt 43.7k")
  })
  test("no cache figure on a provider that never caches", () => {
    expect(formatPromptAt({ kind: "prompt", prompt: 900, cached: 0 }, { turn: 1, what: "reply" })).toBe("T1 reply · prompt 900")
  })
  test("pending drops the descriptor — there is no reply to describe", () => {
    expect(formatPromptAt({ kind: "pending" }, { turn: 3, what: "reply" })).toBe("T3 · not sent yet")
  })
  test("nothing to say prints nothing, so the caller drops the field", () => {
    expect(formatPromptAt({ kind: "none" }, { turn: 3 })).toBe("")
  })
})
