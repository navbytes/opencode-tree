import { describe, expect, test } from "bun:test"
import { bandFor, contextSizeOf, estimateTokens, type MinimalMessage } from "../src/core/tokens.js"

describe("estimateTokens", () => {
  test("chars/4, rounded up", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("abcd")).toBe(1)
    expect(estimateTokens("abcde")).toBe(2)
    expect(estimateTokens("a".repeat(4000))).toBe(1000)
  })
})

describe("bandFor", () => {
  test("bands are absolute per DESIGN.md §6.7", () => {
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
