/**
 * TUI-side actions (DESIGN.md §6.2, §6.3, §4.2). Everything here talks to OpenCode
 * through `api.client` (SDK v2) and writes journal lines through the shared store.
 * Pure planning lives in core; this file only executes plans.
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createSignal } from "solid-js"
import fs from "node:fs"
import path from "node:path"
import type { JournalStore } from "../shared/store.js"
import { withBranchLabel, type CropAppliedData, type JournalEntry, type TreeState } from "../core/journal.js"
import type { UndoPlan } from "../core/undo.js"
import type { TranscriptMessage } from "../core/transcript.js"
import { contextSizeOf, formatK, type MinimalMessage } from "../core/tokens.js"
import { DECISION_SYSTEM, branchTranscriptText, buildDecisionDraftPrompt, decisionMessageText, decisionRecord, decisionTemplate, openSiblings, templatePlaceholders } from "../core/decision.js"
import { editInExternalEditor, hasEditor } from "./editor.js"
import { debug } from "../shared/debug.js"
import { fetchTranscript } from "./transcripts.js"

export type JumpPlan =
  | { kind: "noop"; reason: string }
  | { kind: "switch"; sessionID: string }
  | { kind: "fork"; sessionID: string; messageID: string; prefill?: string; mode: "redo" | "continue" }

export type ActionContext = {
  api: TuiPluginApi
  store: JournalStore
  directory: string
}

export type SummaryChoice = { kind: "none" } | { kind: "summarize"; customInstructions?: string }

const [revision, setRevision] = createSignal(0)
/** The journal is plain files, so views built from `store.stateFor*` subscribe to this
 *  counter to notice writes made by this TUI (the sidebar card, the route). */
export const journalRevision = revision
export function bumpJournal(): void {
  setRevision((n) => n + 1)
}

/** Every journal write from the TUI goes through here, so none can forget the bump. */
function record<T extends JournalEntry["type"]>(ctx: ActionContext, treeId: string, type: T, data: Extract<JournalEntry, { type: T }>["data"]): JournalEntry {
  // generic forwarding trips TS's intersection of all data shapes, as in JournalStore.record
  const entry = ctx.store.record(treeId, type, data as never, "tui")
  bumpJournal()
  return entry
}

const SUMMARY_SYSTEM =
  "You are a context summarization assistant. Read a conversation between a user and an AI coding assistant and produce a structured summary in the exact format requested. Do NOT continue the conversation; ONLY output the summary."

const SUMMARY_INSTRUCTIONS = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned, or "(none)"]

## Progress
### Done
- [x] [Completed tasks/changes]
### In Progress
- [ ] [Work started but not finished]
### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

export const SUMMARY_PREAMBLE = "The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\n"

/** Mirror the tree linkage into `session.metadata.ctree` (DESIGN.md §4.2). Best effort. */
export async function mirrorMetadata(
  ctx: ActionContext,
  sessionID: string,
  ctree: Record<string, unknown>,
): Promise<void> {
  const existing = await ctx.api.client.session.get({ sessionID, directory: ctx.directory }).catch(() => undefined)
  const metadata = { ...((existing?.data as any)?.metadata ?? {}), ctree: { ...(((existing?.data as any)?.metadata ?? {}).ctree ?? {}), ...ctree } }
  await ctx.api.client.session.update({ sessionID, directory: ctx.directory, metadata }).catch(() => undefined)
}

export function navigateToSession(ctx: ActionContext, sessionID: string): void {
  ctx.api.route.navigate("session", { sessionID })
}

/** A branch's display name: adopted native forks carry no journal `name`, so fall back to
 *  the session's own title (DESIGN.md §4.1's `kind: "native"`). */
export function branchLabel(api: TuiPluginApi, sessionID: string, name: string | undefined, max?: number): string {
  const label = name ?? api.state.session.get(sessionID)?.title ?? "branch"
  return max === undefined ? label : clip(label, max)
}

/** `provider/model` of the last reply in a transcript — OpenCode stamps every assistant
 *  message with the model that answered, which is the session's current model. */
export function lastAnsweringModel(messages: readonly { role?: string; providerID?: string; modelID?: string }[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === "assistant" && m.providerID && m.modelID) return `${m.providerID}/${m.modelID}`
  }
  return undefined
}

