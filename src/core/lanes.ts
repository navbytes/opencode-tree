/**
 * DSH-style timeline lanes (DESIGN.md §7.1, §7.3): three series — Input, Model,
 * Tools — over the chosen mode's x-axis. Two models live here: the original
 * magnitude columns (`buildLanes` + `sparkline`) and the event strip
 * (`buildEventStrip`), which is what the DSH bar actually draws. Pure.
 */
import { estimateTokens } from "./tokens.js"
import { stepKind, type StepPart, type Transcript, type TranscriptMessage } from "./transcript.js"

export type LaneMode = "turns" | "calls" | "duration"

export type LaneColumn = {
  /** identifies what the column represents, for cursor mirroring */
  messageID: string
  /** the column's user message, so the cursor also mirrors ● rows (turns/duration mode) */
  userMessageID?: string
  partID?: string
  turn: number
  input: number
  output: number
  tool: number
  toolError: boolean
  /** wall-clock span of the column, ms (duration mode) */
  ms: number
}

export type Lanes = { mode: LaneMode; columns: LaneColumn[] }

type Turn = { user?: TranscriptMessage; assistants: TranscriptMessage[]; index: number }

function turnsOf(messages: TranscriptMessage[]): Turn[] {
  const out: Turn[] = []
  let index = 0
  for (const m of messages) {
    if (m.role === "user") out.push({ user: m, assistants: [], index: ++index })
    else {
      // after a compaction the transcript opens with an assistant summary: it gets turn 0
      if (out.length === 0) out.push({ assistants: [], index: 0 })
      out[out.length - 1]!.assistants.push(m)
    }
  }
  return out
}

function spanOf(m: TranscriptMessage): number {
  const end = m.time.completed ?? m.parts.reduce((e, p) => Math.max(e, p.state?.time?.end ?? p.time?.end ?? 0), 0)
  return end > m.time.created ? end - m.time.created : 0
}

export function buildLanes(transcript: Transcript, mode: LaneMode): Lanes {
  const columns: LaneColumn[] = []
  for (const turn of turnsOf(transcript.messages)) {
    if (mode === "calls") {
      let any = false
      for (const m of turn.assistants) {
        for (const p of m.parts) {
          if (p.type !== "tool") continue
          any = true
          const out = p.state?.output ?? ""
          const t = p.state?.time
          columns.push({ messageID: m.id, userMessageID: turn.user?.id, partID: p.id, turn: turn.index, input: m.tokens?.input ?? 0, output: 0, tool: estimateTokens(out), toolError: p.state?.status === "error", ms: t?.start !== undefined && t?.end !== undefined ? t.end - t.start : 0 })
        }
      }
      if (!any) {
        const last = turn.assistants.at(-1)
        columns.push({ messageID: last?.id ?? turn.user?.id ?? "", userMessageID: turn.user?.id, turn: turn.index, input: last?.tokens?.input ?? 0, output: last?.tokens?.output ?? 0, tool: 0, toolError: false, ms: last ? spanOf(last) : 0 })
      }
      continue
    }
    // turns / duration: one column per user turn
    const last = turn.assistants.at(-1)
    let tool = 0
    let toolError = false
    let ms = 0
    let output = 0
    for (const m of turn.assistants) {
      output += m.tokens?.output ?? 0
      ms += spanOf(m)
      for (const p of m.parts) {
        if (p.type !== "tool") continue
        tool += estimateTokens(p.state?.output ?? "")
        if (p.state?.status === "error") toolError = true
      }
    }
    columns.push({ messageID: last?.id ?? turn.user?.id ?? "", userMessageID: turn.user?.id, turn: turn.index, input: last?.tokens?.input ?? 0, output, tool, toolError, ms })
  }
  return { mode, columns }
}

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

/** `scale` (the model's context limit for the Input lane) fixes the reference height, so a
 *  two-message session no longer draws a full bar next to `ctx 100 · low`. */
export function sparkline(values: number[], width: number, scale?: number): string {
  if (values.length === 0 || width <= 0) return ""
  const cells = fitColumns(values, width)
  const max = Math.max(1, scale ?? 0, ...cells)
  return cells.map((v) => (v <= 0 ? " " : BLOCKS[Math.min(7, Math.floor((v / max) * 7.999))]!)).join("")
}

