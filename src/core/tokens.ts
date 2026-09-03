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

export type ContextSize = {
  tokens: number
  estimated: boolean
  /** The selected turn's `cache.read` once *any* assistant message has ever reported cache
   *  tokens this session; undefined on a provider that never caches, so consumers can hide
   *  the figure instead of showing a permanent, meaningless `0% cached`. */
  cached?: number
  /** The selected turn's whole prompt (`input + cache.read + cache.write`); paired with
   *  `cached` for `cacheShare`, so it is undefined exactly when `cached` is. */
  prompt?: number
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
export function contextSizeOf(messages: MinimalMessage[]): ContextSize {
  let lastAssistantIndex = -1
  let lastAssistantPrompt = 0
  let lastAssistantCached = 0
  let sawCache = false
  // snapshotted only when the selected turn advances, so a later, still-in-flight reply's
  // cache stats can never cache-tag an earlier turn that was genuinely uncached
  let sawCacheAtSelected = false
  for (let i = 0; i < messages.length; i++) {
    const info = messages[i]!.info
    if (info.role === "assistant" && ((info.tokens?.cache?.read ?? 0) > 0 || (info.tokens?.cache?.write ?? 0) > 0)) sawCache = true
    // matches OpenCode's own sidebar gauge: skip a turn with no output yet (e.g. a
    // reasoning-only turn still in flight) in favor of the last one that finished
    if (info.role === "assistant" && typeof info.tokens?.output === "number" && info.tokens.output > 0) {
      lastAssistantIndex = i
      lastAssistantPrompt = (info.tokens.input ?? 0) + (info.tokens.cache?.read ?? 0) + (info.tokens.cache?.write ?? 0)
      lastAssistantCached = info.tokens.cache?.read ?? 0
      sawCacheAtSelected = sawCache
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

  return {
    tokens: lastAssistantPrompt + counted + guessed,
    estimated: guessed > 0,
    cached: sawCacheAtSelected ? lastAssistantCached : undefined,
    prompt: sawCacheAtSelected ? lastAssistantPrompt : undefined,
  }
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

/** `cached / prompt` as a 0–100 integer percent, or undefined when either is unknown
 *  (no provider cache signal yet, or a zero prompt would divide by zero). */
export function cacheShare(size: Pick<ContextSize, "cached" | "prompt">): number | undefined {
  if (size.cached === undefined || !size.prompt) return undefined
  return Math.round((size.cached / size.prompt) * 100)
}

/** Same total filled count as `contextBar`, split into a cached run and a fresh run by
 *  `cacheShare` (cached rounded down, at least one fresh cell once anything is used — a
 *  fully-cached prompt still shows the one fresh cell that made this request happen). */
export function contextBarCells(size: ContextSize, limit: number, cells = 5): { cached: number; fresh: number; empty: number } {
  if (!(limit > 0)) return { cached: 0, fresh: 0, empty: cells }
  const filled = size.tokens <= 0 ? 0 : Math.min(cells, Math.max(1, Math.round((size.tokens / limit) * cells)))
  const share = cacheShare(size) ?? 0
  let cached = Math.floor((filled * share) / 100)
  let fresh = filled - cached
  if (filled === 1) {
    // one cell can't show both colors: pick whichever share is larger, so a mostly-cached
    // prompt doesn't render as if nothing were cached
    cached = share > 50 ? 1 : 0
    fresh = filled - cached
  } else if (filled > 0 && fresh < 1) {
    fresh = 1
    cached = filled - 1
  }
  return { cached, fresh, empty: cells - filled }
}

/** `12345` → `12.3k`, `800` → `800`, `1310700` → `1.3M`. */
export function formatK(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  // rounds up into "1M" from 999_500, not just at the exact million, so the printed figure never disagrees with its own rounding
  const unit = tokens >= 999_500 ? 1_000_000 : 1_000
  const n = (tokens / unit).toFixed(1)
  return `${n.endsWith(".0") ? n.slice(0, -2) : n}${unit === 1_000_000 ? "M" : "k"}`
}

/** The one context string every surface shows: `ctx ▓▓░░░ ~2.3k/32.8k · low · 95% cached`
 *  (`~` when estimated; the bar and the `/limit` only when the model's window is known; the
 *  cached suffix only once the provider has reported cache tokens this session). */
export function formatContext(size: ContextSize, limit?: number): string {
  const bar = limit ? `${contextBar(size.tokens, limit)} ` : ""
  const share = cacheShare(size)
  return `ctx ${bar}${size.estimated ? "~" : ""}${formatK(size.tokens)}${limit ? `/${formatK(limit)}` : ""} · ${bandFor(size.tokens, limit)}${share !== undefined ? ` · ${share}% cached` : ""}`
}