/** Abort a streaming session before we leave it (DESIGN.md §9, Pi #7022). */
async function abortIfBusy(ctx: ActionContext, sessionID: string): Promise<boolean> {
  const status = ctx.api.state.session.status(sessionID)
  if (!status || (status as any).type === "idle") return false
  await ctx.api.client.session.abort({ sessionID, directory: ctx.directory }).catch(() => undefined)
  ctx.api.ui.toast({ variant: "warning", message: "Aborted the running response before switching" })
  return true
}

/** Fork `sessionID` at `messageID` (exclusive, OpenCode semantics), journal it, mirror metadata. */
export async function forkBranch(
  ctx: ActionContext,
  input: { sessionID: string; messageID: string; name?: string; kind: "explicit" | "jump" | "redo"; branchModel?: string; trunkModel?: string; title?: string },
): Promise<string> {
  const treeId = ctx.store.ensureTree(input.sessionID, "tui")
  // journal anchors are the last *shared* message (inclusive); OpenCode's fork boundary is exclusive.
  // The owning session may not be loaded in this TUI (jumping into an ancestor), so read it via the SDK.
  const parentMsgs = (await fetchTranscript(ctx.api, input.sessionID, ctx.directory)).messages
  const boundary = parentMsgs.findIndex((m) => m.id === input.messageID)
  if (boundary === -1) throw new Error("fork point not found in the session")
  const anchorMessageID = boundary > 0 ? parentMsgs[boundary - 1]!.id : ""
  const forked = await ctx.api.client.session.fork({ sessionID: input.sessionID, messageID: input.messageID, directory: ctx.directory })
  const forkedID = (forked.data as any)?.id as string | undefined
  if (!forkedID) throw new Error("fork did not return a session id")
  ctx.store.registerSession(forkedID, treeId)
  record(ctx, treeId, "branch.opened", { sessionID: forkedID, parentSessionID: input.sessionID, anchorMessageID, name: input.name, kind: input.kind, branchModel: input.branchModel, trunkModel: input.trunkModel })
  if (input.title) await ctx.api.client.session.update({ sessionID: forkedID, directory: ctx.directory, title: input.title }).catch(() => undefined)
  await mirrorMetadata(ctx, forkedID, { treeId, parentSessionID: input.sessionID, anchorMessageID, name: input.name, status: "open" })
  await mirrorMetadata(ctx, input.sessionID, { treeId })
  return forkedID
}

/** `/branch <name> [model]` from the tip of the current session (DESIGN.md §6.3). */
export async function createNamedBranch(
  ctx: ActionContext,
  input: { sessionID: string; name: string; model?: string; trunkModel?: string },
): Promise<string> {
  const msgs = ctx.api.state.session.messages(input.sessionID)
  const last = msgs[msgs.length - 1]
  debug("branch.start", { sessionID: input.sessionID, name: input.name, messages: msgs.length, status: ctx.api.state.session.status(input.sessionID) })
  if (!last) throw new Error("nothing to branch from yet")
  await abortIfBusy(ctx, input.sessionID)
  debug("branch.afterAbort")
  // Fork "after the tip": OpenCode copies messages strictly before messageID, so we pass a
  // sentinel by forking without messageID (full copy) — the SDK accepts messageID undefined.
  const treeId = ctx.store.ensureTree(input.sessionID, "tui")
  debug("branch.tree", { treeId })
  const forked = await ctx.api.client.session.fork({ sessionID: input.sessionID, directory: ctx.directory })
  debug("branch.forked", { data: forked.data, error: forked.error })
  const forkedID = (forked.data as any)?.id as string | undefined
  if (!forkedID) throw new Error("fork did not return a session id")
  ctx.store.registerSession(forkedID, treeId)
  record(ctx, treeId, "branch.opened", { sessionID: forkedID, parentSessionID: input.sessionID, anchorMessageID: last.id, name: input.name, kind: "explicit", branchModel: input.model, trunkModel: input.trunkModel })
  debug("branch.recorded")
  record(ctx, treeId, "label.set", { sessionID: input.sessionID, messageID: last.id, label: withBranchLabel(ctx.store.stateFor(treeId).labels[last.id]?.label, input.name) })
  await ctx.api.client.session.update({ sessionID: forkedID, directory: ctx.directory, title: `⎇ ${input.name}` }).catch(() => undefined)
  await mirrorMetadata(ctx, forkedID, { treeId, parentSessionID: input.sessionID, anchorMessageID: last.id, name: input.name, status: "open" })
  await mirrorMetadata(ctx, input.sessionID, { treeId })
  debug("branch.mirrored")
  navigateToSession(ctx, forkedID)
  ctx.api.ui.toast({ variant: "success", message: `⎇ ${input.name} opened${input.model ? ` on ${input.model}` : ""}` })
  debug("branch.done", { forkedID })
  return forkedID
}

