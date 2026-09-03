import { describe, expect, test } from "bun:test"
import { buildEventStrip, buildLanes, columnFor, durationWeighted, fitColumns, layoutEventStrip, overviewTrack, sparkline, stripIndexFor, windowFor, type EventStrip } from "../src/core/lanes.js"
import { bar, consumers } from "../src/core/consumers.js"
import type { Transcript, TranscriptMessage } from "../src/core/transcript.js"
import { assistant, buildFixture, OPEN, user } from "./fixtures/tree.js"

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

const T = (messages: TranscriptMessage[]): Transcript => ({ sessionID: "s", title: "strip", status: "available", messages })

/** cells that belong to any lane, per index — the axis is shared, so this must never exceed 1 */
function occupancy(strip: EventStrip): number[] {
  return Array.from({ length: strip.width }, (_, c) => (["input", "model", "tools"] as const).filter((l) => strip.lanes[l][c] !== null).length)
}

describe("event strip", () => {
  test("calls mode: one pill per event, single gaps, no overlap across lanes", () => {
    const s = buildEventStrip(T([user("u1", "hi"), assistant("a1", { text: "ok", tool: { name: "bash", input: { command: "ls" }, output: "out" } })]), "calls", 40)
    expect(s.events.map((e) => `${e.lane}/${e.kind}`)).toEqual(["input/user", "tools/tool", "model/text"])
    expect(s.spans).toEqual([{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 5 }])
    expect(s.lanes.input[0]).toEqual({ lane: "input", eventIndex: 0, glyph: "▬" })
    expect(s.lanes.input[1]).toBe(null)
    expect(occupancy(s).every((n) => n <= 1)).toBe(true)
    expect(s.truncatedLeft).toBe(0)
  })
  test("turns mode: a turn boundary opens a 2-cell gap, steps inside a turn keep 1", () => {
    const s = buildEventStrip(T([user("u1", "a"), assistant("a1", { text: "one" }), user("u2", "b"), assistant("a2", { text: "two" })]), "turns", 40)
    expect(s.events.map((e) => e.turn)).toEqual([1, 1, 2, 2])
    expect(s.spans[1]!.start - s.spans[0]!.end).toBe(1)
    expect(s.spans[2]!.start - s.spans[1]!.end).toBe(2)
    expect(s.spans[3]!.start - s.spans[2]!.end).toBe(1)
    expect(s.lanes.input[s.spans[2]!.start]!.eventIndex).toBe(2)
  })
  test("duration mode: widths follow durations, untimed events keep 1 cell", () => {
    const slow = assistant("a1", { tool: { name: "bash", input: { command: "slow" }, output: "x", ms: 8000 } })
    const fast = assistant("a2", { tool: { name: "bash", input: { command: "fast" }, output: "x", ms: 1000 } })
    const s = buildEventStrip(T([user("u1", "go"), slow, fast]), "duration", 40)
    const width = (i: number) => s.spans[i]!.end - s.spans[i]!.start
    expect(width(0)).toBe(1) // a user prompt has no wall clock of its own
    expect(width(1)).toBeGreaterThan(width(2) * 3)
    expect(s.spans[2]!.start - s.spans[1]!.end).toBe(1)
    expect(s.spans.at(-1)!.end).toBeLessThanOrEqual(40)
  })
  test("duration mode falls back to the calls layout when no event is timed", () => {
    const s = buildEventStrip(T([user("u1", "a"), user("u2", "b"), user("u3", "c")]), "duration", 20)
    expect(s.spans).toEqual([{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 5 }])
  })
  test("truncation keeps the newest events and reports how many were dropped", () => {
    const messages = Array.from({ length: 12 }, (_, i) => [user(`u${i}`, "q"), assistant(`a${i}`, { text: "r" })]).flat()
    const all = buildEventStrip(T(messages), "calls", 200)
    const s = buildEventStrip(T(messages), "calls", 9)
    expect(s.truncatedLeft + s.events.length).toBe(all.events.length)
    expect(s.truncatedLeft).toBeGreaterThan(0)
    expect(s.events.at(-1)!.messageID).toBe("a11")
    expect(s.spans.at(-1)!.end).toBeLessThanOrEqual(9)
    expect(occupancy(s).every((n) => n <= 1)).toBe(true)
  })
  test("stripIndexFor maps a tool part to its event, and its span covers it", () => {
    const s = buildEventStrip(open, "calls", 80)
    const i = stripIndexFor(s, "oa1", "oa1-tool")
    expect(i).toBeGreaterThanOrEqual(0)
    expect(s.events[i]!.lane).toBe("tools")
    expect(s.lanes.tools[s.spans[i]!.start]!.eventIndex).toBe(i)
    expect(stripIndexFor(s, "om1")).toBe(s.events.findIndex((e) => e.messageID === "om1"))
    expect(stripIndexFor(s, "nope")).toBe(-1)
  })
  test("a lane with no events is reported as empty", () => {
    const s = buildEventStrip(T([user("u1", "hi"), assistant("a1", { text: "no tools here" })]), "calls", 20)
    expect(s.empty).toEqual({ input: false, model: false, tools: true })
    expect(s.lanes.tools.every((c) => c === null)).toBe(true)
  })
  test("a failed tool call keeps the glyph and flags the error", () => {
    const failed = assistant("a1", { tool: { name: "bash", input: { command: "boom" }, output: "nope" } })
    failed.parts = failed.parts.map((p) => (p.type === "tool" ? { ...p, state: { ...p.state, status: "error" } } : p))
    const s = buildEventStrip(T([user("u1", "go"), failed]), "calls", 20)
    const i = stripIndexFor(s, "a1", "a1-tool")
    expect(s.events[i]!.error).toBe(true)
    expect(s.lanes.tools[s.spans[i]!.start]).toEqual({ lane: "tools", eventIndex: i, glyph: "▬", error: true })
  })
  test("a compaction summary is context on the Input lane, not model output", () => {
    const compacted = { ...open, messages: [{ ...open.messages[1]!, summary: true }, ...open.messages.slice(4)] }
    const s = buildEventStrip(compacted, "turns", 60)
    expect(s.events[0]).toMatchObject({ lane: "input", kind: "context", turn: 0, messageID: "o-a1" })
    expect(s.events.some((e) => e.messageID === "o-a1" && e.lane === "model")).toBe(false)
    expect(s.events.some((e) => e.messageID === "o-a1" && e.lane === "tools")).toBe(true) // its tool calls stay tool calls
  })
})

