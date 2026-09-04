/** @jsxImportSource @opentui/solid */
/**
 * The combined tree + trajectory route (DESIGN.md §7). Pure view model from core,
 * OpenCode data through the adapters, actions through ./actions.
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { PLUGIN_VERSION } from "../shared/version.js"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { abandonedTail, planJump, type AbandonedTail, type JumpPlan } from "../core/actions.js"
import { foldJournal, type TreeState } from "../core/journal.js"
import { firstIndex, lastIndex, moveSelection, nextBranchIndex, paneWindow, resolveSelection, scrollPane, toggleExpanded } from "../core/navigation.js"
import { contextSizeOf, formatContext, formatK, type MinimalMessage } from "../core/tokens.js"
import { buildSpineMap, buildTreeView, currentChainOf, formatPromptAt, promptAtRow, type Filter, type Row, type StepRow, type TurnRow } from "../core/tree.js"
import { ContextGauge } from "./gauge.js"
import type { Transcript } from "../core/transcript.js"
import type { JournalStore } from "../shared/store.js"
import { applyCrop, branchLabel, BRANCH_DIALOG, clip as clipTo, copyText, createNamedBranch, describeTail, executeJump, executeUndo, jumpDialogOptions, jumpDialogTitle, mergeBranch, mergeDialogOptions, mergeDialogTitle, mergePickerFigures, MERGE_TRUST, setLabel, UNDO_KEY, type ActionContext, type MergeMode, type SummaryChoice } from "./actions.js"
import { decisionSummary, exportDecisions, renderDecision } from "../core/decision.js"
import { laneLabel, laneSuffix, layoutEventStrip, overviewTrack, stripIndexFor, windowFor, LANE_CHROME, type LaneMode, type StripCell } from "../core/lanes.js"
import { bar, consumers, type Consumer, type ConsumerEntry } from "../core/consumers.js"
import { hasEditor } from "./editor.js"
import fs from "node:fs"
import path from "node:path"
import { autoMark, planResultCrop, planTurnCrops, reclaimed, resultCandidates, turnCandidates, type ResultCandidate, type TurnCandidate } from "../core/cropplan.js"
import { planUndo } from "../core/undo.js"
import { fetchTranscript, liveTranscript, mergeTranscripts, modelContextLimit } from "./transcripts.js"
import { debug } from "../shared/debug.js"

export type TreeRouteProps = {
  api: TuiPluginApi
  store: JournalStore
  directory: string
  sessionID?: string
  options: { jumpSummary: "ask" | "never"; hardCrop?: boolean; keybinds?: Record<string, string[]> }
  /** Bumped by the host when native forks were adopted, so the open route refolds. */
  refresh?: () => number
  /** open directly on a secondary view */
  initialView?: "tree" | "decisions"
}

function statusColor(t: TuiPluginApi["theme"]["current"], status: Row & { kind: "branch" }): unknown {
  switch (status.status) {
    case "open":
      return t.success
    case "squashed":
      return t.info
    case "rejected":
    case "discarded":
      return t.error
    default:
      return t.textMuted
  }
}

