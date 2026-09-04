/**
 * The combined tree + trajectory view model (DESIGN.md §7) — a Pi-style whole-tree outline.
 *
 * `buildTreeView` does a depth-first walk of the *whole* tree of sessions, starting at the
 * root (`state.root`, or the current session's furthest loaded ancestor). Each session
 * contributes its own messages (a branch's tail after the copied prefix; `session.fork`
 * copies that prefix with **fresh message IDs**, so the tail is found by *position* — the
 * anchor's index in the parent applied to the branch). A branch hangs off the message it was
 * forked from: right after that message we draw a `⎇ name` header and, when the branch is
 * open, recurse into its tail one level deeper. Branches on the current path (its chain from
 * the root) are open by default so you always see the trunk, where you are, and every sibling
 * from anywhere; off-path branches fold to a single header (`▸`), expandable with `→`/`e`.
 *
 * A `git log --graph` gutter draws the tree axis: `│ ` for each open ancestor level and a
 * `├⎇`/`╰⎇` join at each branch header; row order is the time axis. Rows carry their *owning*
 * session's message IDs (jumping into the prefix forks the ancestor, not the copy).
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
  /** false for rows the current session never sends: an ancestor's rows past the point where
   *  this path forked away, and every other branch's rows (DESIGN.md §7.1). */
  inContext: boolean
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
  /** Time the model spent reasoning for the owning message, folded onto its first real step:
   *  outside the `all` filter thinking parts get no row of their own. */
  thinkingMs?: number
  isError: boolean
  isCropped: boolean
  warn: boolean
  /** Label of the owning message, shown on its first step row only. */
  label?: string
  /** See TurnRow.inContext. */
  inContext: boolean
  /** The owning assistant message's real token report (DESIGN.md §6.7's inspector Prompt/Reply
   *  lines), carried on every one of its step rows; undefined until the provider costs it. */
  tokenFields?: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
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
  /** The reason recorded when the branch was closed (discard "Why?", tournament epitaph). */
  note?: string
  turns: number
  tokens: number
  model?: string
  expanded: boolean
  isCurrent: boolean
  last: boolean
}

/** Decoration drawn in an ancestor right after the point where the current path forked away:
 *  everything below it in that session is history the model is not shown. Never selectable. */
export type SeparatorRow = {
  kind: "separator"
  id: string
  depth: number
  gutter: string
  text: string
}

export type Row = TurnRow | StepRow | BranchRow | SeparatorRow

const OFF_PATH_TEXT = "── not in this branch's context ──"

export type TreeView = {
  rows: Row[]
  indexById: Record<string, number>
  currentRowId?: string
  totalTokens: number
  /** true when any part of `totalTokens` is a chars/4 guess — render it as `~`.
   *  Optional so callers can build a placeholder view without it. */
  totalEstimated?: boolean
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

/** Marker `say()` puts on every headless `/ctree …` reply (src/server/index.ts). */
const PLUGIN_COMMAND_PREFIX = "[context tree]"

/** A headless `/ctree …` runs as an OpenCode command, so it leaves a user turn carrying
 *  the marker plus a one-line acknowledgement: plugin plumbing, not conversation. */
function isPluginCommand(message: TranscriptMessage): boolean {
  const text = message.parts.find((p) => p.type === "text" && p.text)?.text
  return text !== undefined && text.startsWith(PLUGIN_COMMAND_PREFIX)
}

/** Plugin command turns are hidden everywhere but `all`, and while hidden they are not
 *  turns at all — `T<n>` numbers what you can see, so it never skips (DESIGN.md §7.2). */
function hiddenPluginTurn(filter: Filter, message: TranscriptMessage): boolean {
  return filter !== "all" && message.role === "user" && isPluginCommand(message)
}

function countTurns(filter: Filter, messages: TranscriptMessage[]): number {
  return messages.reduce((n, m) => (m.role === "user" && !hiddenPluginTurn(filter, m) ? n + 1 : n), 0)
}

function findLastUserIndex(messages: TranscriptMessage[], filter: Filter): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user" && !hiddenPluginTurn(filter, messages[i]!)) return i
  return -1
}

