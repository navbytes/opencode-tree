import { describe, expect, test } from "bun:test"
import { eventAllowed, laneLabel, laneModeLine, laneSuffix, layoutEventStrip, overviewTrack, stripIndexFor, windowFor, type EventLayout, LANE_CHROME, LANE_LABEL_WIDTH } from "../src/core/lanes.js"
import { bar, consumers } from "../src/core/consumers.js"
import type { Transcript, TranscriptMessage } from "../src/core/transcript.js"
import { assistant, buildFixture, OPEN, user } from "./fixtures/tree.js"

const f = buildFixture()
const open = f.transcripts[OPEN]!

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

  test("the system prompt is a bucket, so the view reconciles with the ctx gauge", () => {
    // without it this view walks the transcript only, and silently omits a chunk the header's
    // `ctx …` (tokens.input) does include
    const system = [
      { name: "base prompt", text: "x".repeat(8000) },
      { name: "AGENTS.md", text: "y".repeat(4000) },
    ]
    const withSystem = consumers(open, { system })
    const without = consumers(open)
    const bucket = withSystem.find((c) => c.kind === "system")!
    expect(bucket.source).toBe("≡ system prompt")
    expect(bucket.tokens).toBe(3000) // (8000 + 4000) / 4
    expect(bucket.count).toBe(2)
    expect(withSystem.reduce((n, c) => n + c.tokens, 0)).toBe(without.reduce((n, c) => n + c.tokens, 0) + 3000)
  })

  test("its parts are separate entries, biggest first, and none is croppable", () => {
    const system = [
      { name: "base prompt", text: "x".repeat(400) },
      { name: "AGENTS.md", text: "y".repeat(4000) },
    ]
    const bucket = consumers(open, { system }).find((c) => c.kind === "system")!
    expect(bucket.entries.map((e) => e.preview.split(":")[0])).toEqual(["AGENTS.md", "base prompt"])
    expect(bucket.entries.every((e) => !e.croppable)).toBe(true)
    expect(bucket.note).toContain("not croppable")
  })

  test("no snapshot means no bucket — absent is 'unknown', never 'zero'", () => {
    expect(consumers(open).some((c) => c.kind === "system")).toBe(false)
    expect(consumers(open, { system: [] }).some((c) => c.kind === "system")).toBe(false)
  })

  test("shares still sum to 1 once the system prompt is in", () => {
    const cs = consumers(open, { system: [{ name: "base prompt", text: "x".repeat(8000) }] })
    expect(cs.reduce((n, c) => n + c.share, 0)).toBeCloseTo(1, 5)
  })

const T = (messages: TranscriptMessage[]): Transcript => ({ sessionID: "s", title: "strip", status: "available", messages })

/** cells that belong to any lane, per index — the axis is shared, so this must never exceed 1 */
function occupancy(l: EventLayout): number[] {
  return Array.from({ length: l.totalWidth }, (_, c) => (["input", "model", "tools"] as const).filter((lane) => l.lanes[lane][c] !== null).length)
}