/** Resample `values` to exactly `width` cells (max-pooling when shrinking, repeating when growing). */
export function fitColumns(values: number[], width: number): number[] {
  if (values.length === 0) return []
  if (values.length === width) return values.slice()
  const out: number[] = []
  if (values.length > width) {
    const per = values.length / width
    for (let i = 0; i < width; i++) {
      const a = Math.floor(i * per)
      const b = Math.max(a + 1, Math.floor((i + 1) * per))
      out.push(Math.max(...values.slice(a, b)))
    }
    return out
  }
  const rep = width / values.length
  for (let i = 0; i < width; i++) out.push(values[Math.min(values.length - 1, Math.floor(i / rep))]!)
  return out
}

/** Duration mode: repeat each column proportionally to its wall-clock share. */
export function durationWeighted(lanes: Lanes, width: number): { input: number[]; output: number[]; tool: number[]; toolError: boolean[]; columnAt: (cell: number) => number } {
  const total = lanes.columns.reduce((s, c) => s + Math.max(1, c.ms), 0) || 1
  const input: number[] = []
  const output: number[] = []
  const tool: number[] = []
  const toolError: boolean[] = []
  const owner: number[] = []
  lanes.columns.forEach((c, i) => {
    const cells = Math.max(1, Math.round((Math.max(1, c.ms) / total) * width))
    for (let k = 0; k < cells; k++) {
      input.push(c.input)
      output.push(c.output)
      tool.push(c.tool)
      toolError.push(c.toolError)
      owner.push(i)
    }
  })
  return { input, output, tool, toolError, columnAt: (cell) => owner[Math.min(owner.length - 1, Math.max(0, cell))] ?? 0 }
}

/** Index of the column that contains a given message/part (for the cursor marker). */
export function columnFor(lanes: Lanes, messageID: string, partID?: string): number {
  if (partID) {
    const i = lanes.columns.findIndex((c) => c.partID === partID)
    if (i >= 0) return i
  }
  const i = lanes.columns.findIndex((c) => c.messageID === messageID || c.userMessageID === messageID)
  return i >= 0 ? i : -1
}

/* ── Event strip (DESIGN.md §7.1's DSH trajectory bar) ────────────────────────
 * The strip is an *event* timeline, not a histogram: one small pill per event on
 * one shared axis across the three lanes, gap between neighbours, width = duration
 * in Duration mode. Colour is categorical (per lane), so nothing here scales by
 * tokens — `tokens` rides along only for the inspector.
 */

export type LaneEvent = {
  lane: "input" | "model" | "tools"
  /** `context` = compaction/branch summary: machine-written context, not the human prompting */
  kind: "user" | "context" | "text" | "reasoning" | "tool"
  messageID: string
  partID?: string
  turn: number
  startMs?: number
  durationMs?: number
  error?: boolean
  tokens: number
}

/** One terminal cell of one lane. */
export type StripCell = { lane: LaneEvent["lane"]; eventIndex: number; glyph: string; error?: boolean }

export type EventStrip = {
  /** time order; only the events that fit — see `truncatedLeft` */
  events: LaneEvent[]
  width: number
  /** `width` cells each; null = gap/empty */
  lanes: Record<LaneEvent["lane"], (StripCell | null)[]>
  /** cell index range [start, end) of `events[i]`, for cursor/scroll mapping */
  spans: { start: number; end: number }[]
  /** lane has no events in the strip (render "no tool calls" etc.) */
  empty: Record<LaneEvent["lane"], boolean>
  /** older events dropped off the left because they did not fit */
  truncatedLeft: number
}

const EVENT_GLYPH = "▬"

function ctreeKindOf(message: TranscriptMessage): string | undefined {
  for (const p of message.parts) {
    const ctree = p.metadata?.["ctree"] as { kind?: string } | undefined
    if (ctree?.kind) return ctree.kind
  }
  return undefined
}

function isContextMessage(message: TranscriptMessage): boolean {
  return message.summary === true || ctreeKindOf(message) === "summary"
}