/** Tokens for one part of an assistant message: a share of `message.tokens.output`
 *  proportional to this part's text length when the message has been costed by the
 *  model, else a chars/4 estimate (DESIGN.md §7's row `tokens` column). */
function stepTokensFor(part: StepPart, message: TranscriptMessage): { tokens: number; estimated: boolean } {
  const text = partText(part)
  // a tool result is not model output: `tokens.output` never covers it, and splitting the
  // model's output across it would price an 80k-char result at a few dozen tokens
  if (part.type !== "tool") {
    const output = message.tokens?.output
    if (typeof output === "number" && output > 0) {
      const generatedLen = message.parts.reduce((sum, p) => (p.type === "tool" ? sum : sum + partText(p).length), 0)
      if (generatedLen > 0) {
        return { tokens: Math.round(output * (text.length / generatedLen)), estimated: false }
      }
    }
  }
  return { tokens: estimateTokens(text), estimated: true }
}

/** The message-level token breakdown for the inspector's Prompt/Reply lines; undefined until
 *  the provider has actually costed this message (DESIGN.md §6.7), same test as `stepTokensFor`. */
function tokenFieldsOf(message: TranscriptMessage): StepRow["tokenFields"] {
  const tk = message.tokens
  if (typeof tk?.output !== "number" || tk.output <= 0) return undefined
  return { input: tk.input ?? 0, output: tk.output, reasoning: tk.reasoning ?? 0, cacheRead: tk.cache?.read ?? 0, cacheWrite: tk.cache?.write ?? 0 }
}

export function aggregateTokens(messages: TranscriptMessage[]): number {
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
  /** anchorMessageID → the branches forked there, in journal order. */
  anchorMap: Map<string, BranchState[]>
  /** The current session and every ancestor up to the root; these are open by default. */
  onPath: Set<string>
  /** Each on-path session → the next session down the current path, so the DFS can keep
   *  descending toward the current session even when an ancestor's transcript never loaded. */
  onPathChild: Map<string, string>
  /** Index in the current session's transcript where its own messages begin (its copied
   *  prefix length), used to render its rows when its parent's transcript is missing. */
  currentTailStart: number
}

function isCropped(ctx: Ctx, messageID: string, partID: string): boolean {
  return ctx.crops.some((c) => c.messageID === messageID && (c.partID === undefined || c.partID === partID))
}

function emitAssistantRows(ctx: Ctx, sessionID: string, message: TranscriptMessage, depth: number, gutter: string, inContext: boolean, out: Row[]): void {
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
      inContext,
    })
    return
  }

  // Reasoning parts were 40–50% of the outline and say nothing: outside `all` they get no row
  // and their duration rides the message's first real step instead (`· 9.8s thought`).
  const collapseThinking = ctx.filter !== "all"
  const tokenFields = tokenFieldsOf(message)
  const rows: StepRow[] = []
  let thinkingMs: number | undefined
  let first = true
  for (const part of message.parts) {
    const kind = stepKind(part)
    if (collapseThinking && kind === "reasoning") {
      const ms = durationOfPart(part)
      if (ms !== undefined) thinkingMs = (thinkingMs ?? 0) + ms
      continue
    }
    const label = first ? ctx.labels[message.id] : undefined
    if (!stepAllowed(ctx.filter, kind, Boolean(label))) continue
    const { tokens, estimated } = stepTokensFor(part, message)
    first = false
    rows.push({
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
      inContext,
      tokenFields,
    })
  }

  if (rows.length > 0) {
    if (thinkingMs !== undefined) rows[0]!.thinkingMs = thinkingMs
  } else if (collapseThinking) {
    // nothing but thinking: keep one row, standing for the whole message, or it goes invisible
    const thinking = message.parts.filter((p) => stepKind(p) === "reasoning")
    const label = ctx.labels[message.id]
    if (thinking.length > 0 && stepAllowed(ctx.filter, "reasoning", Boolean(label))) {
      const tokens = thinking.reduce((sum, p) => sum + stepTokensFor(p, message).tokens, 0)
      rows.push({
        kind: "step",
        id: `${sessionID}:${message.id}:${thinking[0]!.id}`,
        sessionID,
        messageID: message.id,
        partID: thinking[0]!.id,
        depth,
        gutter,
        glyph: "○",
        preview: partPreview(thinking[0]!),
        tokens,
        estimated: thinking.some((p) => stepTokensFor(p, message).estimated),
        durationMs: thinkingMs,
        isError: false,
        isCropped: isCropped(ctx, message.id, thinking[0]!.id),
        warn: tokens >= WARN_TOKENS,
        label,
        inContext,
        tokenFields,
      })
    }
  }
  out.push(...rows)
}

