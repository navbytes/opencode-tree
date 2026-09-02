/**
 * The combined tree + trajectory view model (DESIGN.md §7).
 *
 * `buildTreeView` walks the *spine* — root session → … → current session. Because
 * `session.fork` copies the prefix with **fresh message IDs**, a branch anchored on an
 * ancestor's message can only be placed by position, so each spine session contributes
 * the *segment* it owns: the root up to and including the first anchor, each child from
 * the message after its anchor up to and including the next anchor, and the current
 * session from after its anchor to its tip. Rows therefore carry their *owning*
 * session's message IDs (jumping into the prefix forks the ancestor, not the copy) and
 * `branch` rows attach right after the anchor message of the segment they fork from.
 * `anchorMessageID` is the **last message shared** with the parent (inclusive). A `git log --graph`
 * gutter (`├⎇` / `╰⎇` / `│ `) draws the tree axis; row order is the time axis.
 *
 * Pure, no OpenCode/opentui/solid-js imports — see test/core-purity.test.ts.
 */
import type { BranchState, TreeState } from "./journal.js"
import { estimateTokens } from "./tokens.js"
import { messagePreview, partPreview, stepKind, type StepPart, type Transcript, type TranscriptMessage } from "./transcript.js"

export type Filter = "default" | "no-tools" | "user-only" | "labeled" | "all"

export type TurnRow = {
  kind: "turn"
  id: string
  sessionID: string
  messageID: string
  turn: number
  depth: number
  gutter: string
  glyph: "●"
  preview: string
  tokens: number
  estimated: boolean
  label?: string
  isCurrent: boolean
  isTip: boolean
  isDecision: boolean
  isSummary: boolean
}

export type StepRow = {
  kind: "step"
  id: string
  sessionID: string
  messageID: string
  partID: string
  depth: number
  gutter: string
  glyph: "○" | "⚙" | "◇"
  preview: string
  tokens: number
  estimated: boolean
  durationMs?: number
  isError: boolean
  isCropped: boolean
  warn: boolean
  /** Label of the owning message, shown on its first step row only. */
  label?: string
}

export type BranchRow = {
  kind: "branch"
  id: string
  sessionID: string
  parentSessionID: string
  anchorMessageID: string
  depth: number
  gutter: string
  name: string
  status: "open" | "squashed" | "rejected" | "discarded" | "abandoned" | "deleted"
  turns: number
  tokens: number
  model?: string
  expanded: boolean
  isCurrent: boolean
  last: boolean
}

export type Row = TurnRow | StepRow | BranchRow

export type TreeView = {
  rows: Row[]
  indexById: Record<string, number>
  currentRowId?: string
  totalTokens: number
}

export type CropRef = { messageID: string; partID?: string }

export type BuildOptions = {
  state: TreeState
  transcripts: Record<string, Transcript>
  currentSessionID: string
  /** sessionIDs whose branch row is expanded to show its own rows inline. */
  expanded: Set<string>
  filter: Filter
  search?: string
  /** Bookmarks, keyed by messageID (DESIGN.md §4.1 `label.set`). */
  labels?: Record<string, string>
  crops?: CropRef[]
}

const WARN_TOKENS = 10_000

// ---------------------------------------------------------------------------
// Small text/number helpers.
// ---------------------------------------------------------------------------

function userText(message: TranscriptMessage): string {
  return message.parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text)
    .join("\n")
}

function partText(part: StepPart): string {
  return part.type === "tool" ? (part.state?.output ?? "") : (part.text ?? "")
}

function durationOfPart(part: StepPart): number | undefined {
  const t = part.state?.time ?? part.time
  if (t?.start !== undefined && t?.end !== undefined) return t.end - t.start
  return undefined
}

function durationOfParts(parts: StepPart[]): number | undefined {
  let start: number | undefined
  let end: number | undefined
  for (const p of parts) {
    const t = p.state?.time ?? p.time
    if (t?.start !== undefined) start = start === undefined ? t.start : Math.min(start, t.start)
    if (t?.end !== undefined) end = end === undefined ? t.end : Math.max(end, t.end)
  }
  return start !== undefined && end !== undefined ? end - start : undefined
}

/** `metadata.ctree.kind` of a message, read off whichever part carries it. */
function ctreeKindOf(message: TranscriptMessage): string | undefined {
  for (const part of message.parts) {
    const ctree = part.metadata?.["ctree"] as { kind?: string } | undefined
    if (ctree?.kind) return ctree.kind
  }
  return undefined
}

