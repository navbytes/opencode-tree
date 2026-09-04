/**
 * Journal entry types and pure fold logic (DESIGN.md §4.1).
 *
 * This module must never import from `@opencode-ai/*`, `@opentui/*`, or
 * `solid-js` — it is plain, deterministic TypeScript, unit-tested with
 * fixtures, and run in both the server and TUI plugin halves.
 */
import { z } from "zod"

// ---------------------------------------------------------------------------
// Journal line payloads, one schema per `type` in DESIGN.md §4.1's table.
// ---------------------------------------------------------------------------

export const TreeCreatedData = z.object({
  rootSessionID: z.string(),
})
export type TreeCreatedData = z.infer<typeof TreeCreatedData>

export const BranchKind = z.enum(["explicit", "jump", "redo", "native"])
export type BranchKind = z.infer<typeof BranchKind>

export const BranchOpenedData = z.object({
  sessionID: z.string(),
  parentSessionID: z.string(),
  anchorMessageID: z.string(),
  name: z.string().optional(),
  trunkModel: z.string().optional(),
  branchModel: z.string().optional(),
  kind: BranchKind,
})
export type BranchOpenedData = z.infer<typeof BranchOpenedData>

export const BranchStatus = z.enum(["squashed", "rejected", "discarded", "abandoned"])
export type BranchStatus = z.infer<typeof BranchStatus>

export const BranchClosedData = z.object({
  sessionID: z.string(),
  status: BranchStatus,
  decisionMessageID: z.string().optional(),
  note: z.string().optional(),
})
export type BranchClosedData = z.infer<typeof BranchClosedData>

export const SummaryRecordedData = z.object({
  sessionID: z.string(),
  messageID: z.string(),
  fromSessionID: z.string(),
  fromMessageID: z.string(),
})
export type SummaryRecordedData = z.infer<typeof SummaryRecordedData>

export const DecisionRecordedData = z.object({
  /** The record text as landed in the trunk (kept here so compaction re-injection and the
   *  decisions view need no OpenCode round-trip). */
  text: z.string().optional(),
  sessionID: z.string(),
  messageID: z.string(),
  forkSessionID: z.string(),
  branchName: z.string(),
  siblings: z.array(z.object({ name: z.string(), reason: z.string().optional() })),
})
export type DecisionRecordedData = z.infer<typeof DecisionRecordedData>

export const CropMode = z.enum(["result", "turn"])
export type CropMode = z.infer<typeof CropMode>

export const CropTarget = z.object({
  messageID: z.string(),
  partID: z.string().optional(),
  callID: z.string().optional(),
  tool: z.string().optional(),
  estTokens: z.number(),
  sha8: z.string(),
})
export type CropTarget = z.infer<typeof CropTarget>

export const CropAppliedData = z.object({
  sessionID: z.string(),
  mode: CropMode,
  targets: z.array(CropTarget),
  anchorMessageID: z.string(),
})
export type CropAppliedData = z.infer<typeof CropAppliedData>

export const CropRestoredData = z.object({
  cropID: z.string(),
})
export type CropRestoredData = z.infer<typeof CropRestoredData>

export const LabelSetData = z.object({
  sessionID: z.string(),
  messageID: z.string(),
  label: z.string().nullable(),
})
export type LabelSetData = z.infer<typeof LabelSetData>

export const SessionForgottenData = z.object({
  sessionID: z.string(),
})
export type SessionForgottenData = z.infer<typeof SessionForgottenData>

// ---------------------------------------------------------------------------
// The envelope and its discriminated-union variants.
// ---------------------------------------------------------------------------

export const JournalActor = z.enum(["tui", "server", "cli"])
export type JournalActor = z.infer<typeof JournalActor>

const envelope = <Type extends string, Data extends z.ZodTypeAny>(type: Type, data: Data) =>
  z.object({
    v: z.literal(1),
    id: z.string(),
    ts: z.number(),
    type: z.literal(type),
    actor: JournalActor,
    data,
  })

