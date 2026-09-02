/**
 * `/undo` planning (DESIGN.md §6.6): find the most recent mutation that is still
 * active on the current session's path and describe how to revert it. Pure.
 */
import type { JournalEntry, TreeState } from "./journal.js"

export type UndoPlan =
  | { kind: "restore-crop"; cropID: string; mode: "result" | "turn"; estTokens: number }
  | { kind: "abandon-branch"; sessionID: string; parentSessionID: string; name?: string }
  | { kind: "reopen-branch"; sessionID: string; decisionMessageID?: string; status: string }
  | { kind: "nothing" }

/**
 * Walk the journal newest→oldest and return the first entry that (a) concerns the
 * current session or the branch it lives on and (b) has not itself been undone.
 * `entries` must be the raw journal in file order; `state` its fold.
 */
export function planUndo(entries: JournalEntry[], state: TreeState, sessionID: string): UndoPlan {
  const undone = new Set<string>()
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    switch (e.type) {
      case "crop.restored":
        undone.add(e.data.cropID)
        continue
      case "crop.applied": {
        if (e.data.sessionID !== sessionID || undone.has(e.id)) continue
        const crop = state.crops[e.id]
        if (!crop || crop.restored) continue
        return { kind: "restore-crop", cropID: e.id, mode: e.data.mode, estTokens: e.data.targets.reduce((s, t) => s + t.estTokens, 0) }
      }
      case "branch.closed": {
        // a squash/discard whose branch we are standing in (trunk side) can be re-opened
        const branch = state.sessions[e.data.sessionID]
        if (!branch) continue
        if (branch.parentSessionID !== sessionID && e.data.sessionID !== sessionID) continue
        if (branch.status === "open") continue // already re-opened
        if (e.data.status === "abandoned") continue // an undone jump is not itself undoable
        return { kind: "reopen-branch", sessionID: e.data.sessionID, decisionMessageID: e.data.decisionMessageID, status: e.data.status }
      }
      case "branch.opened": {
        if (e.data.sessionID !== sessionID) continue
        const branch = state.sessions[sessionID]
        if (!branch || branch.status !== "open") continue
        return { kind: "abandon-branch", sessionID, parentSessionID: e.data.parentSessionID, name: e.data.name }
      }
      default:
        continue
    }
  }
  return { kind: "nothing" }
}
