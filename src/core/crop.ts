/**
 * Crop application (DESIGN.md §6.5, invariants in §8.1).
 *
 * Operates on a minimal structural type that mirrors OpenCode's
 * `{ info: Message, parts: Part[] }` shape closely enough to be driven by
 * `experimental.chat.messages.transform`, without importing anything from
 * `@opencode-ai/*`. Pure, no OpenCode/opentui imports — see
 * test/core-purity.test.ts.
 */

export type MinimalToolState = {
  status?: string
  input?: unknown
  output?: string
  title?: string
  time?: { start?: number; end?: number; compacted?: number }
}

export type MinimalPart = {
  id: string
  type: string
  tool?: string
  callID?: string
  state?: MinimalToolState
  text?: string
  metadata?: Record<string, unknown>
}

export type MinimalMessageInfo = {
  id: string
  role: "user" | "assistant" | "system"
  sessionID: string
}

export type MinimalMessage = {
  info: MinimalMessageInfo
  parts: MinimalPart[]
}

/** One crop target, as recorded on a `crop.applied` journal line (see core/journal.ts). */
export type CropTargetRef = {
  messageID: string
  partID?: string
  callID?: string
  tool?: string
  estTokens: number
  sha8: string
}

export type CropSpec = {
  mode: "result" | "turn"
  targets: CropTargetRef[]
  anchorMessageID: string
}

const CROPPED_PREFIX = "[cropped:"
const DROPPED_PREFIX = "[dropped turn"

function formatK(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const k = (tokens / 1000).toFixed(1)
  return `${k.endsWith(".0") ? k.slice(0, -2) : k}k`
}

function isDecisionMessage(message: MinimalMessage): boolean {
  return message.parts.some((p) => {
    const ctree = p.metadata?.["ctree"] as { kind?: string } | undefined
    return ctree?.kind === "decision"
  })
}

function findLastUserIndex(messages: MinimalMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.info.role === "user") return i
  }
  return -1
}

function matchesTarget(part: MinimalPart, target: CropTargetRef): boolean {
  if (target.partID) return part.id === target.partID
  if (target.callID) return part.callID === target.callID
  if (target.tool) return part.type === "tool" && part.tool === target.tool
  return part.type === "tool"
}

function shortArg(state: MinimalToolState | undefined): string {
  if (!state?.input || typeof state.input !== "object") return ""
  const input = state.input as Record<string, unknown>
  const candidate = input["command"] ?? input["filePath"] ?? input["pattern"] ?? input["url"]
  if (typeof candidate !== "string") return ""
  const trimmed = candidate.length > 40 ? `${candidate.slice(0, 40)}…` : candidate
  return ` "${trimmed}"`
}

/** result mode: rewrite `state.output` to a stub; input/callID/status are left untouched. */
function applyResultCrop(messages: MinimalMessage[], crop: CropSpec, lastUserIndex: number): void {
  for (const target of crop.targets) {
    const index = messages.findIndex((m) => m.info.id === target.messageID)
    if (index === -1) continue
    if (index === lastUserIndex) continue // never touch the last user message
    const message = messages[index]!
    if (isDecisionMessage(message)) continue // decision records are never cropped

    for (const part of message.parts) {
      if (part.type !== "tool") continue
      if (!matchesTarget(part, target)) continue
      if (!part.state || part.state.status !== "completed") continue
      if (typeof part.state.output === "string" && part.state.output.startsWith(CROPPED_PREFIX)) continue // idempotent

      const arg = shortArg(part.state)
      part.state.output = `${CROPPED_PREFIX} ${target.tool ?? part.tool ?? "tool"}${arg}, ~${formatK(target.estTokens)} tokens, sha8 ${target.sha8}]`
    }
  }
}

/**
 * turn mode: splice out the user message at `anchorMessageID` and every
 * assistant/tool message up to (excluding) the next user message, replacing them
 * with exactly one synthetic user message so role alternation is preserved.
 */
function applyTurnCrop(messages: MinimalMessage[], crop: CropSpec, lastUserIndex: number): void {
  const startIndex = messages.findIndex((m) => m.info.id === crop.anchorMessageID)
  if (startIndex === -1) return // already dropped (idempotent) or not in this array
  if (startIndex === lastUserIndex) return // never touch the last user message
  const anchor = messages[startIndex]!
  if (anchor.info.role !== "user") return
  if (isDecisionMessage(anchor)) return
  if (anchor.parts.some((p) => p.type === "text" && typeof p.text === "string" && p.text.startsWith(DROPPED_PREFIX))) return // idempotent

  let endIndex = startIndex + 1
  while (endIndex < messages.length && messages[endIndex]!.info.role !== "user") endIndex++

  const removed = endIndex - startIndex
  const target = crop.targets[0]
  const estTokens = crop.targets.reduce((sum, t) => sum + t.estTokens, 0)
  const sha8 = target?.sha8 ?? "00000000"

  const synthetic: MinimalMessage = {
    info: { id: anchor.info.id, role: "user", sessionID: anchor.info.sessionID },
    parts: [
      {
        id: `${anchor.info.id}-dropped`,
        type: "text",
        text: `${DROPPED_PREFIX} — ${removed} steps, ~${formatK(estTokens)} tokens, recoverable: ${sha8}]`,
      },
    ],
  }

  messages.splice(startIndex, removed, synthetic)
}

/**
 * Apply a set of crops to `messages` in place, mirroring how the server plugin
 * mutates OpenCode's `output.messages` by reference in
 * `experimental.chat.messages.transform`. Returns the same array for convenience.
 *
 * Invariants (DESIGN.md §8.1), all enforced here:
 * 1. Never remove or alter the last user message.
 * 2. A tool part is stubbed by rewriting `state.output` only.
 * 3. A dropped turn removes user + assistant/tool up to the next user message and
 *    inserts exactly one synthetic user message, so roles still alternate.
 * 5. Decision records are never cropped.
 * 6. Idempotent: running this twice on the same array yields the same result.
 */
export function applyCrops(messages: MinimalMessage[], crops: CropSpec[]): MinimalMessage[] {
  if (messages.length === 0 || crops.length === 0) return messages

  for (const crop of crops) {
    // Recomputed per crop: turn crops splice the array, so indices shift.
    const lastUserIndex = findLastUserIndex(messages)
    if (crop.mode === "result") applyResultCrop(messages, crop, lastUserIndex)
    else applyTurnCrop(messages, crop, lastUserIndex)
  }

  return messages
}