/** A branch is open in the outline when the user has toggled it: on-path branches start open
 *  (so the root→you path is always visible), so `expanded` membership *collapses* them;
 *  off-path branches start folded, so membership *opens* them. The BranchRow's `expanded`
 *  field carries this resolved state, so the route can fold/unfold with one toggle either way. */
function shownExpanded(ctx: Ctx, sessionID: string): boolean {
  const flagged = ctx.expanded.has(sessionID)
  return ctx.onPath.has(sessionID) ? !flagged : flagged
}

/** Emit a branch header for `branch` (unless a filter hides branch rows) and, when it is open,
 *  recurse into the branch's own messages — its tail after the copied prefix, found by the
 *  anchor's *position* in the parent (fork copies the prefix with fresh IDs). */
function pushBranch(ctx: Ctx, branch: BranchState, depth: number, gutter: string, last: boolean, showHeader: boolean, out: Row[]): void {
  const branchTranscript = ctx.transcripts[branch.sessionID]
  const parentTranscript = ctx.transcripts[branch.parentSessionID]
  const anchorIndex = parentTranscript?.messages.findIndex((m) => m.id === branch.anchorMessageID) ?? -1
  const isCurrent = branch.sessionID === ctx.currentSessionID
  // Offset where the branch's own tail begins in its transcript — the anchor's position in the
  // parent, since fork copies the prefix by position. When the anchor can't be resolved we never
  // slice from 0, which would replay the whole copied prefix as fresh rows (duplicate turns):
  //   · anchor "" — forked before the parent's first message, so it shares nothing: whole tail.
  //   · the current session — its live transcript is here; slice at the prefix the loaded
  //     ancestors account for, so its rows still render when an on-path ancestor never loaded.
  //   · otherwise — a real anchor we cannot place: tail unknown, so empty.
  const tailStart = anchorIndex >= 0 ? anchorIndex + 1 : branch.anchorMessageID === "" ? 0 : isCurrent ? ctx.currentTailStart : -1
  const tail = branchTranscript && tailStart >= 0 ? branchTranscript.messages.slice(tailStart) : []
  const expanded = shownExpanded(ctx, branch.sessionID)

  if (showHeader) {
    out.push({
      kind: "branch",
      id: `branch:${branch.sessionID}`,
      sessionID: branch.sessionID,
      parentSessionID: branch.parentSessionID,
      anchorMessageID: branch.anchorMessageID,
      depth,
      gutter: `${gutter}${last ? "╰⎇" : "├⎇"}`,
      // adopted native forks carry no name: fall back to the session's live title
      name: branch.name ?? branchTranscript?.title ?? branch.sessionID,
      status: branch.forgotten ? "deleted" : (branch.status ?? "open"),
      note: branch.note,
      turns: countTurns(ctx.filter, tail),
      tokens: aggregateTokens(tail),
      model: branch.model,
      expanded,
      isCurrent,
      last,
    })
  }

  if (!expanded) return

  // hidden headers (user-only/labeled) keep the current path flat, one level per open branch
  const childDepth = showHeader ? depth + 1 : depth
  const childGutter = showHeader ? `${gutter}│ ` : gutter
  if (branchTranscript && tailStart >= 0) {
    // continue the parent's turn numbering: the branch's first turn follows the anchor's turn
    const turnAtAnchor =
      anchorIndex >= 0 && parentTranscript
        ? countTurns(ctx.filter, parentTranscript.messages.slice(0, anchorIndex + 1))
        : countTurns(ctx.filter, branchTranscript.messages.slice(0, tailStart))
    walkSession(ctx, branch.sessionID, tail, childDepth, childGutter, turnAtAnchor, out)
  }
  // With no rows of its own an on-path ancestor still must hand off to its on-path child, so the
  // DFS reaches the current session when an intermediate ancestor's transcript never loaded.
  descendOnPath(ctx, branch.sessionID, tail, childDepth, childGutter, out)
}

