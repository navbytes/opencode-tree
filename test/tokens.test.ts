import { describe, expect, test } from "bun:test"
import { bandFor, cacheShare, contextBar, contextBarCells, contextSizeOf, estimateTokens, formatContext, formatK, type MinimalMessage } from "../src/core/tokens.js"

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

  test("formatContext appends the cache share once the provider has reported cache tokens", () => {
    expect(formatContext({ tokens: 2300, estimated: true, cached: 1200, prompt: 2300 }, 32_768)).toBe("ctx ▓░░░░ ~2.3k/32.8k · low · 52% cached")
    expect(formatContext({ tokens: 2300, estimated: true, cached: 0, prompt: 2300 })).toBe("ctx ~2.3k · low · 0% cached")
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

describe("cacheShare", () => {
  test("cached / prompt as a 0-100 integer percent, undefined without a cache signal", () => {
    expect(cacheShare({})).toBeUndefined()
    expect(cacheShare({ cached: 5, prompt: 0 })).toBeUndefined() // no division by zero
    expect(cacheShare({ cached: 0, prompt: 100 })).toBe(0) // a reset cache is still a share, not "unknown"
    expect(cacheShare({ cached: 50, prompt: 100 })).toBe(50)
  })
})

describe("contextBarCells", () => {
  test("splits contextBar's filled count into a cached run and a fresh run", () => {
    // 60% of a 10k window fills 3 of 5 cells; 95% cached rounds down to 2, leaving 1 fresh
    expect(contextBarCells({ tokens: 6000, estimated: false, cached: 5700, prompt: 6000 }, 10_000)).toEqual({ cached: 2, fresh: 1, empty: 2 })
  })

  test("a fully-cached prompt still keeps one fresh cell", () => {
    expect(contextBarCells({ tokens: 10_000, estimated: false, cached: 10_000, prompt: 10_000 }, 10_000)).toEqual({ cached: 4, fresh: 1, empty: 0 })
  })

  test("no cache signal: every filled cell is fresh, same as plain contextBar", () => {
    expect(contextBarCells({ tokens: 6000, estimated: false }, 10_000)).toEqual({ cached: 0, fresh: 3, empty: 2 })
  })

  test("a single filled cell shows whichever share is larger, not always fresh", () => {
    // at low overall fill (e.g. an early-session prompt), the bar has only one lit cell:
    // it must read cached when the prompt is mostly cached, not contradict the "N% cached" text next to it
    expect(contextBarCells({ tokens: 10_300, estimated: false, cached: 10_300, prompt: 10_300 }, 262_100)).toEqual({
      cached: 1,
      fresh: 0,
      empty: 4,
    })
    expect(contextBarCells({ tokens: 10_300, estimated: false, cached: 4000, prompt: 10_300 }, 262_100)).toEqual({
      cached: 0,
      fresh: 1,
      empty: 4,
    })
  })
})

describe("formatK", () => {
  test("k below a million, M above it", () => {
    expect(formatK(800)).toBe("800")
    expect(formatK(12_345)).toBe("12.3k")
    expect(formatK(1_310_700)).toBe("1.3M")
    expect(formatK(2_000_000)).toBe("2M")
  })

  test("rounds up into the M form from 999_500, not just at the exact million", () => {
    expect(formatK(999_499)).toBe("999.5k")
    expect(formatK(999_500)).toBe("1M")
    expect(formatK(999_999)).toBe("1M") // would round-trip to "1000k" otherwise, which is not "1.0k" scale
  })
})

describe("contextSizeOf", () => {
  test("uses the last assistant turn's real tokens.input, plus its own output", () => {
    const messages: MinimalMessage[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
      { info: { role: "assistant", tokens: { input: 4600, output: 100 } }, parts: [{ type: "text", text: "a".repeat(400) }] },
    ]
    const size = contextSizeOf(messages)
    expect(size.tokens).toBe(4700) // input + its own real output; the generated text is not also chars/4'd
    expect(size.estimated).toBe(false)
  })

  test("an empty last assistant turn is the real figure, unestimated", () => {
    const messages: MinimalMessage[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
      { info: { role: "assistant", tokens: { input: 4600, output: 20 } }, parts: [] },
    ]
    expect(contextSizeOf(messages)).toEqual({ tokens: 4620, estimated: false })
  })

  test("adds chars/4 for parts newer than the last assistant turn", () => {
    const messages: MinimalMessage[] = [
      { info: { role: "assistant", tokens: { input: 4600, output: 20 } }, parts: [] },
      { info: { role: "user" }, parts: [{ type: "text", text: "a".repeat(400) }] }, // +100
    ]
    const size = contextSizeOf(messages)
    expect(size.tokens).toBe(4720) // 4600 input + 20 output + 100 guessed for the newer user turn
    expect(size.estimated).toBe(true)
  })

  test("skips a trailing assistant turn with no output yet, like OpenCode's own sidebar gauge", () => {
    const messages: MinimalMessage[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
      {
        info: { role: "assistant", tokens: { input: 5000, output: 500, reasoning: 30, cache: { read: 4750, write: 0 } } },
        parts: [{ type: "text", text: "first answer" }],
      },
      { info: { role: "user" }, parts: [{ type: "text", text: "and now?" }] }, // +2
      {
        info: { role: "assistant", tokens: { input: 200, output: 0, cache: { read: 9800, write: 0 } } },
        parts: [{ type: "tool", tool: "bash", state: { input: { command: "ls" }, output: "ok" } }], // +6
      },
    ]
    // the earlier turn's five-field sum (5000+500+30+4750 = 10280, what OpenCode's sidebar shows
    // too) plus chars/4 for everything newer: the next user turn and the trailing 0-output tool call
    // cached/prompt come from the *selected* (first) turn, not the trailing one with no output yet
    expect(contextSizeOf(messages)).toEqual({ tokens: 10_288, estimated: true, cached: 4750, prompt: 9750 })
  })

  test("estimates everything when no assistant turn has run yet", () => {
    const messages: MinimalMessage[] = [{ info: { role: "user" }, parts: [{ type: "text", text: "a".repeat(40) }] }] // 10
    const size = contextSizeOf(messages)
    expect(size.tokens).toBe(10)
    expect(size.estimated).toBe(true)
  })

  test("counts cached prompt tokens: a cache hit is context the model still held", () => {
    // observed on a caching provider: the gauge read ~200 while 28.3k of prefix came back cached
    const messages: MinimalMessage[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "and now?" }] },
      {
        info: { role: "assistant", tokens: { input: 139, output: 17, reasoning: 44, cache: { read: 28_263, write: 0 } } },
        parts: [{ type: "reasoning", text: "a".repeat(176) }, { type: "text", text: "b".repeat(68) }],
      },
    ]
    // input + cache.read + cache.write + output + reasoning — the provider counted all of it,
    // so the generated parts are never chars/4'd on top
    expect(contextSizeOf(messages)).toEqual({ tokens: 28_463, estimated: false, cached: 28_263, prompt: 28_402 })
  })

  test("a fresh branch whose whole prefix was a cache hit is not an empty context", () => {
    const messages: MinimalMessage[] = [
      { info: { role: "user" }, parts: [] },
      { info: { role: "assistant", tokens: { input: 0, output: 512, reasoning: 88, cache: { read: 56_700, write: 0 } } }, parts: [] },
    ]
    // the whole prompt was a cache hit: cached === prompt, 100% cached
    expect(formatContext(contextSizeOf(messages), 262_144)).toBe("ctx ▓░░░░ 57.3k/262.1k · low · 100% cached")
  })

  test("cache.write counts too — the turn that filled the cache still sent those tokens", () => {
    const messages: MinimalMessage[] = [{ info: { role: "assistant", tokens: { input: 100, output: 1, reasoning: 0, cache: { read: 0, write: 4000 } } }, parts: [] }]
    // a write-only turn reported cache activity, so cached is 0 (meaningful), not undefined
    expect(contextSizeOf(messages)).toEqual({ tokens: 4101, estimated: false, cached: 0, prompt: 4100 })
  })

  test("cached is undefined when no assistant message has ever reported cache tokens", () => {
    const messages: MinimalMessage[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
      { info: { role: "assistant", tokens: { input: 100, output: 50, reasoning: 0 } }, parts: [{ type: "text", text: "ok" }] },
    ]
    const size = contextSizeOf(messages)
    expect(size.cached).toBeUndefined()
    expect(size.prompt).toBeUndefined()
  })

  test("cache seen earlier but reset to 0 on the selected turn is still a defined 0, not undefined", () => {
    const messages: MinimalMessage[] = [
      { info: { role: "assistant", tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 500, write: 0 } } }, parts: [] },
      { info: { role: "user" }, parts: [] },
      // a crop/merge/fork reset the cache: this (selected) turn's own read/write are both 0
      { info: { role: "assistant", tokens: { input: 50, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] },
    ]
    const size = contextSizeOf(messages)
    expect(size.cached).toBe(0)
    expect(size.prompt).toBe(50)
  })

  test("a later, still-in-flight reply's cache stats do not cache-tag the earlier selected turn", () => {
    const messages: MinimalMessage[] = [
      // the selected turn (last one with output > 0) — genuinely never cached
      { info: { role: "assistant", tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] },
      { info: { role: "user" }, parts: [] },
      // still streaming: no output yet, but already reporting a cache read
      { info: { role: "assistant", tokens: { input: 50, output: 0, reasoning: 0, cache: { read: 900, write: 0 } } }, parts: [] },
    ]
    const size = contextSizeOf(messages)
    expect(size.cached).toBeUndefined()
    expect(size.prompt).toBeUndefined()
  })

  test("includes tool input/output text in the newer-parts estimate", () => {
    const messages: MinimalMessage[] = [
      { info: { role: "assistant", tokens: { input: 100, output: 1 } }, parts: [] },
      {
        info: { role: "assistant" },
        parts: [{ type: "tool", tool: "bash", state: { input: { command: "ls" }, output: "a".repeat(40) } }],
      },
    ]
    const size = contextSizeOf(messages)
    expect(size.tokens).toBeGreaterThan(100)
  })
})
