import { describe, expect, test } from "bun:test"
import { buildLanes, columnFor, durationWeighted, fitColumns, sparkline } from "../src/core/lanes.js"
import { bar, consumers } from "../src/core/consumers.js"
import { buildFixture, OPEN } from "./fixtures/tree.js"

const f = buildFixture()
const open = f.transcripts[OPEN]!

describe("lanes", () => {
  test("turns mode: one column per user turn with context size and tool tokens", () => {
    const l = buildLanes(open, "turns")
    expect(l.columns.length).toBe(4)
    expect(l.columns.map((c) => c.input)).toEqual([1200, 2400, 5000, 6000])
    expect(l.columns[2]!.tool).toBeGreaterThan(4000)
    expect(l.columns[0]!.tool).toBeGreaterThan(1000)
  })
  test("calls mode: one column per tool call, text-only turns keep a column", () => {
    const l = buildLanes(open, "calls")
    expect(l.columns.map((c) => Boolean(c.partID))).toEqual([true, false, true, false])
    expect(columnFor(l, "oa1", "oa1-tool")).toBe(2)
  })
  test("sparkline scales to width and max", () => {
    expect(sparkline([1, 2, 4, 8], 4)).toBe("▁▂▄█")
    expect(sparkline([1, 2, 4, 8], 2).length).toBe(2)
    expect(fitColumns([1, 2], 4)).toEqual([1, 1, 2, 2])
    expect(fitColumns([1, 5, 2, 9], 2)).toEqual([5, 9])
  })
  test("an explicit scale (the context limit) keeps a small session small", () => {
    expect(sparkline([100], 4)).toBe("████")
    expect(sparkline([100], 4, 200_000)).toBe("▁▁▁▁")
    expect(sparkline([400_000], 4, 200_000)).toBe("████") // never clips above the limit
  })
  test("turns mode: the cursor mirrors ● user rows too", () => {
    const l = buildLanes(open, "turns")
    expect(columnFor(l, "om1")).toBe(2) // the user message that opened turn 3
    expect(columnFor(l, "oa1")).toBe(2)
  })
  test("a leading compaction summary opens turn 0 instead of being dropped", () => {
    const compacted = { ...open, messages: [{ ...open.messages[1]!, summary: true }, ...open.messages.slice(4)] }
    const l = buildLanes(compacted, "turns")
    expect(l.columns.map((c) => c.turn)).toEqual([0, 1, 2])
    expect(l.columns[0]!.tool).toBeGreaterThan(1000)
  })
  test("duration weighting maps cells back to columns", () => {
    const l = buildLanes(open, "turns")
    const w = durationWeighted(l, 20)
    expect(w.input.length).toBeGreaterThanOrEqual(4)
    expect(w.columnAt(0)).toBe(0)
    expect(w.columnAt(w.input.length - 1)).toBe(3)
  })
  test("duration mode spreads cells by wall clock, so it does not draw like turns mode", () => {
    const columns = [
      { messageID: "a", turn: 1, input: 1000, output: 0, tool: 1000, toolError: false, ms: 1000 },
      { messageID: "b", turn: 2, input: 2000, output: 0, tool: 8000, toolError: false, ms: 9000 },
    ]
    const w = durationWeighted({ mode: "turns", columns }, 20)
    expect(w.tool.filter((v) => v === 8000).length).toBeGreaterThan(w.tool.filter((v) => v === 1000).length * 3)
    const even = sparkline(fitColumns(columns.map((c) => c.tool), 20), 20)
    expect(sparkline(fitColumns(w.tool, 20), 20)).not.toBe(even)
  })
  test("duration weighting keeps tool sizes and flags errors separately", () => {
    const w = durationWeighted({ mode: "turns", columns: [{ messageID: "a", turn: 1, input: 0, output: 0, tool: 500, toolError: true, ms: 10 }] }, 4)
    expect(w.tool.every((v) => v === 500)).toBe(true)
    expect(w.toolError.every(Boolean)).toBe(true)
  })
})

describe("consumers", () => {
  test("tokens by source, sorted, with shares that sum to 1", () => {
    const c = consumers(open)
    expect(c[0]!.source).toBe("bash")
    expect(c.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 5)
    expect(c.find((x) => x.source === "● user prompts")!.count).toBe(4)
  })
  test("native compaction summaries get their own bucket", () => {
    const compacted = { ...open, messages: open.messages.map((m, i) => (i === 1 ? { ...m, summary: true } : m)) }
    const c = consumers(compacted)
    expect(c.find((x) => x.source === "◇ compaction summaries")!.kind).toBe("summary")
    expect(c.find((x) => x.source === "○ assistant text")!.count).toBeLessThan(consumers(open).find((x) => x.source === "○ assistant text")!.count)
  })
  test("cropped parts are excluded; bar renders", () => {
    const c = consumers(open, { cropped: new Set(["oa1-tool"]) })
    expect(c[0]!.source).toBe("bash")
    expect(c[0]!.tokens).toBeLessThan(consumers(open)[0]!.tokens)
    expect(bar(0.5, 10)).toBe("▰▰▰▰▰▱▱▱▱▱")
  })
})