/** Keep the DFS descending the on-path chain even when a session's transcript is missing or
 *  empty: draw `sessionID`'s on-path child (known from the journal, no transcript needed) unless
 *  the walk over `walked` already drew it. Off-path sessions have no on-path child — a no-op. */
function descendOnPath(ctx: Ctx, sessionID: string, walked: TranscriptMessage[], depth: number, gutter: string, out: Row[]): void {
  const childID = ctx.onPathChild.get(sessionID)
  const child = childID ? ctx.state.sessions[childID] : undefined
  if (!child || walked.some((m) => m.id === child.anchorMessageID)) return
  pushBranch(ctx, child, depth, gutter, true, branchAllowed(ctx.filter), out)
}

/** The branches forked at `anchorMessageID` of `sessionID`, drawn just below that message.
 *  When a filter hides branch rows, only the current path recurses (off-path branches drop). */
function emitChildBranches(ctx: Ctx, sessionID: string, anchorMessageID: string, depth: number, gutter: string, out: Row[]): void {
  const children = (ctx.anchorMap.get(anchorMessageID) ?? []).filter((b) => b.parentSessionID === sessionID)
  if (children.length === 0) return
  const showHeaders = branchAllowed(ctx.filter)
  const visible = showHeaders ? children : children.filter((b) => ctx.onPath.has(b.sessionID))
  visible.forEach((branch, i) => {
    pushBranch(ctx, branch, depth, gutter, i === visible.length - 1, showHeaders, out)
  })
}

/** The message after which the current path leaves `sessionID` — its on-path child's anchor.
 *  undefined for the current session and for branches off the path (nothing forks away). */
function forkAnchorOf(ctx: Ctx, sessionID: string): string | undefined {
  const childID = ctx.onPathChild.get(sessionID)
  return childID ? ctx.state.sessions[childID]?.anchorMessageID : undefined
}

/**
 * Depth-first over one session: emit its own `messages` (the tail after any copied prefix)
 * as rows at `depth`/`gutter`, and after each message recurse into the branches anchored on
 * it. `turnStart` seeds the turn counter (a branch continues its parent's numbering).
 *
 * Rows are marked `inContext` while they are part of what the current session sends: an
 * ancestor's rows up to and including its fork point, and the current session's own rows.
 * Where that stops, one separator row is drawn before the next row this session contributes.
 */
function walkSession(ctx: Ctx, sessionID: string, messages: TranscriptMessage[], depth: number, gutter: string, turnStart: number, out: Row[]): void {
  const lastUserIndex = findLastUserIndex(messages, ctx.filter)
  const counter = { turn: turnStart }
  // set by a hidden plugin command turn, so the acknowledgement that follows it goes too
  let inPluginCommand = false
  const forkAnchor = forkAnchorOf(ctx, sessionID)
  let inContext = ctx.onPath.has(sessionID)
  // anchor "" — the path forked before this session's first message, so none of it is sent
  let separatorDue = inContext && forkAnchor === ""
  if (separatorDue) inContext = false
  messages.forEach((message, i) => {
    const before = out.length
    if (message.role === "user") {
      inPluginCommand = hiddenPluginTurn(ctx.filter, message)
      if (!inPluginCommand) {
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
            inContext,
          })
        }
      }
    } else if (!inPluginCommand) {
      emitAssistantRows(ctx, sessionID, message, depth, gutter, inContext, out)
    }
    // Branches attach right after their anchor — the last message they share with
    // this session — whichever role that message has.
    emitChildBranches(ctx, sessionID, message.id, depth, gutter, out)

    // drawn lazily, so a fork point with nothing after it never leaves a dangling separator
    if (separatorDue && out.length > before) {
      out.splice(before, 0, { kind: "separator", id: `separator:${sessionID}`, depth, gutter, text: OFF_PATH_TEXT })
      separatorDue = false
    }
    if (inContext && message.id === forkAnchor) {
      inContext = false
      separatorDue = true
    }
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
    case "separator":
      return [] // decoration: a flat search hit list has no fork point to divide
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

