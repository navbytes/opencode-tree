import { describe, expect, test } from "bun:test"
import { bandFor, contextBar, contextSizeOf, estimateTokens, formatContext, type MinimalMessage } from "../src/core/tokens.js"

describe("estimateTokens", () => {
  test("chars/4, rounded up", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("abcd")).toBe(1)
    expect(estimateTokens("abcde")).toBe(2)
    expect(estimateTokens("a".repeat(4000))).toBe(1000)
  })
})

describe("bandFor", () => {
  test("relative to the model window when the limit is known", () => {
    expect(bandFor(30_000, 32_768)).toBe("red") // one prompt from compaction is not "healthy"
    expect(bandFor(70_000, 1_000_000)).toBe("low")
    expect(bandFor(20_000, 100_000)).toBe("low")
    expect(bandFor(25_000, 100_000)).toBe("healthy")
    expect(bandFor(60_000, 100_000)).toBe("filling")
    expect(bandFor(85_000, 100_000)).toBe("red")
  })

  test("contextBar fills by share of the window and never hides a non-zero context", () => {
    expect(contextBar(0, 32_768)).toBe("░░░░░")
    expect(contextBar(100, 32_768)).toBe("▓░░░░")
    expect(contextBar(16_384, 32_768)).toBe("▓▓▓░░")
    expect(contextBar(32_768, 32_768)).toBe("▓▓▓▓▓")
    expect(contextBar(1000, 0)).toBe("")
  })

  test("formatContext carries the bar and the limit only when the window is known", () => {
    expect(formatContext({ tokens: 2300, estimated: true }, 32_768)).toBe("ctx ▓░░░░ ~2.3k/32.8k · low")
    expect(formatContext({ tokens: 2300, estimated: false })).toBe("ctx 2.3k · low")
  })

  test("bands are absolute per DESIGN.md §6.7 when no limit is known", () => {
    expect(bandFor(0)).toBe("low")
    expect(bandFor(7999)).toBe("low")
    expect(bandFor(8000)).toBe("healthy")
    expect(bandFor(31999)).toBe("healthy")
    expect(bandFor(32000)).toBe("filling")
    expect(bandFor(63999)).toBe("filling")
    expect(bandFor(64000)).toBe("red")
    expect(bandFor(1_000_000)).toBe("red")
  })
})

describe("contextSizeOf", () => {
  test("uses the last assistant turn's real tokens.input, plus its own output", () => {
    const messages: MinimalMessage[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
      { info: { role: "assistant", tokens: { input: 4600 } }, parts: [{ type: "text", text: "a".repeat(400) }] }, // +100
    ]
    const size = contextSizeOf(messages)
    expect(size.tokens).toBe(4700)
    expect(size.estimated).toBe(true)
  })

  test("an empty last assistant turn is the real figure, unestimated", () => {
    const messages: MinimalMessage[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
      { info: { role: "assistant", tokens: { input: 4600 } }, parts: [] },
    ]
    expect(contextSizeOf(messages)).toEqual({ tokens: 4600, estimated: false })
  })

  test("adds chars/4 for parts newer than the last assistant turn", () => {
    const messages: MinimalMessage[] = [
      { info: { role: "assistant", tokens: { input: 4600 } }, parts: [] },
      { info: { role: "user" }, parts: [{ type: "text", text: "a".repeat(400) }] }, // +100
    ]
    const size = contextSizeOf(messages)
    expect(size.tokens).toBe(4700)
    expect(size.estimated).toBe(true)
  })

  test("estimates everything when no assistant turn has run yet", () => {
    const messages: MinimalMessage[] = [{ info: { role: "user" }, parts: [{ type: "text", text: "a".repeat(40) }] }] // 10
    const size = contextSizeOf(messages)
    expect(size.tokens).toBe(10)
    expect(size.estimated).toBe(true)
  })

  test("includes tool input/output text in the newer-parts estimate", () => {
    const messages: MinimalMessage[] = [
      { info: { role: "assistant", tokens: { input: 100 } }, parts: [] },
      {
        info: { role: "assistant" },
        parts: [{ type: "tool", tool: "bash", state: { input: { command: "ls" }, output: "a".repeat(40) } }],
      },
    ]
    const size = contextSizeOf(messages)
    expect(size.tokens).toBeGreaterThan(100)
  })
})
