/**
 * "What is filling the window" (DESIGN.md §7.4): tokens by source over the
 * current session's context. Pure.
 */
import { estimateTokens } from "./tokens.js"
import type { Transcript } from "./transcript.js"

export type Consumer = { source: string; kind: "tool" | "assistant" | "user" | "decision" | "summary" | "reasoning"; tokens: number; count: number; share: number }

export function consumers(transcript: Transcript, opts: { cropped?: Set<string> } = {}): Consumer[] {
  const acc = new Map<string, Consumer>()
  const add = (source: string, kind: Consumer["kind"], tokens: number) => {
    const c = acc.get(source) ?? { source, kind, tokens: 0, count: 0, share: 0 }
    c.tokens += tokens
    c.count += 1
    acc.set(source, c)
  }
  for (const m of transcript.messages) {
    for (const p of m.parts) {
      if (opts.cropped?.has(p.id)) continue
      if (p.type === "tool") add(p.tool ?? "tool", "tool", estimateTokens(p.state?.output ?? "") + estimateTokens(JSON.stringify(p.state?.input ?? "")))
      else if (p.type === "text") {
        const kind = (p.metadata?.["ctree"] as { kind?: string } | undefined)?.kind
        if (kind === "decision") add("◆ decisions", "decision", estimateTokens(p.text ?? ""))
        else if (kind === "summary") add("◇ branch summaries", "summary", estimateTokens(p.text ?? ""))
        else if (m.role === "user") add("● user prompts", "user", estimateTokens(p.text ?? ""))
        else if (m.summary) add("◇ compaction summaries", "summary", estimateTokens(p.text ?? ""))
        else add("○ assistant text", "assistant", estimateTokens(p.text ?? ""))
      } else if (p.type === "reasoning") add("(thinking)", "reasoning", estimateTokens(p.text ?? ""))
    }
  }
  const total = [...acc.values()].reduce((s, c) => s + c.tokens, 0) || 1
  return [...acc.values()].map((c) => ({ ...c, share: c.tokens / total })).sort((a, b) => b.tokens - a.tokens)
}

export function bar(share: number, width: number): string {
  const n = Math.round(share * width)
  return "▰".repeat(n) + "▱".repeat(Math.max(0, width - n))
}
