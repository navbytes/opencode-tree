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
 * Context size of a session's message list: the last assistant turn's real
 * `tokens.input`, plus a chars/4 estimate of everything the next request will add on
 * top of it — that turn's own output and tool results included (DESIGN.md §3.3 /
 * §6.7). Returns `{ tokens, estimated }`; `estimated` is true whenever any part of
 * the figure is a chars/4 guess.
 */
export function contextSizeOf(messages: MinimalMessage[]): { tokens: number; estimated: boolean } {
  let lastAssistantIndex = -1
  let lastAssistantInput = 0
  for (let i = 0; i < messages.length; i++) {
    const info = messages[i]!.info
    if (info.role === "assistant" && typeof info.tokens?.input === "number") {
      lastAssistantIndex = i
      lastAssistantInput = info.tokens.input
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

  // starts AT the last assistant: its `tokens.input` is the context it was *given*, so its
  // own output and tool results are only in the context from the next request on.
  let newer = 0
  for (let i = lastAssistantIndex; i < messages.length; i++) {
    for (const part of messages[i]!.parts) newer += estimateTokens(partText(part))
  }

  return { tokens: lastAssistantInput + newer, estimated: newer > 0 }
}

export type ContextBand = "low" | "healthy" | "filling" | "red"

/** Absolute bands from DESIGN.md §6.7: <8k low · 8-32k healthy · 32-64k filling · >=64k red. */
export function bandFor(tokens: number): ContextBand {
  if (tokens < 8_000) return "low"
  if (tokens < 32_000) return "healthy"
  if (tokens < 64_000) return "filling"
  return "red"
}
