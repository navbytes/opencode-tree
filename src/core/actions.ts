/**
 * Pure planning of the "go here" jump action (DESIGN.md §6.2), given a selected
 * `Row` and the `TreeView` it came from. Planning never performs the jump itself —
 * callers (the server/TUI halves) execute the plan against OpenCode and the journal.
 *
 * Pure, no OpenCode/opentui/solid-js imports — see test/core-purity.test.ts.
 */
import type { Row } from "./tree.js"
import type { Transcript } from "./transcript.js"

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
