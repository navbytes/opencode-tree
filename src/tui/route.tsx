/** @jsxImportSource @opentui/solid */
/**
 * The combined tree + trajectory route (DESIGN.md §7). Pure view model from core,
 * OpenCode data through the adapters, actions through ./actions.
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { planJump } from "../core/actions.js"
import { foldJournal, type TreeState } from "../core/journal.js"
import { cycleFilter, moveSelection, nextBranchIndex, resolveSelection, toggleExpanded } from "../core/navigation.js"
import { bandFor, contextSizeOf, formatContext, formatK, type MinimalMessage } from "../core/tokens.js"
import { buildSpineMap, buildTreeView, currentChainOf, type Filter, type Row } from "../core/tree.js"
import type { Transcript } from "../core/transcript.js"
import type { JournalStore } from "../shared/store.js"
import { applyCrop, BRANCH_DIALOG, createNamedBranch, executeJump, executeUndo, mergeBranch, mergeDialogOptions, mergeDialogTitle, MERGE_TRUST, setLabel, type ActionContext, type MergeMode, type SummaryChoice } from "./actions.js"
import { exportDecisions } from "../core/decision.js"
import { buildLanes, columnFor, durationWeighted, fitColumns, sparkline, type LaneMode } from "../core/lanes.js"
import { bar, consumers } from "../core/consumers.js"
import { hasEditor } from "./editor.js"
import fs from "node:fs"
import path from "node:path"
import { autoMark, planResultCrop, planTurnCrops, reclaimed, resultCandidates, turnCandidates, type ResultCandidate, type TurnCandidate } from "../core/cropplan.js"
import { planUndo } from "../core/undo.js"
import { fetchTranscript, liveTranscript, modelContextLimit } from "./transcripts.js"
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

const BAND_KEY = { low: "success", healthy: "success", filling: "warning", red: "error" } as const

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
function glyphOf(row: Exclude<Row, { kind: "branch" }>): string {
  if (row.kind === "turn") return row.isDecision ? "◆" : row.isSummary ? "≣" : "●"
  if (row.glyph === "⚙") return "⚙"
  if (row.glyph === "◇") return "≣" // OpenCode-native compaction summary
  return "○"
}

/** Content-forward row text — Pi's outline × DSH's trajectory: `user:` / `assistant:` inline,
 *  tool steps as `[bash $ …]` / `[tool: arg] → out` (from partPreview), decisions/summaries
 *  labelled. The gutter (drawn separately) carries the tree structure, not fixed columns. */
function textOf(row: Exclude<Row, { kind: "branch" }>): string {
  if (row.kind === "turn") {
    if (row.isDecision) return plain(row.preview).replace(/^◆\s*/, "").replace(/^#+\s*/, "")
    if (row.isSummary) return plain(row.preview)
    return `user: ${plain(row.preview)}`
  }
  if (row.glyph === "⚙" || row.glyph === "◇") return plain(row.preview)
  return `assistant: ${plain(row.preview)}`
}

function rowLine(row: Row, width: number, here: boolean): string {
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
    body = `${row.gutter}${glyphOf(row)} ${textOf(row)}${flags}${dur}${marker}`
  }
  return fitRow(body, tokens, width)
}

const DEFAULT_KEYS: Record<string, string[]> = {
  up: ["up", "k"],
  down: ["down", "j"],
  jump_up: ["shift+up", "shift+k"],
  jump_down: ["shift+down", "shift+j"],
  first: ["g"],
  last: ["shift+g"],
  prev_branch: ["["],
  next_branch: ["]"],
  fold: ["left", "h"],
  unfold: ["right", "l"],
  toggle: ["e"],
  go: ["return"],
  branch: ["b"],
  crop: ["c"],
  crop_toggle_mode: ["t"],
  mark: ["space"],
  auto: ["a"],
  undo: ["x"],
  merge: ["m"],
  inspector: ["i"],
  consumers: ["u"],
  copy: ["y"],
  mode_duration: ["1"],
  mode_turns: ["2"],
  mode_calls: ["3"],
  lanes_off: ["0"],
  decisions: ["shift+d"],
  export: ["shift+e"],
  label: ["shift+l"],
  filter: ["f"],
  search: ["/"],
  // terminals disagree on whether "?" carries the shift flag, so bind both spellings
  help: ["?", "shift+/"],
  back: ["q", "escape"],
}

const NO_BRANCHES = "No branches yet · b forks here into a real OpenCode session; nothing is copied or deleted."

