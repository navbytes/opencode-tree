import { describe, expect, test } from "bun:test"
import { foldJournal, type JournalEntry } from "../src/core/journal.js"
import { planUndo } from "../src/core/undo.js"

const base: JournalEntry[] = [
  { v: 1, id: "e1", ts: 1, type: "tree.created", actor: "tui", data: { rootSessionID: "trunk" } },
  { v: 1, id: "e2", ts: 2, type: "branch.opened", actor: "tui", data: { sessionID: "b1", parentSessionID: "trunk", anchorMessageID: "a2", kind: "explicit", name: "fix" } },
  { v: 1, id: "e3", ts: 3, type: "crop.applied", actor: "tui", data: { sessionID: "b1", mode: "result", targets: [{ messageID: "m", partID: "p", estTokens: 4000, sha8: "deadbeef" }], anchorMessageID: "m" } },
]

describe("planUndo", () => {
  test("latest active crop first", () => {
    expect(planUndo(base, foldJournal(base), "b1")).toEqual({ kind: "restore-crop", cropID: "e3", mode: "result", estTokens: 4000 })
  })
  test("after restoring, the open branch is next; from the trunk there is nothing", () => {
    const entries: JournalEntry[] = [...base, { v: 1, id: "e4", ts: 4, type: "crop.restored", actor: "tui", data: { cropID: "e3" } }]
    expect(planUndo(entries, foldJournal(entries), "b1")).toEqual({ kind: "abandon-branch", sessionID: "b1", parentSessionID: "trunk", name: "fix" })
    expect(planUndo(entries, foldJournal(entries), "trunk")).toEqual({ kind: "nothing" })
  })
  test("a squash seen from the trunk can be re-opened; an abandoned jump cannot", () => {
    const entries: JournalEntry[] = [...base, { v: 1, id: "e5", ts: 5, type: "branch.closed", actor: "tui", data: { sessionID: "b1", status: "squashed", decisionMessageID: "d1" } }]
    expect(planUndo(entries, foldJournal(entries), "trunk")).toEqual({ kind: "reopen-branch", sessionID: "b1", decisionMessageID: "d1", status: "squashed" })
    const abandoned: JournalEntry[] = [...base, { v: 1, id: "e6", ts: 6, type: "branch.closed", actor: "tui", data: { sessionID: "b1", status: "abandoned" } }]
    expect(planUndo(abandoned, foldJournal(abandoned), "trunk").kind).toBe("nothing")
  })
})