/** 20 turns: 40 events, so `calls` mode lays out 79 cells — several screens of a 20-cell lane. */
const LONG = T(Array.from({ length: 20 }, (_, i) => [user(`u${i}`, "q"), assistant(`a${i}`, { text: "r" })]).flat())

describe("event layout", () => {
  test("lays out every event on an unbounded axis", () => {
    const l = layoutEventStrip(LONG, "calls")
    expect(l.events.length).toBe(40)
    expect(l.totalWidth).toBe(79)
    expect(l.spans[0]).toEqual({ start: 0, end: 1 })
    expect(l.spans.at(-1)).toEqual({ start: 78, end: 79 })
    expect(l.lanes.input.length).toBe(79)
    expect(l.lanes.input[0]!.eventIndex).toBe(0)
    expect(l.empty).toEqual({ input: false, model: false, tools: true })
  })
  test("the strip is the layout windowed at its end", () => {
    const l = layoutEventStrip(LONG, "calls")
    const s = buildEventStrip(LONG, "calls", 20)
    expect(s.truncatedLeft).toBe(30)
    expect(s.events).toEqual(l.events.slice(30))
    expect(s.spans[0]).toEqual({ start: 1, end: 2 }) // flush right: the slack lands on the left
    expect(s.lanes.model[19]!.eventIndex).toBe(s.events.length - 1)
  })
  test("duration mode keeps its proportions off-screen instead of squeezing into a width", () => {
    const slow = assistant("a1", { tool: { name: "bash", input: { command: "slow" }, output: "x", ms: 8000 } })
    const fast = assistant("a2", { tool: { name: "bash", input: { command: "fast" }, output: "x", ms: 1000 } })
    const l = layoutEventStrip(T([user("u1", "go"), slow, fast]), "duration")
    const width = (i: number) => l.spans[i]!.end - l.spans[i]!.start
    expect(l.totalWidth).toBeGreaterThan(layoutEventStrip(T([user("u1", "go"), slow, fast]), "calls").totalWidth)
    expect(width(1)).toBeGreaterThan(width(2) * 3)
  })
})

