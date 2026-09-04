import { describe, expect, test } from "bun:test"
import { cycleFilter, firstIndex, lastIndex, moveSelection, nextBranchIndex, paneWindow, resolveSelection, scrollPane, toggleExpanded } from "../src/core/navigation.js"
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

describe("paneWindow — the inspector scroller", () => {
  test("content shorter than the pane never scrolls", () => {
    expect(paneWindow(5, 20, 0)).toEqual({ start: 0, from: 1, to: 5 })
    expect(paneWindow(5, 20, 99)).toEqual({ start: 0, from: 1, to: 5 })
  })
  test("the last page sits flush with the end instead of scrolling into blank space", () => {
    expect(paneWindow(118, 20, 999)).toEqual({ start: 98, from: 99, to: 118 })
    expect(paneWindow(118, 20, 98)).toEqual({ start: 98, from: 99, to: 118 })
  })
  test("mid-scroll reads as the screenshot's missing figure would", () => {
    expect(paneWindow(118, 29, 11)).toEqual({ start: 11, from: 12, to: 40 })
  })
  test("empty content reports nothing rather than 1–0 of 0", () => {
    expect(paneWindow(0, 20, 0)).toEqual({ start: 0, from: 0, to: 0 })
  })
  test("a shorter row cannot strand the view past the end (clamping is in the getter)", () => {
    const deep = paneWindow(500, 20, 400).start
    expect(paneWindow(30, 20, deep)).toEqual({ start: 10, from: 11, to: 30 })
  })
})

describe("scrollPane", () => {
  test("a page down overlaps by two lines so the eye keeps its place", () => {
    expect(scrollPane(118, 20, 0, 1)).toBe(18)
    expect(scrollPane(118, 20, 18, 1)).toBe(36)
  })
  test("up and down are symmetric, and both clamp", () => {
    expect(scrollPane(118, 20, 18, -1)).toBe(0)
    expect(scrollPane(118, 20, 0, -1)).toBe(0)
    expect(scrollPane(118, 20, 98, 1)).toBe(98)
  })
  test("paging down repeatedly lands on the last page and stops", () => {
    let top = 0
    for (let i = 0; i < 50; i++) top = scrollPane(118, 20, top, 1)
    expect(top).toBe(98)
    expect(paneWindow(118, 20, top).to).toBe(118)
  })
  test("a pane of one line still advances", () => {
    expect(scrollPane(10, 1, 0, 1)).toBe(1)
  })
})
