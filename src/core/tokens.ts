/**
 * Token estimation and context-size bands (DESIGN.md §3.3, §6.7).
 *
 * Pure, no OpenCode/opentui imports — see test/core-purity.test.ts.
 */

/** chars/4 heuristic used throughout the design for anything not yet costed by the model. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

export type MinimalPart = {
  type: string
  text?: string
  tool?: string
  state?: {
    status?: string
    input?: unknown
    output?: string
    title?: string
  }
}

export type MinimalAssistantInfo = {
  role: "assistant"
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
}

export type MinimalMessageInfo = MinimalAssistantInfo | { role: "user" | "system" }

export type MinimalMessage = {
  info: MinimalMessageInfo
  parts: MinimalPart[]
}

/** Rough text content of a part, for chars/4 estimation of anything newer than the last assistant turn. */
function partText(part: MinimalPart): string {
  if (part.type === "text" || part.type === "reasoning") return part.text ?? ""
  if (part.type === "tool") {
    const input = part.state?.input !== undefined ? JSON.stringify(part.state.input) : ""
    const output = typeof part.state?.output === "string" ? part.state.output : ""
    return `${part.tool ?? ""} ${input} ${output}`
  }
  return ""
}

/**
 * Context size of a session's message list: the last assistant turn's whole prompt —
 * `tokens.input` *plus* `cache.read`/`cache.write`, since a cache hit is context the model
 * still held, only cheaper (same sum as OpenCode's own sidebar gauge) — plus what the next
 * request adds on top of it: that turn's own output/reasoning when the provider counted them,
 * and a chars/4 estimate of everything else, tool results included (DESIGN.md §3.3 / §6.7).
 * Returns `{ tokens, estimated }`; `estimated` is true whenever any part of the figure is a
 * chars/4 guess.
 */
export function contextSizeOf(messages: MinimalMessage[]): { tokens: number; estimated: boolean } {
  let lastAssistantIndex = -1
  let lastAssistantPrompt = 0
  for (let i = 0; i < messages.length; i++) {
    const info = messages[i]!.info
    if (info.role === "assistant" && typeof info.tokens?.input === "number") {
      lastAssistantIndex = i
      lastAssistantPrompt = info.tokens.input + (info.tokens.cache?.read ?? 0) + (info.tokens.cache?.write ?? 0)
    }
  }

  if (lastAssistantIndex === -1) {
    // No costed assistant turn yet: everything is an estimate.
    let estimated = 0
    for (const message of messages) {
      for (const part of message.parts) estimated += estimateTokens(partText(part))
    }
    return { tokens: estimated, estimated: true }
  }

  // starts AT the last assistant: its prompt is the context it was *given*, so its own
  // output and tool results are only in the context from the next request on.
  let counted = 0
  let guessed = 0
  for (let i = lastAssistantIndex; i < messages.length; i++) {
    const message = messages[i]!
    const tokens = message.info.role === "assistant" ? message.info.tokens : undefined
    // `tokens.output` covers what the model generated, never the tool results it read back
    const output = tokens?.output
    if (typeof output === "number") counted += output + (tokens?.reasoning ?? 0)
    for (const part of message.parts) if (part.type === "tool" || typeof output !== "number") guessed += estimateTokens(partText(part))
  }

  return { tokens: lastAssistantPrompt + counted + guessed, estimated: guessed > 0 }
}

export type ContextBand = "low" | "healthy" | "filling" | "red"

/** Bands relative to the model's window when it is known (<25% low · <60% healthy · <85%
 *  filling · else red); DESIGN.md §6.7's absolute 8k/32k/64k bands only as the fallback,
 *  since 30k is "healthy" on a 200k model and one prompt from compaction on a 32k one. */
export function bandFor(tokens: number, limit?: number): ContextBand {
  if (limit && limit > 0) {
    const r = tokens / limit
    if (r < 0.25) return "low"
    if (r < 0.6) return "healthy"
    if (r < 0.85) return "filling"
    return "red"
  }
  if (tokens < 8_000) return "low"
  if (tokens < 32_000) return "healthy"
  if (tokens < 64_000) return "filling"
  return "red"
}

/** `▓▓▓░░`: `cells` wide, filled by tokens/limit, always at least one cell once anything is used. */
export function contextBar(tokens: number, limit: number, cells = 5): string {
  if (!(limit > 0)) return ""
  const filled = tokens <= 0 ? 0 : Math.min(cells, Math.max(1, Math.round((tokens / limit) * cells)))
  return "▓".repeat(filled) + "░".repeat(cells - filled)
}

/** `12345` → `12.3k`, `800` → `800`. */
export function formatK(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const k = (tokens / 1000).toFixed(1)
  return `${k.endsWith(".0") ? k.slice(0, -2) : k}k`
}

/** The one context string every surface shows: `ctx ▓▓░░░ ~2.3k/32.8k · low` (`~` when
 *  estimated; the bar and the `/limit` only when the model's window is known). */
export function formatContext(size: { tokens: number; estimated: boolean }, limit?: number): string {
  const bar = limit ? `${contextBar(size.tokens, limit)} ` : ""
  return `ctx ${bar}${size.estimated ? "~" : ""}${formatK(size.tokens)}${limit ? `/${formatK(limit)}` : ""} · ${bandFor(size.tokens, limit)}`
}
