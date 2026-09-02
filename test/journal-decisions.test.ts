import { describe, expect, test } from "bun:test"
import { foldJournal, type JournalEntry } from "../src/core/journal.js"

const entries: JournalEntry[] = [
  { v: 1, id: "e1", ts: 1, type: "tree.created", actor: "tui", data: { rootSessionID: "trunk" } },
  { v: 1, id: "e2", ts: 2, type: "branch.opened", actor: "tui", data: { sessionID: "b1", parentSessionID: "trunk", anchorMessageID: "a2", kind: "explicit", name: "fix" } },
  { v: 1, id: "e3", ts: 3, type: "decision.recorded", actor: "tui", data: { sessionID: "trunk", messageID: "d1", forkSessionID: "b1", branchName: "fix", siblings: [], text: "◆ ## Decision: fix" } },
  { v: 1, id: "e4", ts: 4, type: "branch.closed", actor: "tui", data: { sessionID: "b1", status: "squashed", decisionMessageID: "d1" } },
]

describe("decisions in the fold", () => {
  test("recorded + closed → visible decision with text", () => {
    const st = foldJournal(entries)
    expect(st.decisions["d1"]).toMatchObject({ hidden: false, text: "◆ ## Decision: fix", recordedAt: 3 })
    expect(st.sessions["b1"]!.status).toBe("squashed")
  })
  test("re-opening the branch hides its record; closing again unhides", () => {
    const reopened: JournalEntry[] = [...entries, { v: 1, id: "e5", ts: 5, type: "branch.opened", actor: "tui", data: { sessionID: "b1", parentSessionID: "trunk", anchorMessageID: "a2", kind: "explicit", name: "fix" } }]
    expect(foldJournal(reopened).decisions["d1"]!.hidden).toBe(true)
    expect(foldJournal(reopened).sessions["b1"]!.status).toBe("open")
    const closedAgain: JournalEntry[] = [...reopened, { v: 1, id: "e6", ts: 6, type: "branch.closed", actor: "tui", data: { sessionID: "b1", status: "squashed", decisionMessageID: "d1" } }]
    expect(foldJournal(closedAgain).decisions["d1"]!.hidden).toBe(false)
  })
})