/** Row previews come from message text: markdown emphasis is noise at one line. */
function plain(text: string): string {
  return text.replace(/\*\*|`/g, "")
}

function fitRow(body: string, tokens: string, width: number): string {
  const room = Math.max(10, width - tokens.length - 2)
  const clipped = body.length > room ? `${body.slice(0, room - 1)}…` : body.padEnd(room)
  return `${clipped} ${tokens}`
}

/** Display glyph, from the row's semantic flags rather than the stored glyph. */
function glyphOf(row: TurnRow | StepRow): string {
  if (row.kind === "turn") return row.isDecision ? "◆" : row.isSummary ? "≣" : "●"
  if (row.glyph === "⚙") return "⚙"
  if (row.glyph === "◇") return "≣" // OpenCode-native compaction summary
  return "○"
}

/** Content-forward row text — Pi's outline × DSH's trajectory: `user:` / `assistant:` inline,
 *  tool steps as `[bash $ …]` / `[tool: arg] → out` (from partPreview), decisions/summaries
 *  labelled. The gutter (drawn separately) carries the tree structure, not fixed columns. */
function textOf(row: TurnRow | StepRow): string {
  if (row.kind === "turn") {
    if (row.isDecision) return plain(row.preview).replace(/^◆\s*/, "").replace(/^#+\s*/, "")
    if (row.isSummary) return plain(row.preview)
    return `user: ${plain(row.preview)}`
  }
  if (row.glyph === "⚙" || row.glyph === "◇") return plain(row.preview)
  return `assistant: ${plain(row.preview)}`
}

/** The reasoning time folded onto this step by core (thinking parts have no row of their own
 *  outside the `all` filter); drawn dim by the caller. */
function thoughtOf(row: Row): string {
  if (row.kind !== "step" || row.thinkingMs === undefined) return ""
  return ` · ${(row.thinkingMs / 1000).toFixed(row.thinkingMs < 10_000 ? 1 : 0)}s thought`
}

function rowLine(row: Row, width: number, here: boolean): string {
  // decoration, not content: no glyph, no token column
  if (row.kind === "separator") return `${row.gutter}${row.text}`
  const tokens = `${row.kind !== "branch" && row.estimated ? "~" : ""}${formatK(row.tokens)}`
  const marker = here ? "  ← here" : ""
  let body: string
  if (row.kind === "branch") {
    const model = row.model ? ` · ${row.model.split("/").pop()}` : ""
    const fold = row.expanded ? "▾" : "▸"
    const turns = `${row.turns} turn${row.turns === 1 ? "" : "s"}`
    // nothing to expand yet: a ▸ caret here reads as a broken/empty branch
    const meta = row.turns === 0 ? `${row.status} · just branched, nothing here yet` : `${fold} ${row.status} · ${turns}${model}`
    body = `${row.gutter} ${row.name}  ${meta}${marker}`
  } else {
    const flags =
      row.kind === "step"
        ? `${row.label ? ` [${row.label}]` : ""}${row.isCropped ? " ✂" : ""}${row.warn ? " ⚠" : ""}${row.isError ? " ✗" : ""}`
        : row.label
          ? ` [${row.label}]`
          : ""
    const dur = row.kind === "step" && row.durationMs !== undefined ? ` ${(row.durationMs / 1000).toFixed(row.durationMs < 10_000 ? 1 : 0)}s` : ""
    body = `${row.gutter}${glyphOf(row)} ${textOf(row)}${flags}${dur}${thoughtOf(row)}${marker}`
  }
  return fitRow(body, tokens, width)
}

/** A rendered row split for colour: the live search hit and the dim `…s thought` tail.
 *  One segment means "draw it as one plain string" (the common case). */
type Segment = { text: string; kind: "plain" | "match" | "dim" }
function segmentsOf(line: string, query: string, thought: string): Segment[] {
  const ranges: { at: number; len: number; kind: "match" | "dim" }[] = []
  if (query) {
    const at = line.toLowerCase().indexOf(query.toLowerCase())
    if (at >= 0) ranges.push({ at, len: query.length, kind: "match" })
  }
  if (thought) {
    const at = line.lastIndexOf(thought)
    if (at >= 0) ranges.push({ at, len: thought.length, kind: "dim" })
  }
  if (ranges.length === 0) return [{ text: line, kind: "plain" }]
  const out: Segment[] = []
  let cursor = 0
  for (const r of ranges.sort((a, b) => a.at - b.at)) {
    if (r.at < cursor) continue // the query matched inside the tail: the first range wins
    if (r.at > cursor) out.push({ text: line.slice(cursor, r.at), kind: "plain" })
    out.push({ text: line.slice(r.at, r.at + r.len), kind: r.kind })
    cursor = r.at + r.len
  }
  if (cursor < line.length) out.push({ text: line.slice(cursor), kind: "plain" })
  return out
}

/** Vim-aligned defaults; every name is rebindable through the `keybinds` option. */
const DEFAULT_KEYS: Record<string, string[]> = {
  up: ["up", "k"],
  down: ["down", "j"],
  jump_up: ["shift+up", "shift+k"],
  jump_down: ["shift+down", "shift+j"],
  half_up: ["ctrl+u"],
  half_down: ["ctrl+d"],
  // a sequence, so bare `g` is free (and never fires on its own)
  first: ["gg"],
  last: ["shift+g"],
  prev_branch: ["["],
  next_branch: ["]"],
  fold: ["left", "h"],
  unfold: ["right", "l"],
  toggle: ["tab", "e"],
  go: ["return"],
  branch: ["b"],
  crop: ["c"],
  crop_toggle_mode: ["t"],
  mark: ["space"],
  auto: ["a"],
  undo: ["u", "x"],
  merge: ["m"],
  inspector: ["i"],
  inspector_full: ["shift+i"],
  inspector_up: ["pageup"],
  inspector_down: ["pagedown"],
  consumers: ["s"],
  copy: ["y"],
  mode_duration: ["1"],
  mode_turns: ["2"],
  lanes_off: ["0"],
  decisions: ["shift+d"],
  export: ["shift+e"],
  label: ["shift+l"],
  filter_pick: ["f"],
  filter_prev: ["shift+f"],
  search: ["/"],
  search_next: ["n"],
  search_prev: ["shift+n"],
  // terminals disagree on whether "?" carries the shift flag, so bind both spellings
  help: ["?", "shift+/"],
  back: ["q", "escape"],
}

/** Ceiling on the lines the inspector materialises for one field. The pane scrolls, so this is
 *  only a guard against building a huge array each render; `y` copies the untruncated text. */
const INSPECTOR_MAX_LINES = 2000

/** Placeholder for the strip while no session is loaded. */
const EMPTY_TRANSCRIPT: Transcript = { sessionID: "", title: "", status: "available", messages: [] }

const NO_BRANCHES = "No branches yet · b forks here into a real OpenCode session; nothing is copied or deleted."

/** The `?` pane: unindented lines are headings, indented ones body (see the render).
 *  It sits under the rows, so the tree stays on screen while you read it. */
const HELP = [
  `? help · ? or esc closes · opencode-context-tree ${PLUGIN_VERSION}`,
  "Move",
  "  ↑↓ j k · J K by 20 · ctrl+d ctrl+u half page · gg top · G bottom · [ ] branch rows",
  "  h l ← → fold/unfold a branch · Tab (or e) toggle · / live search · n N next/prev match",
  "Act",
  "  ⏎ go — a ⎇ header switches to it · a user turn forks & prefills it · a step forks after it",
  "     then: no summary · summarize everything below that point · summarize with your own prompt (esc stays put)",
  "  b branch · m merge · c crop mode (space mark · a auto · t result⇄turn · ⏎ apply · esc leave)",
  "  u undo (alias x) · L label · y copy · E export decisions",
  "Views",
  "  i inspector · I full screen · PgUp/PgDn scroll it · 1 2 lanes (duration/turns x-axis) · 0 off",
  "  s consumers · D decisions · f F filter",
  "Legend",
  "  ● user · ○ assistant · ⚙ tool step · ◆ decision · ≣ summary · ⎇ branch (a real OpenCode session)",
  "  │ ├ ╰ draw the topology · ▾ open ▸ folded · ← here is the session you are in",
  "  dim rows are not sent to the model; ── not in this branch's context ── is where your path forked",
  "  right column is tokens; ~ estimated · ⚠ ≥10k · ✂ cropped · ✗ tool error",
  "  status-line right: the prompt really sent at the cursor · history, not re-costed after a crop",
  "  ⎇ colours: open green · squashed blue · rejected/discarded red · abandoned grey",
  "  lanes: Input green you / grey context · Model purple answer / grey thinking · Tools orange call / red failed",
  "  the lanes are a window that follows the cursor: …N / N… are events hidden either side, all = whole session",
  "  │ in the lanes is a turn boundary · the lanes show what the f filter shows (f → tools-only = just calls)",
]

/** `f` opens this as a picker; `F` steps back through it (DESIGN.md §7.5). */
const FILTERS: { title: string; value: Filter; description: string }[] = [
  { title: "default", value: "default", description: "user turns, assistant text, tool steps" },
  { title: "no-tools", value: "no-tools", description: "hide ⚙ tool steps" },
  { title: "tools-only", value: "tools-only", description: "⚙ tool steps only — what did I run (the lanes follow)" },
  { title: "user-only", value: "user-only", description: "● user turns only" },
  { title: "labeled", value: "labeled", description: "labelled rows only" },
  { title: "all", value: "all", description: "everything, thinking parts included" },
]

/** Plugin option `keybinds: { <command>: "k,up" | [..] | "none" }` overrides DEFAULT_KEYS. */
function bindingsFor(overrides: Record<string, string[]> | undefined) {
  const out: { key: string; cmd: string }[] = []
  for (const [cmd, keys] of Object.entries(DEFAULT_KEYS)) for (const key of overrides?.[cmd] ?? keys) out.push({ key, cmd: `ctree.${cmd}` })
  return out
}

export function TreeRoute(props: TreeRouteProps) {
  const { api, store, directory } = props
  const sessionID = props.sessionID
  const t = api.theme.current

  const [tick, setTick] = createSignal(0)
  const bump = () => setTick((n) => n + 1)
  createEffect(on(() => props.refresh?.(), () => bump(), { defer: true }))
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set(api.kv.get<string[]>(`ctree.expanded.${sessionID}`, [])))
  const [filter, setFilter] = createSignal<Filter>(api.kv.get<Filter>("ctree.filter", "default"))
  const [search, setSearch] = createSignal("")
  // `/` types straight into the row list; esc restores the query it started from
  const [searchMode, setSearchMode] = createSignal(false)
  let searchBefore = ""
  const [selected, setSelected] = createSignal(0)
  const [others, setOthers] = createSignal<Record<string, Transcript>>({})
  const [busy, setBusy] = createSignal<string | undefined>()
  /** Set while a jump is drafting its branch summary: `esc` cancels the draft, and with it the
   *  jump — nothing has been forked or switched yet (Pi's `abortBranchSummary`). */
  const [summaryAbort, setSummaryAbort] = createSignal<AbortController | undefined>()
  const [cropMode, setCropMode] = createSignal<"result" | "turn" | undefined>()
  const [panel, setPanel] = createSignal<"tree" | "decisions" | "consumers" | "help">(props.initialView ?? "tree")
  // "calls" was a third mode until it became the `tools-only` row filter; old kv still holds it
  const [laneMode, setLaneMode] = createSignal<LaneMode>(api.kv.get<LaneMode>("ctree.lanes", "turns") === "duration" ? "duration" : "turns")
  // DSH lanes and inspector are first-class but off by default, so the first screen reads as
  // Pi's clean outline (header + tree + footer); `1/2/3` and `i` bring them in, one keystroke.
  const [lanesOn, setLanesOn] = createSignal<boolean>(api.kv.get<boolean>("ctree.lanesOn", false))
  /** Full-screen inspector (`shift+i`), and the only inspector below 110 columns where the
   *  side pane does not fit — DESIGN.md §7.1's promised `pi-context-tree` inspect view. */
  const [inspectorFull, setInspectorFull] = createSignal(false)
  /** First inspector line drawn: `PgUp`/`PgDn` move it, a new row resets it. */
  const [inspectorTop, setInspectorTop] = createSignal(0)
  const [inspector, setInspector] = createSignal<boolean>(api.kv.get<boolean>("ctree.inspector", false))
  const [consumerIndex, setConsumerIndex] = createSignal(0)
  const [consumerOpen, setConsumerOpen] = createSignal<Set<string>>(new Set())
  const [decisionIndex, setDecisionIndex] = createSignal(0)
  const [decisionScroll, setDecisionScroll] = createSignal(0)
  const [marked, setMarked] = createSignal<Set<string>>(new Set())

  // `api.ui.toast` draws in the session chrome this route replaces, so a toast raised from here
  // is never seen: route-level feedback goes to the status line instead. Actions shared with the
  // palette (actions.ts) take this as `ctx.notify`, falling back to `api.ui.toast` without one.
  const [notice, setNotice] = createSignal<string | undefined>()
  let noticeTimer: ReturnType<typeof setTimeout> | undefined
  const notify = (message: string, ms = 4000) => {
    setNotice(message)
    clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => setNotice(undefined), ms)
  }
  onCleanup(() => clearTimeout(noticeTimer))
  const ctx: ActionContext = { api, store, directory, notify }

  const state = createMemo<TreeState>(() => {
    tick()
    return (sessionID && store.stateForSession(sessionID)) || foldJournal([], "none")
  })

  // Sessions in the tree other than the current one, through the SDK. Closed/forgotten
  // branches are immutable, so they are fetched once; open ones are refreshed per tick.
  // A sequence number drops responses that were overtaken by a newer run.
  let fetchSeq = 0
  createEffect(
    on([state, tick], async () => {
      if (!sessionID) return
      const seq = ++fetchSeq
      const st = state()
      const ids = new Set<string>()
      for (const id of Object.keys(st.sessions)) ids.add(id)
      for (const b of Object.values(st.sessions)) ids.add(b.parentSessionID)
      if (st.root) ids.add(st.root)
      ids.delete(sessionID)
      const cached = others()
      const onPath = new Set(currentChainOf(st, sessionID))
      const wanted = [...ids].filter((id) => {
        const tr = cached[id]
        // uncached, or an open (still-mutable) branch: always (re)fetch
        if (!tr || (st.sessions[id]?.status ?? "open") === "open") return true
        // a closed on-path ancestor whose single fetch failed comes back status:"deleted"; without
        // this it would never retry and its rows would stay missing from the tree (core keeps the
        // current session visible meanwhile). Retry while it is still missing/deleted.
        return onPath.has(id) && tr.status === "deleted"
      })
      if (wanted.length === 0) return
      const loaded = await Promise.all(wanted.map((id) => fetchTranscript(api, id, directory)))
      if (seq !== fetchSeq) return
      setOthers((prev) => ({ ...prev, ...Object.fromEntries(loaded.map((tr) => [tr.sessionID, tr])) }))
    }),
  )

  // The current session's full history (api.state stops at OpenCode's last page — see
  // mergeTranscripts). Refetched per tick so crops/merges that remove messages are reflected.
  const [selfFull, setSelfFull] = createSignal<Transcript | undefined>()
  let selfSeq = 0
  createEffect(
    on([state, tick], async () => {
      if (!sessionID) return
      const seq = ++selfSeq
      const t0 = performance.now()
      const tr = await fetchTranscript(api, sessionID, directory)
      if (seq !== selfSeq || tr.status !== "available") return
      debug("route.selfTranscript", { messages: tr.messages.length, ms: Math.round(performance.now() - t0) })
      setSelfFull(tr)
    }),
  )

  const live = createMemo(() => (sessionID ? mergeTranscripts(selfFull(), liveTranscript(api, sessionID)) : undefined))
  const transcripts = createMemo(() => (sessionID ? { ...others(), [sessionID]: live()! } : {}))
  const spine = createMemo(() => buildSpineMap({ state: state(), transcripts: transcripts(), currentSessionID: sessionID ?? "" }))

  const view = createMemo(() => {
    if (!sessionID) return { rows: [] as Row[], indexById: {}, currentRowId: undefined, totalTokens: 0, totalEstimated: false }
    const st = state()
    const labels: Record<string, string> = {}
    for (const l of Object.values(st.labels)) labels[l.messageID] = l.label
    // crop targets are recorded with the current session's ids; prefix rows carry the
    // ancestor's, so translate through the spine map before the view compares them
    const crops = st.activeCrops(sessionID).flatMap((c) =>
      c.targets.map((x) => {
        if (x.partID) {
          const owner = spine().partFromCurrent(x.messageID, x.partID)
          return owner ? { messageID: owner.messageID, partID: owner.partID } : { messageID: x.messageID, partID: x.partID }
        }
        const owner = spine().fromCurrent(x.messageID)
        return { messageID: owner?.messageID ?? x.messageID, partID: undefined }
      }),
    )
    return buildTreeView({
      state: st,
      transcripts: transcripts(),
      currentSessionID: sessionID,
      expanded: expanded(),
      filter: filter(),
      search: search() || undefined,
      labels,
      crops,
    })
  })

  // Keep the cursor sensible when the list is rebuilt.
  let lastId: string | undefined
  let initialised = false
  createEffect(
    on(view, (v) => {
      if (!initialised) {
        initialised = true
        setSelected(resolveSelection(v, undefined, v.currentRowId))
      } else {
        setSelected(resolveSelection(v, lastId, v.currentRowId, selected()))
      }
      lastId = v.rows[selected()]?.id
    }),
  )
  createEffect(() => {
    lastId = view().rows[selected()]?.id
  })

  const current = () => view().rows[selected()]
  // renderer.width/height are plain fields, so the terminal size only relayouts if we listen
  const terminal = () => api.renderer as unknown as { width?: number; height?: number }
  const [size, setSize] = createSignal({ cols: terminal().width ?? 120, rows: terminal().height ?? 30 })
  const onResize = () => setSize({ cols: terminal().width ?? 120, rows: terminal().height ?? 30 })
  api.renderer.on("resize", onResize)
  onCleanup(() => void api.renderer.off("resize", onResize))
  const cols = () => size().cols
  // the `?` pane sits under the rows so the tree stays visible: it takes its space from them
  const helpHeight = () => (panel() === "help" ? Math.min(HELP.length, Math.max(0, size().rows - 12)) : 0)
  const width = () => Math.max(60, cols() - 4)
  // ---- lane geometry (the lanes themselves are further down) ----------------
  /** The strip fills the terminal, ending on the same column as the rows and the status line.
   *  The `+ 2` is the `│ ` a row draws *outside* its own width — a lane label carries its own,
   *  so those two columns come back to the strip. No ceiling: the strip is a window onto an
   *  unbounded layout, so more cells is more events visible and less scrolling, and the
   *  overview track hides itself once nothing is off-screen (`laneOverview`). */
  const laneWidth = () => Math.max(10, width() + 2 - LANE_CHROME)
  const layout = createMemo(() => layoutEventStrip(live() ?? EMPTY_TRANSCRIPT, laneMode(), filter()))
  /** DESIGN.md §7.6: below 80 columns the strip is the Input lane alone. */
  const showAllLanes = () => cols() >= 80
  /** The overview track only exists — and only costs its row — when the timeline overflows. */
  const laneOverview = () => showAllLanes() && layout().totalWidth > laneWidth()
  // chrome above/below the rows: padding, header, status, footer (+3 lane lines when lanes are on,
  // +1 for the overview track)
  const height = () => Math.max(4, size().rows - 8 - (lanesOn() && size().rows >= 12 ? (laneOverview() ? 4 : 3) : 0) - helpHeight())
  /** Two lines go to the `↑ n more` / `… n more ↓` cues as soon as the list does not fit. */
  const overflow = () => view().rows.length > height() - 2
  const rowsHeight = () => (overflow() ? height() - 2 : height())
  const windowStart = createMemo(() => {
    const h = rowsHeight()
    const s = selected()
    const n = view().rows.length
    return Math.max(0, Math.min(s - Math.floor(h / 2), n - h))
  })
  const visible = createMemo(() => view().rows.slice(windowStart(), windowStart() + rowsHeight()))
  const hiddenAbove = () => windowStart()
  const hiddenBelow = () => Math.max(0, view().rows.length - windowStart() - rowsHeight())

  // ---- crop mode -----------------------------------------------------------
  // Crops act on the *current* session's context. Spine rows above the fork point carry
  // the ancestor's message IDs, but the current session holds a positional copy of that
  // prefix; the spine map (built from unfiltered transcripts) translates both ways.
  const currentMessageOf = (row: Row): string | undefined => {
    if (row.kind === "branch" || row.kind === "separator") return undefined
    if (row.sessionID === sessionID) return row.messageID
    return spine().toCurrent(row.sessionID, row.messageID)
  }
  const currentPartOf = (row: Row & { kind: "step" }): string | undefined => {
    if (row.sessionID === sessionID) return row.partID
    return spine().partToCurrent(row.sessionID, row.messageID, row.partID)
  }
  const alreadyCropped = createMemo(() => {
    const set = new Set<string>()
    if (!sessionID) return set
    for (const c of state().activeCrops(sessionID)) for (const t of c.targets) set.add(t.partID ?? t.messageID)
    return set
  })
  const resultCands = createMemo(() => (live() ? resultCandidates(live()!, { alreadyCropped: alreadyCropped() }) : []))
  const turnCands = createMemo(() => (live() ? turnCandidates(live()!, { alreadyDropped: alreadyCropped() }) : []))
  const candidateOf = (row: Row): ResultCandidate | TurnCandidate | undefined => {
    const mode = cropMode()
    if (!mode) return undefined
    if (mode === "result") {
      if (row.kind !== "step" || row.glyph !== "⚙") return undefined
      const pid = currentPartOf(row)
      return resultCands().find((c) => c.partID === pid)
    }
    const mid = currentMessageOf(row)
    return turnCands().find((c) => c.anchorMessageID === mid)
  }
  const markKey = (c: ResultCandidate | TurnCandidate) => (c.kind === "result" ? c.partID : c.anchorMessageID)
  const selectedCandidates = createMemo(() => {
    const m = marked()
    const list: (ResultCandidate | TurnCandidate)[] = cropMode() === "result" ? resultCands() : turnCands()
    return list.filter((c) => m.has(markKey(c)))
  })

  /** The crop mode a row can be marked in, so `space` alone can enter crop mode on it. */
  function modeForRow(row: Row): "result" | "turn" | undefined {
    if (row.kind === "step" && resultCands().some((c) => c.partID === (currentPartOf(row) ?? row.partID))) return "result"
    if (row.kind !== "branch" && row.kind !== "separator" && turnCands().some((c) => c.anchorMessageID === currentMessageOf(row))) return "turn"
    return undefined
  }

  /** True when one more `space` on the selected row would override its protection. */
  const armed = () => {
    const row = current()
    const c = row ? candidateOf(row) : undefined
    if (!c) return false
    const key = markKey(c)
    return marked().has(`${key}:warned`) && !marked().has(key)
  }

  function toggleMark() {
    const row = current()
    if (!row) return
    if (!cropMode()) {
      const mode = modeForRow(row)
      if (!mode) {
        notify("nothing croppable on this row — c opens crop mode")
        return
      }
      setCropMode(mode)
    }
    const c = candidateOf(row)
    debug("crop.mark", { row: row.id, candidate: c ? { kind: c.kind, protections: c.protections } : undefined, marked: [...marked()] })
    if (!c) {
      notify(cropMode() === "result" ? "select a tool result row" : "select a turn row")
      return
    }
    const hard = c.protections.filter((p) => p !== "too-small")
    const next = new Set(marked())
    const key = markKey(c)
    if (next.has(key)) {
      next.delete(key)
      next.delete(`${key}:warned`) // unmarking forgets the warning, so re-marking asks again
    } else if (hard.length && !(next.has(`${key}:warned`))) {
      next.add(`${key}:warned`)
      notify(`protected (${hard.join(", ")}) — press space again to mark anyway`)
    } else next.add(key)
    setMarked(next)
  }

  /** Leaving crop mode throws marks away, so say how many before it happens. */
  async function leaveCropMode() {
    const n = selectedCandidates().length
    if (n > 0 && !(await confirm(`Drop ${n} mark${n === 1 ? "" : "s"}?`, "Nothing has been cropped yet — the marks are lost, the transcript is untouched."))) return
    setCropMode(undefined)
    setMarked(new Set<string>())
  }

  function autoMarkAll() {
    if (cropMode() !== "result") return
    const picks = autoMark(resultCands())
    setMarked(new Set(picks.map((c) => c.partID)))
    notify(picks.length ? `auto-marked ${picks.length} result${picks.length === 1 ? "" : "s"} (≥10k tokens, older than 2 turns)` : "nothing matches the auto rules")
  }

  async function applyMarked() {
    if (!sessionID) return
    const picks = selectedCandidates()
    debug("crop.apply", { picks: picks.length, marked: [...marked()] })
    if (picks.length === 0) {
      notify("nothing marked — space marks a row, a auto-marks")
      return
    }
    // count the plans, not the marks: planTurnCrops refuses the current turn (cropplan.ts)
    const result = cropMode() === "result"
    const plans = result ? [planResultCrop(sessionID, picks as ResultCandidate[])].filter((p) => p !== undefined) : planTurnCrops(sessionID, picks as TurnCandidate[])
    const n = result ? (plans[0]?.targets.length ?? 0) : plans.length
    if (n === 0) {
      notify("nothing to crop — the current turn always stays in context")
      return
    }
    const total = plans.reduce((s, p) => s + p.targets.reduce((x, t) => x + t.estTokens, 0), 0)
    const ok = await confirm(`Crop ${n} ${result ? "result" : "turn"}${n === 1 ? "" : "s"}?`, `~${formatK(total)} tokens leave the model's context on the next turn. Your transcript is never rewritten; the model just stops seeing these. /undo restores.`)
    if (!ok) return
    await guarded("crop", async () => {
      for (const plan of plans) await applyCrop(ctx, plan, { hard: result && Boolean(props.options.hardCrop) })
      notify(`✂ cropped ${n} · ~${formatK(total)} reclaimed`)
      setMarked(new Set<string>())
      setCropMode(undefined)
    })
  }

  async function undo() {
    if (!sessionID) return
    const st = state()
    const plan = planUndo(store.entriesFor(st.treeId), st, sessionID)
    if (plan.kind === "nothing") {
      notify("nothing to undo on this path")
      return
    }
    const what =
      plan.kind === "restore-crop" ? `restore the ${plan.mode === "turn" ? "dropped turn" : "cropped result"} (~${formatK(plan.estTokens)} tokens)` : plan.kind === "abandon-branch" ? `leave ⎇ ${plan.name ?? "this branch"} and return to its parent` : `re-open the ${plan.status} branch`
    const ok = await confirm("Undo?", `This will ${what}. Nothing is deleted.`)
    if (!ok) return
    await guarded("undo", async () => {
      await executeUndo(ctx, sessionID, plan)
    })
  }

  // the same figure the prompt gauge shows: context of the session, not of the drawn rows
  const contextSize = createMemo(() => contextSizeOf((live()?.messages ?? []).map((m): MinimalMessage => ({ info: m.role === "assistant" ? { role: "assistant", tokens: m.tokens } : { role: "user" }, parts: m.parts }))))
  const branchOfCurrent = () => (sessionID ? state().sessions[sessionID] : undefined)
  const userTurns = () => (live()?.messages ?? []).filter((m) => m.role === "user").length

  // ---- lanes (DSH event strip) ---------------------------------------------
  // One pill per event on a shared time axis — categorical colour, nothing scaled by tokens.
  // `layout` (above) is the whole session; the lanes draw a `laneWidth()` window of it that
  // follows the cursor, with `…N`/`N…` cues and the overview track for what is off-screen.
  /** The strip events the cursor sits on; their cells draw inverted, so there is no cursor block.
   *  A step row also owns the thinking pills folded into it (the list shows them as `· Ns thought`),
   *  otherwise the grey reasoning pills would never light up. */
  const cursorEvents = createMemo<Set<number>>(() => {
    const row = current()
    const hit = new Set<number>()
    if (!row || row.kind === "branch" || row.kind === "separator") return hit
    const mid = currentMessageOf(row) ?? row.messageID
    const pid = row.kind === "step" ? (currentPartOf(row) ?? row.partID) : undefined
    const own = stripIndexFor(layout(), mid, pid)
    if (own >= 0) hit.add(own)
    layout().events.forEach((e, i) => {
      if (e.messageID !== mid) return
      if (row.kind === "turn" ? e.lane === "input" : e.kind === "reasoning") hit.add(i)
    })
    return hit
  })
  /** The window follows the row's own event, else the first thinking pill folded into it. */
  const laneCursor = () => cursorEvents().values().next().value ?? -1
  const [laneStart, setLaneStart] = createSignal<number | undefined>()
  createEffect(() => {
    const l = layout()
    const w = laneWidth()
    const cursor = laneCursor()
    setLaneStart((prev) => windowFor(l, cursor, w, prev))
  })
  const laneOffset = () => laneStart() ?? Math.max(0, layout().totalWidth - laneWidth())
  const hiddenLeft = createMemo(() => layout().spans.filter((s) => s.end <= laneOffset()).length)
  const hiddenRight = createMemo(() => layout().spans.filter((s) => s.start >= laneOffset() + laneWidth()).length)
  const laneCue = (n: number) => (n > 999 ? "999" : String(n))
  const cellColor = (cell: StripCell): unknown => {
    if (cell.error) return t.error
    const e = layout().events[cell.eventIndex]
    if (!e) return t.textMuted
    if (e.lane === "tools") return t.warning
    if (e.lane === "input") return e.kind === "user" ? t.success : t.textMuted
    return e.kind === "reasoning" ? t.textMuted : t.accent
  }
  /** Adjacent cells of the same colour collapse into one <text>, so a lane is a few nodes. */
  const laneRuns = (lane: "input" | "model" | "tools") => {
    const cur = cursorEvents()
    const start = laneOffset()
    const w = laneWidth()
    const rules = new Set(layout().rules)
    const runs: { text: string; fg: unknown; bg: unknown }[] = []
    for (let c = 0; c < w; c++) {
      const cell = layout().lanes[lane][start + c] ?? null
      const sel = cell !== null && cur.has(cell.eventIndex)
      const color = cell === null ? t.textMuted : cellColor(cell)
      const fg = sel ? t.background : color
      const bg = sel ? color : undefined
      // a turn boundary is a rule across all three lanes, the way DSH marks turns on its
      // Overview — it never lands on a pill, the gap that holds it is opened for it
      const glyph = cell?.glyph ?? (rules.has(start + c) ? "│" : " ")
      const last = runs[runs.length - 1]
      if (last && last.fg === fg && last.bg === bg) last.text += glyph
      else runs.push({ text: glyph, fg, bg })
    }
    return runs
  }
  const inputRuns = createMemo(() => laneRuns("input"))
  const modelRuns = createMemo(() => laneRuns("model"))
  const toolRuns = createMemo(() => laneRuns("tools"))
  /** The whole timeline in one dim line: where the window is, and every failed call. */
  const trackRuns = createMemo(() => {
    const runs: { text: string; fg: unknown }[] = []
    for (const kind of overviewTrack(layout(), laneOffset(), laneWidth())) {
      const glyph = kind === "window" ? "━" : kind === "error" ? "·" : "─"
      const fg = kind === "window" ? t.text : kind === "error" ? t.error : t.textMuted
      const last = runs[runs.length - 1]
      if (last && last.fg === fg) last.text += glyph
      else runs.push({ text: glyph, fg })
    }
    return runs
  })
  // the context window no longer scales anything, but the Input lane still needs its limit
  const contextLimit = createMemo(() => (sessionID ? modelContextLimit(api, sessionID) : undefined))
  // under three turns every lane is one or two pills, which reads as a glitch rather than a strip
  const laneRoom = () => height() >= 12 && panel() === "tree"
  const showLanes = () => laneRoom() && lanesOn() && userTurns() >= 3
  /** `1/2/3` turn the DSH lanes on and pick the x-axis; the active one again (or `0`) hides them. */
  function setLane(mode: LaneMode) {
    if (lanesOn() && laneMode() === mode) {
      setLanesOn(false)
      api.kv.set("ctree.lanesOn", false)
      return
    }
    setLaneMode(mode)
    setLanesOn(true)
    api.kv.set("ctree.lanes", mode)
    api.kv.set("ctree.lanesOn", true)
  }

  // ---- inspector -----------------------------------------------------------
  /** The inspector has content to show — it may land in the side pane or full screen. */
  const inspectorOpen = () => inspector() && panel() === "tree"
  /** Full screen when asked for, and whenever the side pane cannot fit: `i` on an 80-column
   *  terminal used to flip a flag that rendered nothing and said nothing. */
  const showInspectorFull = () => inspectorOpen() && (inspectorFull() || cols() < 110)
  const showInspector = () => inspectorOpen() && !showInspectorFull()
  const inspectorWidth = () => Math.min(56, Math.max(36, Math.floor(width() * 0.4)))
  const rowWidth = () => (showInspector() ? width() - inspectorWidth() - 2 : width()) - (cropMode() ? 4 : 0)
  // wraps badly next to the inspector, so break it at the ";" rather than mid-clause
  const noBranchesLines = () => (NO_BRANCHES.length + 2 <= rowWidth() ? [NO_BRANCHES] : NO_BRANCHES.split(/(?<=;) /))
  const inspectorLines = createMemo((): { fg: unknown; text: string }[] => {
    const row = current()
    if (!row || row.kind === "separator") return []
    const w = (showInspectorFull() ? width() : inspectorWidth()) - 3
    const clip = (x: string) => (x.length > w ? `${x.slice(0, w - 1)}…` : x)
    const out: { fg: unknown; text: string }[] = []
    const head = (x: string) => out.push({ fg: t.primary, text: clip(x) })
    const kv = (k: string, v: string) => out.push({ fg: t.text, text: clip(`${k.padEnd(10)}${v}`) })
    const muted = (x: string) => out.push({ fg: t.textMuted, text: clip(x) })
    // every line, for the scroller to window — bounded only so a pathological payload cannot
    // build an unbounded array on each render; `y` still copies the untruncated original
    const block = (label: string, text: string) => {
      const lines = text.split("\n").filter((l) => l.length)
      kv(label, lines[0] ?? "")
      for (const l of lines.slice(1, INSPECTOR_MAX_LINES)) out.push({ fg: t.text, text: clip(`          ${l}`) })
      if (lines.length > INSPECTOR_MAX_LINES) muted(`          … ${lines.length - INSPECTOR_MAX_LINES} more lines (y to copy)`)
    }
    if (row.kind === "branch") {
      head(`⎇ ${row.name}`)
      kv("Status", row.status)
      if (row.note) muted(`note: ${row.note}`)
      kv("Parent", others()[row.parentSessionID]?.title ?? row.parentSessionID)
      kv("Anchor", row.anchorMessageID.slice(0, 20))
      kv("Turns", String(row.turns))
      kv("Tokens", `~${formatK(row.tokens)}`)
      if (row.model) kv("Model", row.model)
      muted(row.isCurrent ? "you are here" : row.expanded ? "← fold" : "→ expand · ⏎ switch to it")
      return out
    }
    const tr = row.sessionID === sessionID ? live() : others()[row.sessionID]
    const msg = tr?.messages.find((m) => m.id === row.messageID)
    const turn = view().rows.slice(0, view().indexById[row.id]! + 1).filter((r) => r.kind === "turn").at(-1)
    if (row.kind === "turn") {
      const text = msg?.parts.map((p) => p.text ?? "").join("\n") ?? row.preview
      if (row.isDecision) {
        // a record is prose, not a payload: markdown off, wrapped to the pane
        head(`◆ ${decisionSummary(text).title}`)
        kv("Tokens", `~${formatK(row.tokens)}`)
        const lines = renderDecision(text, w)
        for (const l of lines.slice(0, INSPECTOR_MAX_LINES)) out.push({ fg: t.text, text: l })
        if (lines.length > INSPECTOR_MAX_LINES) muted(`… ${lines.length - INSPECTOR_MAX_LINES} more lines (y to copy)`)
        return out
      }
      head(`${row.isSummary ? "◇ summary" : "● user"} · T${row.turn}`)
      if (row.label) kv("Label", row.label)
      kv("Tokens", `~${formatK(row.tokens)}`)
      kv("At", msg ? new Date(msg.time.created).toISOString().slice(11, 19) : "?")
      if (!row.inContext) muted("not in this branch's context")
      block("Text", text)
      return out
    }
    const part = msg?.parts.find((p) => p.id === row.partID)
    const stepNo = msg ? msg.parts.filter((p) => p.type === "tool" || p.type === "text").findIndex((p) => p.id === row.partID) + 1 : 0
    head(`${row.glyph} ${part?.type === "tool" ? part.tool : row.glyph === "◇" ? "compaction" : "assistant"} · T${turn?.kind === "turn" ? turn.turn : "?"} · step ${stepNo}`)
    kv("Hierarchy", `T${turn?.kind === "turn" ? turn.turn : "?"} › assistant › step ${stepNo}`)
    if (!row.inContext) muted("not in this branch's context")
    if (row.tokenFields) {
      const tf = row.tokenFields
      const cached = tf.cacheRead > 0 ? ` · ${formatK(tf.cacheRead)} cached` : ""
      const written = tf.cacheWrite > 0 ? ` · ${formatK(tf.cacheWrite)} written` : ""
      kv("Prompt", `${formatK(tf.input + tf.cacheWrite)} fresh${cached}${written}`)
      kv("Reply", `${formatK(tf.output)} out${tf.reasoning > 0 ? ` · ${formatK(tf.reasoning)} thinking` : ""}`)
    }
    if (part?.type === "tool") {
      const st = part.state
      const dur = st?.time?.start !== undefined && st?.time?.end !== undefined ? `${st.time.end - st.time.start} ms` : "?"
      kv("Status", `${st?.status ?? "?"} · ${dur}`)
      kv("Tokens", `~${formatK(row.tokens)} · ${view().totalTokens ? `${((row.tokens / view().totalTokens) * 100).toFixed(1)}% of context` : ""}`)
      block("Payload", JSON.stringify(st?.input ?? {}, null, 1))
      block("Result", String(st?.output ?? ""))
      kv("Timing", st?.time?.start ? `started ${new Date(st.time.start).toISOString().slice(11, 23)} · ${dur} · session ts` : "n/a")
      const cand = resultCands().find((c) => c.partID === (currentPartOf(row) ?? row.partID))
      kv("Crop", row.isCropped ? `✂ cropped (${UNDO_KEY} to restore)` : cand ? (cand.protections.length ? `protected: ${cand.protections.join(", ")}` : "c then space to stub this result") : "n/a")
    } else {
      kv("Tokens", `~${formatK(row.tokens)}`)
      if (row.durationMs !== undefined) kv("Duration", `${(row.durationMs / 1000).toFixed(1)} s`)
      if (row.thinkingMs !== undefined) kv("Thought", `${(row.thinkingMs / 1000).toFixed(1)} s`)
      block("Text", part?.text ?? row.preview)
    }
    return out
  })

  /** Lines the inspector can draw; one is given up to the position line when it overflows. */
  const inspectorRoom = () => Math.max(1, height() - (inspectorOverflow() ? 1 : 0))
  const inspectorOverflow = () => inspectorLines().length > height()
  /** Clamped here rather than in the setter, so a resize or a shorter row cannot strand the
   *  view past the end of the content. */
  const inspectorPane = () => paneWindow(inspectorLines().length, inspectorRoom(), inspectorTop())
  const inspectorVisible = createMemo(() => inspectorLines().slice(inspectorPane().start, inspectorPane().start + inspectorRoom()))
  function scrollInspector(dir: 1 | -1) {
    setInspectorTop(scrollPane(inspectorLines().length, inspectorRoom(), inspectorTop(), dir))
  }
  /** `12–40 of 118 · PgUp/PgDn scroll · y copy · I full` — replaces the old per-field
   *  "… 61 more lines" dead end with where you are and how to see the rest. */
  const inspectorStatus = () => {
    const { from, to } = inspectorPane()
    return clipTo(`${from}–${to} of ${inspectorLines().length} · PgUp/PgDn · y copy · ${inspectorFull() ? "I pane" : "I full"}`, (showInspectorFull() ? width() : inspectorWidth()) - 3)
  }
  // a new row is new content: keep the reader at its top rather than mid-way down a payload
  createEffect(on(() => `${current()?.id ?? ""}:${showInspectorFull()}`, () => setInspectorTop(0)))

  // ---- consumers -------------------------------------------------------------
  const consumerRows = createMemo(() => (live() ? consumers(live()!, { cropped: alreadyCropped(), limit: contextLimit() }) : []))
  /** Buckets plus the entries of every expanded one, flattened so ↑↓ walks both. */
  type ConsumerLine = { bucket: Consumer; entry?: ConsumerEntry }
  const consumerLines = createMemo((): ConsumerLine[] =>
    consumerRows().flatMap((c) => [{ bucket: c } as ConsumerLine, ...(consumerOpen().has(c.source) ? c.entries.map((e) => ({ bucket: c, entry: e })) : [])]),
  )
  const consumerLine = () => consumerLines()[Math.min(consumerIndex(), consumerLines().length - 1)]
  /** Bars are scaled to the biggest bucket, not to the window: the shape is the point. */
  const consumerMax = () => Math.max(1, ...consumerRows().map((c) => c.tokens))

  function toggleConsumer(open: boolean) {
    const line = consumerLine()
    if (!line) return
    const next = new Set(consumerOpen())
    if (open) next.add(line.bucket.source)
    else next.delete(line.bucket.source)
    setConsumerOpen(next)
  }

  /** `space` in the consumers panel marks one part for crop where it stands — entering crop
   *  mode is implied. Entries that cannot be stubbed carry their reason on the row itself. */
  function markConsumerEntry() {
    const line = consumerLine()
    if (!line) return
    if (!line.entry) {
      toggleConsumer(true)
      return
    }
    const cand = line.entry.croppable ? resultCands().find((r) => r.partID === line.entry?.partID) : undefined
    if (!cand) return
    setCropMode("result")
    const next = new Set(marked())
    if (next.has(cand.partID)) next.delete(cand.partID)
    else next.add(cand.partID)
    setMarked(next)
  }

  /** From the consumers panel: back to the tree in crop mode with that source's
   *  unprotected results pre-marked (DESIGN.md §7.4). */
  function cropConsumer() {
    const c = consumerLine()?.bucket
    setPanel("tree")
    if (!c || c.kind !== "tool") {
      setCropMode("result")
      notify(c ? (c.note ?? `${c.source} is not a tool result; mark rows by hand`) : "nothing to crop")
      return
    }
    setCropMode("result")
    const picks = resultCands().filter((r) => r.tool === c.source && r.protections.length === 0)
    setMarked(new Set<string>(picks.map((r) => r.partID)))
    notify(picks.length ? `marked ${picks.length} unprotected ${c.source} result${picks.length === 1 ? "" : "s"} — ⏎ to apply` : `every ${c.source} result is protected; mark with space (twice) to override`)
  }

  function copySelected() {
    const row = current()
    if (!row || row.kind === "branch" || row.kind === "separator") return
    const tr = row.sessionID === sessionID ? live() : others()[row.sessionID]
    const msg = tr?.messages.find((m) => m.id === row.messageID)
    const text = row.kind === "step" ? String(msg?.parts.find((p) => p.id === row.partID)?.state?.output ?? msg?.parts.find((p) => p.id === row.partID)?.text ?? "") : (msg?.parts.map((p) => p.text ?? "").join("\n") ?? "")
    try {
      const { hint } = copyText(api, text, directory)
      notify(`copied ${text.length} chars → ${hint}`)
    } catch (e) {
      notify(`copy failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function back() {
    if (sessionID) api.route.navigate("session", { sessionID })
    else api.route.navigate("home")
  }

  /**
   * Pi's one question on `⏎` (its tree selector's "Summarize branch?"): the choice *is* the
   * confirmation, so pressing enter on a row offers "start the fork clean", "summarize
   * everything below this point" or "summarize with a prompt" in a single step.
   *
   * `esc` on the choices puts you back on the same row with nothing done, and cancelling the
   * custom-prompt editor loops back to the choices rather than silently meaning "no summary"
   * (`interactive-mode.ts#showTreeSelector`). With `jumpSummary: "never"`, or when the jump
   * abandons nothing to summarize, it degrades to the plain confirm.
   *
   * Resolves `undefined` for "changed my mind, stay in the tree".
   */
  function askJump(plan: JumpPlan & { kind: "switch" | "fork" }, tail: AbandonedTail, title: string): Promise<SummaryChoice | undefined> {
    const note =
      plan.kind === "switch"
        ? `The session you are on now stays exactly as it is. ${UNDO_KEY} undoes this.`
        : `A new OpenCode session forks from ${sessionLabel(plan.sessionID)} at this point; nothing is deleted. ${UNDO_KEY} undoes this.`
    if (props.options.jumpSummary === "never" || tail.messages.length === 0) return confirm(title, note).then((ok) => (ok ? { kind: "none" } : undefined))

    return new Promise((resolve) => {
      let done = false
      // a `replace` closes the dialog under it, and that close fires the handler we passed for
      // `esc`: the token makes every superseded handler a no-op, so only a real `esc` acts
      let gen = 0
      const settle = (value: SummaryChoice | undefined) => {
        if (done) return
        done = true
        api.ui.dialog.clear()
        resolve(value)
      }
      const openCustom = () => {
        const mine = ++gen
        const back = () => {
          if (done || mine !== gen) return
          // The host's own post-esc dismissal runs right after this handler returns, and it
          // targets whatever was on top of the stack when `esc` was pressed — if we `replace`
          // synchronously here, that dismissal fires *after* us and wipes the choices dialog
          // right back off. Deferring a tick lets the host finish closing first.
          setTimeout(() => {
            if (done || mine !== gen) return
            openChoices()
          }, 0)
        }
        api.ui.dialog.replace(
          () =>
            api.ui.DialogPrompt({
              title: "Custom summarization instructions",
              placeholder: "focus on…",
              onConfirm: (value) => settle({ kind: "summarize", customInstructions: value.trim() || undefined }),
              onCancel: back,
            }),
          back,
        )
      }
      const openChoices = () => {
        const mine = ++gen
        const cancel = () => {
          if (done || mine !== gen) return
          settle(undefined)
        }
        api.ui.dialog.replace(
          () =>
            api.ui.DialogSelect({
              title,
              options: jumpDialogOptions(tail, plan.kind),
              onSelect: (o) => {
                if (o.value === "custom") {
                  openCustom()
                  return
                }
                settle(o.value === "summarize" ? { kind: "summarize" } : { kind: "none" })
              },
            }),
          cancel,
        )
      }
      openChoices()
    })
  }

  function confirm(title: string, message: string): Promise<boolean> {
    return new Promise((resolve) => {
      api.ui.dialog.replace(
        () =>
          api.ui.DialogConfirm({
            title,
            message,
            onConfirm: () => {
              resolve(true)
              api.ui.dialog.clear()
            },
            onCancel: () => {
              resolve(false)
              api.ui.dialog.clear()
            },
          }),
        () => resolve(false),
      )
    })
  }

  function prompt(title: string, placeholder?: string, value?: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      api.ui.dialog.replace(
        () =>
          api.ui.DialogPrompt({
            title,
            placeholder,
            value,
            onConfirm: (v) => {
              resolve(v)
              api.ui.dialog.clear()
            },
            onCancel: () => {
              resolve(undefined)
              api.ui.dialog.clear()
            },
          }),
        () => resolve(undefined),
      )
    })
  }

  async function guarded(label: string, fn: () => Promise<void>) {
    if (busy()) {
      debug("route.busy", { label, busy: busy() })
      return
    }
    setBusy(label)
    try {
      await fn()
    } catch (e) {
      notify(`⚠ ${label} failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(undefined)
      bump()
    }
  }

  /** How a session reads in a dialog: its branch name if it has one, else its title. */
  const sessionLabel = (id: string) => {
    const name = state().sessions[id]?.name
    return name ? `⎇ ${name}` : (others()[id]?.title ?? api.state.session.get(id)?.title ?? id)
  }

  async function jump() {
    const row = current()
    if (!row || !sessionID) return
    const plan = planJump(row, { transcripts: transcripts(), currentSessionID: sessionID })
    debug("route.jump", { row: { kind: row.kind, id: row.id }, plan })
    if (plan.kind === "noop") {
      notify(plan.reason)
      return
    }
    // what the model would stop seeing: Pi's "entries from the old leaf to the common ancestor"
    const tail = abandonedTail({ state: state(), transcripts: transcripts(), currentSessionID: sessionID, plan })
    const title = jumpDialogTitle(plan, sessionLabel)
    const choice = await askJump(plan, tail, title)
    if (!choice) return
    await guarded("jump", async () => {
      const controller = new AbortController()
      const summarizing = choice.kind === "summarize"
      if (summarizing) {
        setSummaryAbort(controller)
        notify(`summarizing ${describeTail(tail)} below this point — esc to skip`, 120_000)
      }
      try {
        const out = await executeJump(ctx, plan, { currentSessionID: sessionID!, summary: choice, abandoned: tail.messages, signal: controller.signal })
        if (out.aborted) {
          notify("summary cancelled — nothing moved")
          return
        }
        if (out.target) api.ui.toast({ message: `moved to ${sessionLabel(out.target)} · ${UNDO_KEY} undoes it` })
      } finally {
        setSummaryAbort(undefined)
      }
    })
  }

  async function branch() {
    if (!sessionID) return
    const name = await prompt(BRANCH_DIALOG.title, BRANCH_DIALOG.placeholder)
    if (!name) return
    const model = await new Promise<string | undefined>((resolve) => {
      api.ui.dialog.replace(
        () =>
          api.ui.DialogSelect({
            title: BRANCH_DIALOG.modelTitle,
            options: [
              { title: "Keep the current model", value: "" },
              { title: "Other… (provider/model)", value: "other" },
            ],
            onSelect: (o) => {
              if (o.value === "other") {
                api.ui.dialog.replace(
                  () =>
                    api.ui.DialogPrompt({
                      title: "provider/model",
                      placeholder: "anthropic/claude-haiku-4-5",
                      onConfirm: (v) => {
                        resolve(v || undefined)
                        api.ui.dialog.clear()
                      },
                      onCancel: () => {
                        resolve(undefined)
                        api.ui.dialog.clear()
                      },
                    }),
                  () => resolve(undefined),
                )
                return
              }
              resolve(undefined)
              api.ui.dialog.clear()
            },
          }),
        () => resolve(undefined),
      )
    })
    const last = [...(api.state.session.messages(sessionID) as unknown as { role: string; providerID?: string; modelID?: string }[])].reverse().find((m) => m.role === "assistant")
    const trunkModel = last?.providerID && last.modelID ? `${last.providerID}/${last.modelID}` : undefined
    await guarded("branch", () => createNamedBranch(ctx, { sessionID, name, model, trunkModel }).then(() => undefined))
  }

  async function label() {
    const row = current()
    if (!row || row.kind === "branch" || row.kind === "separator") return
    const st = state()
    const existing = st.labels[row.messageID]?.label
    const value = await prompt("Label (empty to remove)", "checkpoint", existing)
    if (value === undefined) return
    setLabel(ctx, { sessionID: row.sessionID, messageID: row.messageID, label: value.trim() ? value.trim() : null })
    bump()
  }

  function foldOrUnfold(open: boolean) {
    const row = current()
    if (!row) return
    const target = row.kind === "separator" ? undefined : row.kind === "branch" || row.depth > 0 ? row.sessionID : undefined
    if (!target) return
    // the row's resolved state, not raw set membership: on-path branches start open, so
    // `expanded` membership inverts there (see tree.ts shownExpanded). A visible nested row
    // means its branch is shown; a branch row carries its resolved state in `expanded`.
    const shown = row.kind === "branch" ? row.expanded : true
    if (open === shown) return
    const next = toggleExpanded(expanded(), target)
    setExpanded(next)
    api.kv.set(`ctree.expanded.${sessionID}`, [...next])
  }

  const decisions = createMemo(() =>
    Object.values(state().decisions)
      .sort((a, b) => a.recordedAt - b.recordedAt),
  )

  function select<T>(title: string, options: { title: string; value: T; description?: string }[]): Promise<T | undefined> {
    return new Promise((resolve) => {
      api.ui.dialog.replace(
        () =>
          api.ui.DialogSelect<T>({
            title,
            options,
            onSelect: (o) => {
              resolve(o.value)
              api.ui.dialog.clear()
            },
          }),
        () => resolve(undefined),
      )
    })
  }

  async function merge() {
    if (!sessionID) return
    const b = branchOfCurrent()
    if (!b || b.status !== "open") {
      notify(b ? `⎇ ${branchLabel(api, sessionID, b.name, 24)} is already ${b.status}` : "no open branch to merge · b starts one")
      return
    }
    const siblings = Object.values(state().sessions).filter((x) => x.parentSessionID === b.parentSessionID && x.sessionID !== sessionID && x.status === "open").length
    const { turns, target } = await mergePickerFigures(ctx, state(), sessionID)
    const mode = await select<MergeMode>(mergeDialogTitle(branchLabel(api, sessionID, b.name), target, turns), mergeDialogOptions({ siblings, turns }))
    if (!mode) return
    const inApp = !hasEditor()
      ? async (draft: string) => {
          const ok = await confirm("Accept the drafted record as-is?", `${draft.slice(0, 400)}${draft.length > 400 ? "…" : ""}\n\n${MERGE_TRUST}\n\n(set $EDITOR to review it in your editor)`)
          return ok ? draft : undefined
        }
      : undefined
    // mergeBranch owns the discard gate (its confirm + "Why?" note prompt), so there is none here
    await guarded("merge", async () => {
      await mergeBranch(ctx, { sessionID, mode, confirm: inApp })
    })
  }

  function exportDecisionsFile() {
    const records = decisions().filter((d) => d.text).map((d) => ({ branchName: d.branchName, text: d.text!, sessionID: d.sessionID, at: d.recordedAt }))
    const file = path.join(directory, "ctree-decisions.md")
    try {
      fs.writeFileSync(file, exportDecisions(records))
      notify(`wrote ${records.length} record${records.length === 1 ? "" : "s"} → ${file}`)
    } catch (e) {
      notify(`export failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function jumpToDecision() {
    const d = decisions()[decisionIndex()]
    if (!d) return
    const idx = view().rows.findIndex((r) => (r.kind === "turn" || r.kind === "step") && r.messageID === d.messageID)
    setPanel("tree")
    if (idx >= 0) setSelected(idx)
    else notify("that record lives in another session")
  }

  // ---- keys ------------------------------------------------------------------
  const treePanel = () => panel() === "tree"
  const inCrop = () => cropMode() !== undefined
  /** Crop mode is exclusive: it owns space/⏎/esc, so the other verbs step aside. */
  const treeIdle = () => treePanel() && !inCrop()
  const listPanel = () => treePanel() || panel() === "consumers"

  function setFilterTo(next: Filter) {
    setFilter(next)
    api.kv.set("ctree.filter", next)
  }

  async function pickFilter() {
    const next = await select<Filter>(
      "Filter rows",
      FILTERS.map((f) => ({ title: `${f.value === filter() ? "●" : " "} ${f.title}`, value: f.value, description: f.description })),
    )
    if (next) setFilterTo(next)
  }

  /** ↑↓ walk whichever list is on screen. */
  function moveIndex(delta: number) {
    if (panel() === "decisions") {
      setDecisionIndex((i) => Math.min(Math.max(0, decisions().length - 1), Math.max(0, i + delta)))
      setDecisionScroll(0)
      return
    }
    if (panel() === "consumers") {
      setConsumerIndex((i) => Math.min(Math.max(0, consumerLines().length - 1), Math.max(0, i + delta)))
      return
    }
    setSelected((i) => moveSelection(view().rows, i, delta))
  }

  function halfPage(dir: 1 | -1) {
    const half = Math.max(1, Math.floor(height() / 2))
    // in the decisions panel a half page scrolls the open record, not the record list
    if (panel() === "decisions") setDecisionScroll((s) => Math.max(0, s + dir * half))
    else moveIndex(dir * half)
  }

  function gotoEdge(dir: 1 | -1) {
    if (panel() === "decisions") {
      setDecisionIndex(dir === -1 ? 0 : Math.max(0, decisions().length - 1))
      setDecisionScroll(0)
      return
    }
    if (panel() === "consumers") {
      setConsumerIndex(dir === -1 ? 0 : Math.max(0, consumerLines().length - 1))
      return
    }
    const i = dir === -1 ? firstIndex(view().rows) : lastIndex(view().rows)
    if (i >= 0) setSelected(i)
  }

  /** Where the live query sits in a rendered row (-1 when the row only survived the filter
   *  because one of the rows it owns matched). */
  const matchIn = (line: string): number => {
    const q = search().trim().toLowerCase()
    return q ? line.toLowerCase().indexOf(q) : -1
  }

  function moveMatch(dir: 1 | -1) {
    const rows = view().rows
    const q = search().trim()
    if (rows.length === 0 || !q) return
    for (let step = 1; step <= rows.length; step++) {
      const i = (((selected() + dir * step) % rows.length) + rows.length) % rows.length
      if (rows[i]!.kind !== "separator" && matchIn(rowLine(rows[i]!, rowWidth(), false)) >= 0) {
        setSelected(i)
        return
      }
    }
    notify(`no other row matches "${q}"`)
  }

  function enterSearch() {
    searchBefore = search()
    setSearchMode(true)
  }

  /** `esc` puts the view back the way it was; `⏎` keeps the filter and leaves the mode. */
  function exitSearch(commit: boolean) {
    if (!commit) setSearch(searchBefore)
    setSearchMode(false)
  }

  // Search types straight into the row list, and the layer below would fire j/k/b as commands:
  // while the mode is on we take the key before any binding sees it.
  const stopTyping = api.keymap.intercept("key", (input) => {
    if (!searchMode()) return
    const ev = input.event
    if (ev.eventType === "release" || ev.ctrl || ev.meta) return
    const take = () => input.consume({ preventDefault: true, stopPropagation: true })
    if (ev.name === "escape") return void (exitSearch(false), take())
    if (ev.name === "return" || ev.name === "enter") return void (exitSearch(true), take())
    if (ev.name === "backspace") return void (setSearch((q) => q.slice(0, -1)), take())
    const char = ev.sequence?.length === 1 && ev.sequence >= " " && ev.sequence !== "\x7f" ? ev.sequence : ev.name.length === 1 ? ev.name : undefined
    if (char === undefined) return
    setSearch((q) => q + char)
    take()
  })
  onCleanup(() => stopTyping())

  const off = api.keymap.registerLayer({
    // OpenCode's own bare-letter layers do the same: dialogs push "modal", so without this
    // typing "bash" into a prompt would fire b/a/s/h as route commands
    mode: "base",
    commands: [
      { name: "ctree.up", hidden: true, run: () => moveIndex(-1) },
      { name: "ctree.down", hidden: true, run: () => moveIndex(1) },
      { name: "ctree.jump_up", hidden: true, enabled: treePanel, run: () => moveIndex(-20) },
      { name: "ctree.jump_down", hidden: true, enabled: treePanel, run: () => moveIndex(20) },
      { name: "ctree.half_up", hidden: true, run: () => halfPage(-1) },
      { name: "ctree.half_down", hidden: true, run: () => halfPage(1) },
      { name: "ctree.first", hidden: true, run: () => gotoEdge(-1) },
      { name: "ctree.last", hidden: true, run: () => gotoEdge(1) },
      { name: "ctree.prev_branch", hidden: true, enabled: treePanel, run: () => setSelected((i) => nextBranchIndex(view().rows, i, -1)) },
      { name: "ctree.next_branch", hidden: true, enabled: treePanel, run: () => setSelected((i) => nextBranchIndex(view().rows, i, 1)) },
      { name: "ctree.fold", hidden: true, enabled: listPanel, run: () => (panel() === "consumers" ? toggleConsumer(false) : foldOrUnfold(false)) },
      { name: "ctree.unfold", hidden: true, enabled: listPanel, run: () => (panel() === "consumers" ? toggleConsumer(true) : foldOrUnfold(true)) },
      { name: "ctree.toggle", hidden: true, enabled: treePanel, run: () => foldOrUnfold(!(current()?.kind === "branch" && (current() as Row & { kind: "branch" }).expanded)) },
      {
        name: "ctree.go",
        hidden: true,
        run: () =>
          void (panel() === "decisions"
            ? jumpToDecision()
            : panel() === "consumers"
              ? toggleConsumer(!consumerOpen().has(consumerLine()?.bucket.source ?? ""))
              : cropMode()
                ? applyMarked()
                : jump()),
      },
      { name: "ctree.branch", hidden: true, enabled: treeIdle, run: () => void branch() },
      { name: "ctree.label", hidden: true, enabled: treeIdle, run: () => void label() },
      { name: "ctree.filter_pick", hidden: true, enabled: () => !inCrop(), run: () => void pickFilter() },
      {
        name: "ctree.filter_prev",
        hidden: true,
        enabled: () => !inCrop(),
        run: () => setFilterTo(FILTERS[(FILTERS.findIndex((f) => f.value === filter()) - 1 + FILTERS.length) % FILTERS.length]!.value),
      },
      { name: "ctree.search", hidden: true, enabled: treeIdle, run: () => enterSearch() },
      { name: "ctree.search_next", hidden: true, enabled: treePanel, run: () => moveMatch(1) },
      { name: "ctree.search_prev", hidden: true, enabled: treePanel, run: () => moveMatch(-1) },
      {
        name: "ctree.crop",
        hidden: true,
        enabled: listPanel,
        run: () => {
          if (panel() === "consumers") {
            cropConsumer()
            return
          }
          if (cropMode()) void leaveCropMode()
          else setCropMode("result")
        },
      },
      {
        name: "ctree.crop_toggle_mode",
        hidden: true,
        enabled: inCrop,
        // marks are keyed per mode, so switching the lens keeps both sets alive
        run: () => setCropMode(cropMode() === "result" ? "turn" : "result"),
      },
      { name: "ctree.mark", hidden: true, enabled: listPanel, run: () => (panel() === "consumers" ? markConsumerEntry() : toggleMark()) },
      { name: "ctree.auto", hidden: true, enabled: inCrop, run: () => autoMarkAll() },
      { name: "ctree.undo", hidden: true, enabled: treeIdle, run: () => void undo() },
      { name: "ctree.merge", hidden: true, enabled: treeIdle, run: () => void merge() },
      { name: "ctree.inspector", hidden: true, enabled: () => !inCrop(), run: () => { setInspector(!inspector()); api.kv.set("ctree.inspector", inspector()) } },
      {
        name: "ctree.inspector_full",
        hidden: true,
        enabled: () => !inCrop(),
        // from a closed inspector this opens it full screen, so `shift+i` is one key to "show me all of it"
        run: () => {
          if (!inspector()) {
            setInspector(true)
            api.kv.set("ctree.inspector", true)
          } else setInspectorFull(!inspectorFull())
          setInspectorTop(0)
        },
      },
      { name: "ctree.inspector_up", hidden: true, enabled: inspectorOpen, run: () => scrollInspector(-1) },
      { name: "ctree.inspector_down", hidden: true, enabled: inspectorOpen, run: () => scrollInspector(1) },
      { name: "ctree.consumers", hidden: true, enabled: () => !inCrop(), run: () => setPanel(panel() === "consumers" ? "tree" : "consumers") },
      { name: "ctree.copy", hidden: true, enabled: treeIdle, run: () => copySelected() },
      { name: "ctree.mode_duration", hidden: true, enabled: treePanel, run: () => setLane("duration") },
      { name: "ctree.mode_turns", hidden: true, enabled: treePanel, run: () => setLane("turns") },
      { name: "ctree.lanes_off", hidden: true, enabled: treePanel, run: () => { setLanesOn(false); api.kv.set("ctree.lanesOn", false) } },
      { name: "ctree.decisions", hidden: true, enabled: () => !inCrop(), run: () => setPanel(panel() === "decisions" ? "tree" : "decisions") },
      { name: "ctree.export", hidden: true, enabled: () => panel() === "decisions", run: () => exportDecisionsFile() },
      { name: "ctree.help", hidden: true, run: () => setPanel(panel() === "help" ? "tree" : "help") },
      {
        name: "ctree.back",
        hidden: true,
        run: () => {
          const draft = summaryAbort()
          if (draft) {
            draft.abort()
            setSummaryAbort(undefined)
            notify("cancelling the branch summary…")
            return
          }
          if (showInspectorFull() && inspectorFull()) {
            setInspectorFull(false)
            return
          }
          if (panel() !== "tree") {
            setPanel("tree")
            return
          }
          if (cropMode()) {
            void leaveCropMode()
            return
          }
          // a live filter is invisible chrome once search mode is off: clear it before leaving
          if (search()) {
            setSearch("")
            return
          }
          back()
        },
      },
    ],
    bindings: bindingsFor(props.options.keybinds),
  })
  onCleanup(() => off())

  const sessionTitle = () => (sessionID ? (api.state.session.get(sessionID)?.title ?? sessionID) : "no session")
  /** The tree is titled by its trunk: a branch's own session title is just `⎇ <name>`. */
  const title = () => {
    const root = state().root
    return (root && root !== sessionID ? others()[root]?.title : undefined) ?? sessionTitle()
  }
  const modeTag = () => (cropMode() ? " · crop mode" : searchMode() ? " · search" : "")
  /** `┌ Context tree · ⎇ fix-flaky ← Fix flaky test`: from a branch the trunk title is a
   *  suffix, not a repeat. Both titles are cut so the `ctx …` string never clips. */
  const headLine = () => {
    const b = branchOfCurrent()
    const lead = "┌ Context tree · "
    const where = b ? `⎇ ${clipTo(b.name ?? sessionTitle(), 28)}${b.status === "open" ? "" : ` (${b.status})`} ← ` : ""
    const tail = b ? "" : " · trunk"
    const room = cols() - 4 - formatContext(contextSize(), contextLimit()).length - modeTag().length - lead.length - where.length - tail.length - 3
    return `${lead}${where}${clipTo(title(), Math.max(8, room))}${tail}${modeTag()}   `
  }

  /** The turn a row sits in, for the `T<n>` in the prompt figure — the same walk the
   *  inspector's `Hierarchy` line does. */
  const turnOf = (row: Row) => {
    const i = view().indexById[row.id]
    if (i === undefined) return undefined
    const owner = view().rows.slice(0, i + 1).findLast((r) => r.kind === "turn")
    return owner?.kind === "turn" ? owner.turn : undefined
  }

  /** What the selected row is, for the prompt figure: a tool step is named by its tool. */
  const whatOf = (row: Row) => {
    if (row.kind !== "step") return "reply"
    if (row.glyph === "◇") return "compaction"
    if (row.glyph !== "⚙") return "reply"
    const tr = row.sessionID === sessionID ? live() : others()[row.sessionID]
    const part = tr?.messages.find((m) => m.id === row.messageID)?.parts.find((p) => p.id === row.partID)
    return part?.type === "tool" ? (part.tool ?? "tool") : "reply"
  }

  /** `T2 reply · prompt 43.7k · 30.1k cached` for the row under the cursor: what the provider
   *  was really sent at that point, against the whole-session `ctx …` gauge directly above it.
   *  It is history — an older row's prompt is what went out *then*, before any crop or merge
   *  you have applied since (DESIGN.md §6.7). */
  const promptHere = () => {
    const row = current()
    if (!row) return ""
    return formatPromptAt(promptAtRow(row, transcripts()), { turn: turnOf(row), what: whatOf(row) })
  }

  const statusLine = () => {
    const n = view().rows.length
    const pos = `${n ? Math.min(selected() + 1, n) : 0}/${n}`
    if (cropMode()) {
      const a = armed()
      return `✂ crop mode (${cropMode()}) · space mark · a auto · t result⇄turn · ⏎ apply · esc leave · marked ${selectedCandidates().length} ~${formatK(reclaimed(selectedCandidates()))}${a ? " · armed — space again to override" : ""}`
    }
    if (searchMode()) return `search: ${search()}▏ · ${pos} rows · ⏎ keeps it · esc clears`
    const said = notice()
    if (said) return `${clipTo(said, cols())}   ${pos} rows`
    const left = `filter: ${filter()}${search() ? `   search: "${search()}"` : ""}${busy() ? `   … ${busy()}` : ""}   ${pos} rows`
    const right = promptHere()
    // right-aligned under the header's `ctx …`; dropped rather than wrapped when the
    // terminal is too narrow to hold both (DESIGN.md §7.6)
    const room = cols() - 4 - left.length - right.length
    return right && room >= 3 ? `${left}${" ".repeat(room)}${right}` : left
  }

  /** `⏎` does four different things; the footer says which one for the row under the cursor. */
  const goVerb = () => {
    const row = current()
    if (!row) return "⏎ go"
    if (row.kind === "branch") return row.isCurrent ? "⏎ you are here" : `⏎ switch to ⎇ ${clipTo(row.name, 20)}`
    if (row.kind === "separator") return "⏎ go"
    if (row.id === view().currentRowId) return "⏎ you are here"
    return row.kind === "turn" ? "⏎ fork & prefill this turn" : "⏎ fork after this step"
  }

  const footer = () => {
    if (showInspectorFull()) return `PgUp/PgDn scroll  y copy  ${cols() >= 110 ? "I pane  " : ""}i close  q back`
    if (cropMode()) return "space mark  a auto  t result⇄turn  ⏎ apply  esc leave"
    if (panel() === "decisions") return "⏎ jump to record  E export  q back"
    if (panel() === "consumers") return "⏎ expand  space mark  c crop  q back"
    if (panel() === "help") return "esc/q back"
    return `${goVerb()}  b branch  m merge  c crop  ${UNDO_KEY} undo  s consumers  ? help  q back`
  }

  const showsTree = () => panel() === "tree" || panel() === "help"
  /** Never "no messages yet" when a filter or a search is what emptied the list. */
  const emptyText = () => {
    const q = search().trim()
    if (q) return `no rows match "${q}" · esc clears`
    if (filter() !== "default") return `no rows match filter: ${filter()} · f changes it`
    return "(no messages yet — chat first, then open the tree)"
  }

  return (
    <box flexDirection="column" padding={1} backgroundColor={t.background} width="100%" height="100%">
      <box flexDirection="row">
        {/* one expression: JSX would trim the gap before the context string */}
        <text fg={t.primary}>{headLine()}</text>
        <ContextGauge theme={t} size={contextSize()} limit={contextLimit()} />
      </box>
      <Show when={showLanes()}>
        <box flexDirection="row">
          {/* one expression per label: JSX trims the gap between a text node and an expression */}
          <text fg={t.textMuted}>{laneLabel("Input", hiddenLeft() > 0 ? `…${laneCue(hiddenLeft())}` : "")}</text>
          <Show when={!layout().empty.input} fallback={<text fg={t.textMuted}>{"no input".padEnd(laneWidth())}</text>}>
            <For each={inputRuns()}>{(r) => <text fg={r.fg as never} bg={r.bg as never}>{r.text}</text>}</For>
          </Show>
          <text fg={t.textMuted}>{laneSuffix(hiddenRight() > 0 ? `${laneCue(hiddenRight())}…` : "", laneMode())}</text>
        </box>
        <Show when={showAllLanes()}>
          <box flexDirection="row">
            <text fg={t.textMuted}>{laneLabel("Model")}</text>
            <Show when={!layout().empty.model} fallback={<text fg={t.textMuted}>{"no model steps".padEnd(laneWidth())}</text>}>
              <For each={modelRuns()}>{(r) => <text fg={r.fg as never} bg={r.bg as never}>{r.text}</text>}</For>
            </Show>
          </box>
          <box flexDirection="row">
            <text fg={t.textMuted}>{laneLabel("Tools")}</text>
            <Show when={!layout().empty.tools} fallback={<text fg={t.textMuted}>{"no tool calls".padEnd(laneWidth())}</text>}>
              <For each={toolRuns()}>{(r) => <text fg={r.fg as never} bg={r.bg as never}>{r.text}</text>}</For>
            </Show>
            <text fg={t.textMuted}>{"   i inspector · s consumers"}</text>
          </box>
          <Show when={laneOverview()}>
            <box flexDirection="row">
              <text fg={t.textMuted}>{laneLabel("all")}</text>
              <For each={trackRuns()}>{(r) => <text fg={r.fg as never}>{r.text}</text>}</For>
            </box>
          </Show>
        </Show>
      </Show>
      <Show when={laneRoom() && lanesOn() && !showLanes()}>
        <text fg={t.textMuted}>│ lanes appear after 3 turns</text>
      </Show>
      <text fg={cropMode() ? t.warning : searchMode() ? t.accent : t.textMuted}>│ {statusLine()}</text>
      <Show when={panel() === "decisions"}>
        <text fg={t.accent}>│ ◆ decisions on this tree ({decisions().length}) · ⏎ jump to record · E export markdown · q back</text>
        <Show when={decisions().length === 0}>
          <text fg={t.textMuted}>│ (none yet — /merge a branch to write one)</text>
        </Show>
        <For each={decisions()}>
          {(d, i) => {
            const sel = () => i() === decisionIndex()
            const body = () => renderDecision(d.text ?? "", width() - 6)
            const room = () => Math.max(3, height() - decisions().length)
            const start = () => Math.min(decisionScroll(), Math.max(0, body().length - room()))
            const more = () => Math.max(0, body().length - start() - room())
            return (
              <box flexDirection="column">
                <text fg={sel() ? t.background : t.accent} bg={sel() ? t.primary : undefined}>
                  {sel() ? "›" : "│"} {d.hidden ? "◇ (hidden from model) " : "◆ "}{clipTo(decisionSummary(d.text ?? "").title || d.branchName, 48)}  · {new Date(d.recordedAt).toISOString().slice(0, 16).replace("T", " ")}{d.siblings.length ? ` · ✗ ${d.siblings.map((x) => x.name).join(", ")}` : ""}
                </text>
                <For each={sel() ? body().slice(start(), start() + room()) : []}>{(l) => <text fg={t.text}>{`│    ${l}`}</text>}</For>
                <Show when={sel() && more() > 0}>
                  <text fg={t.textMuted}>{`│    … ${more()} more lines ↓ (ctrl+d)`}</text>
                </Show>
              </box>
            )
          }}
        </For>
      </Show>
      <Show when={panel() === "consumers"}>
        <text fg={t.accent}>│ what's filling the context · {formatK(view().totalTokens)} total · source · %tree · %window · tokens · entries</text>
        <For each={consumerLines()}>
          {(line, i) => {
            const sel = () => i() === consumerIndex()
            const c = line.bucket
            const fg = () => (sel() ? t.background : line.entry ? t.textMuted : c.kind === "tool" ? t.warning : t.text)
            const window = () => (c.shareOfWindow === undefined ? "–" : `${(c.shareOfWindow * 100).toFixed(0)}%`)
            const entry = line.entry
            return (
              <text fg={fg()} bg={sel() ? t.primary : undefined}>
                {sel() ? "›" : "│"} {entry
                  ? fitRow(`    ${entry.croppable ? (marked().has(entry.partID ?? "") ? "[x]" : "[ ]") : "   "} ${plain(entry.preview)}${entry.croppable ? "" : ` · ${c.note ?? "not a completed tool result"}`}`, formatK(entry.tokens), width() - 4)
                  : `${consumerOpen().has(c.source) ? "▾" : "▸"} ${c.source.padEnd(20).slice(0, 20)} ${`${(c.share * 100).toFixed(0)}%`.padStart(4)} ${window().padStart(5)} ${bar(c.tokens / consumerMax(), 18)} ${formatK(c.tokens).padStart(6)} · ${c.count} entr${c.count === 1 ? "y" : "ies"}${c.note ? ` · ${c.note}` : ""}`}
              </text>
            )
          }}
        </For>
      </Show>
      <Show when={showsTree() && view().rows.length === 0}>
        <text fg={t.textMuted}>│ {emptyText()}</text>
      </Show>
      <box flexDirection="row" flexGrow={1}>
      <Show when={!showInspectorFull()}>
      <box flexDirection="column" flexGrow={1}>
      <Show when={showsTree() && overflow()}>
        <text fg={t.textMuted}>│ {hiddenAbove() > 0 ? `↑ ${hiddenAbove()} more` : ""}</text>
      </Show>
      <For each={showsTree() ? visible() : []}>
        {(row, i) => {
          const isSel = () => windowStart() + i() === selected()
          const color = () =>
            row.kind === "separator"
              ? t.textMuted
              : row.kind === "branch"
                ? statusColor(t, row)
                : !row.inContext
                  ? t.textMuted // the model is never shown these: an ancestor's rows past our fork point
                  : row.kind === "turn"
                    ? (row.isDecision ? t.accent : t.text)
                    : row.isError
                      ? t.error
                      : row.warn
                        ? t.warning
                        : t.textMuted
          const mark = () => {
            if (!cropMode()) return ""
            const c = candidateOf(row)
            if (!c) return "    "
            const on = marked().has(markKey(c))
            const prot = c.protections.filter((p) => p !== "too-small")
            return `${on ? "[x]" : "[ ]"}${prot.length ? "!" : " "}`
          }
          const prefix = () => `${isSel() ? "›" : "│"} ${mark()}`
          const segs = () => segmentsOf(rowLine(row, rowWidth(), row.id === view().currentRowId), search().trim(), thoughtOf(row))
          return (
            <Show
              when={segs().length > 1}
              fallback={
                <text fg={isSel() ? t.background : (color() as never)} bg={isSel() ? t.primary : undefined}>
                  {prefix()}
                  {segs()[0]?.text}
                </text>
              }
            >
              <box flexDirection="row">
                <text fg={isSel() ? t.background : (color() as never)} bg={isSel() ? t.primary : undefined}>{prefix()}</text>
                <For each={segs()}>
                  {(s) => (
                    <text fg={(s.kind === "match" ? t.background : s.kind === "dim" ? t.textMuted : isSel() ? t.background : color()) as never} bg={s.kind === "match" ? t.accent : isSel() ? t.primary : undefined}>
                      {s.text}
                    </text>
                  )}
                </For>
              </box>
            </Show>
          )
        }}
      </For>
      <Show when={showsTree() && overflow()}>
        <text fg={t.textMuted}>│ {hiddenBelow() > 0 ? `… ${hiddenBelow()} more ↓` : ""}</text>
      </Show>
      <For each={showsTree() && view().rows.length > 0 && !view().rows.some((r) => r.kind === "branch") ? noBranchesLines() : []}>
        {(l) => <text fg={t.textMuted}>│ {l}</text>}
      </For>
      {/* the help pane sits under the rows, so the tree it explains stays on screen */}
      <For each={panel() === "help" ? HELP.slice(0, helpHeight()) : []}>{(l) => <text fg={l.startsWith(" ") ? t.textMuted : t.accent}>│ {l}</text>}</For>
      </box>
      </Show>
      <Show when={showInspector() || showInspectorFull()}>
        <box flexDirection="column" width={showInspectorFull() ? undefined : inspectorWidth()} flexGrow={showInspectorFull() ? 1 : undefined} paddingLeft={1}>
          <For each={inspectorVisible()}>{(l) => <text fg={l.fg as never}>┃ {l.text}</text>}</For>
          <Show when={inspectorOverflow()}>
            <text fg={t.accent}>┃ {inspectorStatus()}</text>
          </Show>
        </box>
      </Show>
      </box>
      <text fg={cropMode() ? t.warning : t.textMuted}>└ {footer()}</text>
    </box>
  )
}