describe("event strip", () => {
  test("one pill per event, single gaps inside a turn, no overlap across lanes", () => {
    const l = layoutEventStrip(T([user("u1", "hi"), assistant("a1", { text: "ok", tool: { name: "bash", input: { command: "ls" }, output: "out" } })]), "turns")
    expect(l.events.map((e) => `${e.lane}/${e.kind}`)).toEqual(["input/user", "tools/tool", "model/text"])
    expect(l.spans).toEqual([{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 5 }])
    expect(l.lanes.input[0]).toEqual({ lane: "input", eventIndex: 0, glyph: "▬" })
    expect(l.lanes.input[1]).toBe(null)
    expect(occupancy(l).every((n) => n <= 1)).toBe(true)
    expect(l.rules).toEqual([]) // one turn, so no boundary to rule
  })

  test("a turn boundary opens a gap and puts a rule in it, in both modes", () => {
    const two = T([user("u1", "a"), assistant("a1", { text: "one" }), user("u2", "b"), assistant("a2", { text: "two" })])
    for (const mode of ["turns", "duration"] as const) {
      const l = layoutEventStrip(two, mode)
      expect(l.events.map((e) => e.turn)).toEqual([1, 1, 2, 2])
      expect(l.spans[1]!.start - l.spans[0]!.end).toBe(1) // inside a turn
      expect(l.spans[2]!.start - l.spans[1]!.end).toBe(3) // across the boundary
      expect(l.rules).toEqual([l.spans[1]!.end + 1])
      // the rule never lands on a pill: its cell is empty in every lane
      for (const lane of ["input", "model", "tools"] as const) expect(l.lanes[lane][l.rules[0]!]).toBe(null)
    }
  })

  test("duration mode: widths follow durations, untimed events keep one cell", () => {
    const slow = assistant("a1", { tool: { name: "bash", input: { command: "slow" }, output: "x", ms: 8000 } })
    const fast = assistant("a2", { tool: { name: "bash", input: { command: "fast" }, output: "x", ms: 1000 } })
    const l = layoutEventStrip(T([user("u1", "go"), slow, fast]), "duration")
    const width = (i: number) => l.spans[i]!.end - l.spans[i]!.start
    expect(width(0)).toBe(1) // a user prompt has no wall clock of its own
    expect(width(1)).toBeGreaterThan(width(2) * 3)
  })

  test("duration mode falls back to one cell per event when nothing is timed", () => {
    const l = layoutEventStrip(T([user("u1", "a"), user("u2", "b"), user("u3", "c")]), "duration")
    expect(l.spans.map((s) => s.end - s.start)).toEqual([1, 1, 1])
  })

  test("stripIndexFor maps a tool part to its event, and its span covers it", () => {
    const l = layoutEventStrip(open, "turns")
    const i = stripIndexFor(l, "oa1", "oa1-tool")
    expect(i).toBeGreaterThanOrEqual(0)
    expect(l.events[i]!.lane).toBe("tools")
    expect(l.lanes.tools[l.spans[i]!.start]!.eventIndex).toBe(i)
    expect(stripIndexFor(l, "om1")).toBe(l.events.findIndex((e) => e.messageID === "om1"))
    expect(stripIndexFor(l, "nope")).toBe(-1)
  })

  test("a lane with no events is reported as empty", () => {
    const l = layoutEventStrip(T([user("u1", "hi"), assistant("a1", { text: "no tools here" })]), "turns")
    expect(l.empty).toEqual({ input: false, model: false, tools: true })
    expect(l.lanes.tools.every((c) => c === null)).toBe(true)
  })

  test("a failed tool call keeps the glyph and flags the error", () => {
    const failed = assistant("a1", { tool: { name: "bash", input: { command: "boom" }, output: "nope" } })
    failed.parts = failed.parts.map((p) => (p.type === "tool" ? { ...p, state: { ...p.state, status: "error" } } : p))
    const l = layoutEventStrip(T([user("u1", "go"), failed]), "turns")
    const i = stripIndexFor(l, "a1", "a1-tool")
    expect(l.events[i]!.error).toBe(true)
    expect(l.lanes.tools[l.spans[i]!.start]).toEqual({ lane: "tools", eventIndex: i, glyph: "▬", error: true })
  })

  test("a compaction summary is context on the Input lane, not model output", () => {
    const compacted = { ...open, messages: [{ ...open.messages[1]!, summary: true }, ...open.messages.slice(4)] }
    const l = layoutEventStrip(compacted, "turns")
    expect(l.events[0]).toMatchObject({ lane: "input", kind: "context", turn: 0, messageID: "o-a1" })
    expect(l.events.some((e) => e.messageID === "o-a1" && e.lane === "model")).toBe(false)
    expect(l.events.some((e) => e.messageID === "o-a1" && e.lane === "tools")).toBe(true) // its tool calls stay tool calls
  })
})

describe("the lanes follow the row filter, so there is no 'calls' mode", () => {
  const one = T([user("u1", "hi"), assistant("a1", { text: "ok", think: { text: "hmm" }, tool: { name: "bash", input: { command: "ls" }, output: "out" } })])

  test("tools-only leaves the tool calls and nothing else — the 'what did I run' view", () => {
    const l = layoutEventStrip(one, "turns", "tools-only")
    expect(l.events.map((e) => e.kind)).toEqual(["tool"])
    expect(l.empty).toEqual({ input: true, model: true, tools: false })
  })

  test("no-tools is its mirror; user-only keeps the prompts", () => {
    expect(layoutEventStrip(one, "turns", "no-tools").events.some((e) => e.kind === "tool")).toBe(false)
    expect(layoutEventStrip(one, "turns", "user-only").events.map((e) => e.kind)).toEqual(["user"])
  })

  test("default, labeled and all leave the strip whole — a label is not an event", () => {
    const whole = layoutEventStrip(one, "turns", "all").events.length
    expect(layoutEventStrip(one, "turns", "default").events.length).toBe(whole)
    expect(layoutEventStrip(one, "turns", "labeled").events.length).toBe(whole)
  })

  test("thinking stays on the Model lane in every filter: the strip is a timeline", () => {
    for (const filter of ["default", "no-tools", "labeled", "all"] as const) {
      expect(layoutEventStrip(one, "turns", filter).events.some((e) => e.kind === "reasoning")).toBe(true)
    }
    expect(eventAllowed("tools-only", "reasoning")).toBe(false)
  })

  test("filtering the strip narrows it — the complaint that started this", () => {
    expect(layoutEventStrip(open, "turns", "tools-only").totalWidth).toBeLessThan(layoutEventStrip(open, "turns", "default").totalWidth)
  })
})

/** 20 turns: 40 events; one cell each, 1-cell gaps inside a turn and 3 across a boundary. */
const LONG = T(Array.from({ length: 20 }, (_, i) => [user(`u${i}`, "q"), assistant(`a${i}`, { text: "r" })]).flat())