function findLastUserIndex(messages: TranscriptMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user") return i
  return -1
}

/** Tokens for one part of an assistant message: a share of `message.tokens.output`
 *  proportional to this part's text length when the message has been costed by the
 *  model, else a chars/4 estimate (DESIGN.md §7's row `tokens` column). */
function stepTokensFor(part: StepPart, message: TranscriptMessage): { tokens: number; estimated: boolean } {
  const text = partText(part)
  const output = message.tokens?.output
  if (typeof output === "number" && output > 0) {
    const totalLen = message.parts.reduce((sum, p) => sum + partText(p).length, 0)
    if (totalLen > 0) {
      return { tokens: Math.round(output * (text.length / totalLen)), estimated: false }
    }
  }
  return { tokens: estimateTokens(text), estimated: true }
}

function aggregateTokens(messages: TranscriptMessage[]): number {
  let total = 0
  for (const m of messages) {
    if (m.role === "user") total += estimateTokens(userText(m))
    else for (const p of m.parts) total += estimateTokens(partText(p))
  }
  return total
}

// ---------------------------------------------------------------------------
// Ancestry.
// ---------------------------------------------------------------------------

/** Session IDs from the root down to (but excluding) `sessionID`, by walking
 *  `parentSessionID` through `state.sessions`. Empty if `sessionID` was never itself
 *  forked (e.g. the tree's root session). */
function ancestorChainOf(state: TreeState, sessionID: string): string[] {
  const chain: string[] = []
  const seen = new Set<string>([sessionID])
  let cur = sessionID
  for (;;) {
    const branch = state.sessions[cur]
    if (!branch) break
    if (seen.has(branch.parentSessionID)) break // guard against a corrupt cycle
    chain.unshift(branch.parentSessionID)
    seen.add(branch.parentSessionID)
    cur = branch.parentSessionID
  }
  return chain
}

function buildAnchorMap(state: TreeState): Map<string, BranchState[]> {
  const map = new Map<string, BranchState[]>()
  for (const sessionID of Object.keys(state.sessions)) {
    const branch = state.sessions[sessionID]!
    const list = map.get(branch.anchorMessageID)
    if (list) list.push(branch)
    else map.set(branch.anchorMessageID, [branch])
  }
  return map
}

// ---------------------------------------------------------------------------
// Filters.
// ---------------------------------------------------------------------------

function stepAllowed(filter: Filter, kind: "text" | "tool" | "reasoning" | "other", labelled = false): boolean {
  switch (filter) {
    case "user-only":
      return false
    case "labeled":
      return labelled
    case "default":
      return kind !== "other"
    case "no-tools":
      return kind !== "other" && kind !== "tool"
    case "all":
      return true
  }
}

function turnAllowed(filter: Filter, label: string | undefined): boolean {
  return filter === "labeled" ? Boolean(label) : true
}

function branchAllowed(filter: Filter): boolean {
  return filter !== "labeled" && filter !== "user-only"
}

// ---------------------------------------------------------------------------
// Row emission.
// ---------------------------------------------------------------------------

type Ctx = {
  state: TreeState
  transcripts: Record<string, Transcript>
  currentSessionID: string
  expanded: Set<string>
  filter: Filter
  labels: Record<string, string>
  crops: CropRef[]
  anchorMap: Map<string, BranchState[]>
  spineSessions: Set<string>
}

function isCropped(ctx: Ctx, messageID: string, partID: string): boolean {
  return ctx.crops.some((c) => c.messageID === messageID && (c.partID === undefined || c.partID === partID))
}

function emitAssistantRows(ctx: Ctx, sessionID: string, message: TranscriptMessage, depth: number, gutter: string, out: Row[]): void {
  if (message.summary) {
    // OpenCode-native compaction summary: one row for the whole message (DESIGN.md §7).
    if (!stepAllowed(ctx.filter, "text")) return
    const text = message.parts.map((p) => partText(p)).join("\n")
    const output = message.tokens?.output
    const tokens = typeof output === "number" ? output : estimateTokens(text)
    const estimated = typeof output !== "number"
    const firstPart = message.parts[0]
    const partID = firstPart?.id ?? `${message.id}-summary`
    out.push({
      kind: "step",
      id: `${sessionID}:${message.id}:${partID}`,
      sessionID,
      messageID: message.id,
      partID,
      depth,
      gutter,
      glyph: "◇",
      preview: "compaction summary",
      tokens,
      estimated,
      durationMs: durationOfParts(message.parts),
      isError: false,
      isCropped: false,
      warn: tokens >= WARN_TOKENS,
    })
    return
  }

  let first = true
  for (const part of message.parts) {
    const kind = stepKind(part)
    const label = first ? ctx.labels[message.id] : undefined
    if (!stepAllowed(ctx.filter, kind, Boolean(label))) continue
    const { tokens, estimated } = stepTokensFor(part, message)
    first = false
    out.push({
      kind: "step",
      id: `${sessionID}:${message.id}:${part.id}`,
      sessionID,
      messageID: message.id,
      partID: part.id,
      depth,
      gutter,
      glyph: kind === "tool" ? "⚙" : "○",
      preview: partPreview(part),
      tokens,
      estimated,
      durationMs: durationOfPart(part),
      isError: part.state?.status === "error",
      isCropped: isCropped(ctx, message.id, part.id),
      warn: tokens >= WARN_TOKENS,
      label,
    })
  }
}

