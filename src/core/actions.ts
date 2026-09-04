/**
 * Pure planning of the "go here" jump action (DESIGN.md §6.2), given a selected
 * `Row` and the `TreeView` it came from. Planning never performs the jump itself —
 * callers (the server/TUI halves) execute the plan against OpenCode and the journal.
 *
 * Pure, no OpenCode/opentui/solid-js imports — see test/core-purity.test.ts.
 */
import type { TreeState } from "./journal.js"
import { aggregateTokens, spineOf, type Row } from "./tree.js"
import type { Transcript, TranscriptMessage } from "./transcript.js"

export type JumpPlan =
  | { kind: "noop"; reason: string }
  | { kind: "switch"; sessionID: string }
  | {
      kind: "fork"
      sessionID: string
      /** The message to fork AT (exclusive — `session.fork` copies everything before it). */
      messageID: string
      prefill?: string
      mode: "redo" | "continue"
    }

/**
 * Plan the jump for a selected row (DESIGN.md §6.2), against the *unfiltered*
 * transcripts so search/filters never change what a jump does:
 * - a **branch row** → switch to that branch's session (same as its tip), or a noop on the
 *   marker row of the session you are already in;
 * - a **turn/step row on the last message of a non-current session** → switch to it
 *   (no fork) — Pi's "move the leaf to an existing leaf";
 * - a **turn row** elsewhere → fork at that user message, prefilled with its text;
 * - a **step row** elsewhere → fork at the *next* message after its assistant message;
 * - the **last message of the current session** → noop, "already here".
 */
export function planJump(row: Row, ctx: { transcripts: Record<string, Transcript>; currentSessionID: string }): JumpPlan {
  if (row.kind === "separator") return { kind: "noop", reason: "nothing to go to" }
  if (row.kind === "branch") return row.sessionID === ctx.currentSessionID ? { kind: "noop", reason: "you are here" } : { kind: "switch", sessionID: row.sessionID }
  const tr = ctx.transcripts[row.sessionID]
  if (!tr) return { kind: "noop", reason: "that session is not loaded" }
  const idx = tr.messages.findIndex((m) => m.id === row.messageID)
  if (idx === -1) return { kind: "noop", reason: "message not found" }
  const last = idx === tr.messages.length - 1
  if (row.sessionID === ctx.currentSessionID) {
    if (last) return { kind: "noop", reason: "already here" }
  } else if (last) {
    return { kind: "switch", sessionID: row.sessionID }
  }
  if (row.kind === "turn") {
    const text = tr.messages[idx]!.parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n")
    return { kind: "fork", sessionID: row.sessionID, messageID: row.messageID, prefill: text || row.preview, mode: "redo" }
  }
  const next = tr.messages[idx + 1]
  if (!next) return { kind: "switch", sessionID: row.sessionID }
  return { kind: "fork", sessionID: row.sessionID, messageID: next.id, mode: "continue" }
}

/** What a jump leaves behind: the current session's messages below the point being
 *  jumped to — Pi's "entries from the old leaf back to the common ancestor", which is
 *  exactly what its branch summary covers (DESIGN.md §6.2). */
export type AbandonedTail = {
  /** Oldest first. Empty when the jump abandons nothing (a switch onto your own path). */
  messages: TranscriptMessage[]
  /** User turns among them — how the fork dialog counts what you are leaving. */
  turns: number
  /** Rough token weight of the tail; always an estimate. */
  tokens: number
}

const EMPTY_TAIL: AbandonedTail = { messages: [], turns: 0, tokens: 0 }

/**
 * The part of the current session that a jump plan drops out of the context path.
 *
 * Both sides are reduced to their **spine** — the ordered `sessionID:messageID` path from
 * the root, where an ancestor's copied prefix keeps the ancestor's own IDs (`core/tree.ts`
 * `spineOf`). The deepest entry present in both is the common ancestor; everything after it
 * in the current session's transcript is abandoned. A `fork` plan cuts the target spine
 * *before* its fork boundary, because `session.fork` copies messages strictly before it.
 *
 * Examples, against the trunk `m1 a1 m2 a2 m3 a3`:
 * - redo `m2` from the trunk → `m2 a2 m3 a3` (everything below the selected row);
 * - switch from an open branch to a sibling forked at the same anchor → the branch's own turns;
 * - switch to a branch of the session you are on → the trunk turns past the fork point.
 */
export function abandonedTail(o: {
  state: TreeState
  transcripts: Record<string, Transcript>
  currentSessionID: string
  plan: JumpPlan
}): AbandonedTail {
  const plan = o.plan
  const current = o.transcripts[o.currentSessionID]
  if (!current || plan.kind === "noop") return EMPTY_TAIL

  const mine = spineOf(o.state, o.transcripts, o.currentSessionID)
  let theirs = spineOf(o.state, o.transcripts, plan.sessionID)
  if (plan.kind === "fork") {
    const cut = theirs.findIndex((e) => e.sessionID === plan.sessionID && e.messageID === plan.messageID)
    if (cut !== -1) theirs = theirs.slice(0, cut)
  }
  const keep = new Set(theirs.map((e) => `${e.sessionID}:${e.messageID}`))

  let common = -1
  for (let i = mine.length - 1; i >= 0; i--) {
    const e = mine[i]!
    if (keep.has(`${e.sessionID}:${e.messageID}`)) {
      common = i
      break
    }
  }

  const messages = current.messages.slice(Math.min(common + 1, current.messages.length))
  return { messages, turns: messages.filter((m) => m.role === "user").length, tokens: aggregateTokens(messages) }
}