/** Execute a jump plan (DESIGN.md §6.2). Returns the session we ended up in. */
export async function executeJump(
  ctx: ActionContext,
  plan: JumpPlan,
  opts: { currentSessionID: string; summary: SummaryChoice },
): Promise<string | undefined> {
  debug("jump.plan", { plan, current: opts.currentSessionID, summary: opts.summary.kind })
  if (plan.kind === "noop") {
    ctx.api.ui.toast({ message: plan.reason })
    return undefined
  }
  await abortIfBusy(ctx, opts.currentSessionID)
  const leavingTip = ctx.api.state.session.messages(opts.currentSessionID).at(-1)?.id
  let target: string
  if (plan.kind === "switch") {
    target = plan.sessionID
  } else {
    target = await forkBranch(ctx, { sessionID: plan.sessionID, messageID: plan.messageID, kind: plan.mode === "redo" ? "redo" : "jump" })
  }
  if (opts.summary.kind === "summarize" && leavingTip && target !== opts.currentSessionID) {
    // the fork already exists; a failed summary must not strand the user on the old session
    await summarizeInto(ctx, { fromSessionID: opts.currentSessionID, fromMessageID: leavingTip, targetSessionID: target, customInstructions: opts.summary.customInstructions }).catch((e) =>
      ctx.api.ui.toast({ variant: "error", message: `summary failed: ${e instanceof Error ? e.message : String(e)} — moved without it` }),
    )
  }
  debug("jump.navigate", { target })
  navigateToSession(ctx, target)
  if (plan.kind === "fork" && plan.prefill) {
    await new Promise((r) => setTimeout(r, 0))
    await ctx.api.client.tui.appendPrompt({ text: plan.prefill, directory: ctx.directory }).catch(() => undefined)
  }
  return target
}

/** Pi-style summary of the branch we are leaving, generated in a throw-away helper session and
 *  injected into the destination with `noReply` (DESIGN.md §6.2, journal `summary.recorded`). */
export async function summarizeInto(
  ctx: ActionContext,
  input: { fromSessionID: string; fromMessageID: string; targetSessionID: string; customInstructions?: string; signal?: AbortSignal },
): Promise<string | undefined> {
  const msgs = await ctx.api.client.session.messages({ sessionID: input.fromSessionID, directory: ctx.directory })
  const transcript = ((msgs.data as any[]) ?? [])
    .map((m) => {
      const role = m.info.role === "user" ? "[User]" : "[Assistant]"
      const text = (m.parts as any[])
        .map((p) => (p.type === "text" ? p.text : p.type === "tool" ? `(tool ${p.tool}: ${JSON.stringify(p.state?.input ?? {}).slice(0, 200)} → ${String(p.state?.output ?? "").slice(0, 400)})` : ""))
        .filter(Boolean)
        .join("\n")
      return text ? `${role}: ${text}` : ""
    })
    .filter(Boolean)
    .join("\n\n")
  debug("summary.start", { from: input.fromSessionID, target: input.targetSessionID, chars: transcript.length })
  const helper = await ctx.api.client.session.create({ directory: ctx.directory, title: "Context tree: branch summary" })
  const helperID = (helper.data as any)?.id as string | undefined
  if (!helperID) throw new Error("could not create helper session")
  try {
    const instructions = input.customInstructions ? `${SUMMARY_INSTRUCTIONS}\n\nAdditional focus from the user:\n${input.customInstructions}` : SUMMARY_INSTRUCTIONS
    const reply = await ctx.api.client.session.prompt({
      sessionID: helperID,
      directory: ctx.directory,
      system: SUMMARY_SYSTEM,
      parts: [{ type: "text", text: `<conversation>\n${transcript}\n</conversation>\n\n${instructions}` }],
    })
    const summary = ((reply.data as any)?.parts as any[] | undefined)
      ?.filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
      .map((p) => p.text)
      .join("")
      .trim()
    debug("summary.generated", { chars: summary?.length ?? 0 })
    if (!summary) throw new Error("summary model returned no text")
    const injected = await ctx.api.client.session.prompt({
      sessionID: input.targetSessionID,
      directory: ctx.directory,
      noReply: true,
      parts: [{ type: "text", text: SUMMARY_PREAMBLE + summary, metadata: { ctree: { kind: "summary", fromSessionID: input.fromSessionID } } }],
    })
    const messageID = (injected.data as any)?.info?.id ?? (injected.data as any)?.id
    const treeId = ctx.store.ensureTree(input.targetSessionID, "tui")
    record(ctx, treeId, "summary.recorded", { sessionID: input.targetSessionID, messageID: String(messageID ?? ""), fromSessionID: input.fromSessionID, fromMessageID: input.fromMessageID })
    ctx.api.ui.toast({ variant: "success", message: "Branch summary added" })
    return summary
  } finally {
    await ctx.api.client.session.delete({ sessionID: helperID, directory: ctx.directory }).catch(() => undefined)
  }
}