function emitBranches(ctx: Ctx, sessionID: string, anchorMessageID: string, depth: number, out: Row[]): void {
  if (!branchAllowed(ctx.filter)) return
  const candidates = (ctx.anchorMap.get(anchorMessageID) ?? []).filter(
    (b) => b.parentSessionID === sessionID && !ctx.spineSessions.has(b.sessionID),
  )

  candidates.forEach((branch, i) => {
    const last = i === candidates.length - 1
    const branchTranscript = ctx.transcripts[branch.sessionID]
    const parentTranscript = ctx.transcripts[branch.parentSessionID]
    const anchorIndex = parentTranscript?.messages.findIndex((m) => m.id === branch.anchorMessageID) ?? -1
    // the branch's own messages start after the copied prefix (anchor inclusive)
    const tail = branchTranscript ? branchTranscript.messages.slice(anchorIndex + 1) : []
    const expanded = ctx.expanded.has(branch.sessionID)

    out.push({
      kind: "branch",
      id: `branch:${branch.sessionID}`,
      sessionID: branch.sessionID,
      parentSessionID: branch.parentSessionID,
      anchorMessageID: branch.anchorMessageID,
      depth,
      gutter: last ? "╰⎇" : "├⎇",
      name: branch.name ?? branch.sessionID,
      status: branch.forgotten ? "deleted" : branch.status,
      turns: tail.filter((m) => m.role === "user").length,
      tokens: aggregateTokens(tail),
      model: branch.model,
      expanded,
      // The current session never appears as a branch row (it is excluded from
      // `candidates` via `spineSessions`), so this is always false in practice —
      // kept for a truthful, type-complete Row rather than a hidden invariant.
      isCurrent: branch.sessionID === ctx.currentSessionID,
      last,
    })

    if (expanded && branchTranscript) {
      // continue the parent's turn numbering: the branch's first turn follows the anchor's turn
      const turnAtAnchor = parentTranscript ? parentTranscript.messages.slice(0, anchorIndex + 1).filter((m) => m.role === "user").length : 0
      renderMessages(ctx, branch.sessionID, tail, depth + 1, "│ ", out, { turn: turnAtAnchor })
    }
  })
}

function renderMessages(
  ctx: Ctx,
  sessionID: string,
  messages: TranscriptMessage[],
  depth: number,
  gutter: string,
  out: Row[],
  counter: { turn: number } = { turn: 0 },
  lastUserIndexOverride?: number,
): void {
  const lastUserIndex = lastUserIndexOverride ?? findLastUserIndex(messages)
  messages.forEach((message, i) => {
    if (message.role === "user") {
      counter.turn++
      const turn = counter.turn
      const label = ctx.labels[message.id]
      const isDecision = ctx.state.decisions[message.id] !== undefined || ctreeKindOf(message) === "decision"
      const isSummary = ctreeKindOf(message) === "summary"
      if (turnAllowed(ctx.filter, label)) {
        out.push({
          kind: "turn",
          id: `${sessionID}:${message.id}`,
          sessionID,
          messageID: message.id,
          turn,
          depth,
          gutter,
          glyph: "●",
          preview: messagePreview(message),
          tokens: estimateTokens(userText(message)),
          estimated: true,
          label,
          isCurrent: sessionID === ctx.currentSessionID,
          isTip: i === lastUserIndex,
          isDecision,
          isSummary,
        })
      }
    } else {
      emitAssistantRows(ctx, sessionID, message, depth, gutter, out)
    }
    // Branches attach right after their anchor — the last message they share with
    // this session — whichever role that message has.
    emitBranches(ctx, sessionID, message.id, depth, out)
  })
}

