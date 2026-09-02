/**
 * Crop planning (DESIGN.md §6.5): which tool results / turns *can* be cropped,
 * which are protected, the `--auto` rules, and how a selection becomes the
 * `crop.applied` journal payload that core/crop.ts applies.
 *
 * Pure, no OpenCode/opentui/solid-js imports — see test/core-purity.test.ts.
 */
import type { CropAppliedData, CropTarget } from "./journal.js"
import { estimateTokens } from "./tokens.js"
import type { StepPart, Transcript, TranscriptMessage } from "./transcript.js"

/** FNV-1a 32-bit, hex — a stable 8-char handle for "this exact output". */
export function sha8(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

export type Protection = "latest-per-tool" | "current-turn" | "decision" | "keep-glob" | "already-cropped" | "too-small"

export type ResultCandidate = {
  kind: "result"
  messageID: string
  partID: string
  callID?: string
  tool: string
  arg: string
  estTokens: number
  sha8: string
  /** user-turn index (1-based) this result belongs to */
  turn: number
  turnsAgo: number
  protections: Protection[]
}

export type TurnCandidate = {
  kind: "turn"
  anchorMessageID: string
  turn: number
  turnsAgo: number
  steps: number
  estTokens: number
  sha8: string
  targets: CropTarget[]
  protections: Protection[]
}

export type CropRules = {
  minTokens: number
  olderThanTurns: number
  keep: string[]
}

export const DEFAULT_RULES: CropRules = { minTokens: 10_000, olderThanTurns: 2, keep: [] }

function primaryArg(part: StepPart): string {
  const input = part.state?.input
  if (!input || typeof input !== "object") return ""
  const rec = input as Record<string, unknown>
  const v = rec["command"] ?? rec["filePath"] ?? rec["pattern"] ?? rec["url"] ?? rec["path"]
  return typeof v === "string" ? v : ""
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`, "i")
}

function keepMatches(keep: string[], tool: string, arg: string): boolean {
  return keep.some((g) => {
    const re = globToRegExp(g)
    return re.test(tool) || re.test(`${tool} ${arg}`) || re.test(arg)
  })
}

function isCtreeKind(message: TranscriptMessage, kind: string): boolean {
  return message.parts.some((p) => (p.metadata?.["ctree"] as { kind?: string } | undefined)?.kind === kind)
}

type Turn = { index: number; user: TranscriptMessage; assistants: TranscriptMessage[] }

function turnsOf(messages: TranscriptMessage[]): Turn[] {
  const turns: Turn[] = []
  for (const m of messages) {
    if (m.role === "user") turns.push({ index: turns.length + 1, user: m, assistants: [] })
    else turns[turns.length - 1]?.assistants.push(m)
  }
  return turns
}

/** Every completed tool result in the transcript, newest last, with its protections. */
export function resultCandidates(transcript: Transcript, opts: { alreadyCropped?: Set<string>; keep?: string[]; minTokens?: number } = {}): ResultCandidate[] {
  const turns = turnsOf(transcript.messages)
  const total = turns.length
  const out: ResultCandidate[] = []
  for (const turn of turns) {
    for (const m of turn.assistants) {
      for (const p of m.parts) {
        if (p.type !== "tool" || p.state?.status !== "completed") continue
        const output = p.state.output ?? ""
        const tool = p.tool ?? "tool"
        const arg = primaryArg(p)
        const protections: Protection[] = []
        if (turn.index === total) protections.push("current-turn")
        if (opts.alreadyCropped?.has(p.id)) protections.push("already-cropped")
        if (opts.keep && keepMatches(opts.keep, tool, arg)) protections.push("keep-glob")
        const estTokens = estimateTokens(output)
        if (opts.minTokens !== undefined && estTokens < opts.minTokens) protections.push("too-small")
        out.push({ kind: "result", messageID: m.id, partID: p.id, callID: p.callID, tool, arg, estTokens, sha8: sha8(output), turn: turn.index, turnsAgo: total - turn.index, protections })
      }
    }
  }
  // latest result per tool is protected (needs an explicit double-mark)
  const seen = new Set<string>()
  for (let i = out.length - 1; i >= 0; i--) {
    const c = out[i]!
    if (!seen.has(c.tool)) {
      seen.add(c.tool)
      c.protections.push("latest-per-tool")
    }
  }
  return out
}

/** Every user turn with its answers, as a droppable unit. */
export function turnCandidates(transcript: Transcript, opts: { alreadyDropped?: Set<string> } = {}): TurnCandidate[] {
  const turns = turnsOf(transcript.messages)
  const total = turns.length
  return turns.map((turn) => {
    const protections: Protection[] = []
    if (turn.index === total) protections.push("current-turn")
    if (isCtreeKind(turn.user, "decision") || turn.assistants.some((m) => isCtreeKind(m, "decision"))) protections.push("decision")
    if (opts.alreadyDropped?.has(turn.user.id)) protections.push("already-cropped")
    const targets: CropTarget[] = []
    let text = ""
    const userText = turn.user.parts.map((p) => p.text ?? "").join("\n")
    text += userText
    targets.push({ messageID: turn.user.id, estTokens: estimateTokens(userText), sha8: sha8(userText) })
    for (const m of turn.assistants) {
      const t = m.parts.map((p) => (p.type === "tool" ? (p.state?.output ?? "") : (p.text ?? ""))).join("\n")
      text += `\n${t}`
      targets.push({ messageID: m.id, estTokens: estimateTokens(t), sha8: sha8(t) })
    }
    const estTokens = targets.reduce((s, t) => s + t.estTokens, 0)
    return { kind: "turn", anchorMessageID: turn.user.id, turn: turn.index, turnsAgo: total - turn.index, steps: 1 + turn.assistants.length, estTokens, sha8: sha8(text), targets, protections }
  })
}

/** `--auto`: pre-mark results that are big enough, old enough, and unprotected. */
export function autoMark(candidates: ResultCandidate[], rules: CropRules = DEFAULT_RULES): ResultCandidate[] {
  return candidates.filter((c) => c.estTokens >= rules.minTokens && c.turnsAgo >= rules.olderThanTurns && c.protections.length === 0)
}

/** The single biggest unprotected result (`/crop --top`). */
export function topCandidate(candidates: ResultCandidate[]): ResultCandidate | undefined {
  return candidates
    .filter((c) => !c.protections.some((p) => p !== "too-small"))
    .sort((a, b) => b.estTokens - a.estTokens)[0]
}

/** Turn a result-mode selection into one `crop.applied` payload. */
export function planResultCrop(sessionID: string, selected: ResultCandidate[]): CropAppliedData | undefined {
  if (selected.length === 0) return undefined
  const targets: CropTarget[] = selected.map((c) => ({ messageID: c.messageID, partID: c.partID, callID: c.callID, tool: c.tool, estTokens: c.estTokens, sha8: c.sha8 }))
  // the anchor is informational for result crops: the earliest touched message
  const anchorMessageID = selected.slice().sort((a, b) => a.turn - b.turn)[0]!.messageID
  return { sessionID, mode: "result", targets, anchorMessageID }
}

/** One `crop.applied` payload per dropped turn (turn crops splice, so each is its own line). */
export function planTurnCrops(sessionID: string, selected: TurnCandidate[]): CropAppliedData[] {
  return selected.map((t) => ({ sessionID, mode: "turn", targets: t.targets, anchorMessageID: t.anchorMessageID }))
}

export function reclaimed(selected: (ResultCandidate | TurnCandidate)[]): number {
  return selected.reduce((s, c) => s + c.estTokens, 0)
}