export function setLabel(ctx: ActionContext, input: { sessionID: string; messageID: string; label: string | null }): void {
  const treeId = ctx.store.ensureTree(input.sessionID, "tui")
  record(ctx, treeId, "label.set", { sessionID: input.sessionID, messageID: input.messageID, label: input.label })
}

/** Record a crop (the server half applies it on the next turn). With `hard`, result crops
 *  additionally set OpenCode's own `state.time.compacted` flag on the tool part, so the
 *  TUI renders "[Old tool result content cleared]" and hides the text (DESIGN.md §6.5). */
export async function applyCrop(ctx: ActionContext, data: CropAppliedData, opts: { hard?: boolean } = {}): Promise<string> {
  const treeId = ctx.store.ensureTree(data.sessionID, "tui")
  const entry = record(ctx, treeId, "crop.applied", data)
  if (opts.hard && data.mode === "result") await setCompacted(ctx, data.sessionID, data.targets.map((t) => ({ messageID: t.messageID, partID: t.partID })), Date.now())
  return entry.id
}

async function setCompacted(ctx: ActionContext, sessionID: string, targets: { messageID: string; partID?: string }[], value: number | undefined): Promise<void> {
  for (const t of targets) {
    if (!t.partID) continue
    const part = (ctx.api.state.part(t.messageID) as unknown as any[]).find((p) => p.id === t.partID)
    if (!part || part.type !== "tool" || part.state?.status !== "completed") continue
    const next = { ...part, state: { ...part.state, time: { ...(part.state.time ?? {}), compacted: value } } }
    if (value === undefined) delete next.state.time.compacted
    await ctx.api.client.part.update({ sessionID, messageID: t.messageID, partID: t.partID, directory: ctx.directory, part: next } as any).catch((e: unknown) => debug("hardcrop.error", { error: String(e) }))
  }
}

/** Execute an undo plan (DESIGN.md §6.6). Returns the session to show afterwards. */
export async function executeUndo(ctx: ActionContext, sessionID: string, plan: UndoPlan): Promise<string | undefined> {
  const treeId = ctx.store.ensureTree(sessionID, "tui")
  debug("undo.plan", { plan })
  switch (plan.kind) {
    case "nothing":
      ctx.api.ui.toast({ message: "nothing to undo on this path" })
      return undefined
    case "restore-crop": {
      record(ctx, treeId, "crop.restored", { cropID: plan.cropID })
      const crop = ctx.store.stateFor(treeId).crops[plan.cropID]
      if (crop && crop.mode === "result") await setCompacted(ctx, sessionID, crop.targets.map((t) => ({ messageID: t.messageID, partID: t.partID })), undefined)
      ctx.api.ui.toast({ variant: "success", message: `↶ restored ${plan.mode === "turn" ? "dropped turn" : "cropped result"} (~${Math.round(plan.estTokens / 100) / 10}k tokens back in context)` })
      return undefined
    }
    case "abandon-branch": {
      await abortIfBusy(ctx, sessionID)
      record(ctx, treeId, "branch.closed", { sessionID: plan.sessionID, status: "abandoned" })
      await mirrorMetadata(ctx, plan.sessionID, { status: "abandoned" })
      navigateToSession(ctx, plan.parentSessionID)
      ctx.api.ui.toast({ variant: "success", message: `↶ back on the trunk; ⎇ ${branchLabel(ctx.api, plan.sessionID, plan.name)} kept as abandoned` })
      return plan.parentSessionID
    }
    case "reopen-branch": {
      const branch = ctx.store.stateFor(treeId).sessions[plan.sessionID]
      if (!branch) return undefined
      record(ctx, treeId, "branch.opened", { sessionID: branch.sessionID, parentSessionID: branch.parentSessionID, anchorMessageID: branch.anchorMessageID, name: branch.name, kind: branch.kind, branchModel: branch.branchModel, trunkModel: branch.trunkModel })
      await mirrorMetadata(ctx, plan.sessionID, { status: "open" })
      navigateToSession(ctx, plan.sessionID)
      ctx.api.ui.toast({ variant: "success", message: `↶ re-opened ⎇ ${branchLabel(ctx.api, plan.sessionID, branch.name)}${plan.decisionMessageID ? " (its decision record is hidden from the model)" : ""}` })
      return plan.sessionID
    }
  }
}

