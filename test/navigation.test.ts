import { describe, expect, test } from "bun:test"
import { cycleFilter, firstIndex, lastIndex, moveSelection, nextBranchIndex, resolveSelection, toggleExpanded } from "../src/core/navigation.js"
import { buildTreeView } from "../src/core/tree.js"
import { buildFixture, OPEN, TRUNK } from "./fixtures/tree.js"

const f = buildFixture()
const view = buildTreeView({ state: f.state, transcripts: f.transcripts, currentSessionID: TRUNK, expanded: new Set(), filter: "default" })

describe("navigation", () => {
  test("moveSelection clamps", () => {
    expect(moveSelection(view.rows, 0, -1)).toBe(0)
    expect(moveSelection(view.rows, 0, 20)).toBe(view.rows.length - 1)
    expect(moveSelection([], 0, 1)).toBe(-1)
  })
  test("nextBranchIndex jumps between branch rows and stays put at the ends", () => {
    const first = nextBranchIndex(view.rows, 0, 1)
    expect(view.rows[first]!.kind).toBe("branch")
    const second = nextBranchIndex(view.rows, first, 1)
    expect(second).toBe(first + 1)
    expect(nextBranchIndex(view.rows, second, 1)).toBe(second)
    expect(nextBranchIndex(view.rows, 0, -1)).toBe(0)
  })
  test("toggleExpanded returns a new set", () => {
    const a = new Set<string>()
    const b = toggleExpanded(a, OPEN)
    expect(a.has(OPEN)).toBe(false)
    expect(b.has(OPEN)).toBe(true)
    expect(toggleExpanded(b, OPEN).has(OPEN)).toBe(false)
  })
  test("cycleFilter order", () => {
    expect(["default", "no-tools", "tools-only", "user-only", "labeled", "all", "default"].slice(1)).toEqual(
      ["default", "no-tools", "tools-only", "user-only", "labeled", "all"].map((x) => cycleFilter(x as any)),
    )
  })
  test("resolveSelection keeps the id, falls back to the owning turn, then the current row", () => {
    const tool = view.rows.find((r) => r.kind === "step")!
    expect(resolveSelection(view, tool.id, view.currentRowId)).toBe(view.indexById[tool.id])
    const noTools = buildTreeView({ state: f.state, transcripts: f.transcripts, currentSessionID: TRUNK, expanded: new Set(), filter: "user-only" })
    // a filtered-out step: nothing else identifies its turn (assistant ids ≠ user ids), so the
    // resolver keeps the cursor position when given one, else falls back to the current row
    expect(resolveSelection(noTools, tool.id, noTools.currentRowId, 1)).toBe(1)
    expect(resolveSelection(noTools, tool.id, noTools.currentRowId)).toBe(noTools.indexById[noTools.currentRowId!])
    expect(resolveSelection(view, "nope:nope", view.currentRowId)).toBe(view.indexById[view.currentRowId!])
  })
})

describe("separator rows are decoration, never the cursor", () => {
  const branchView = buildTreeView({ state: f.state, transcripts: f.transcripts, currentSessionID: OPEN, expanded: new Set(), filter: "default" })
  const sep = branchView.rows.findIndex((r) => r.kind === "separator")

  test("moveSelection steps over it in both directions", () => {
    expect(sep).toBeGreaterThan(0)
    expect(moveSelection(branchView.rows, sep - 1, 1)).toBe(sep + 1)
    expect(moveSelection(branchView.rows, sep + 1, -1)).toBe(sep - 1)
    expect(moveSelection(branchView.rows, 0, branchView.rows.length)).toBe(branchView.rows.length - 1)
  })
  test("first/last and resolveSelection land on real rows", () => {
    expect(firstIndex(branchView.rows)).toBe(0)
    expect(lastIndex(branchView.rows)).toBe(branchView.rows.length - 1)
    expect(resolveSelection(branchView, branchView.rows[sep]!.id, branchView.currentRowId)).toBe(sep + 1)
    expect(resolveSelection(branchView, "nope:nope", undefined, sep)).toBe(sep + 1)
  })
  test("nextBranchIndex still only lands on branch rows", () => {
    const i = nextBranchIndex(branchView.rows, 0, 1)
    expect(branchView.rows[i]!.kind).toBe("branch")
  })
})
