/**
 * Timeline lanes (DESIGN.md §7.1, §7.3): three series — Input, Model, Tools — of one pill
 * per event on one shared axis, with turn boundaries drawn as a rule across all three.
 *
 * Two things pick what you see, and they are deliberately different questions:
 * `LaneMode` is only the **x-scale** (uniform per event, or proportional to wall clock),
 * and the route's row `Filter` is **which events** — so "tool calls only" is the same
 * `tools-only` filter that thins the rows, never a third mode that redraws the same
 * events a cell wider. Pure.
 */
import { estimateTokens } from "./tokens.js"
import { stepKind, type StepPart, type Transcript, type TranscriptMessage } from "./transcript.js"
import type { Filter } from "./tree.js"

export type LaneMode = "turns" | "duration"

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

/* ── Event strip (DESIGN.md §7.1's DSH trajectory bar) ────────────────────────
 * The strip is an *event* timeline, not a histogram: one small pill per event on
 * one shared axis across the three lanes, gap between neighbours, width = duration
 * in Duration mode. Colour is categorical (per lane), so nothing here scales by
 * tokens — `tokens` rides along only for the inspector.
 */

/**
 * Chrome around the strip on a lane row: the fixed-width label on the left and the mode line
 * on the right. Both are fixed width *by construction* — `laneCue` caps at three digits, and
 * each mode label is the same length selected or not — so the strip can be sized as
 * "everything else" without measuring per frame.
 *
 * They live here, and `LANE_CHROME` is derived from them rather than written down, because the
 * width was a literal `61` that stayed `61` when dropping the "3 calls" mode shortened the
 * mode line: the strip quietly gave up ~10 columns and stopped short of the right edge.
 */
export const laneLabel = (name: string, cue = "") => `│ ${name} ${cue}`.padEnd(LANE_LABEL_WIDTH)
export const LANE_LABEL_WIDTH = 12

export function laneModeLine(mode: LaneMode): string {
  return `${mode === "duration" ? "[1] Duration" : " 1  duration"} · ${mode === "turns" ? "[2] Turns" : " 2  turns"} · 0 off`
}

export function laneSuffix(cue: string, mode: LaneMode): string {
  return `${cue.padStart(4).padEnd(5)}${laneModeLine(mode)}`
}

/** Columns a lane row spends on anything that is not the strip. */
export const LANE_CHROME = LANE_LABEL_WIDTH + laneSuffix("", "turns").length

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
  /** `providerID/modelID` of the assistant message this event belongs to (model-lane events only). */
  model?: string
}

/** One terminal cell of one lane. */
export type StripCell = { lane: LaneEvent["lane"]; eventIndex: number; glyph: string; error?: boolean }

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
  const model = message.model ? `${message.model.providerID}/${message.model.modelID}` : undefined
  return { ...base, lane: "model", kind: part.type === "reasoning" ? "reasoning" : "text", tokens: estimateTokens(part.text ?? ""), model }
}

/**
 * Which events a row filter leaves on the strip, so the lanes and the rows always answer the
 * same question (DESIGN.md §7.3): `tools-only` is the "what did I run" view in both, and
 * there is no lane mode that does it separately.
 *
 * Two deliberate mismatches with `stepAllowed`: `labeled` is an annotation on a row, not a
 * property of an event, so the lanes read it as no filter at all; and reasoning stays on the
 * Model lane in every filter, because folding it into its assistant row is a *reading*
 * convenience and the strip is a timeline — a minute of thinking is a thing that happened.
 */
export function eventAllowed(filter: Filter, kind: LaneEvent["kind"]): boolean {
  switch (filter) {
    case "user-only":
      return kind === "user" || kind === "context"
    case "tools-only":
      return kind === "tool"
    case "no-tools":
      return kind !== "tool"
    case "default":
    case "labeled":
    case "all":
      return true
  }
}

function eventsOf(transcript: Transcript, filter: Filter): LaneEvent[] {
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
  return out.filter((e) => eventAllowed(filter, e.kind))
}

/** A turn boundary is drawn, not implied: DSH's Overview marks turns with a rule rather than
 *  offering a "turns" layout, so the gap widens to hold one and both modes get it. */
const TURN_RULE_GAP = 3

function isTurnBoundary(events: LaneEvent[], i: number): boolean {
  return i > 0 && events[i]!.turn !== events[i - 1]!.turn
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
  /** every event the filter left, in time order */
  events: LaneEvent[]
  /** cell range [start, end) of `events[i]` on the unbounded axis */
  spans: { start: number; end: number }[]
  totalWidth: number
  /** `totalWidth` cells each; null = gap/empty */
  lanes: Record<LaneEvent["lane"], (StripCell | null)[]>
  empty: Record<LaneEvent["lane"], boolean>
  /** cells carrying a turn rule, drawn across every lane */
  rules: number[]
  /** subset of `rules` where the Model lane's answering model differs from the previous turn
   *  that had one — the strip's only cue that a switch happened (DESIGN.md §7.1 keeps colour
   *  categorical by lane, not per-model, so this rides the existing turn-rule machinery). */
  modelChanges: number[]
}

/**
 * The whole timeline on one axis, however wide it comes out — `windowFor` picks the slice to
 * draw. `mode` sets only the x-scale: one cell per event, or cells proportional to wall clock.
 * `filter` decides which events are on it at all.
 */
export function layoutEventStrip(transcript: Transcript, mode: LaneMode, filter: Filter = "all"): EventLayout {
  const events = eventsOf(transcript, filter)
  const widths = mode === "duration" ? durationWidths(events, events.length * DURATION_CELLS) : events.map(() => 1)
  // one representative model per turn (its first Model-lane event that has one), so a turn with
  // no text/reasoning (tool-only, or a filter that hid it) carries no opinion either way
  const turnModel = new Map<number, string>()
  for (const e of events) if (e.lane === "model" && e.model && !turnModel.has(e.turn)) turnModel.set(e.turn, e.model)
  let lastModel = turnModel.get(events[0]?.turn ?? -1)
  const spans: { start: number; end: number }[] = []
  const rules: number[] = []
  const modelChanges: number[] = []
  let cursor = 0
  events.forEach((_, i) => {
    const boundary = isTurnBoundary(events, i)
    if (boundary) {
      const cell = cursor + 1
      rules.push(cell) // centred in the wider gap it opens
      const model = turnModel.get(events[i]!.turn)
      if (model && lastModel && model !== lastModel) modelChanges.push(cell)
      if (model) lastModel = model
    }
    const start = cursor + (i === 0 ? 0 : boundary ? TURN_RULE_GAP : 1)
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
  return { events, spans, totalWidth: cursor, lanes, empty: { input: has("input"), model: has("model"), tools: has("tools") }, rules, modelChanges }
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