describe("window following the cursor", () => {
  const l = layoutEventStrip(LONG, "calls") // 79 cells; at width 20: margin 2, chunk 6, last start 59
  const spanOfEvent = (i: number) => l.spans[i]!
  test("a layout that fits starts at 0", () => {
    expect(windowFor(l, 39, 200, undefined)).toBe(0)
    expect(windowFor(l, 0, 200, 40)).toBe(0)
  })
  test("no previous window opens at the newest events", () => {
    expect(windowFor(l, 39, 20, undefined)).toBe(59)
    expect(windowFor(l, -1, 20, undefined)).toBe(59)
  })
  test("a cursor between the margins does not move the window", () => {
    expect(windowFor(l, 22, 20, 40)).toBe(40) // span 44..45, inside [42, 58)
    expect(windowFor(l, -1, 20, 40)).toBe(40) // a row with no event holds the window still
  })
  test("a cursor just past the left margin shifts one chunk", () => {
    expect(spanOfEvent(20).start).toBe(40) // one cell outside [42, 58)
    expect(windowFor(l, 20, 20, 40)).toBe(34)
  })
  test("a cursor past the right margin shifts in chunks until it is inside", () => {
    const start = windowFor(l, 12, 20, 0)
    expect(start).toBe(12)
    expect(spanOfEvent(12).end).toBeLessThanOrEqual(start + 20 - 2)
  })
  test("a far jump clamps: gg lands at 0, G at the last window", () => {
    expect(windowFor(l, 0, 20, 59)).toBe(0)
    expect(windowFor(l, 39, 20, 0)).toBe(59)
    expect(windowFor(l, -1, 20, 999)).toBe(59)
  })
  test("walking the cursor backwards keeps its event on the strip", () => {
    let start = windowFor(l, 39, 20, undefined)
    for (let i = 39; i >= 0; i--) {
      start = windowFor(l, i, 20, start)
      const span = spanOfEvent(i)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(span.start).toBeGreaterThanOrEqual(start)
      expect(span.end).toBeLessThanOrEqual(start + 20)
    }
    expect(start).toBe(0)
  })
})

describe("overview track", () => {
  const l = layoutEventStrip(LONG, "calls")
  test("the bright segment sits where the window is", () => {
    const head = overviewTrack(l, 0, 20)
    expect(head.length).toBe(20)
    expect(head[0]).toBe("window")
    expect(head.at(-1)).toBe("track")
    const tail = overviewTrack(l, 59, 20)
    expect(tail.at(-1)).toBe("window")
    expect(tail[0]).toBe("track")
    expect(tail.filter((k) => k === "window").length).toBeGreaterThan(0)
  })
  test("a failed call outside the window still shows as a tick", () => {
    const failed = assistant("a0", { tool: { name: "bash", input: { command: "boom" }, output: "nope" } })
    failed.parts = failed.parts.map((p) => (p.type === "tool" ? { ...p, state: { ...p.state, status: "error" } } : p))
    const withError = layoutEventStrip(T([user("u0", "go"), failed, ...LONG.messages]), "calls")
    const track = overviewTrack(withError, withError.totalWidth - 20, 20)
    expect(track[0]).toBe("error")
    expect(track.at(-1)).toBe("window")
  })
})
