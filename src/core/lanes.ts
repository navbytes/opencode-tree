/**
 * DSH-style timeline lanes (DESIGN.md §7.1, §7.3): one column per unit of the
 * chosen mode, three series — Input (context size at each assistant turn), Model
 * (output tokens per assistant step), Tools (result size per tool call, errors
 * flagged). Pure.
 */
import { estimateTokens } from "./tokens.js"
import type { Transcript, TranscriptMessage } from "./transcript.js"

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