/** The last assistant turn's whole prompt in the current session — `tokens.input` *plus* the
 *  cached prompt tokens, which the model still had to hold — and what the next request adds on
 *  top of it: that turn's own output/reasoning (exact when the provider counted it) and its tool
 *  results (always chars/4) — following `tokens.ts`'s `contextSizeOf` (DESIGN.md §3.3 /
 *  §6.7). `estimated` is true only when a guess really is part of the figure. */
function computeTotalTokens(transcript: Transcript): { tokens: number; estimated: boolean } {
  let lastIndex = -1
  let lastPrompt = 0
  transcript.messages.forEach((m, idx) => {
    // matches OpenCode's own sidebar gauge / tokens.ts's contextSizeOf: skip a turn with no
    // output yet in favor of the last one that finished
    if (m.role === "assistant" && typeof m.tokens?.output === "number" && m.tokens.output > 0) {
      lastIndex = idx
      lastPrompt = (m.tokens.input ?? 0) + (m.tokens.cache?.read ?? 0) + (m.tokens.cache?.write ?? 0)
    }
  })

  // starts AT the last assistant: its prompt is the context it was *given*
  let counted = 0
  let guessed = 0
  for (let i = Math.max(lastIndex, 0); i < transcript.messages.length; i++) {
    const m = transcript.messages[i]!
    if (m.role === "user") {
      guessed += estimateTokens(userText(m))
      continue
    }
    // `tokens.output` covers what the model generated, never the tool results it read back
    const output = m.tokens?.output
    if (typeof output === "number") counted += output + (m.tokens?.reasoning ?? 0)
    for (const p of m.parts) if (p.type === "tool" || typeof output !== "number") guessed += estimateTokens(partText(p))
  }

  return { tokens: lastPrompt + counted + guessed, estimated: lastIndex === -1 || guessed > 0 }
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/** The current session and every ancestor from the root down to it — the path drawn open by
 *  default. Exported so the route can seed its fold state / know what is "on the path". */
export function currentChainOf(state: TreeState, currentSessionID: string): string[] {
  return [...ancestorChainOf(state, currentSessionID), currentSessionID]
}

/** How many messages of the current session's transcript are copied prefix: the summed length
 *  every *loaded* on-path ancestor contributes (an unloaded ancestor adds nothing, so its share
 *  falls to the current session). Mirrors buildSpineMap's `from`, so the render and the
 *  crop/spine translation slice the current transcript at the same point. */
function prefixLengthOf(state: TreeState, transcripts: Record<string, Transcript>, chain: string[]): number {
  let from = 0
  for (let s = 0; s < chain.length - 1; s++) {
    const own = transcripts[chain[s]!]
    const child = state.sessions[chain[s + 1]!]
    const anchorIndex = own && child ? own.messages.findIndex((m) => m.id === child.anchorMessageID) : -1
    if (anchorIndex >= 0) from = anchorIndex + 1
  }
  return from
}

export function buildTreeView(o: BuildOptions): TreeView {
  const currentTranscript = o.transcripts[o.currentSessionID]
  const chain = currentChainOf(o.state, o.currentSessionID)

  // Render from the tree's declared root when its transcript is loaded, else the furthest
  // loaded ancestor of the current session, else the current session itself. The DFS below
  // then reaches every branch and sibling from there, so nothing is "elsewhere".
  let root = o.currentSessionID
  if (o.state.root && o.transcripts[o.state.root]) root = o.state.root
  else for (const s of chain) if (o.transcripts[s]) { root = s; break }

  const rootTranscript = o.transcripts[root]
  if (!rootTranscript) return { rows: [], indexById: {}, currentRowId: undefined, totalTokens: 0, totalEstimated: false }

  const ctx: Ctx = {
    state: o.state,
    transcripts: o.transcripts,
    currentSessionID: o.currentSessionID,
    expanded: o.expanded,
    filter: o.filter,
    labels: o.labels ?? {},
    crops: o.crops ?? [],
    anchorMap: buildAnchorMap(o.state),
    onPath: new Set(chain),
    onPathChild: new Map(chain.slice(0, -1).map((s, i) => [s, chain[i + 1]!])),
    currentTailStart: prefixLengthOf(o.state, o.transcripts, chain),
  }

  const allRows: Row[] = []
  // branches forked before the first message (anchor "") sit above the root's messages
  emitChildBranches(ctx, root, "", 0, "", allRows)
  walkSession(ctx, root, rootTranscript.messages, 0, "", 0, allRows)
  // if the render root's on-path child wasn't drawn among its messages (its anchor isn't in the
  // loaded root transcript), descend anyway so the path to the current session is never cut
  descendOnPath(ctx, root, rootTranscript.messages, 0, "", allRows)

  const rows = o.search ? applySearch(allRows, o.search) : allRows

  // the current session's tip: its last message row, or — for a fork with no messages of its
  // own yet — its own branch header
  let currentRowId: string | undefined
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!
    if ((r.kind === "turn" || r.kind === "step") && r.sessionID === o.currentSessionID) {
      currentRowId = r.id
      break
    }
  }
  if (!currentRowId) currentRowId = rows.find((r) => r.kind === "branch" && r.isCurrent)?.id

  const indexById: Record<string, number> = {}
  rows.forEach((r, i) => {
    indexById[r.id] = i
  })

  const total = currentTranscript ? computeTotalTokens(currentTranscript) : { tokens: 0, estimated: false }
  return { rows, indexById, currentRowId, totalTokens: total.tokens, totalEstimated: total.estimated }
}


