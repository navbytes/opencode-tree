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
  test("duration weighting maps cells back to columns", () => {
    const l = buildLanes(open, "turns")
    const w = durationWeighted(l, 20)
    expect(w.input.length).toBeGreaterThanOrEqual(4)
    expect(w.columnAt(0)).toBe(0)
    expect(w.columnAt(w.input.length - 1)).toBe(3)
  })
})

describe("consumers", () => {
  test("tokens by source, sorted, with shares that sum to 1", () => {
    const c = consumers(open)
    expect(c[0]!.source).toBe("bash")
    expect(c.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 5)
    expect(c.find((x) => x.source === "● user prompts")!.count).toBe(4)
  })
  test("cropped parts are excluded; bar renders", () => {
    const c = consumers(open, { cropped: new Set(["oa1-tool"]) })
    expect(c[0]!.source).toBe("bash")
    expect(c[0]!.tokens).toBeLessThan(consumers(open)[0]!.tokens)
    expect(bar(0.5, 10)).toBe("▰▰▰▰▰▱▱▱▱▱")
  })
})
