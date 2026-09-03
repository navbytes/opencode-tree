import { describe, expect, test } from "bun:test"
import { consumers } from "../src/core/consumers.js"
import type { Transcript, TranscriptMessage } from "../src/core/transcript.js"
import { assistant, buildFixture, OPEN, TRUNK, user } from "./fixtures/tree.js"

const f = buildFixture()
const open = f.transcripts[OPEN]!
const transcriptOf = (messages: TranscriptMessage[]): Transcript => ({ sessionID: TRUNK, title: "t", status: "available", messages })

describe("consumer buckets can be drilled into", () => {
  test("entries are biggest-first, one per part, and preview what they are", () => {
    const bash = consumers(open).find((c) => c.source === "bash")!
    expect(bash.entries.length).toBe(bash.count)
    expect(bash.entries.map((e) => e.tokens)).toEqual([...bash.entries.map((e) => e.tokens)].sort((a, b) => b - a))
    expect(bash.entries.reduce((s, e) => s + e.tokens, 0)).toBe(bash.tokens)
    expect(bash.entries[0]!.preview.startsWith("[bash $")).toBe(true)
    expect(bash.entries[0]!.messageID).toBe("oa1")
    expect(bash.entries[0]!.partID).toBe("oa1-tool")
  })
  test("only a completed tool result is croppable — crop's result mode can stub nothing else", () => {
    const running: TranscriptMessage = {
      id: "r1",
      role: "assistant",
      time: { created: 1 },
      parts: [{ id: "r1-tool", type: "tool", tool: "bash", state: { status: "running", input: { command: "sleep 1" } } }],
    }
    const c = consumers(transcriptOf([user("q1", "run it"), running]))
    expect(c.find((x) => x.source === "bash")!.entries.every((e) => e.croppable)).toBe(false)
    expect(c.find((x) => x.source === "● user prompts")!.entries.every((e) => e.croppable)).toBe(false)
    expect(consumers(open).find((x) => x.source === "bash")!.entries.every((e) => e.croppable)).toBe(true)
  })
  test("a limit adds the share of the window without touching the share of the tree", () => {
    const plain = consumers(open)
    const withLimit = consumers(open, { limit: 200_000 })
    expect(plain[0]!.shareOfWindow).toBeUndefined()
    expect(withLimit[0]!.shareOfWindow).toBeCloseTo(withLimit[0]!.tokens / 200_000, 6)
    expect(withLimit.map((c) => c.share)).toEqual(plain.map((c) => c.share))
    expect(consumers(open, { limit: 0 })[0]!.shareOfWindow).toBeUndefined()
  })
  test("the thinking bucket says why it cannot be acted on", () => {
    const c = consumers(transcriptOf([user("q1", "think"), assistant("r1", { think: { text: "a long chain of thought" }, text: "answer", input: 10, output: 4 })]))
    const think = c.find((x) => x.kind === "reasoning")!
    expect([think.source, think.note]).toEqual(["(thinking)", "provider reasoning · not croppable"])
    expect(think.entries.every((e) => !e.croppable)).toBe(true)
    expect(c.find((x) => x.kind === "assistant")!.note).toBeUndefined()
  })
  test("a cropped part leaves the bucket and its entry list", () => {
    const bash = consumers(open, { cropped: new Set(["oa1-tool"]) }).find((c) => c.source === "bash")!
    expect(bash.entries.some((e) => e.partID === "oa1-tool")).toBe(false)
    expect(bash.count).toBe(consumers(open).find((c) => c.source === "bash")!.count - 1)
  })
})
