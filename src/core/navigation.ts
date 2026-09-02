/**
 * Pure row-selection and expand/filter helpers for the tree + trajectory route
 * (DESIGN.md §7). Operates on a `Row[]`/`TreeView` built by `core/tree.ts`.
 *
 * Pure, no OpenCode/opentui/solid-js imports — see test/core-purity.test.ts.
 */
import type { Filter, Row, TreeView } from "./tree.js"

/** Move the selection by `delta` rows, clamped to the row list's bounds.
 *  Returns -1 for an empty row list. */
export function moveSelection(rows: Row[], index: number, delta: number): number {
  if (rows.length === 0) return -1
  const next = index + delta
  if (next < 0) return 0
  if (next > rows.length - 1) return rows.length - 1
  return next
}

export function firstIndex(rows: Row[]): number {
  return rows.length ? 0 : -1
}

export function lastIndex(rows: Row[]): number {
  return rows.length ? rows.length - 1 : -1
}

/** The next/previous `branch` row from `index` in direction `dir` (DESIGN.md §7.2's
 *  gutter jump). Stays put if there is no branch row in that direction. */
export function nextBranchIndex(rows: Row[], index: number, dir: 1 | -1): number {
  if (rows.length === 0) return index
  let i = index
  for (let step = 0; step < rows.length; step++) {
    i += dir
    if (i < 0 || i >= rows.length) return index
    if (rows[i]!.kind === "branch") return i
  }
  return index
}

/** Toggle one sessionID's membership in the `expanded` set, returning a new Set
 *  (DESIGN.md §7's `e`/`→` expand, `←` fold). */
export function toggleExpanded(expanded: Set<string>, sessionID: string): Set<string> {
  const next = new Set(expanded)
  if (next.has(sessionID)) next.delete(sessionID)
  else next.add(sessionID)
  return next
}

const FILTER_ORDER: Filter[] = ["default", "no-tools", "user-only", "labeled", "all"]

/** `f` cycles `default → no-tools → user-only → labeled → all → default …`
 *  (DESIGN.md §7.5). */
export function cycleFilter(filter: Filter): Filter {
  const idx = FILTER_ORDER.indexOf(filter)
  return FILTER_ORDER[(idx + 1) % FILTER_ORDER.length]!
}

/**
 * Resolve which row index should carry the selection after the view was rebuilt
 * (a filter/search/expand change, a journal refold, …):
 * 1. `preferredId` (the previously-selected row's id) if it is still present.
 * 2. Failing that, the nearest surviving row for the same message — a step row's
 *    id is `sessionID:messageID:partID`, so its owning turn (`sessionID:messageID`)
 *    is a reasonable "nearest" landing spot when the step itself was filtered out.
 * 2b. `previousIndex`, clamped, when given — keeps the cursor where it was.
 * 3. `currentRowId` (or, failing that, `view.currentRowId`) — the "you are here" row.
 * 4. The first row, or -1 if the view is empty.
 */
export function resolveSelection(
  view: TreeView,
  preferredId: string | undefined,
  currentRowId: string | undefined,
  previousIndex?: number,
): number {
  if (view.rows.length === 0) return -1

  if (preferredId !== undefined) {
    const exact = view.indexById[preferredId]
    if (exact !== undefined) return exact

    const owner = preferredId.split(":").slice(0, 2).join(":")
    for (let i = 0; i < view.rows.length; i++) {
      const row = view.rows[i]!
      const rowOwner = row.kind === "branch" ? row.id : `${row.sessionID}:${row.messageID}`
      if (rowOwner === owner) return i
    }
  }

  // 2b. the row that now sits where the old selection was (filter/fold changed the list)
  if (previousIndex !== undefined && previousIndex >= 0) return Math.min(previousIndex, view.rows.length - 1)

  if (currentRowId !== undefined) {
    const idx = view.indexById[currentRowId]
    if (idx !== undefined) return idx
  }

  if (view.currentRowId !== undefined) {
    const idx = view.indexById[view.currentRowId]
    if (idx !== undefined) return idx
  }

  return 0
}
