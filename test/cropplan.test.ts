import { describe, expect, test } from "bun:test"
import { autoMark, planResultCrop, planTurnCrops, resultCandidates, sha8, topCandidate, turnCandidates } from "../src/core/cropplan.js"
import { applyCrops, type MinimalMessage } from "../src/core/crop.js"
import { buildFixture, OPEN, TRUNK } from "./fixtures/tree.js"

const f = buildFixture()
const open = f.transcripts[OPEN]!

describe("crop planning", () => {
  test("sha8 is stable and 8 hex chars", () => {
    expect(sha8("hello")).toBe(sha8("hello"))
    expect(sha8("hello")).toMatch(/^[0-9a-f]{8}$/)
    expect(sha8("hello")).not.toBe(sha8("hello!"))
  })
  test("result candidates carry protections: current turn, latest per tool", () => {
    const cands = resultCandidates(open)
    // open branch: bash in trunk prefix (T1, 8k chars) and bash in T3 (20k chars); T4 is current
    expect(cands.map((c) => [c.turn, c.tool, c.protections])).toEqual([
      [1, "bash", []],
      [3, "bash", ["latest-per-tool"]],
    ])
    expect(cands[1]!.estTokens).toBeGreaterThan(5000)
  })
  test("auto rules: min tokens, older than N turns, unprotected", () => {
    const cands = resultCandidates(open)
    expect(autoMark(cands, { minTokens: 1000, olderThanTurns: 2, keep: [] }).map((c) => c.turn)).toEqual([1])
    expect(autoMark(cands, { minTokens: 3000, olderThanTurns: 1, keep: [] })).toEqual([])
    expect(resultCandidates(open, { keep: ["bash*"] }).every((c) => c.protections.includes("keep-glob"))).toBe(true)
  })
  test("top candidate ignores protected results", () => {
    expect(topCandidate(resultCandidates(open))!.turn).toBe(1)
  })
  test("planResultCrop → applyCrops stubs the chosen output only", () => {
    const cands = resultCandidates(open)
    const plan = planResultCrop(OPEN, [cands[0]!])!
    const msgs: MinimalMessage[] = open.messages.map((m) => ({ info: { id: m.id, role: m.role, sessionID: OPEN }, parts: m.parts.map((p) => ({ ...p, state: p.state ? { ...p.state } : undefined })) }))
    applyCrops(msgs, [{ mode: plan.mode, targets: plan.targets, anchorMessageID: plan.anchorMessageID }])
    const stubbed = msgs.find((m) => m.info.id === cands[0]!.messageID)!.parts.find((p) => p.type === "tool")!
    expect(stubbed.state!.output!.startsWith("[cropped: bash")).toBe(true)
    const untouched = msgs.find((m) => m.info.id === cands[1]!.messageID)!.parts.find((p) => p.type === "tool")!
    expect(untouched.state!.output!.startsWith("[cropped")).toBe(false)
  })
  test("results after a compaction summary are still candidates (turn 0)", () => {
    const compacted = { ...open, messages: [{ ...open.messages[1]!, summary: true }, ...open.messages.slice(4)] }
    expect(resultCandidates(compacted).map((c) => [c.turn, c.tool])).toEqual([[0, "bash"], [1, "bash"]])
    expect(turnCandidates(compacted).map((t) => t.turn)).toEqual([1, 2]) // the summary turn has no user message to splice
  })
  test("the turn stub's handle is the candidate's whole-turn sha8", () => {
    const t = turnCandidates(open)[2]!
    const plan = planTurnCrops(OPEN, [t])[0]!
    expect(plan.targets[0]!.sha8).toBe(t.sha8)
    expect(t.sha8).not.toBe(sha8(open.messages[4]!.parts.map((p) => p.text ?? "").join("\n")))
  })
  test("planTurnCrops refuses the current turn", () => {
    const turns = turnCandidates(open)
    expect(planTurnCrops(OPEN, [turns[3]!, turns[0]!]).map((p) => p.anchorMessageID)).toEqual([turns[0]!.anchorMessageID])
  })
  test("a fat result that only exists in the current turn plans nothing (the server skips, never throws)", () => {
    const currentTurnOnly = { ...open, messages: open.messages.slice(4, 6) } // om1 + its 20k bash result
    const cands = resultCandidates(currentTurnOnly)
    expect(cands.map((c) => c.protections)).toEqual([["current-turn", "latest-per-tool"]])
    expect(autoMark(cands, { minTokens: 1000, olderThanTurns: 0, keep: [] })).toEqual([])
    expect(topCandidate(cands, true)).toBeUndefined() // --force waives latest-per-tool, never the current turn
    expect(planResultCrop(OPEN, [])).toBeUndefined()
    expect(planTurnCrops(OPEN, turnCandidates(currentTurnOnly))).toEqual([])
  })
  test("turn candidates: last turn protected; planTurnCrops drops a whole turn", () => {
    const turns = turnCandidates(open)
    expect(turns.map((t) => [t.turn, t.steps, t.protections])).toEqual([[1, 2, []], [2, 2, []], [3, 2, []], [4, 2, ["current-turn"]]])
    const plans = planTurnCrops(OPEN, [turns[2]!])
    const msgs: MinimalMessage[] = open.messages.map((m) => ({ info: { id: m.id, role: m.role, sessionID: OPEN }, parts: m.parts.map((p) => ({ ...p })) }))
    applyCrops(msgs, plans.map((p) => ({ mode: p.mode, targets: p.targets, anchorMessageID: p.anchorMessageID })))
    expect(msgs.length).toBe(open.messages.length - 1)
    expect(msgs.find((m) => m.info.id === "om1")!.parts[0]!.text!.startsWith("[dropped turn")).toBe(true)
  })
})