describe("event layout", () => {
  test("lays out every event on an unbounded axis, with a rule per turn boundary", () => {
    const l = layoutEventStrip(LONG, "turns")
    expect(l.events.length).toBe(40)
    expect(l.totalWidth).toBe(117) // 40 pills + 19 boundaries × 3 + 20 gaps × 1
    expect(l.rules.length).toBe(19)
    expect(l.spans[0]).toEqual({ start: 0, end: 1 })
    expect(l.spans.at(-1)).toEqual({ start: 116, end: 117 })
    expect(l.lanes.input.length).toBe(117)
    expect(l.lanes.input[0]!.eventIndex).toBe(0)
    expect(l.empty).toEqual({ input: false, model: false, tools: true })
  })
  test("duration mode keeps its proportions off-screen instead of squeezing into a width", () => {
    const slow = assistant("a1", { tool: { name: "bash", input: { command: "slow" }, output: "x", ms: 8000 } })
    const fast = assistant("a2", { tool: { name: "bash", input: { command: "fast" }, output: "x", ms: 1000 } })
    const messages = T([user("u1", "go"), slow, fast])
    const l = layoutEventStrip(messages, "duration")
    const width = (i: number) => l.spans[i]!.end - l.spans[i]!.start
    expect(l.totalWidth).toBeGreaterThan(layoutEventStrip(messages, "turns").totalWidth)
    expect(width(1)).toBeGreaterThan(width(2) * 3)
  })
})

describe("window following the cursor", () => {
  const l = layoutEventStrip(LONG, "turns") // 117 cells; at width 20: margin 2, chunk 6, last start 97
  const spanOfEvent = (i: number) => l.spans[i]!
  test("a layout that fits starts at 0", () => {
    expect(windowFor(l, 39, 200, undefined)).toBe(0)
    expect(windowFor(l, 0, 200, 40)).toBe(0)
  })
  test("no previous window opens at the newest events", () => {
    expect(windowFor(l, 39, 20, undefined)).toBe(97)
    expect(windowFor(l, -1, 20, undefined)).toBe(97)
  })
  test("a cursor between the margins does not move the window", () => {
    expect(windowFor(l, 22, 20, 60)).toBe(60) // span 66..67, inside [62, 78)
    expect(windowFor(l, -1, 20, 60)).toBe(60) // a row with no event holds the window still
  })
  test("a far jump clamps: gg lands at 0, G at the last window", () => {
    expect(windowFor(l, 0, 20, 97)).toBe(0)
    expect(windowFor(l, 39, 20, 0)).toBe(97)
    expect(windowFor(l, -1, 20, 999)).toBe(97)
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
  const l = layoutEventStrip(LONG, "turns")
  test("the bright segment sits where the window is", () => {
    const head = overviewTrack(l, 0, 20)
    expect(head.length).toBe(20)
    expect(head[0]).toBe("window")
    expect(head.at(-1)).toBe("track")
    const tail = overviewTrack(l, l.totalWidth - 20, 20)
    expect(tail.at(-1)).toBe("window")
    expect(tail[0]).toBe("track")
    expect(tail.filter((k) => k === "window").length).toBeGreaterThan(0)
  })
  test("a failed call outside the window still shows as a tick", () => {
    const failed = assistant("a0", { tool: { name: "bash", input: { command: "boom" }, output: "nope" } })
    failed.parts = failed.parts.map((p) => (p.type === "tool" ? { ...p, state: { ...p.state, status: "error" } } : p))
    const withError = layoutEventStrip(T([user("u0", "go"), failed, ...LONG.messages]), "turns")
    const track = overviewTrack(withError, withError.totalWidth - 20, 20)
    expect(track[0]).toBe("error")
    expect(track.at(-1)).toBe("window")
  })
})

describe("lane chrome", () => {
  test("the mode line is the same width whichever mode is selected", () => {
    // the strip is sized as "the terminal minus the chrome", so a mode line that changed width
    // with the selection would shift every pill sideways on `1`/`2`
    expect(laneModeLine("turns").length).toBe(laneModeLine("duration").length)
  })

  test("the label column is fixed width, cue or no cue, longest lane name or shortest", () => {
    for (const name of ["Input", "Model", "Tools"]) {
      expect(laneLabel(name).length).toBe(LANE_LABEL_WIDTH)
      expect(laneLabel(name, "…999").length).toBe(LANE_LABEL_WIDTH)
    }
  })

  test("the suffix is fixed width, cue or no cue", () => {
    expect(laneSuffix("", "turns").length).toBe(laneSuffix("999…", "duration").length)
  })

  test("LANE_CHROME is what a lane row actually spends off-strip", () => {
    // measured, never written down: the old reserve was a literal 61 and stayed 61 when the
    // "3 calls" mode went away, so the strip stopped ~10 columns short of the right edge
    expect(LANE_CHROME).toBe(laneLabel("Input", "…999").length + laneSuffix("999…", "turns").length)
  })
})