// ---------------------------------------------------------------------------
// Search.
// ---------------------------------------------------------------------------

function rowSearchFields(row: Row): string[] {
  switch (row.kind) {
    case "turn":
      return row.label ? [row.preview, row.label] : [row.preview]
    case "step":
      return row.label ? [row.preview, row.label] : [row.preview]
    case "branch":
      return row.model ? [row.name, row.model, row.status] : [row.name, row.status]
  }
}

function rowMatches(row: Row, needle: string): boolean {
  return rowSearchFields(row).some((f) => f.toLowerCase().includes(needle))
}

/** Case-insensitive substring search over preview/name/tool/label (DESIGN.md §7.5).
 *  A turn row is kept if it — or one of the step rows it owns (same depth,
 *  immediately following) — matches; a branch row is kept if it, or any row nested
 *  under it (depth greater than its own), matches. */
function applySearch(rows: Row[], search: string): Row[] {
  const needle = search.trim().toLowerCase()
  if (!needle) return rows

  const direct = rows.map((r) => rowMatches(r, needle))
  const keep = direct.slice()

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    if (row.kind === "turn") {
      let j = i + 1
      while (j < rows.length && rows[j]!.depth === row.depth && rows[j]!.kind === "step") {
        if (direct[j]) keep[i] = true
        j++
      }
    } else if (row.kind === "branch") {
      let j = i + 1
      while (j < rows.length && rows[j]!.depth > row.depth) {
        if (direct[j]) keep[i] = true
        j++
      }
    }
  }

  return rows.filter((_, i) => keep[i])
}

// ---------------------------------------------------------------------------
// Total tokens.
// ---------------------------------------------------------------------------

/** Last assistant `tokens.input` in the current session, plus a chars/4 estimate of
 *  anything newer (DESIGN.md §3.3 / §6.7), mirroring `tokens.ts`'s `contextSizeOf`. */
function computeTotalTokens(transcript: Transcript): number {
  let lastIndex = -1
  let lastInput = 0
  transcript.messages.forEach((m, idx) => {
    if (m.role === "assistant" && typeof m.tokens?.input === "number") {
      lastIndex = idx
      lastInput = m.tokens.input
    }
  })

  let newer = 0
  for (let i = lastIndex + 1; i < transcript.messages.length; i++) {
    const m = transcript.messages[i]!
    if (m.role === "user") newer += estimateTokens(userText(m))
    else for (const p of m.parts) newer += estimateTokens(partText(p))
  }

  return lastInput + newer
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export function buildTreeView(o: BuildOptions): TreeView {
  const transcript = o.transcripts[o.currentSessionID]
  if (!transcript) return { rows: [], indexById: {}, currentRowId: undefined, totalTokens: 0 }

  const ancestorChain = ancestorChainOf(o.state, o.currentSessionID)
  const spineSessions = new Set([...ancestorChain, o.currentSessionID])

  const ctx: Ctx = {
    state: o.state,
    transcripts: o.transcripts,
    currentSessionID: o.currentSessionID,
    expanded: o.expanded,
    filter: o.filter,
    labels: o.labels ?? {},
    crops: o.crops ?? [],
    anchorMap: buildAnchorMap(o.state),
    spineSessions,
  }

  const allRows: Row[] = []
  const counter = { turn: 0 }
  // branches forked before the first message anchor on "" and sit above everything
  emitBranches(ctx, ancestorChain[0] ?? o.currentSessionID, "", 0, allRows)
  // Spine segments (see header comment). A missing ancestor transcript degrades to
  // rendering the current session's own copy of that prefix.
  const spine = [...ancestorChain, o.currentSessionID]
  let from = 0 // index into the *current* session's transcript where the next segment starts
  for (let s = 0; s < spine.length; s++) {
    const sessionID = spine[s]!
    const own = o.transcripts[sessionID]
    const child = spine[s + 1]
    const childBranch = child ? o.state.sessions[child] : undefined
    if (s < spine.length - 1) {
      const anchorIndex = own ? own.messages.findIndex((m) => m.id === childBranch?.anchorMessageID) : -1
      if (own && anchorIndex !== -1) {
        // this ancestor owns messages [from .. anchorIndex]
        const segment = own.messages.slice(from, anchorIndex + 1)
        renderMessages(ctx, sessionID, segment, 0, "", allRows, counter, -1)
        from = anchorIndex + 1
        continue
      }
      // unknown anchor: let the next segment render from where we are, out of the copy
      continue
    }
    const segment = transcript.messages.slice(from)
    const lastUser = findLastUserIndex(segment)
    renderMessages(ctx, sessionID, segment, 0, "", allRows, counter, lastUser)
  }

  const rows = o.search ? applySearch(allRows, o.search) : allRows

  let currentRowId: string | undefined
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!
    if (r.kind !== "branch" && r.sessionID === o.currentSessionID) {
      currentRowId = r.id
      break
    }
  }

  const indexById: Record<string, number> = {}
  rows.forEach((r, i) => {
    indexById[r.id] = i
  })

  return { rows, indexById, currentRowId, totalTokens: computeTotalTokens(transcript) }
}