/** A whole message as one pill: user prompts and summaries read as single events. */
function messageEvent(message: TranscriptMessage, turn: number): LaneEvent {
  const ms = spanOf(message)
  return {
    lane: "input",
    kind: isContextMessage(message) ? "context" : "user",
    messageID: message.id,
    turn,
    startMs: message.time.created,
    ...(ms > 0 ? { durationMs: ms } : {}),
    tokens: message.parts.reduce((s, p) => s + estimateTokens(p.text ?? ""), 0),
  }
}

function partEvent(message: TranscriptMessage, part: StepPart, turn: number): LaneEvent {
  const t = part.state?.time ?? part.time
  const base = {
    messageID: message.id,
    partID: part.id,
    turn,
    startMs: t?.start ?? message.time.created,
    ...(t?.start !== undefined && t?.end !== undefined ? { durationMs: Math.max(0, t.end - t.start) } : {}),
  }
  if (part.type === "tool")
    return { ...base, lane: "tools", kind: "tool", error: part.state?.status === "error", tokens: estimateTokens(part.state?.output ?? "") + estimateTokens(JSON.stringify(part.state?.input ?? "")) }
  return { ...base, lane: "model", kind: part.type === "reasoning" ? "reasoning" : "text", tokens: estimateTokens(part.text ?? "") }
}

function eventsOf(transcript: Transcript): LaneEvent[] {
  const out: LaneEvent[] = []
  for (const turn of turnsOf(transcript.messages)) {
    if (turn.user) out.push(messageEvent(turn.user, turn.index))
    for (const m of turn.assistants) {
      const context = isContextMessage(m)
      if (context) out.push(messageEvent(m, turn.index))
      for (const p of m.parts) {
        const kind = stepKind(p)
        // a summary's prose is already the context pill above; a tool call it made is still a tool call
        if (kind === "other" || (context && kind !== "tool")) continue
        out.push(partEvent(m, p, turn.index))
      }
    }
  }
  return out
}

/** Turns mode groups by turn, so a turn boundary breaks wider than a step boundary. */
function gapBefore(events: LaneEvent[], i: number, mode: LaneMode): number {
  return mode === "turns" && events[i]!.turn !== events[i - 1]!.turn ? 2 : 1
}

function durationWidths(events: LaneEvent[], budget: number): number[] {
  const total = events.reduce((s, e) => s + Math.max(0, e.durationMs ?? 0), 0)
  if (total <= 0) return events.map(() => 1) // no timing data: read as the calls layout
  const widths = events.map((e) => Math.max(1, Math.round((Math.max(0, e.durationMs ?? 0) / total) * budget)))
  let over = widths.reduce((s, v) => s + v, 0) - budget
  while (over > 0) {
    let widest = -1
    for (let i = 0; i < widths.length; i++) if ((widths[i] ?? 0) > 1 && (widest < 0 || (widths[i] ?? 0) > (widths[widest] ?? 0))) widest = i
    if (widest < 0) break // every event is already down to its one cell
    widths[widest] = (widths[widest] ?? 1) - 1
    over--
  }
  return widths
}

/** Duration mode has no width to divide, so the axis gets a fixed density: enough cells per event
 *  that a call an order of magnitude longer than its neighbours still draws that much wider. */
const DURATION_CELLS = 4

export type EventLayout = {
  /** every event of the transcript, in time order */
  events: LaneEvent[]
  /** cell range [start, end) of `events[i]` on the unbounded axis */
  spans: { start: number; end: number }[]
  totalWidth: number
  /** `totalWidth` cells each; null = gap/empty */
  lanes: Record<LaneEvent["lane"], (StripCell | null)[]>
  empty: Record<LaneEvent["lane"], boolean>
}

/** The whole timeline on one axis, however wide it comes out — `windowFor` picks the slice to draw. */
export function layoutEventStrip(transcript: Transcript, mode: LaneMode): EventLayout {
  const events = eventsOf(transcript)
  const widths = mode === "duration" ? durationWidths(events, events.length * DURATION_CELLS) : events.map(() => 1)
  const spans: { start: number; end: number }[] = []
  let cursor = 0
  events.forEach((_, i) => {
    const start = cursor + (i === 0 ? 0 : gapBefore(events, i, mode))
    cursor = start + (widths[i] ?? 1)
    spans.push({ start, end: cursor })
  })
  const blank = (): (StripCell | null)[] => Array.from({ length: cursor }, () => null)
  const lanes: EventLayout["lanes"] = { input: blank(), model: blank(), tools: blank() }
  events.forEach((e, i) => {
    const cell: StripCell = { lane: e.lane, eventIndex: i, glyph: EVENT_GLYPH, ...(e.error ? { error: true } : {}) }
    for (let c = spans[i]!.start; c < spans[i]!.end; c++) lanes[e.lane][c] = cell
  })
  const has = (lane: LaneEvent["lane"]) => !events.some((e) => e.lane === lane)
  return { events, spans, totalWidth: cursor, lanes, empty: { input: has("input"), model: has("model"), tools: has("tools") } }
}