/** Run one prompt in a throw-away helper session and return the assistant text. */
export async function draftWithHelper(ctx: ActionContext, input: { title: string; system: string; prompt: string; model?: { providerID: string; modelID: string } }): Promise<string> {
  const helper = await ctx.api.client.session.create({ directory: ctx.directory, title: input.title })
  const helperID = (helper.data as any)?.id as string | undefined
  if (!helperID) throw new Error("could not create helper session")
  try {
    const reply = await ctx.api.client.session.prompt({ sessionID: helperID, directory: ctx.directory, system: input.system, model: input.model, parts: [{ type: "text", text: input.prompt }] })
    const text = ((reply.data as any)?.parts as any[] | undefined)
      ?.filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
      .map((p) => p.text)
      .join("")
      .trim()
    if (!text) throw new Error("the model returned no text")
    return text
  } finally {
    await ctx.api.client.session.delete({ sessionID: helperID, directory: ctx.directory }).catch(() => undefined)
  }
}

export type MergeMode = "squash" | "squash-no-llm" | "discard" | "tournament"

/** The promise every merge confirmation repeats — the reason a merge is safe to try. */
export const MERGE_TRUST = "Your transcript is never rewritten; the record is appended to the trunk as a normal message."

/** The tree route's undo key (`x` stays as an alias); every hint we print names this one. */
export const UNDO_KEY = "u"

/** What the $EDITOR gate opens with: the draft is a proposal, saving is the confirmation. */
export const MERGE_GATE_NOTICE = `Edit the ◆ decision record, then save to confirm (empty file or a non-zero exit aborts the merge).\n${MERGE_TRUST}`

/** The discard gate's message: the same promise, plus the way back. */
export const DISCARD_NOTICE = `${MERGE_TRUST}\nThe branch is only marked rejected — ${UNDO_KEY} (alias x) undoes it.`

/** Where the merge lands, as the picker should name it. `label` is `TRUNK_LABEL` for the tree
 *  root, else the parent branch's name; the figures come from the parent's own transcript. */
export type MergeTarget = { label: string; turns: number; tokens: number }

export const TRUNK_LABEL = "trunk"

/** The picker's destination figures, computed the same way on every surface (the gauge's own
 *  context size and the user-turn count) so the numbers on one screen agree. `anchor` counts
 *  the destination's *own* turns, like its tree row — a nested parent's inherited prefix is
 *  not its work; the trunk has no anchor and counts all of them. */
export function mergeTargetOf(label: string, messages: readonly TranscriptMessage[], anchor?: { messageID?: string; parentMessageIDs: readonly string[] }): MergeTarget {
  const minimal = messages.map((m): MinimalMessage => ({ info: m.role === "assistant" ? { role: "assistant", tokens: m.tokens } : { role: "user" }, parts: m.parts }))
  const turns = anchor ? ownTurnCount(messages, anchor) : messages.filter((m) => m.role === "user").length
  return { label, turns, tokens: contextSizeOf(minimal).tokens }
}

/** Everything the merge picker's header needs, counted past each session's own anchor so the
 *  figures match the tree's rows: what the branch would fold, and where it lands. */
export async function mergePickerFigures(ctx: ActionContext, state: TreeState, sessionID: string): Promise<{ turns: number; target?: MergeTarget }> {
  const branch = state.sessions[sessionID]
  if (!branch) return { turns: 0 }
  // the parent is usually not the loaded session, so its figures come over the SDK
  const parent = await fetchTranscript(ctx.api, branch.parentSessionID, ctx.directory).catch(() => undefined)
  const turns = ownTurnCount(ctx.api.state.session.messages(sessionID), { messageID: branch.anchorMessageID, parentMessageIDs: parent?.messages.map((m) => m.id) ?? [] })
  if (!parent) return { turns }
  const up = state.sessions[branch.parentSessionID]
  const grand = up ? await fetchTranscript(ctx.api, up.parentSessionID, ctx.directory).catch(() => undefined) : undefined
  const anchor = up ? { messageID: up.anchorMessageID, parentMessageIDs: grand?.messages.map((m) => m.id) ?? [] } : undefined
  return { turns, target: mergeTargetOf(up ? branchLabel(ctx.api, up.sessionID, up.name) : TRUNK_LABEL, parent.messages, anchor) }
}

