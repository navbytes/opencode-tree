import { describe, expect, test } from "bun:test"
import { branchTranscriptText, buildDecisionDraftPrompt, decisionMessageText, decisionTemplate, exportDecisions, openSiblings } from "../src/core/decision.js"
import { buildFixture, OPEN, SQUASHED } from "./fixtures/tree.js"

describe("decision records", () => {
  const f = buildFixture()
  test("template carries name, model, date and all headings", () => {
    const t = decisionTemplate("fix-flaky", "mock/mock-b", new Date("2026-09-02T00:00:00Z"))
    expect(t).toContain("## Decision: fix-flaky")
    expect(t).toContain("**Date:** 2026-09-02 · **Model:** mock/mock-b")
    for (const h of ["Outcome", "Why", "Assumptions", "Changes", "Gotchas", "Open questions", "Confidence", "Rejected alternatives"]) expect(t).toContain(h)
  })
  test("branch transcript starts after the anchor and truncates tool output", () => {
    const text = branchTranscriptText(f.transcripts[OPEN]!, 3, 100)
    expect(text.startsWith("[User]: the test flakes on CI only")).toBe(true)
    expect(text).not.toContain("Build yourself a tool")
    expect(text).toContain("more chars]")
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
  test("export joins records", () => {
    expect(exportDecisions([{ branchName: "a", text: "◆ ## Decision: a\nx", sessionID: "s" }])).toBe("# Decisions\n\n## Decision: a\nx\n")
  })
})
