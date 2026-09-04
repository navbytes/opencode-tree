/**
 * "What is filling the window" (DESIGN.md §7.4): tokens by source over the
 * current session's context. Pure.
 */
import { estimateTokens } from "./tokens.js"
import { partPreview, type StepPart, type Transcript, type TranscriptMessage } from "./transcript.js"

/** One part inside a bucket, so the route can drill in and crop it in place. */
export type ConsumerEntry = {
  messageID: string
  partID?: string
  tokens: number
  preview: string
  /** only a completed tool result can be stubbed by crop's result mode (core/crop.ts) */
  croppable: boolean
  /** system entries only: which captured part this is. Names are a heuristic and two parts can
   *  share one (a global and a project `AGENTS.md`), so `y` must not find its text by name. */
  systemIndex?: number
}

export type Consumer = {
  source: string
  kind: "tool" | "assistant" | "user" | "decision" | "summary" | "reasoning" | "system"
  tokens: number
  count: number
  /** share of this transcript's own total */
  share: number
  /** share of the model's context window, when a limit is known */
  shareOfWindow?: number
  /** biggest first */
  entries: ConsumerEntry[]
  /** why this bucket cannot be acted on, when it cannot */
  note?: string
}

const THINKING = "(thinking)"
const THINKING_NOTE = "provider reasoning · not croppable"
const SYSTEM = "≡ system prompt"
const SYSTEM_NOTE = "sent whole every request · not croppable (y copies a part)"

export function consumers(
  transcript: Transcript,
  opts: {
    cropped?: Set<string>
    limit?: number
    /**
     * The system parts the provider is really sent, captured by the server half. Without it
     * this view silently omits them, and its total cannot be reconciled with the `ctx …` gauge
     * — which reads `tokens.input` and so *does* include them (DESIGN.md §7.4).
     */
    system?: { name: string; text: string }[]
  } = {},
): Consumer[] {
  const acc = new Map<string, Consumer>()
  const add = (source: string, kind: Consumer["kind"], tokens: number, message: TranscriptMessage, part: StepPart) => {
    const c = acc.get(source) ?? { source, kind, tokens: 0, count: 0, share: 0, entries: [] }
    c.tokens += tokens
    c.count += 1
    c.entries.push({
      messageID: message.id,
      partID: part.id,
      tokens,
      preview: partPreview(part),
      croppable: part.type === "tool" && part.state?.status === "completed",
    })
    acc.set(source, c)
  }
  for (const m of transcript.messages) {
    for (const p of m.parts) {
      if (opts.cropped?.has(p.id)) continue
      if (p.type === "tool") add(p.tool ?? "tool", "tool", estimateTokens(p.state?.output ?? "") + estimateTokens(JSON.stringify(p.state?.input ?? "")), m, p)
      else if (p.type === "text") {
        const kind = (p.metadata?.["ctree"] as { kind?: string } | undefined)?.kind
        if (kind === "decision") add("◆ decisions", "decision", estimateTokens(p.text ?? ""), m, p)
        else if (kind === "summary") add("◇ branch summaries", "summary", estimateTokens(p.text ?? ""), m, p)
        else if (m.role === "user") add("● user prompts", "user", estimateTokens(p.text ?? ""), m, p)
        else if (m.summary) add("◇ compaction summaries", "summary", estimateTokens(p.text ?? ""), m, p)
        else add("○ assistant text", "assistant", estimateTokens(p.text ?? ""), m, p)
      } else if (p.type === "reasoning") add(THINKING, "reasoning", estimateTokens(p.text ?? ""), m, p)
    }
  }
  // one bucket, one entry per part, so "AGENTS.md is 4k" is visible next to "bash is 30k"
  for (const [i, part] of (opts.system ?? []).entries()) {
    const c = acc.get(SYSTEM) ?? { source: SYSTEM, kind: "system" as const, tokens: 0, count: 0, share: 0, entries: [] }
    const tokens = estimateTokens(part.text)
    c.tokens += tokens
    c.count += 1
    c.entries.push({ messageID: "", tokens, preview: `${part.name}: ${part.text.slice(0, 120).replace(/\s+/g, " ").trim()}`, croppable: false, systemIndex: i })
    acc.set(SYSTEM, c)
  }

  const total = [...acc.values()].reduce((s, c) => s + c.tokens, 0) || 1
  const limit = opts.limit !== undefined && opts.limit > 0 ? opts.limit : undefined
  return [...acc.values()]
    .map((c) => ({
      ...c,
      share: c.tokens / total,
      ...(limit === undefined ? {} : { shareOfWindow: c.tokens / limit }),
      ...(c.kind === "reasoning" ? { note: THINKING_NOTE } : c.kind === "system" ? { note: SYSTEM_NOTE } : {}),
      entries: c.entries.sort((a, b) => b.tokens - a.tokens),
    }))
    .sort((a, b) => b.tokens - a.tokens)
}

export function bar(share: number, width: number): string {
  const n = Math.round(share * width)
  return "▰".repeat(n) + "▱".repeat(Math.max(0, width - n))
}