/** The branch's *own* user turns — the ones a squash folds into the record. Sliced like
 *  `branchTranscriptText`: everything past the anchor's index in the parent (an unknown anchor
 *  counts the whole session rather than throwing; this figure is only a label). */
export function ownTurnCount(messages: readonly { role: string }[], anchor: { messageID?: string; parentMessageIDs: readonly string[] }): number {
  const anchorIndex = anchor.messageID ? anchor.parentMessageIDs.indexOf(anchor.messageID) : -1
  return messages.slice(anchorIndex + 1).filter((m) => m.role === "user").length
}

/** Shared copy for the merge picker (palette and route). Naming the destination "trunk" rather
 *  than quoting the parent's title keeps the title from reading as a question ("→ What does git
 *  rebase do?"). */
export function mergeDialogTitle(branchName: string, target?: MergeTarget | string, ownTurns?: number): string {
  // both counts are "own turns past the anchor", so neither can be read as the other's
  const from = `Merge ⎇ ${branchName}${ownTurns === undefined ? "" : ` (${plural(ownTurns, "turn")})`}`
  // a bare parent title is the old call shape, and quoting it is the bug: name the trunk instead
  if (!target || typeof target === "string") return `${from} → the trunk`
  const where = target.label === TRUNK_LABEL ? TRUNK_LABEL : `⎇ ${clip(target.label, 24)}`
  return `${from} → ${where} (${plural(target.turns, "turn")}, ~${formatK(target.tokens)})`
}

/** Tournament only exists when there is something to compare against. Descriptions render on
 *  the option's own line, which truncates past ~50 columns — keep them short; the full promise
 *  is repeated at the confirmation step (`MERGE_TRUST`). */
export function mergeDialogOptions(input: { siblings: number; turns?: number }): { title: string; value: MergeMode; description: string }[] {
  const folds = input.turns === undefined ? "the branch" : plural(input.turns, "turn")
  return [
    { title: "Squash", value: "squash" as const, description: `1 model call · folds ${folds} into one ◆ record` },
    { title: "Squash without LLM", value: "squash-no-llm" as const, description: "you write it · no model call" },
    { title: "Discard", value: "discard" as const, description: "rejected · nothing lands in the trunk" },
    ...(input.siblings > 0 ? [{ title: "Tournament", value: "tournament" as const, description: "compare sibling branches and keep one" }] : []),
  ]
}

export type MergeInput = {
  sessionID: string
  mode: MergeMode
  note?: string
  /** how to confirm the record: external editor (default) or a pre-confirmed text */
  confirm?: (draft: string) => Promise<string | undefined>
}

/** Dialogs opened from an action (not from a route/palette handler), so every caller of
 *  `mergeBranch` gets the same gate. Both resolve to "cancelled" when the stack closes. */
function confirmDialog(ctx: ActionContext, title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    ctx.api.ui.dialog.replace(
      () =>
        ctx.api.ui.DialogConfirm({
          title,
          message,
          onConfirm: () => {
            resolve(true)
            ctx.api.ui.dialog.clear()
          },
          onCancel: () => {
            resolve(false)
            ctx.api.ui.dialog.clear()
          },
        }),
      () => resolve(false),
    )
  })
}

function promptDialog(ctx: ActionContext, title: string, placeholder?: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    ctx.api.ui.dialog.replace(
      () =>
        ctx.api.ui.DialogPrompt({
          title,
          placeholder,
          onConfirm: (value) => {
            resolve(value)
            ctx.api.ui.dialog.clear()
          },
          onCancel: () => {
            resolve(undefined)
            ctx.api.ui.dialog.clear()
          },
        }),
      () => resolve(undefined),
    )
  })
}

