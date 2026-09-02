/**
 * Pure planning of the "go here" jump action (DESIGN.md §6.2), given a selected
 * `Row` and the `TreeView` it came from. Planning never performs the jump itself —
 * callers (the server/TUI halves) execute the plan against OpenCode and the journal.
 *
 * Pure, no OpenCode/opentui/solid-js imports — see test/core-purity.test.ts.
 */
import type { Row, TreeView } from "./tree.js"

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

/** Is `row` the last turn/step row belonging to its session in `view.rows`? This is
 *  "the tip" in DESIGN.md §6.2's sense (the session's last *message*, which may be an
 *  assistant/tool step, not necessarily its last *user* turn — unlike `TurnRow.isTip`). */
function isLastRowOfSession(row: Row, view: TreeView): boolean {
  const idx = view.indexById[row.id]
  if (idx === undefined) return false
  for (let i = idx + 1; i < view.rows.length; i++) {
    const r = view.rows[i]!
    if (r.kind !== "branch" && r.sessionID === row.sessionID) return false
  }
  return true
}

/** The messageID of the next turn/step row belonging to `row`'s session after `row`
 *  (i.e. the first row whose messageID differs from `row`'s) — the fork boundary for
 *  "continue from here" on a step row. */
function nextMessageIdAfter(row: Row, view: TreeView): string | undefined {
  if (row.kind === "branch") return undefined
  const idx = view.indexById[row.id]
  if (idx === undefined) return undefined
  for (let i = idx + 1; i < view.rows.length; i++) {
    const r = view.rows[i]!
    if (r.kind !== "branch" && r.sessionID === row.sessionID && r.messageID !== row.messageID) return r.messageID
  }
  return undefined
}

/**
 * Plan the jump for a selected row (DESIGN.md §6.2):
 * - a **branch row** → switch to that branch's session (same as its tip);
 * - a **turn/step row that is the tip of a non-current session** → switch to that
 *   session (no fork) — Pi's "move the leaf to an existing leaf";
 * - a **turn row** elsewhere → fork at that user message, prefilled with its text
 *   ("redo this turn on a new branch");
 * - a **step row** elsewhere → fork at the *next* message after its assistant
 *   message, with an empty prompt ("continue from here");
 * - the **tip row of the current session** → noop, "already here".
 */
export function planJump(row: Row, view: TreeView, opts: { currentSessionID: string }): JumpPlan {
  if (row.kind === "branch") {
    return { kind: "switch", sessionID: row.sessionID }
  }

  const last = isLastRowOfSession(row, view)

  if (row.sessionID === opts.currentSessionID) {
    if (last) return { kind: "noop", reason: "already here" }
  } else if (last) {
    return { kind: "switch", sessionID: row.sessionID }
  }

  if (row.kind === "turn") {
    return { kind: "fork", sessionID: row.sessionID, messageID: row.messageID, prefill: row.preview, mode: "redo" }
  }

  const nextMessageID = nextMessageIdAfter(row, view)
  if (nextMessageID === undefined) {
    // No later message in view to fork before (shouldn't happen once `last` above
    // has been handled) — fall back to switching rather than mis-forking.
    return { kind: "switch", sessionID: row.sessionID }
  }
  return { kind: "fork", sessionID: row.sessionID, messageID: nextMessageID, mode: "continue" }
}
