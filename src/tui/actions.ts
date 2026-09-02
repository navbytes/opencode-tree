/**
 * TUI-side actions (DESIGN.md §6.2, §6.3, §4.2). Everything here talks to OpenCode
 * through `api.client` (SDK v2) and writes journal lines through the shared store.
 * Pure planning lives in core; this file only executes plans.
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { JournalStore } from "../shared/store.js"

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
  const forked = await ctx.api.client.session.fork({ sessionID: input.sessionID, messageID: input.messageID, directory: ctx.directory })
  const forkedID = (forked.data as any)?.id as string | undefined
  if (!forkedID) throw new Error("fork did not return a session id")
  ctx.store.registerSession(forkedID, treeId)
  ctx.store.record(
    treeId,
    "branch.opened",
    { sessionID: forkedID, parentSessionID: input.sessionID, anchorMessageID: input.messageID, name: input.name, kind: input.kind, branchModel: input.branchModel, trunkModel: input.trunkModel },
    "tui",
  )
  if (input.title) await ctx.api.client.session.update({ sessionID: forkedID, directory: ctx.directory, title: input.title }).catch(() => undefined)
  await mirrorMetadata(ctx, forkedID, { treeId, parentSessionID: input.sessionID, anchorMessageID: input.messageID, name: input.name, status: "open" })
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
  if (!last) throw new Error("nothing to branch from yet")
  await abortIfBusy(ctx, input.sessionID)
  // Fork "after the tip": OpenCode copies messages strictly before messageID, so we pass a
  // sentinel by forking without messageID (full copy) — the SDK accepts messageID undefined.
  const treeId = ctx.store.ensureTree(input.sessionID, "tui")
  const forked = await ctx.api.client.session.fork({ sessionID: input.sessionID, directory: ctx.directory })
  const forkedID = (forked.data as any)?.id as string | undefined
  if (!forkedID) throw new Error("fork did not return a session id")
  ctx.store.registerSession(forkedID, treeId)
  ctx.store.record(
    treeId,
    "branch.opened",
    { sessionID: forkedID, parentSessionID: input.sessionID, anchorMessageID: last.id, name: input.name, kind: "explicit", branchModel: input.model, trunkModel: input.trunkModel },
    "tui",
  )
  ctx.store.record(treeId, "label.set", { sessionID: input.sessionID, messageID: last.id, label: `⎇ ${input.name}` }, "tui")
  await ctx.api.client.session.update({ sessionID: forkedID, directory: ctx.directory, title: `⎇ ${input.name}` }).catch(() => undefined)
  await mirrorMetadata(ctx, forkedID, { treeId, parentSessionID: input.sessionID, anchorMessageID: last.id, name: input.name, status: "open" })
  await mirrorMetadata(ctx, input.sessionID, { treeId })
  navigateToSession(ctx, forkedID)
  ctx.api.ui.toast({ variant: "success", message: `⎇ ${input.name} opened${input.model ? ` on ${input.model}` : ""}` })
  return forkedID
}

/** Execute a jump plan (DESIGN.md §6.2). Returns the session we ended up in. */
export async function executeJump(
  ctx: ActionContext,
  plan: JumpPlan,
  opts: { currentSessionID: string; summary: SummaryChoice },
): Promise<string | undefined> {
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
    await summarizeInto(ctx, { fromSessionID: opts.currentSessionID, fromMessageID: leavingTip, targetSessionID: target, customInstructions: opts.summary.customInstructions })
  }
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
    if (!summary) throw new Error("summary model returned no text")
    const injected = await ctx.api.client.session.prompt({
      sessionID: input.targetSessionID,
      directory: ctx.directory,
      noReply: true,
      parts: [{ type: "text", text: SUMMARY_PREAMBLE + summary, metadata: { ctree: { kind: "summary", fromSessionID: input.fromSessionID } } }],
    })
    const messageID = (injected.data as any)?.info?.id ?? (injected.data as any)?.id
    const treeId = ctx.store.ensureTree(input.targetSessionID, "tui")
    ctx.store.record(treeId, "summary.recorded", { sessionID: input.targetSessionID, messageID: String(messageID ?? ""), fromSessionID: input.fromSessionID, fromMessageID: input.fromMessageID }, "tui")
    ctx.api.ui.toast({ variant: "success", message: "Branch summary added" })
    return summary
  } finally {
    await ctx.api.client.session.delete({ sessionID: helperID, directory: ctx.directory }).catch(() => undefined)
  }
}

export function setLabel(ctx: ActionContext, input: { sessionID: string; messageID: string; label: string | null }): void {
  const treeId = ctx.store.ensureTree(input.sessionID, "tui")
  ctx.store.record(treeId, "label.set", { sessionID: input.sessionID, messageID: input.messageID, label: input.label }, "tui")
}