/** Close the branch the session lives on (DESIGN.md §6.4). Returns the parent session id. */
export async function mergeBranch(ctx: ActionContext, input: MergeInput): Promise<string | undefined> {
  const treeId = ctx.store.ensureTree(input.sessionID, "tui")
  const state = ctx.store.stateFor(treeId)
  const branch = state.sessions[input.sessionID]
  if (!branch || branch.status !== "open") throw new Error("this session is not an open branch")
  const parentID = branch.parentSessionID
  const name = branchLabel(ctx.api, input.sessionID, branch.name)
  debug("merge.start", { mode: input.mode, sessionID: input.sessionID, parentID })
  await abortIfBusy(ctx, input.sessionID)

  // both paths measure the branch by its own turns: what a squash folds into the record is
  // also what a discard throws away — the prefix shared with the parent is neither
  const parentMsgs = await ctx.api.client.session.messages({ sessionID: parentID, directory: ctx.directory }).catch(() => undefined)
  const parentMessageIDs = ((parentMsgs?.data as any[]) ?? []).map((m) => String(m.info.id))
  const own = await fetchOwnTranscript(ctx, input.sessionID)
  const turns = ownTurnCount(own.messages, { messageID: branch.anchorMessageID, parentMessageIDs })

  if (input.mode === "discard") {
    // discard is the one mode that lands nothing, so it gets its own gate — and a cancelled
    // note prompt has to abort too, not fall through as "no note"
    const ok = await confirmDialog(ctx, `Discard ⎇ ${name} (${plural(turns, "turn")})?`, DISCARD_NOTICE)
    if (!ok) {
      ctx.api.ui.toast({ variant: "warning", message: `⎇ ${name} kept — nothing discarded` })
      return undefined
    }
    let note = input.note
    if (note === undefined) {
      const answer = await promptDialog(ctx, "Why? (optional note on the close marker)", "dead end")
      if (answer === undefined) {
        ctx.api.ui.toast({ variant: "warning", message: `⎇ ${name} kept — nothing discarded` })
        return undefined
      }
      note = answer.trim() || undefined
    }
    record(ctx, treeId, "branch.closed", { sessionID: input.sessionID, status: "rejected", note })
    await mirrorMetadata(ctx, input.sessionID, { status: "rejected" })
    navigateToSession(ctx, parentID)
    ctx.api.ui.toast({ variant: "success", message: `⎇ ${name} discarded — back on the trunk` })
    return parentID
  }

  // --- draft ---------------------------------------------------------------
  const transcript = branchTranscriptText(own, { messageID: branch.anchorMessageID, parentMessageIDs })
  // no journal model (an adopted fork, or /branch without one) still knows what answered here
  const model = branch.branchModel ?? branch.trunkModel ?? own.model
  const modelRef = model ? { providerID: model.split("/")[0]!, modelID: model.split("/").slice(1).join("/") } : undefined
  const siblingIDs = input.mode === "tournament" ? openSiblings(state, input.sessionID) : []
  const siblings = await Promise.all(
    siblingIDs.map(async (id) => {
      const tr = await fetchOwnTranscript(ctx, id)
      const b = state.sessions[id]!
      return { name: branchLabel(ctx.api, id, b.name), transcript: branchTranscriptText(tr, { messageID: b.anchorMessageID, parentMessageIDs }, 800) }
    }),
  )
  let draft: string
  // a record the user typed field by field needs no second gate: the dialogs were it
  let typed = false
  if (input.mode === "squash-no-llm") {
    // with no $EDITOR the gate has nowhere to type, so the fields are asked one dialog at a time
    if (hasEditor()) draft = decisionTemplate(name, model)
    else {
      const written = await promptDecisionRecord(ctx, name, model)
      if (!written) {
        ctx.api.ui.toast({ variant: "warning", message: "merge aborted — nothing written" })
        return undefined
      }
      draft = written
      typed = true
    }
  } else {
    ctx.api.ui.toast({ message: `drafting the decision record for ⎇ ${name}…` })
    draft = await draftWithHelper(ctx, { title: `Context tree: draft for ${name}`, system: DECISION_SYSTEM, prompt: buildDecisionDraftPrompt({ branchName: name, model, transcript, siblings }), model: modelRef })
  }
  debug("merge.drafted", { chars: draft.length })

  // --- gate ----------------------------------------------------------------
  const confirm = input.confirm ?? (typed ? async (d: string) => d : (d: string) => editInExternalEditor(ctx.api.renderer as any, d, ctx.directory, MERGE_GATE_NOTICE))
  if (!input.confirm && !typed && !hasEditor()) throw new Error("no $EDITOR configured — set VISUAL/EDITOR, or use the in-app confirm")
  const confirmed = await confirm(draft)
  if (!confirmed) {
    ctx.api.ui.toast({ variant: "warning", message: "merge aborted — nothing written" })
    return undefined
  }
  // an unfilled template is not a record: landing it would cost the trunk ~130 tokens of
  // "<1–3 sentences: …>" and nothing else, so the branch stays open instead
  if (templatePlaceholders(confirmed).length > 0) {
    ctx.api.ui.toast({ variant: "warning", message: "record not written: fill in the template" })
    return undefined
  }

  // --- land ----------------------------------------------------------------
  const text = decisionMessageText(confirmed, name)
  const landed = await ctx.api.client.session.prompt({
    sessionID: parentID,
    directory: ctx.directory,
    noReply: true,
    parts: [{ type: "text", text, metadata: { ctree: { kind: "decision", forkSessionID: input.sessionID, branchName: name } } }],
  })
  const messageID = String((landed.data as any)?.info?.id ?? (landed.data as any)?.id ?? "")
  if (!messageID) throw new Error("could not write the decision record into the trunk")
  record(ctx, treeId, "decision.recorded", { sessionID: parentID, messageID, forkSessionID: input.sessionID, branchName: name, siblings: siblings.map((s) => ({ name: s.name })), text })
  record(ctx, treeId, "branch.closed", { sessionID: input.sessionID, status: "squashed", decisionMessageID: messageID })
  for (const id of siblingIDs) record(ctx, treeId, "branch.closed", { sessionID: id, status: "rejected", note: `lost tournament to ${name}` })
  await mirrorMetadata(ctx, input.sessionID, { status: "squashed", decisionMessageID: messageID })
  for (const id of siblingIDs) await mirrorMetadata(ctx, id, { status: "rejected" })
  debug("merge.landed", { messageID, siblings: siblingIDs.length })
  navigateToSession(ctx, parentID)
  ctx.api.ui.toast({ variant: "success", message: `◆ merged ⎇ ${name}${siblingIDs.length ? ` (+${siblingIDs.length} sibling${siblingIDs.length === 1 ? "" : "s"} closed)` : ""}` })
  return parentID
}

