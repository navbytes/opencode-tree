import { describe, expect, test } from "bun:test"
import { foldJournal, parseJournal, parseJournalLine, type JournalEntry } from "../src/core/journal.js"

function line(entry: JournalEntry): string {
  return JSON.stringify(entry)
}

describe("parseJournalLine", () => {
  test("parses a valid line", () => {
    const entry = parseJournalLine(
      line({ v: 1, id: "e_1", ts: 1, type: "tree.created", actor: "server", data: { rootSessionID: "s_root" } }),
    )
    expect(entry?.type).toBe("tree.created")
  })

  test("rejects malformed JSON", () => {
    expect(parseJournalLine("not json")).toBeUndefined()
  })

  test("rejects a well-formed line with an unknown type", () => {
    expect(parseJournalLine(JSON.stringify({ v: 1, id: "e_1", ts: 1, type: "nonsense", actor: "server", data: {} }))).toBeUndefined()
  })

  test("skips blank lines", () => {
    expect(parseJournalLine("")).toBeUndefined()
    expect(parseJournalLine("   ")).toBeUndefined()
  })
})

describe("foldJournal", () => {
  const fixture: JournalEntry[] = [
    { v: 1, id: "e_1", ts: 1000, type: "tree.created", actor: "server", data: { rootSessionID: "s_root" } },
    {
      v: 1,
      id: "e_2",
      ts: 1001,
      type: "branch.opened",
      actor: "tui",
      data: {
        sessionID: "s_branch",
        parentSessionID: "s_root",
        anchorMessageID: "m_10",
        name: "fix-flaky-test",
        kind: "explicit",
        branchModel: "anthropic/claude-haiku-4.5",
      },
    },
    {
      v: 1,
      id: "e_3",
      ts: 1002,
      type: "crop.applied",
      actor: "tui",
      data: {
        sessionID: "s_branch",
        mode: "result",
        anchorMessageID: "m_11",
        targets: [{ messageID: "m_11", callID: "c_1", tool: "bash", estTokens: 4700, sha8: "3f9a1c2e" }],
      },
    },
    { v: 1, id: "e_4", ts: 1003, type: "crop.restored", actor: "tui", data: { cropID: "e_3" } },
    {
      v: 1,
      id: "e_5",
      ts: 1004,
      type: "branch.closed",
      actor: "tui",
      data: { sessionID: "s_branch", status: "squashed", decisionMessageID: "m_20" },
    },
  ]

  test("resolves the root session", () => {
    expect(foldJournal(fixture).root).toBe("s_root")
  })

  test("opens then closes a branch", () => {
    const branch = foldJournal(fixture).sessions["s_branch"]
    expect(branch?.status).toBe("squashed")
    expect(branch?.parentSessionID).toBe("s_root")
    expect(branch?.anchorMessageID).toBe("m_10")
    expect(branch?.name).toBe("fix-flaky-test")
    expect(branch?.model).toBe("anthropic/claude-haiku-4.5")
  })

  test("a crop applied then restored leaves no active crops", () => {
    const state = foldJournal(fixture)
    expect(state.activeCrops("s_branch")).toEqual([])
    expect(Object.keys(state.crops)).toHaveLength(1) // still on record, just marked restored
    expect(state.crops["e_3"]?.restored).toBe(true)
  })

  test("folding twice is deterministic", () => {
    // Compare serialized form: each fold's `activeCrops` is a fresh closure, so
    // function identity would otherwise make an object-level toEqual fail even
    // though the data behind it is identical.
    expect(JSON.stringify(foldJournal(fixture))).toBe(JSON.stringify(foldJournal(fixture)))
  })

  test("a crop with no matching restore stays active", () => {
    const state = foldJournal(fixture.slice(0, 3)) // up to crop.applied, no restore yet
    expect(state.activeCrops("s_branch")).toHaveLength(1)
  })

  test("session.forgotten marks a branch forgotten without dropping it", () => {
    const withForgotten: JournalEntry[] = [
      ...fixture,
      { v: 1, id: "e_6", ts: 1005, type: "session.forgotten", actor: "server", data: { sessionID: "s_branch" } },
    ]
    const state = foldJournal(withForgotten)
    expect(state.sessions["s_branch"]?.forgotten).toBe(true)
    expect(state.sessions["s_branch"]?.status).toBe("squashed") // unrelated to forgotten
  })

  test("parseJournal skips malformed lines but keeps valid ones", () => {
    const contents = [line(fixture[0]!), "garbage", "", line(fixture[1]!)].join("\n")
    const entries = parseJournal(contents)
    expect(entries).toHaveLength(2)
  })
})
