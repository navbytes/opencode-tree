/**
 * Minimal structural transcript types the TUI/server fill from OpenCode's own
 * `Message`/`Part` shapes (DESIGN.md §7), plus pure preview helpers used by
 * `core/tree.ts`.
 *
 * Pure, no OpenCode/opentui/solid-js imports — see test/core-purity.test.ts.
 */

export type StepPart = {
  id: string
  type: string
  text?: string
  tool?: string
  callID?: string
  state?: {
    status?: string
    input?: unknown
    output?: string
    title?: string
    time?: { start?: number; end?: number }
  }
  time?: { start?: number; end?: number }
  metadata?: Record<string, unknown>
}

export type TranscriptMessage = {
  id: string
  role: "user" | "assistant"
  time: { created: number; completed?: number }
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  /** OpenCode-native compaction summary marker (not the ctree "jump summary", which is a
   *  regular user message tagged via `metadata.ctree.kind === "summary"` instead). */
  summary?: boolean
  parts: StepPart[]
}

export type Transcript = {
  sessionID: string
  title: string
  status: "available" | "deleted"
  messages: TranscriptMessage[]
}

/** Part "kind" for filtering/glyph purposes. Anything not text/tool/reasoning (e.g.
 *  step-start, step-finish, snapshot, patch, retry) is "other". */
export function stepKind(part: StepPart): "text" | "tool" | "reasoning" | "other" {
  if (part.type === "text") return "text"
  if (part.type === "tool") return "tool"
  if (part.type === "reasoning") return "reasoning"
  return "other"
}

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  if (max <= 1) return text.slice(0, max)
  return `${text.slice(0, max - 1)}…`
}

function firstLine(text: string): string {
  const idx = text.indexOf("\n")
  return idx === -1 ? text : text.slice(0, idx)
}

/** Best-effort "primary argument" of a tool call, mirroring core/crop.ts's `shortArg`. */
function primaryArgOf(input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const record = input as Record<string, unknown>
  const candidate = record["command"] ?? record["filePath"] ?? record["path"] ?? record["pattern"] ?? record["url"]
  return typeof candidate === "string" ? candidate : ""
}

/**
 * One-line preview of a single part (DESIGN.md §7.2's row `preview` column):
 * - tool: `<tool> <primary-arg → 40 chars>  → <first line of output, 30 chars>`
 * - text: first 60 chars, newlines flattened
 * - reasoning: literal `(thinking)`
 * - other (step-start/finish/snapshot/patch/retry, …): title or type, first 60 chars
 */
export function partPreview(part: StepPart): string {
  const kind = stepKind(part)
  if (kind === "tool") {
    const tool = part.tool ?? "tool"
    const arg = truncate(flatten(primaryArgOf(part.state?.input)), 40)
    const output = truncate(flatten(firstLine(part.state?.output ?? "")), 30)
    return arg ? `${tool} ${arg}  → ${output}` : `${tool}  → ${output}`
  }
  if (kind === "reasoning") return "(thinking)"
  if (kind === "text") return truncate(flatten(part.text ?? ""), 60)
  return truncate(flatten(part.state?.title ?? part.type), 60)
}

/**
 * One-line preview of a whole message (DESIGN.md §7.2's `T<n> ● user <preview>`):
 * the first text part if there is one, else a `[tool a, b]` summary of the tool
 * calls it made. Single line, ≤ 60 chars, newlines flattened.
 */
export function messagePreview(message: TranscriptMessage): string {
  const textPart = message.parts.find((p) => p.type === "text" && p.text)
  if (textPart) return truncate(flatten(textPart.text ?? ""), 60)

  const tools: string[] = []
  for (const part of message.parts) {
    if (part.type !== "tool") continue
    const name = part.tool ?? "tool"
    if (!tools.includes(name)) tools.push(name)
  }
  if (tools.length > 0) return truncate(`[tool ${tools.join(", ")}]`, 60)

  return ""
}