/** The layout windowed at its end: the newest events, as many as `width` holds. */
export function buildEventStrip(transcript: Transcript, mode: LaneMode, width: number): EventStrip {
  const w = Math.max(0, Math.floor(width))
  const layout = layoutEventStrip(transcript, mode)
  const start = Math.max(0, layout.totalWidth - w)
  const truncatedLeft = layout.spans.filter((s) => s.end <= start).length
  const lane = (l: LaneEvent["lane"]): (StripCell | null)[] =>
    Array.from({ length: w }, (_, c) => {
      const cell = layout.lanes[l][start + c]
      return cell ? { ...cell, eventIndex: cell.eventIndex - truncatedLeft } : null
    })
  const lanes: EventStrip["lanes"] = { input: lane("input"), model: lane("model"), tools: lane("tools") }
  return {
    events: layout.events.slice(truncatedLeft),
    width: w,
    lanes,
    spans: layout.spans.slice(truncatedLeft).map((s) => ({ start: Math.max(0, s.start - start), end: Math.min(w, s.end - start) })),
    empty: { input: lanes.input.every((c) => c === null), model: lanes.model.every((c) => c === null), tools: lanes.tools.every((c) => c === null) },
    truncatedLeft,
  }
}

/**
 * Start cell of the `width`-wide window to draw, so the cursor's event stays on the strip:
 * keep `prevStart` while the event sits between the margins, otherwise step towards it in
 * chunks (a far jump lands it a third of a window in from the edge it came from).
 */
export function windowFor(layout: EventLayout, cursorEventIndex: number, width: number, prevStart: number | undefined): number {
  const w = Math.max(1, Math.floor(width))
  const max = layout.totalWidth - w
  if (max <= 0) return 0
  if (prevStart === undefined) return max // a fresh open reads the newest events, like a log tail
  const start = Math.max(0, Math.min(max, Math.round(prevStart)))
  const span = layout.spans[cursorEventIndex]
  if (!span) return start
  const margin = Math.max(2, Math.floor(w / 8))
  const lo = start + margin
  const hi = start + w - margin
  // second case: an event wider than the window itself is "inside" while it covers the margins
  if ((span.start >= lo && span.end <= hi) || (span.start <= lo && span.end >= hi)) return start
  const chunk = Math.max(1, Math.floor(w / 3))
  const steps = (d: number) => Math.ceil(d / chunk) * chunk
  const next = span.start < lo ? start - steps(lo - span.start) : start + steps(span.end - hi)
  return Math.max(0, Math.min(max, next))
}

/** Minimap of the whole axis, `width` cells: where the drawn window and the failed calls are. */
export function overviewTrack(layout: EventLayout, start: number, width: number): ("track" | "window" | "error")[] {
  const w = Math.max(0, Math.floor(width))
  if (w === 0) return []
  const total = Math.max(1, layout.totalWidth)
  const at = (cell: number) => Math.max(0, Math.min(w - 1, Math.floor((cell / total) * w)))
  const out: ("track" | "window" | "error")[] = Array.from({ length: w }, () => "track")
  for (let i = at(start); i <= at(start + w - 1); i++) out[i] = "window"
  layout.events.forEach((e, i) => {
    if (e.error) out[at(layout.spans[i]!.start)] = "error"
  })
  return out
}

/** Index into `events` of the event a message/part belongs to (-1 if it has none). */
export function stripIndexFor(strip: { events: LaneEvent[] }, messageID: string, partID?: string): number {
  if (partID) {
    const byPart = strip.events.findIndex((e) => e.partID === partID)
    if (byPart >= 0) return byPart
  }
  return strip.events.findIndex((e) => e.messageID === messageID)
}