export const JournalEntrySchema = z.discriminatedUnion("type", [
  envelope("tree.created", TreeCreatedData),
  envelope("branch.opened", BranchOpenedData),
  envelope("branch.closed", BranchClosedData),
  envelope("summary.recorded", SummaryRecordedData),
  envelope("decision.recorded", DecisionRecordedData),
  envelope("crop.applied", CropAppliedData),
  envelope("crop.restored", CropRestoredData),
  envelope("label.set", LabelSetData),
  envelope("session.forgotten", SessionForgottenData),
])
export type JournalEntry = z.infer<typeof JournalEntrySchema>
export type JournalEntryType = JournalEntry["type"]

/** Parse one JSONL line into a validated journal entry, or `undefined` if it is malformed. */
/**
 * What the provider is actually sent as its system prompt, captured by the server half in
 * `experimental.chat.system.transform` (DESIGN.md §7.4). It is *not* a journal entry: it has
 * no history, it is not a mutation the user made, and `/undo` has nothing to do with it — the
 * store keeps it in its own per-session file, overwritten each request.
 */
export const SystemPart = z.object({
  /** A name for the part, guessed from its own text — providers hand us an unlabelled array. */
  name: z.string(),
  chars: z.number(),
  text: z.string(),
})
export type SystemPart = z.infer<typeof SystemPart>

export const SystemSnapshot = z.object({
  v: z.literal(1),
  /** When the provider was last sent this; the prompt can change between requests. */
  ts: z.number(),
  parts: z.array(SystemPart),
})
export type SystemSnapshot = z.infer<typeof SystemSnapshot>

export function parseJournalLine(line: string): JournalEntry | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  let json: unknown
  try {
    json = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  const result = JournalEntrySchema.safeParse(json)
  return result.success ? result.data : undefined
}

/** Parse a whole journal file's contents (one JSON object per line), skipping malformed lines. */
export function parseJournal(contents: string): JournalEntry[] {
  const entries: JournalEntry[] = []
  for (const line of contents.split("\n")) {
    const entry = parseJournalLine(line)
    if (entry) entries.push(entry)
  }
  return entries
}

// ---------------------------------------------------------------------------
// Folded state.
// ---------------------------------------------------------------------------

export type BranchState = {
  sessionID: string
  parentSessionID: string
  anchorMessageID: string
  name?: string
  kind: BranchKind
  trunkModel?: string
  branchModel?: string
  /** Alias of `branchModel`, the model this branch should run on (DESIGN.md §5's `/branch <name> [model]`). */
  model?: string
  /** "open" until a matching branch.closed; "forgotten" sessions stay in this map, greyed out. */
  status: "open" | BranchStatus
  decisionMessageID?: string
  note?: string
  forgotten: boolean
}

export type CropState = {
  cropID: string
  sessionID: string
  mode: CropMode
  targets: CropTarget[]
  anchorMessageID: string
  restored: boolean
}

export type DecisionState = {
  sessionID: string
  messageID: string
  forkSessionID: string
  branchName: string
  siblings: { name: string; reason?: string }[]
  text?: string
  /** True once the branch it closed was re-opened by /undo: the message stays on screen
   *  but the server hides it from the model (DESIGN.md §12 decision 4). */
  hidden: boolean
  recordedAt: number
}

export type TreeState = {
  treeId: string
  root?: string
  /** All sessions the plugin knows about, keyed by sessionID (root included, as a degenerate branch-less entry only if it was itself forked from). */
  sessions: Record<string, BranchState>
  /** All crops ever applied, keyed by a synthesized cropID (index-based, stable within one fold). */
  crops: Record<string, CropState>
  /** Bookmarks, keyed by messageID. */
  labels: Record<string, { sessionID: string; messageID: string; label: string }>
  /** Decision records, keyed by messageID. */
  decisions: Record<string, DecisionState>
  /** Active (non-restored) crops for a session, in application order. Bound to this state. */
  activeCrops: (sessionID: string) => CropState[]
}

function emptyTree(treeId: string): Omit<TreeState, "activeCrops"> {
  return { treeId, root: undefined, sessions: {}, crops: {}, labels: {}, decisions: {} }
}

/** cropID is not carried on `crop.applied` itself — DESIGN.md's `crop.restored` refers to it by
 *  the id of the applying journal entry, since a crop is uniquely identified by the event that
 *  created it. */
function cropIdFor(entry: Extract<JournalEntry, { type: "crop.applied" }>): string {
  return entry.id
}