/** The `?` overlay: unindented lines are headings, indented ones body (see the render). */
const HELP = [
  "? help · ? or esc closes",
  "Reading the screen — a whole-tree outline (Pi) fused with a trajectory (DSH)",
  "  the entire tree, oldest first: trunk at the left, branches nested at their fork point",
  "  ● user: … · ○ assistant: … · ⚙ [bash $ …] / [tool: arg] → out · ◆ decision · ≣ summary",
  "  ⎇ = a branch: a real, separate OpenCode session, hung off the message it forked from",
  "  │ ├ ╰ connectors draw the branch topology; ← here marks the session you are in",
  "  ▾ open / ▸ folded — the path to where you are is open by default; → ← (or e) toggle a branch",
  "  right column is tokens; ~ means estimated · ⚠ ≥10k · ✂ cropped · ✗ tool error",
  "Keys",
  "  move   ↑↓ j k · J K by 20 · g G first/last · [ ] branch rows · → ← e fold",
  "  act    ⏎ go/switch · b branch · m merge · c crop · x undo · L label · y copy",
  "         in crop mode: space mark · a auto · t result⇄turn · ⏎ apply · esc leave",
  "  DSH    i inspector (Status/Payload/Result/Timing) · 1 2 3 lanes (Duration/Turns/Calls) · 0 off",
  "  views  u consumers · D decisions · E export · f filter · / search · q back",
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
  const ctx: ActionContext = { api, store, directory }
  const t = api.theme.current

  const [tick, setTick] = createSignal(0)
  const bump = () => setTick((n) => n + 1)
  createEffect(on(() => props.refresh?.(), () => bump(), { defer: true }))
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set(api.kv.get<string[]>(`ctree.expanded.${sessionID}`, [])))
  const [filter, setFilter] = createSignal<Filter>(api.kv.get<Filter>("ctree.filter", "default"))
  const [search, setSearch] = createSignal("")
  const [selected, setSelected] = createSignal(0)
  const [others, setOthers] = createSignal<Record<string, Transcript>>({})
  const [busy, setBusy] = createSignal<string | undefined>()
  const [cropMode, setCropMode] = createSignal<"result" | "turn" | undefined>()
  const [panel, setPanel] = createSignal<"tree" | "decisions" | "consumers" | "help">(props.initialView ?? "tree")
  const [laneMode, setLaneMode] = createSignal<LaneMode>(api.kv.get<LaneMode>("ctree.lanes", "turns"))
  // DSH lanes and inspector are first-class but off by default, so the first screen reads as
  // Pi's clean outline (header + tree + footer); `1/2/3` and `i` bring them in, one keystroke.
  const [lanesOn, setLanesOn] = createSignal<boolean>(api.kv.get<boolean>("ctree.lanesOn", false))
  const [inspector, setInspector] = createSignal<boolean>(api.kv.get<boolean>("ctree.inspector", false))
  const [consumerIndex, setConsumerIndex] = createSignal(0)
  const [decisionIndex, setDecisionIndex] = createSignal(0)
  const [marked, setMarked] = createSignal<Set<string>>(new Set())

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

  const transcripts = createMemo(() => (sessionID ? { ...others(), [sessionID]: liveTranscript(api, sessionID) } : {}))
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
  // chrome above/below the rows: padding, header, status, footer (+3 lane lines when lanes are on)
  const height = () => Math.max(8, size().rows - 8 - (lanesOn() && size().rows >= 12 ? 3 : 0))
  const width = () => Math.max(60, cols() - 4)
  const windowStart = createMemo(() => {
    const h = height()
    const s = selected()
    const n = view().rows.length
    const start = Math.max(0, Math.min(s - Math.floor(h / 2), n - h))
    return start
  })
  const visible = createMemo(() => view().rows.slice(windowStart(), windowStart() + height()))

  // ---- crop mode -----------------------------------------------------------
  // Crops act on the *current* session's context. Spine rows above the fork point carry
  // the ancestor's message IDs, but the current session holds a positional copy of that
  // prefix; the spine map (built from unfiltered transcripts) translates both ways.
  const live = () => (sessionID ? liveTranscript(api, sessionID) : undefined)
  const currentMessageOf = (row: Row): string | undefined => {
    if (row.kind === "branch") return undefined
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

  function toggleMark() {
    const row = current()
    if (!row) return
    const c = candidateOf(row)
    debug("crop.mark", { row: row.id, candidate: c ? { kind: c.kind, protections: c.protections } : undefined, marked: [...marked()] })
    if (!c) {
      api.ui.toast({ message: cropMode() === "result" ? "select a tool result row" : "select a turn row" })
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
      api.ui.toast({ variant: "warning", message: `protected (${hard.join(", ")}) — press space again to mark anyway` })
    } else next.add(key)
    setMarked(next)
  }

  function autoMarkAll() {
    if (cropMode() !== "result") return
    const picks = autoMark(resultCands())
    setMarked(new Set(picks.map((c) => c.partID)))
    api.ui.toast({ message: picks.length ? `auto-marked ${picks.length} result${picks.length === 1 ? "" : "s"} (≥10k tokens, older than 2 turns)` : "nothing matches the auto rules" })
  }

  async function applyMarked() {
    if (!sessionID) return
    const picks = selectedCandidates()
    debug("crop.apply", { picks: picks.length, marked: [...marked()] })
    if (picks.length === 0) {
      api.ui.toast({ message: "nothing marked — space marks a row, a auto-marks" })
      return
    }
    // count the plans, not the marks: planTurnCrops refuses the current turn (cropplan.ts)
    const result = cropMode() === "result"
    const plans = result ? [planResultCrop(sessionID, picks as ResultCandidate[])].filter((p) => p !== undefined) : planTurnCrops(sessionID, picks as TurnCandidate[])
    const n = result ? (plans[0]?.targets.length ?? 0) : plans.length
    if (n === 0) {
      api.ui.toast({ message: "nothing to crop — the current turn always stays in context" })
      return
    }
    const total = plans.reduce((s, p) => s + p.targets.reduce((x, t) => x + t.estTokens, 0), 0)
    const ok = await confirm(`Crop ${n} ${result ? "result" : "turn"}${n === 1 ? "" : "s"}?`, `~${formatK(total)} tokens leave the model's context on the next turn. Your transcript is never rewritten; the model just stops seeing these. /undo restores.`)
    if (!ok) return
    await guarded("crop", async () => {
      for (const plan of plans) await applyCrop(ctx, plan, { hard: result && Boolean(props.options.hardCrop) })
      api.ui.toast({ variant: "success", message: `✂ cropped ${n} · ~${formatK(total)} reclaimed` })
      setMarked(new Set<string>())
      setCropMode(undefined)
    })
  }

  async function undo() {
    if (!sessionID) return
    const st = state()
    const plan = planUndo(store.entriesFor(st.treeId), st, sessionID)
    if (plan.kind === "nothing") {
      api.ui.toast({ message: "nothing to undo on this path" })
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
  const band = () => bandFor(contextSize().tokens)
  const branchOfCurrent = () => (sessionID ? state().sessions[sessionID] : undefined)
  const userTurns = () => (live()?.messages ?? []).filter((m) => m.role === "user").length

  // ---- lanes (minimap) -----------------------------------------------------
  const lanes = createMemo(() => (live() ? buildLanes(live()!, laneMode() === "duration" ? "turns" : laneMode()) : { mode: laneMode(), columns: [] }))
  const laneWidth = () => Math.max(10, Math.min(width() - 46, 80))
  const laneSeries = createMemo(() => {
    const l = lanes()
    if (laneMode() === "duration") {
      const w = durationWeighted(l, laneWidth())
      return { input: w.input, output: w.output, tool: w.tool, toolError: w.toolError, cellFor: (col: number) => w.input.findIndex((_, i) => w.columnAt(i) === col) }
    }
    const n = l.columns.length
    const cellFor = (col: number) => (n === 0 ? -1 : Math.floor((col * laneWidth()) / Math.max(n, laneWidth())) + (n < laneWidth() ? Math.floor(laneWidth() / n / 2) : 0))
    return { input: l.columns.map((c) => c.input), output: l.columns.map((c) => c.output), tool: l.columns.map((c) => c.tool), toolError: l.columns.map((c) => c.toolError), cellFor }
  })
  const cursorCell = createMemo(() => {
    const row = current()
    if (!row || row.kind === "branch") return -1
    // spine rows above the fork carry ancestor ids; map to the current session first
    const mid = currentMessageOf(row) ?? row.messageID
    const pid = row.kind === "step" ? (currentPartOf(row) ?? row.partID) : undefined
    const col = columnFor(lanes(), mid, pid)
    return col < 0 ? -1 : laneSeries().cellFor(col)
  })
  const laneLine = (values: number[], scale?: number) => {
    const line = sparkline(fitColumns(values, laneWidth()), laneWidth(), scale)
    const cur = cursorCell()
    if (cur < 0 || cur >= line.length) return line
    return `${line.slice(0, cur)}▮${line.slice(cur + 1)}`
  }
  /** Tool cells split into same-colour runs so errored calls draw red (DESIGN.md §7.1). */
  const toolRuns = createMemo(() => {
    const line = laneLine(laneSeries().tool)
    const mask = fitColumns(laneSeries().toolError.map((e) => (e ? 1 : 0)), laneWidth())
    const runs: { text: string; error: boolean }[] = []
    for (let i = 0; i < line.length; i++) {
      const error = (mask[i] ?? 0) > 0
      const last = runs[runs.length - 1]
      if (last && last.error === error) last.text += line[i]
      else runs.push({ text: line[i]!, error })
    }
    return runs
  })
  // the Input lane is scaled against the context window, so a two-message session stays small
  const contextLimit = createMemo(() => (sessionID ? modelContextLimit(api, sessionID) : undefined))
  // under three turns every bar is either full or empty, which reads as "context full"
  const laneRoom = () => height() >= 12 && panel() === "tree"
  const showLanes = () => laneRoom() && lanesOn() && userTurns() >= 3
  /** DESIGN.md §7.6: below 80 columns the minimap is the Input sparkline alone. */
  const showAllLanes = () => cols() >= 80
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
  const showInspector = () => inspector() && panel() === "tree" && cols() >= 110
  const inspectorWidth = () => Math.min(56, Math.max(36, Math.floor(width() * 0.4)))
  const rowWidth = () => (showInspector() ? width() - inspectorWidth() - 2 : width()) - (cropMode() ? 4 : 0)
  // wraps badly next to the inspector, so break it at the ";" rather than mid-clause
  const noBranchesLines = () => (NO_BRANCHES.length + 2 <= rowWidth() ? [NO_BRANCHES] : NO_BRANCHES.split(/(?<=;) /))
  const inspectorLines = createMemo((): { fg: unknown; text: string }[] => {
    const row = current()
    if (!row) return []
    const w = inspectorWidth() - 3
    const clip = (x: string) => (x.length > w ? `${x.slice(0, w - 1)}…` : x)
    const out: { fg: unknown; text: string }[] = []
    const head = (x: string) => out.push({ fg: t.primary, text: clip(x) })
    const kv = (k: string, v: string) => out.push({ fg: t.text, text: clip(`${k.padEnd(10)}${v}`) })
    const muted = (x: string) => out.push({ fg: t.textMuted, text: clip(x) })
    const block = (label: string, text: string, max: number) => {
      const lines = text.split("\n").filter((l) => l.length)
      kv(label, lines[0] ?? "")
      for (const l of lines.slice(1, max)) out.push({ fg: t.text, text: clip(`          ${l}`) })
      if (lines.length > max) muted(`          … ${lines.length - max} more lines (y to copy)`)
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
      head(`${row.isDecision ? "◆ decision" : row.isSummary ? "◇ summary" : "● user"} · T${row.turn}`)
      if (row.label) kv("Label", row.label)
      kv("Tokens", `~${formatK(row.tokens)}`)
      kv("At", msg ? new Date(msg.time.created).toISOString().slice(11, 19) : "?")
      block("Text", msg?.parts.map((p) => p.text ?? "").join("\n") ?? row.preview, 14)
      return out
    }
    const part = msg?.parts.find((p) => p.id === row.partID)
    const stepNo = msg ? msg.parts.filter((p) => p.type === "tool" || p.type === "text").findIndex((p) => p.id === row.partID) + 1 : 0
    head(`${row.glyph} ${part?.type === "tool" ? part.tool : row.glyph === "◇" ? "compaction" : "assistant"} · T${turn?.kind === "turn" ? turn.turn : "?"} · step ${stepNo}`)
    kv("Hierarchy", `T${turn?.kind === "turn" ? turn.turn : "?"} › assistant › step ${stepNo}`)
    if (part?.type === "tool") {
      const st = part.state
      const dur = st?.time?.start !== undefined && st?.time?.end !== undefined ? `${st.time.end - st.time.start} ms` : "?"
      kv("Status", `${st?.status ?? "?"} · ${dur}`)
      kv("Tokens", `~${formatK(row.tokens)} · ${view().totalTokens ? `${((row.tokens / view().totalTokens) * 100).toFixed(1)}% of context` : ""}`)
      block("Payload", JSON.stringify(st?.input ?? {}, null, 1), 8)
      block("Result", String(st?.output ?? ""), 10)
      kv("Timing", st?.time?.start ? `started ${new Date(st.time.start).toISOString().slice(11, 23)} · ${dur} · session ts` : "n/a")
      const cand = resultCands().find((c) => c.partID === (currentPartOf(row) ?? row.partID))
      kv("Crop", row.isCropped ? "✂ cropped (x to restore)" : cand ? (cand.protections.length ? `protected: ${cand.protections.join(", ")}` : "c then space to stub this result") : "n/a")
    } else {
      kv("Tokens", `~${formatK(row.tokens)}`)
      if (row.durationMs !== undefined) kv("Duration", `${(row.durationMs / 1000).toFixed(1)} s`)
      block("Text", part?.text ?? row.preview, 14)
    }
    return out
  })

  // ---- consumers -------------------------------------------------------------
  const consumerRows = createMemo(() => (live() ? consumers(live()!, { cropped: alreadyCropped() }) : []))

  /** From the consumers panel: back to the tree in crop mode with that source's
   *  unprotected results pre-marked (DESIGN.md §7.4). */
  function cropConsumer() {
    const c = consumerRows()[consumerIndex()]
    setPanel("tree")
    if (!c || c.kind !== "tool") {
      setCropMode("result")
      api.ui.toast({ message: c ? `${c.source} is not a tool result; mark rows by hand` : "nothing to crop" })
      return
    }
    setCropMode("result")
    const picks = resultCands().filter((r) => r.tool === c.source && r.protections.length === 0)
    setMarked(new Set<string>(picks.map((r) => r.partID)))
    api.ui.toast({ message: picks.length ? `marked ${picks.length} unprotected ${c.source} result${picks.length === 1 ? "" : "s"} — ⏎ to apply` : `every ${c.source} result is protected; mark with space (twice) to override` })
  }

  function copySelected() {
    const row = current()
    if (!row || row.kind === "branch") return
    const tr = row.sessionID === sessionID ? live() : others()[row.sessionID]
    const msg = tr?.messages.find((m) => m.id === row.messageID)
    const text = row.kind === "step" ? String(msg?.parts.find((p) => p.id === row.partID)?.state?.output ?? msg?.parts.find((p) => p.id === row.partID)?.text ?? "") : (msg?.parts.map((p) => p.text ?? "").join("\n") ?? "")
    const file = path.join(directory, ".opencode", "context-tree", "last-copy.txt")
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, text)
      api.ui.toast({ message: `saved ${text.length} chars → .opencode/context-tree/last-copy.txt` })
    } catch (e) {
      api.ui.toast({ variant: "error", message: String(e) })
    }
  }

  function back() {
    if (sessionID) api.route.navigate("session", { sessionID })
    else api.route.navigate("home")
  }

  function askSummary(): Promise<SummaryChoice> {
    if (props.options.jumpSummary === "never") return Promise.resolve({ kind: "none" })
    return new Promise((resolve) => {
      api.ui.dialog.replace(
        () =>
          api.ui.DialogSelect({
            title: "Summarize the branch you are leaving?",
            options: [
              { title: "No summary", value: "none", description: "just move" },
              { title: "Summarize", value: "summarize", description: "Pi-style Goal / Progress / Decisions / Next steps" },
              { title: "Summarize with custom prompt", value: "custom" },
            ],
            onSelect: (o) => {
              if (o.value === "custom") {
                api.ui.dialog.replace(
                  () =>
                    api.ui.DialogPrompt({
                      title: "Custom summarization instructions",
                      placeholder: "focus on…",
                      onConfirm: (value) => {
                        resolve({ kind: "summarize", customInstructions: value || undefined })
                        api.ui.dialog.clear()
                      },
                      onCancel: () => {
                        resolve({ kind: "none" })
                        api.ui.dialog.clear()
                      },
                    }),
                  () => resolve({ kind: "none" }),
                )
                return
              }
              resolve(o.value === "summarize" ? { kind: "summarize" } : { kind: "none" })
              api.ui.dialog.clear()
            },
          }),
        () => resolve({ kind: "none" }),
      )
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
      api.ui.toast({ variant: "error", message: `${label}: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setBusy(undefined)
      bump()
    }
  }

  async function jump() {
    const row = current()
    if (!row || !sessionID) return
    const plan = planJump(row, { transcripts: transcripts(), currentSessionID: sessionID })
    debug("route.jump", { row: { kind: row.kind, id: row.id }, plan })
    await guarded("jump", async () => {
      if (plan.kind === "noop") {
        api.ui.toast({ message: plan.reason })
        return
      }
      if (plan.kind === "fork" && plan.mode === "redo") {
        const ok = await confirm("Redo this turn on a new branch?", "The message is copied into the prompt; nothing is deleted.")
        if (!ok) return
      }
      const summary = await askSummary()
      await executeJump(ctx, plan, { currentSessionID: sessionID, summary })
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
    if (!row || row.kind === "branch") return
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
    const target = row.kind === "branch" ? row.sessionID : row.depth > 0 ? row.sessionID : undefined
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
      api.ui.toast({ message: "not on an open branch — /branch first, or open the tree from a branch" })
      return
    }
    const siblings = Object.values(state().sessions).filter((x) => x.parentSessionID === b.parentSessionID && x.sessionID !== sessionID && x.status === "open").length
    const mode = await select<MergeMode>(mergeDialogTitle(b.name ?? "branch", others()[b.parentSessionID]?.title), mergeDialogOptions({ siblings }))
    if (!mode) return
    let note: string | undefined
    if (mode === "discard") note = (await prompt("Why? (optional note on the close marker)", "dead end")) ?? undefined
    const inApp = !hasEditor()
      ? async (draft: string) => {
          const ok = await confirm("Accept the drafted record as-is?", `${draft.slice(0, 400)}${draft.length > 400 ? "…" : ""}\n\n${MERGE_TRUST}\n\n(set $EDITOR to review it in your editor)`)
          return ok ? draft : undefined
        }
      : undefined
    await guarded("merge", async () => {
      await mergeBranch(ctx, { sessionID, mode, note, confirm: inApp })
    })
  }

  function exportDecisionsFile() {
    const records = decisions().filter((d) => d.text).map((d) => ({ branchName: d.branchName, text: d.text!, sessionID: d.sessionID, at: d.recordedAt }))
    const file = path.join(directory, "ctree-decisions.md")
    try {
      fs.writeFileSync(file, exportDecisions(records))
      api.ui.toast({ variant: "success", message: `wrote ${records.length} record${records.length === 1 ? "" : "s"} → ${file}` })
    } catch (e) {
      api.ui.toast({ variant: "error", message: `export failed: ${e instanceof Error ? e.message : String(e)}` })
    }
  }

  function jumpToDecision() {
    const d = decisions()[decisionIndex()]
    if (!d) return
    const idx = view().rows.findIndex((r) => r.kind !== "branch" && r.messageID === d.messageID)
    setPanel("tree")
    if (idx >= 0) setSelected(idx)
    else api.ui.toast({ message: "that record lives in another session" })
  }

  const off = api.keymap.registerLayer({
    // OpenCode's own bare-letter layers do the same: dialogs push "modal", so without this
    // typing "bash" into a prompt would fire b/a/s/h as route commands
    mode: "base",
    commands: [
      { name: "ctree.up", hidden: true, run: () => (panel() === "decisions" ? setDecisionIndex((i) => Math.max(0, i - 1)) : panel() === "consumers" ? setConsumerIndex((i) => Math.max(0, i - 1)) : setSelected((i) => moveSelection(view().rows, i, -1))) },
      { name: "ctree.down", hidden: true, run: () => (panel() === "decisions" ? setDecisionIndex((i) => Math.min(Math.max(0, decisions().length - 1), i + 1)) : panel() === "consumers" ? setConsumerIndex((i) => Math.min(Math.max(0, consumerRows().length - 1), i + 1)) : setSelected((i) => moveSelection(view().rows, i, 1))) },
      { name: "ctree.jump_up", hidden: true, run: () => setSelected((i) => moveSelection(view().rows, i, -20)) },
      { name: "ctree.jump_down", hidden: true, run: () => setSelected((i) => moveSelection(view().rows, i, 20)) },
      { name: "ctree.first", hidden: true, run: () => setSelected(0) },
      { name: "ctree.last", hidden: true, run: () => setSelected(Math.max(0, view().rows.length - 1)) },
      { name: "ctree.prev_branch", hidden: true, run: () => setSelected((i) => nextBranchIndex(view().rows, i, -1)) },
      { name: "ctree.next_branch", hidden: true, run: () => setSelected((i) => nextBranchIndex(view().rows, i, 1)) },
      { name: "ctree.fold", hidden: true, run: () => foldOrUnfold(false) },
      { name: "ctree.unfold", hidden: true, run: () => foldOrUnfold(true) },
      { name: "ctree.toggle", hidden: true, run: () => foldOrUnfold(!(current()?.kind === "branch" && (current() as Row & { kind: "branch" }).expanded)) },
      { name: "ctree.go", hidden: true, run: () => void (panel() === "decisions" ? jumpToDecision() : panel() === "consumers" ? cropConsumer() : cropMode() ? applyMarked() : jump()) },
      { name: "ctree.branch", hidden: true, run: () => void branch() },
      { name: "ctree.label", hidden: true, run: () => void label() },
      {
        name: "ctree.filter",
        hidden: true,
        run: () => {
          const next = cycleFilter(filter())
          setFilter(next)
          api.kv.set("ctree.filter", next)
        },
      },
      {
        name: "ctree.search",
        hidden: true,
        run: () =>
          void prompt("Search rows (empty to clear)", "bash, redis, label…", search()).then((v) => {
            if (v !== undefined) setSearch(v.trim())
          }),
      },
      {
        name: "ctree.crop",
        hidden: true,
        run: () => {
          if (panel() === "consumers") {
            cropConsumer()
            return
          }
          if (panel() !== "tree") return
          if (cropMode()) {
            setCropMode(undefined)
            setMarked(new Set<string>())
          } else setCropMode("result")
        },
      },
      {
        name: "ctree.crop_toggle_mode",
        hidden: true,
        run: () => {
          if (!cropMode()) return
          setCropMode(cropMode() === "result" ? "turn" : "result")
          setMarked(new Set<string>())
        },
      },
      { name: "ctree.mark", hidden: true, enabled: () => Boolean(cropMode()), run: () => toggleMark() },
      { name: "ctree.auto", hidden: true, enabled: () => Boolean(cropMode()), run: () => autoMarkAll() },
      { name: "ctree.undo", hidden: true, run: () => void undo() },
      { name: "ctree.merge", hidden: true, run: () => void merge() },
      { name: "ctree.inspector", hidden: true, run: () => { setInspector(!inspector()); api.kv.set("ctree.inspector", inspector()) } },
      { name: "ctree.consumers", hidden: true, run: () => setPanel(panel() === "consumers" ? "tree" : "consumers") },
      { name: "ctree.copy", hidden: true, run: () => copySelected() },
      { name: "ctree.mode_duration", hidden: true, run: () => setLane("duration") },
      { name: "ctree.mode_turns", hidden: true, run: () => setLane("turns") },
      { name: "ctree.mode_calls", hidden: true, run: () => setLane("calls") },
      { name: "ctree.lanes_off", hidden: true, run: () => { setLanesOn(false); api.kv.set("ctree.lanesOn", false) } },
      { name: "ctree.decisions", hidden: true, run: () => setPanel(panel() === "decisions" ? "tree" : "decisions") },
      { name: "ctree.export", hidden: true, enabled: () => panel() === "decisions", run: () => exportDecisionsFile() },
      { name: "ctree.help", hidden: true, run: () => setPanel(panel() === "help" ? "tree" : "help") },
      {
        name: "ctree.back",
        hidden: true,
        run: () => {
          if (panel() !== "tree") {
            setPanel("tree")
            return
          }
          if (cropMode()) {
            setCropMode(undefined)
            setMarked(new Set<string>())
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
  const where = () => {
    const b = branchOfCurrent()
    if (!b) return "trunk"
    return `⎇ ${b.name ?? sessionTitle()} (${b.status}${b.model ? ` · ${b.model.split("/").pop()}` : ""})`
  }

  return (
    <box flexDirection="column" padding={1} backgroundColor={t.background} width="100%" height="100%">
      <box flexDirection="row">
        {/* one expression: JSX would trim the gap before the context string */}
        <text fg={t.primary}>{`┌ Context tree · ${title()} · ${where()}   `}</text>
        <text fg={t[BAND_KEY[band()]]}>{formatContext(contextSize(), contextLimit())}</text>
      </box>
      <Show when={showLanes()}>
        <text fg={t.info}>│ Input  {laneLine(laneSeries().input, contextLimit())}   {laneMode() === "duration" ? "[1] Duration" : " 1  duration"} · {laneMode() === "turns" ? "[2] Turns" : " 2  turns"} · {laneMode() === "calls" ? "[3] Calls" : " 3  calls"}</text>
        <Show when={showAllLanes()}>
          <text fg={t.accent}>│ Model  {laneLine(laneSeries().output)}</text>
          <box flexDirection="row">
            <text fg={t.warning}>│ Tools  </text>
            <For each={toolRuns()}>{(run) => <text fg={run.error ? t.error : t.warning}>{run.text}</text>}</For>
            <text fg={t.warning}>   i inspector · u consumers</text>
          </box>
        </Show>
      </Show>
      <Show when={laneRoom() && lanesOn() && !showLanes()}>
        <text fg={t.textMuted}>│ lanes appear after 3 turns</text>
      </Show>
      <text fg={cropMode() ? t.warning : t.textMuted}>
        │ {cropMode() ? `✂ crop mode (${cropMode()}) · space mark · a auto · t result⇄turn · ⏎ apply · esc leave · marked ${selectedCandidates().length} ~${formatK(reclaimed(selectedCandidates()))}` : `filter: ${filter()}`}
        {search() ? `   search: "${search()}"` : ""}
        {busy() ? `   … ${busy()}` : ""}   {view().rows.length} rows
      </text>
      <Show when={panel() === "decisions"}>
        <text fg={t.accent}>│ ◆ decisions on this tree ({decisions().length}) · ⏎ jump to record · E export markdown · D back</text>
        <Show when={decisions().length === 0}>
          <text fg={t.textMuted}>│ (none yet — /merge a branch to write one)</text>
        </Show>
        <For each={decisions()}>
          {(d, i) => {
            const sel = () => i() === decisionIndex()
            const lines = () => (d.text ?? "").split("\n").slice(0, sel() ? 12 : 1)
            return (
              <box flexDirection="column">
                <text fg={sel() ? t.background : t.accent} bg={sel() ? t.primary : undefined}>
                  {sel() ? "›" : "│"} {d.hidden ? "◇ (hidden from model) " : "◆ "}{d.branchName}  · {new Date(d.recordedAt).toISOString().slice(0, 16).replace("T", " ")}{d.siblings.length ? ` · ✗ ${d.siblings.map((x) => x.name).join(", ")}` : ""}
                </text>
                <For each={sel() ? lines().slice(1) : []}>{(l) => <text fg={t.text}>│    {l.slice(0, width() - 6)}</text>}</For>
              </box>
            )
          }}
        </For>
      </Show>
      <Show when={panel() === "consumers"}>
        <text fg={t.accent}>│ what's filling the context · {formatK(view().totalTokens)} total · c crop · u/esc back</text>
        <For each={consumerRows()}>
          {(c, i) => {
            const sel = () => i() === consumerIndex()
            return (
              <text fg={sel() ? t.background : c.kind === "tool" ? t.warning : t.text} bg={sel() ? t.primary : undefined}>
                {sel() ? "›" : "│"} {c.source.padEnd(22).slice(0, 22)} {`${(c.share * 100).toFixed(0)}%`.padStart(4)} {bar(c.share, 24)} {formatK(c.tokens).padStart(6)} · {c.count} entr{c.count === 1 ? "y" : "ies"}
              </text>
            )
          }}
        </For>
      </Show>
      {/* clipped to the terminal so a short window keeps its footer */}
      <For each={panel() === "help" ? HELP.slice(0, Math.max(6, size().rows - 5)) : []}>{(l) => <text fg={l.startsWith(" ") ? t.textMuted : t.accent}>│ {l}</text>}</For>
      <Show when={panel() === "tree" && view().rows.length === 0}>
        <text fg={t.textMuted}>│ (no messages yet — chat first, then open the tree)</text>
      </Show>
      <box flexDirection="row" flexGrow={1}>
      <box flexDirection="column" flexGrow={1}>
      <For each={panel() === "tree" ? visible() : []}>
        {(row, i) => {
          const isSel = () => windowStart() + i() === selected()
          const color = () =>
            row.kind === "branch" ? statusColor(t, row) : row.kind === "turn" ? (row.isDecision ? t.accent : t.text) : row.isError ? t.error : row.warn ? t.warning : t.textMuted
          const mark = () => {
            if (!cropMode()) return ""
            const c = candidateOf(row)
            if (!c) return "    "
            const on = marked().has(markKey(c))
            const prot = c.protections.filter((p) => p !== "too-small")
            return `${on ? "[x]" : "[ ]"}${prot.length ? "!" : " "}`
          }
          return (
            <text fg={isSel() ? t.background : (color() as never)} bg={isSel() ? t.primary : undefined}>
              {isSel() ? "›" : "│"} {mark()}
              {rowLine(row, rowWidth(), row.id === view().currentRowId)}
            </text>
          )
        }}
      </For>
      <For each={panel() === "tree" && view().rows.length > 0 && !view().rows.some((r) => r.kind === "branch") ? noBranchesLines() : []}>
        {(l) => <text fg={t.textMuted}>│ {l}</text>}
      </For>
      </box>
      <Show when={showInspector()}>
        <box flexDirection="column" width={inspectorWidth()} paddingLeft={1}>
          <For each={inspectorLines()}>{(l) => <text fg={l.fg as never}>┃ {l.text}</text>}</For>
        </box>
      </Show>
      </box>
      <text fg={cropMode() ? t.warning : t.textMuted}>
        └ {cropMode() ? "space mark  a auto  t result⇄turn  ⏎ apply  esc leave" : "⏎ go  b branch  m merge  c crop  i inspector  1·2·3 lanes  x undo  ? help  q back"}
      </text>
    </box>
  )
}
