import { describe, expect, test } from "bun:test"
import { branchTranscriptText, buildDecisionDraftPrompt, decisionMessageText, decisionRecord, decisionSummary, decisionTemplate, exportDecisions, openSiblings, renderDecision, templatePlaceholders } from "../src/core/decision.js"
import { buildFixture, OPEN, SQUASHED, TRUNK } from "./fixtures/tree.js"

describe("decision records", () => {
  const f = buildFixture()
  test("template carries name, model, date and all headings", () => {
    const t = decisionTemplate("fix-flaky", "mock/mock-b", new Date("2026-09-02T00:00:00Z"))
    expect(t).toContain("## Decision: fix-flaky")
    expect(t).toContain("**Date:** 2026-09-02 · **Model:** mock/mock-b")
    for (const h of ["Outcome", "Why", "Assumptions", "Changes", "Gotchas", "Open questions", "Confidence", "Rejected alternatives"]) expect(t).toContain(h)
  })
  test("an unfilled template is caught, a written record and code-like angle brackets are not", () => {
    expect(templatePlaceholders(decisionTemplate("fix-flaky", "mock/mock-b")).length).toBeGreaterThan(0)
    expect(templatePlaceholders("**Outcome:** <1–3 sentences: what was concluded / built>")).toEqual(["<1–3 sentences: what was concluded / built>"])
    expect(templatePlaceholders("**Outcome:** kept `Array<string>`; dropped the <div> wrapper")).toEqual([])
  })
  test("a record typed into the dialogs carries the answered fields only, no placeholders", () => {
    const r = decisionRecord({ branchName: "fix-flaky", model: "mock/mock-b", outcome: "  Kept the in-memory cache.  ", why: "the set is small; CI stays fast", date: new Date("2026-09-02T00:00:00Z") })
    expect(r).toBe("## Decision: fix-flaky\n**Date:** 2026-09-02 · **Model:** mock/mock-b · **Branch:** fix-flaky\n**Outcome:** Kept the in-memory cache.\n**Why:**\n- the set is small\n- CI stays fast\n")
    expect(templatePlaceholders(r)).toEqual([])
    expect(decisionRecord({ branchName: "a", outcome: "x", why: "  " })).not.toContain("**Why:**")
  })
  const parentMessageIDs = f.transcripts[TRUNK]!.messages.map((m) => m.id)
  test("branch transcript starts after the anchor and truncates tool output", () => {
    const text = branchTranscriptText(f.transcripts[OPEN]!, { messageID: f.anchor, parentMessageIDs }, 100)
    expect(text.startsWith("[User]: the test flakes on CI only")).toBe(true)
    expect(text).not.toContain("Build yourself a tool")
    expect(text).toContain("more chars]")
  })
  test("an anchor the parent no longer has throws instead of drafting from the shared prefix", () => {
    expect(() => branchTranscriptText(f.transcripts[OPEN]!, { messageID: "m_reverted", parentMessageIDs })).toThrow(/m_reverted/)
    expect(branchTranscriptText(f.transcripts[OPEN]!, { parentMessageIDs })).toContain("Build yourself a tool") // whole transcript, explicitly
  })
  test("draft prompt includes siblings as epitaph material", () => {
    const p = buildDecisionDraftPrompt({ branchName: "a", transcript: "x", siblings: [{ name: "b", transcript: "y" }] })
    expect(p).toContain('<sibling name="b">')
    expect(p).toContain("Rejected alternatives")
  })
  test("message text gets the ◆ header once", () => {
    expect(decisionMessageText("## Decision: a\nbody", "a")).toBe("◆ ## Decision: a\nbody")
    expect(decisionMessageText("just notes", "a")).toBe("◆ ## Decision: a\njust notes")
  })
  test("open siblings share parent and anchor and are open", () => {
    expect(openSiblings(f.state, OPEN)).toEqual([]) // the sibling is squashed
    expect(openSiblings(f.state, SQUASHED)).toEqual([OPEN])
  })
  test("export heads every record with its branch, date and session", () => {
    const md = exportDecisions([{ branchName: "a", text: "◆ ## Decision: a\nx", sessionID: "ses_1", at: Date.parse("2026-09-02T10:11:12Z") }])
    expect(md).toBe("# Decisions\n\n## ⎇ a · 2026-09-02T10:11:12.000Z\n_session ses_1_\n\nx\n")
  })
})

describe("rendering a record", () => {
  const RECORD = `◆ ## Decision: try-redis
**Date:** 2026-09-02 · **Model:** mock/mock-b · **Branch:** try-redis
**Outcome:** Keep the in-memory cache; Redis is overkill here.
**Why:**
- the working set is \`~4 MB\`, well inside the process
- an extra service makes CI **flaky**

### Rejected alternatives
- **redis:** one more container to boot on every CI run
`

  test("emphasis and heading markers go, bullets and paragraph breaks stay, lines fit the width", () => {
    const lines = renderDecision(RECORD, 40)
    expect(lines.every((l) => l.length <= 40)).toBe(true)
    expect(lines[0]).toBe("◆ Decision: try-redis")
    expect(lines.some((l) => l.includes("*") || l.includes("`") || l.includes("#"))).toBe(false)
    expect(lines).toContain("") // the blank line before "Rejected alternatives"
    expect(lines).toContain("Rejected alternatives")
    // a wrapped bullet keeps its marker and hangs its continuation under the text
    expect(lines).toContain("- the working set is ~4 MB, well inside")
    expect(lines).toContain("  the process")
  })
  test("only a token too long for the line is cut, and it is marked", () => {
    expect(renderDecision(`- ${"x".repeat(50)}`, 20)).toEqual([`- ${"x".repeat(17)}…`])
  })
  test("summary pulls the title and the outcome for a one-line row", () => {
    expect(decisionSummary(RECORD)).toEqual({ title: "try-redis", outcome: "Keep the in-memory cache; Redis is overkill here." })
    expect(decisionSummary("scratch notes\nno template here")).toEqual({ title: "scratch notes" })
  })
})