// ---------------------------------------------------------------------------
// Positional map between spine rows and the current session's copied prefix.
// ---------------------------------------------------------------------------

export type SpineMap = {
  /** `${sessionID}:${messageID}` of any spine message → index into the current transcript */
  index: Map<string, number>
  /** current-session messageID for a spine message (same for own messages) */
  toCurrent: (sessionID: string, messageID: string) => string | undefined
  /** current-session partID for a spine part, by position within the message */
  partToCurrent: (sessionID: string, messageID: string, partID: string) => string | undefined
  /** spine owner of a current-session message (itself when past the fork point) */
  fromCurrent: (currentMessageID: string) => { sessionID: string; messageID: string } | undefined
  /** spine partID for a current-session part */
  partFromCurrent: (currentMessageID: string, currentPartID: string) => { sessionID: string; messageID: string; partID: string } | undefined
}

/** Built from the *unfiltered* transcripts, so hidden rows never shift positions
 *  (unlike a map derived from the rendered rows). */
export function buildSpineMap(o: Pick<BuildOptions, "state" | "transcripts" | "currentSessionID">): SpineMap {
  const current = o.transcripts[o.currentSessionID]
  const index = new Map<string, number>()
  const owner: { sessionID: string; messageID: string }[] = []
  if (current) {
    const spine = [...ancestorChainOf(o.state, o.currentSessionID), o.currentSessionID]
    let from = 0
    for (let s = 0; s < spine.length; s++) {
      const sessionID = spine[s]!
      const own = o.transcripts[sessionID]
      const child = spine[s + 1]
      const childBranch = child ? o.state.sessions[child] : undefined
      if (s < spine.length - 1) {
        const anchorIndex = own ? own.messages.findIndex((m) => m.id === childBranch?.anchorMessageID) : -1
        if (own && anchorIndex !== -1) {
          own.messages.slice(from, anchorIndex + 1).forEach((m, i) => {
            index.set(`${sessionID}:${m.id}`, from + i)
            owner[from + i] = { sessionID, messageID: m.id }
          })
          from = anchorIndex + 1
        }
        continue
      }
      current.messages.slice(from).forEach((m, i) => {
        index.set(`${sessionID}:${m.id}`, from + i)
        owner[from + i] = { sessionID, messageID: m.id }
      })
    }
  }
  const messageAt = (i: number) => current?.messages[i]
  const toCurrent = (sessionID: string, messageID: string) => {
    const i = index.get(`${sessionID}:${messageID}`)
    return i === undefined ? undefined : messageAt(i)?.id
  }
  const partToCurrent = (sessionID: string, messageID: string, partID: string) => {
    const i = index.get(`${sessionID}:${messageID}`)
    if (i === undefined) return undefined
    const src = o.transcripts[sessionID]?.messages.find((m) => m.id === messageID)
    const k = src?.parts.findIndex((p) => p.id === partID) ?? -1
    return k === -1 ? undefined : messageAt(i)?.parts[k]?.id
  }
  const fromCurrent = (currentMessageID: string) => {
    const i = current?.messages.findIndex((m) => m.id === currentMessageID) ?? -1
    return i === -1 ? undefined : owner[i]
  }
  const partFromCurrent = (currentMessageID: string, currentPartID: string) => {
    const o1 = fromCurrent(currentMessageID)
    if (!o1) return undefined
    const cur = current?.messages.find((m) => m.id === currentMessageID)
    const k = cur?.parts.findIndex((p) => p.id === currentPartID) ?? -1
    const src = o.transcripts[o1.sessionID]?.messages.find((m) => m.id === o1.messageID)
    const partID = k === -1 ? undefined : src?.parts[k]?.id
    return partID ? { ...o1, partID } : undefined
  }
  return { index, toCurrent, partToCurrent, fromCurrent, partFromCurrent }
}