// ---------------------------------------------------------------------------
// Positional map between spine rows and the current session's copied prefix.
// ---------------------------------------------------------------------------

export type SpineEntry = { sessionID: string; messageID: string }

/**
 * Every message on a session's context path, root-first: each on-path ancestor's copied
 * prefix named by *its own* message IDs, then the session's own tail. Position `i` is the
 * index of that message in `transcripts[sessionID].messages`, so two sessions' spines can be
 * compared entry-by-entry (`sessionID:messageID`) to find where they diverge — see
 * `abandonedTail` in `core/actions.ts`.
 *
 * An ancestor whose transcript is not loaded contributes nothing and its share falls to the
 * session itself, exactly as `prefixLengthOf` and `buildSpineMap` treat it.
 */
export function spineOf(state: TreeState, transcripts: Record<string, Transcript>, sessionID: string): SpineEntry[] {
  const chain = currentChainOf(state, sessionID)
  const out: SpineEntry[] = []
  let from = 0
  for (let s = 0; s < chain.length; s++) {
    const sid = chain[s]!
    const own = transcripts[sid]
    const child = chain[s + 1]
    if (child !== undefined) {
      const anchorID = state.sessions[child]?.anchorMessageID
      const anchorIndex = own && anchorID !== undefined ? own.messages.findIndex((m) => m.id === anchorID) : -1
      if (own && anchorIndex !== -1) {
        for (const m of own.messages.slice(from, anchorIndex + 1)) out.push({ sessionID: sid, messageID: m.id })
        from = anchorIndex + 1
      }
      continue
    }
    if (own) for (const m of own.messages.slice(from)) out.push({ sessionID: sid, messageID: m.id })
  }
  return out
}

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
  const owner: SpineEntry[] = current ? spineOf(o.state, o.transcripts, o.currentSessionID) : []
  owner.forEach((e, i) => index.set(`${e.sessionID}:${e.messageID}`, i))
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