/** The record's fields, asked one dialog at a time — the fallback for a merge with no $EDITOR.
 *  Escape (or an empty outcome) aborts: a record nobody wrote is worse than no record. */
async function promptDecisionRecord(ctx: ActionContext, branchName: string, model?: string): Promise<string | undefined> {
  const outcome = await promptDialog(ctx, `◆ ${branchName} — outcome: what was concluded or built?`, "1–3 sentences")
  if (!outcome?.trim()) return undefined
  const why = await promptDialog(ctx, "Why? (optional, separate reasons with ';')", "the working set fits in memory")
  if (why === undefined) return undefined
  return decisionRecord({ branchName, model, outcome, why })
}

async function fetchOwnTranscript(ctx: ActionContext, sessionID: string) {
  const res = await ctx.api.client.session.messages({ sessionID, directory: ctx.directory })
  const raw = (res.data as any[]) ?? []
  const messages = raw.map((m) => ({
    id: m.info.id as string,
    role: (m.info.role === "user" ? "user" : "assistant") as "user" | "assistant",
    time: m.info.time,
    tokens: m.info.tokens,
    parts: (m.parts as any[]).map((p) => ({ id: p.id, type: p.type, text: p.text, tool: p.tool, callID: p.callID, state: p.state, time: p.time, metadata: p.metadata })),
  }))
  return { sessionID, title: sessionID, status: "available" as const, messages, model: lastAnsweringModel(raw.map((m) => m.info)) }
}

/** Shared copy for the branch-name dialog (palette and route). */
export const BRANCH_DIALOG = { title: "Branch here → new OpenCode session", placeholder: "name, e.g. try-redis", modelTitle: "Model for this branch (Enter keeps the current one)" }

/** Where `y` lands when the terminal has no OSC 52 clipboard (relative to the project). */
export const COPY_HINT = ".opencode/context-tree/last-copy.txt"

/** `y` copy: the terminal's own clipboard through @opentui's OSC 52 (works over ssh/tmux when
 *  the terminal allows it), falling back to `COPY_HINT`. Throws if that file cannot be written. */
export function copyText(api: TuiPluginApi, text: string, directory: string): { target: "clipboard" | "file"; hint: string } {
  const renderer = api.renderer as unknown as { copyToClipboardOSC52?: (text: string) => boolean } | undefined
  // an empty selection must never wipe the user's clipboard; it still lands in the file
  if (text && renderer?.copyToClipboardOSC52?.(text)) return { target: "clipboard", hint: "clipboard" }
  const file = path.join(directory, COPY_HINT)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return { target: "file", hint: COPY_HINT }
}

/** Truncate to `max` columns with an ellipsis — the sidebar and dialogs are narrow. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}