/**
 * Fold an ordered list of journal entries into the current tree state. Pure and
 * deterministic: folding the same entries in the same order always yields the same
 * result, and folding is idempotent when an entry set is re-folded (e.g. after
 * appending more lines, refold from scratch — this function does not do incremental
 * folding itself, callers may cache on top of it).
 */
export function foldJournal(entries: JournalEntry[], treeId = "default"): TreeState {
  const state = emptyTree(treeId)

  for (const entry of entries) {
    switch (entry.type) {
      case "tree.created": {
        state.root = entry.data.rootSessionID
        break
      }
      case "branch.opened": {
        const d = entry.data
        const previous = state.sessions[d.sessionID]
        // both halves adopt native forks independently, so the same branch can be opened
        // twice; the first entry wins (re-opening a *closed* branch still folds)
        if (previous?.status === "open") break
        if (previous?.decisionMessageID) {
          const decision = state.decisions[previous.decisionMessageID]
          if (decision) decision.hidden = true
        }
        state.sessions[d.sessionID] = {
          sessionID: d.sessionID,
          parentSessionID: d.parentSessionID,
          anchorMessageID: d.anchorMessageID,
          name: d.name,
          kind: d.kind,
          trunkModel: d.trunkModel,
          branchModel: d.branchModel,
          model: d.branchModel,
          status: "open",
          forgotten: false,
        }
        break
      }
      case "branch.closed": {
        const branch = state.sessions[entry.data.sessionID]
        if (branch) {
          branch.status = entry.data.status
          branch.decisionMessageID = entry.data.decisionMessageID
          branch.note = entry.data.note
          if (entry.data.decisionMessageID) {
            const decision = state.decisions[entry.data.decisionMessageID]
            if (decision) decision.hidden = false
          }
        }
        break
      }
      case "summary.recorded": {
        // Summaries do not change tree shape; they are surfaced by the caller via the
        // raw entry list if needed (e.g. to render a ◇ marker). Nothing to fold here.
        break
      }
      case "decision.recorded": {
        const d = entry.data
        state.decisions[d.messageID] = {
          sessionID: d.sessionID,
          messageID: d.messageID,
          forkSessionID: d.forkSessionID,
          branchName: d.branchName,
          siblings: d.siblings,
          text: d.text,
          hidden: false,
          recordedAt: entry.ts,
        }
        break
      }
      case "crop.applied": {
        const cropID = cropIdFor(entry)
        state.crops[cropID] = {
          cropID,
          sessionID: entry.data.sessionID,
          mode: entry.data.mode,
          targets: entry.data.targets,
          anchorMessageID: entry.data.anchorMessageID,
          restored: false,
        }
        break
      }
      case "crop.restored": {
        const crop = state.crops[entry.data.cropID]
        if (crop) crop.restored = true
        break
      }
      case "label.set": {
        const d = entry.data
        if (d.label === null) {
          delete state.labels[d.messageID]
        } else {
          state.labels[d.messageID] = { sessionID: d.sessionID, messageID: d.messageID, label: d.label }
        }
        break
      }
      case "session.forgotten": {
        const branch = state.sessions[entry.data.sessionID]
        if (branch) branch.forgotten = true
        break
      }
    }
  }

  return {
    ...state,
    activeCrops: (sessionID: string) => activeCrops(state as TreeState, sessionID),
  }
}

/** The label to write when a branch is opened at a message that may already carry one.
 *  `label.set` *replaces* the label for a message, so two branches off one anchor have to
 *  write the combined string (`⎇ a, ⎇ b`) or the second silently drops the first. */
export function withBranchLabel(existing: string | undefined, name: string): string {
  const tag = `⎇ ${name}`
  const parts = (existing ?? "").split(",").map((p) => p.trim()).filter(Boolean)
  return parts.includes(tag) ? parts.join(", ") : [...parts, tag].join(", ")
}

/** Active (non-restored) crops for a given session, in application order. */
export function activeCrops(state: TreeState, sessionID: string): CropState[] {
  return Object.values(state.crops)
    .filter((c) => c.sessionID === sessionID && !c.restored)
    .sort((a, b) => (a.cropID < b.cropID ? -1 : a.cropID > b.cropID ? 1 : 0))
}
