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
import { bandFor } from "../core/tokens.js"
import { buildTreeView, type Filter, type Row } from "../core/tree.js"
import type { Transcript } from "../core/transcript.js"
import type { JournalStore } from "../shared/store.js"
import { applyCrop, createNamedBranch, executeJump, executeUndo, mergeBranch, setLabel, type ActionContext, type MergeMode, type SummaryChoice } from "./actions.js"
import { exportDecisions } from "../core/decision.js"
import { buildLanes, columnFor, durationWeighted, fitColumns, sparkline, type LaneMode } from "../core/lanes.js"
import { bar, consumers } from "../core/consumers.js"
import { hasEditor } from "./editor.js"
import fs from "node:fs"
import path from "node:path"
import { autoMark, planResultCrop, planTurnCrops, reclaimed, resultCandidates, turnCandidates, type ResultCandidate, type TurnCandidate } from "../core/cropplan.js"
import { planUndo } from "../core/undo.js"
import { fetchTranscript, liveTranscript } from "./transcripts.js"
import { debug } from "../shared/debug.js"

export type TreeRouteProps = {
  api: TuiPluginApi
  store: JournalStore
  directory: string
  sessionID?: string
  options: { jumpSummary: "ask" | "never" }
  /** open directly on a secondary view */
  initialView?: "tree" | "decisions"
}

const BAND_KEY = { low: "success", healthy: "success", filling: "warning", red: "error" } as const

export function formatK(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const k = (tokens / 1000).toFixed(1)
  return `${k.endsWith(".0") ? k.slice(0, -2) : k}k`
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

function rowLine(row: Row, width: number): string {
  const tokens = `${formatK(row.tokens)}${row.kind !== "branch" && row.estimated ? "~" : ""}`
  let body: string
  switch (row.kind) {
    case "turn": {
      const marker = `T${row.turn}`.padEnd(3)
      const label = row.label ? ` [${row.label}]` : ""
      const glyph = row.isDecision ? "◆" : row.isSummary ? "◇" : row.glyph
      body = `${marker} ${row.gutter}${glyph} ${row.isDecision ? "decision " : row.isSummary ? "summary  " : "user     "} ${row.preview}${label}`
      break
    }
    case "step": {
      const flags = `${row.label ? ` [${row.label}]` : ""}${row.isCropped ? " ✂" : ""}${row.warn ? " ⚠" : ""}${row.isError ? " ✗" : ""}`
      const dur = row.durationMs !== undefined ? ` ${(row.durationMs / 1000).toFixed(row.durationMs < 10_000 ? 1 : 0)}s` : ""
      body = `    ${row.gutter}${row.glyph} ${row.glyph === "⚙" ? "tool     " : row.glyph === "◇" ? "compact  " : "assistant"} ${row.preview}${flags}${dur}`
      break
    }
    case "branch": {
      const model = row.model ? ` · ${row.model.split("/").pop()}` : ""
      const fold = row.expanded ? "▾" : "▸"
      body = `    ${row.gutter} ${row.name}  ${fold} ${row.status} · ${row.turns} turn${row.turns === 1 ? "" : "s"}${model}`
      break
    }
  }
  const room = Math.max(10, width - tokens.length - 2)
  const clipped = body.length > room ? `${body.slice(0, room - 1)}…` : body.padEnd(room)
  return `${clipped} ${tokens}`
}

export function TreeRoute(props: TreeRouteProps) {
  const { api, store, directory } = props
  const sessionID = props.sessionID
  const ctx: ActionContext = { api, store, directory }
  const t = api.theme.current

  const [tick, setTick] = createSignal(0)
  const bump = () => setTick((n) => n + 1)
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set(api.kv.get<string[]>(`ctree.expanded.${sessionID}`, [])))
  const [filter, setFilter] = createSignal<Filter>(api.kv.get<Filter>("ctree.filter", "default"))
  const [search, setSearch] = createSignal("")
  const [selected, setSelected] = createSignal(0)
  const [others, setOthers] = createSignal<Record<string, Transcript>>({})
  const [busy, setBusy] = createSignal<string | undefined>()
  const [cropMode, setCropMode] = createSignal<"result" | "turn" | undefined>()
  const [panel, setPanel] = createSignal<"tree" | "decisions" | "consumers">(props.initialView ?? "tree")
  const [laneMode, setLaneMode] = createSignal<LaneMode>(api.kv.get<LaneMode>("ctree.lanes", "turns"))
  const [inspector, setInspector] = createSignal<boolean>(api.kv.get<boolean>("ctree.inspector", true))
  const [consumerIndex, setConsumerIndex] = createSignal(0)
  const [decisionIndex, setDecisionIndex] = createSignal(0)
  const [marked, setMarked] = createSignal<Set<string>>(new Set())

  const state = createMemo<TreeState>(() => {
    tick()
    return (sessionID && store.stateForSession(sessionID)) || foldJournal([], "none")
  })

  // Sessions in the tree other than the current one: fetched once per tick through the SDK.
  createEffect(
    on([state, tick], async () => {
      if (!sessionID) return
      const ids = new Set<string>()
      for (const id of Object.keys(state().sessions)) ids.add(id)
      for (const b of Object.values(state().sessions)) ids.add(b.parentSessionID)
      if (state().root) ids.add(state().root!)
      ids.delete(sessionID)
      const loaded = await Promise.all([...ids].map((id) => fetchTranscript(api, id, directory)))
      setOthers(Object.fromEntries(loaded.map((tr) => [tr.sessionID, tr])))
    }),
  )

  const view = createMemo(() => {
    if (!sessionID) return { rows: [] as Row[], indexById: {}, currentRowId: undefined, totalTokens: 0 }
    const st = state()
    const labels: Record<string, string> = {}
    for (const l of Object.values(st.labels)) labels[l.messageID] = l.label
    const crops = st.activeCrops(sessionID).flatMap((c) => c.targets.map((x) => ({ messageID: x.messageID, partID: x.partID })))
    return buildTreeView({
      state: st,
      transcripts: { ...others(), [sessionID]: liveTranscript(api, sessionID) },
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
  const height = () => Math.max(8, ((api.renderer as unknown as { height?: number }).height ?? 30) - 7 - (((api.renderer as unknown as { height?: number }).height ?? 30) >= 12 ? 3 : 0))
  const width = () => Math.max(60, ((api.renderer as unknown as { width?: number }).width ?? 120) - 4)
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
  // prefix, so the k-th distinct depth-0 message maps onto current.messages[k].
  const live = () => (sessionID ? liveTranscript(api, sessionID) : undefined)
  const rowToCurrent = createMemo(() => {
    const map = new Map<string, { messageID: string; partIndex: Record<string, number> }>()
    const lv = live()
    if (!lv) return map
    let k = -1
    let lastKey = ""
    for (const r of view().rows) {
      if (r.kind === "branch" || r.depth > 0) continue
      const key = `${r.sessionID}:${r.messageID}`
      if (key !== lastKey) {
        k++
        lastKey = key
      }
      const cur = lv.messages[k]
      if (!cur) continue
      const partIndex: Record<string, number> = {}
      cur.parts.forEach((p, i) => (partIndex[p.id] = i))
      map.set(key, { messageID: cur.id, partIndex })
    }
    return map
  })
  const currentMessageOf = (row: Row): string | undefined => {
    if (row.kind === "branch") return undefined
    if (row.sessionID === sessionID) return row.messageID
    return rowToCurrent().get(`${row.sessionID}:${row.messageID}`)?.messageID
  }
  const currentPartOf = (row: Row & { kind: "step" }): string | undefined => {
    if (row.sessionID === sessionID) return row.partID
    // same position within the copied message
    const other = others()[row.sessionID]?.messages.find((m) => m.id === row.messageID)
    const idx = other?.parts.findIndex((p) => p.id === row.partID) ?? -1
    const cur = live()?.messages.find((m) => m.id === currentMessageOf(row))
    return idx >= 0 ? cur?.parts[idx]?.id : undefined
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
    if (next.has(key)) next.delete(key)
    else if (hard.length && !(next.has(`${key}:warned`))) {
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
    const total = reclaimed(picks)
    const ok = await confirm(`Crop ${picks.length} ${cropMode() === "result" ? "result" : "turn"}${picks.length === 1 ? "" : "s"}?`, `~${formatK(total)} tokens leave the model's context on the next turn. The transcript keeps the originals; /undo restores.`)
    if (!ok) return
    await guarded("crop", async () => {
      if (cropMode() === "result") {
        const plan = planResultCrop(sessionID, picks as ResultCandidate[])
        if (plan) applyCrop(ctx, plan)
      } else {
        for (const plan of planTurnCrops(sessionID, picks as TurnCandidate[])) applyCrop(ctx, plan)
      }
      api.ui.toast({ variant: "success", message: `✂ cropped ${picks.length} · ~${formatK(total)} reclaimed` })
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

  const band = () => bandFor(view().totalTokens)
  const branchOfCurrent = () => (sessionID ? state().sessions[sessionID] : undefined)

  // ---- lanes (minimap) -----------------------------------------------------
  const lanes = createMemo(() => (live() ? buildLanes(live()!, laneMode() === "duration" ? "turns" : laneMode()) : { mode: laneMode(), columns: [] }))
  const laneWidth = () => Math.max(10, Math.min(width() - 46, 80))
  const laneSeries = createMemo(() => {
    const l = lanes()
    if (laneMode() === "duration") {
      const w = durationWeighted(l, laneWidth())
      return { input: w.input, output: w.output, tool: w.tool, cellFor: (col: number) => w.input.findIndex((_, i) => w.columnAt(i) === col) }
    }
    const n = l.columns.length
    const cellFor = (col: number) => (n === 0 ? -1 : Math.floor((col * laneWidth()) / Math.max(n, laneWidth())) + (n < laneWidth() ? Math.floor(laneWidth() / n / 2) : 0))
    return { input: l.columns.map((c) => c.input), output: l.columns.map((c) => c.output), tool: l.columns.map((c) => (c.toolError ? -1 : c.tool)), cellFor }
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
  const laneLine = (values: number[]) => {
    const cells = fitColumns(values.map((v) => Math.max(0, v)), laneWidth())
    const line = sparkline(cells, laneWidth())
    const cur = cursorCell()
    if (cur < 0 || cur >= line.length) return line
    return `${line.slice(0, cur)}▮${line.slice(cur + 1)}`
  }
  const showLanes = () => height() >= 12 && panel() === "tree"

  // ---- inspector -----------------------------------------------------------
  const showInspector = () => inspector() && panel() === "tree" && width() >= 100
  const inspectorWidth = () => Math.min(56, Math.max(36, Math.floor(width() * 0.4)))
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
      kv("Parent", others()[row.parentSessionID]?.title ?? row.parentSessionID)
      kv("Anchor", row.anchorMessageID.slice(0, 20))
      kv("Turns", String(row.turns))
      kv("Tokens", `~${formatK(row.tokens)}`)
      if (row.model) kv("Model", row.model)
      muted(row.expanded ? "← fold" : "→ expand · ⏎ switch to it")
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
    const plan = planJump(row, view(), { currentSessionID: sessionID })
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
    const name = await prompt("Branch name", "fix-flaky-test")
    if (!name) return
    const model = await new Promise<string | undefined>((resolve) => {
      api.ui.dialog.replace(
        () =>
          api.ui.DialogSelect({
            title: `Model for ⎇ ${name}`,
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
    const has = expanded().has(target)
    if (open === has) return
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
    const mode = await select<MergeMode>(`Merge ⎇ ${b.name ?? "branch"} into its parent`, [
      { title: "Squash", value: "squash", description: hasEditor() ? "model drafts a ◆ decision record → your $EDITOR → confirm by saving" : "model drafts a ◆ decision record → accept in-app (no $EDITOR set)" },
      { title: "Squash without LLM", value: "squash-no-llm", description: "empty template → your editor" },
      { title: "Discard", value: "discard", description: "back to the parent; branch marked rejected; nothing written" },
      { title: "Tournament", value: "tournament", description: "this branch wins; open siblings get epitaphs and are closed" },
    ])
    if (!mode) return
    let note: string | undefined
    if (mode === "discard") note = (await prompt("Why? (optional note on the close marker)", "dead end")) ?? undefined
    const inApp = !hasEditor()
      ? async (draft: string) => {
          const ok = await confirm("Accept the drafted record as-is?", `${draft.slice(0, 400)}${draft.length > 400 ? "…" : ""}\n\n(set $EDITOR to review it in your editor)`)
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
    fs.writeFileSync(file, exportDecisions(records))
    api.ui.toast({ variant: "success", message: `wrote ${records.length} record${records.length === 1 ? "" : "s"} → ${file}` })
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
      { name: "ctree.go", hidden: true, run: () => void (panel() === "decisions" ? jumpToDecision() : cropMode() ? applyMarked() : jump()) },
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
      { name: "ctree.mode_duration", hidden: true, run: () => { setLaneMode("duration"); api.kv.set("ctree.lanes", "duration") } },
      { name: "ctree.mode_turns", hidden: true, run: () => { setLaneMode("turns"); api.kv.set("ctree.lanes", "turns") } },
      { name: "ctree.mode_calls", hidden: true, run: () => { setLaneMode("calls"); api.kv.set("ctree.lanes", "calls") } },
      { name: "ctree.decisions", hidden: true, run: () => setPanel(panel() === "decisions" ? "tree" : "decisions") },
      { name: "ctree.export", hidden: true, enabled: () => panel() === "decisions", run: () => exportDecisionsFile() },
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
    bindings: [
      { key: "up", cmd: "ctree.up" },
      { key: "k", cmd: "ctree.up" },
      { key: "down", cmd: "ctree.down" },
      { key: "j", cmd: "ctree.down" },
      { key: "shift+up", cmd: "ctree.jump_up" },
      { key: "shift+k", cmd: "ctree.jump_up" },
      { key: "shift+down", cmd: "ctree.jump_down" },
      { key: "shift+j", cmd: "ctree.jump_down" },
      { key: "g", cmd: "ctree.first" },
      { key: "shift+g", cmd: "ctree.last" },
      { key: "[", cmd: "ctree.prev_branch" },
      { key: "]", cmd: "ctree.next_branch" },
      { key: "left", cmd: "ctree.fold" },
      { key: "h", cmd: "ctree.fold" },
      { key: "right", cmd: "ctree.unfold" },
      { key: "l", cmd: "ctree.unfold" },
      { key: "e", cmd: "ctree.toggle" },
      { key: "return", cmd: "ctree.go" },
      { key: "b", cmd: "ctree.branch" },
      { key: "c", cmd: "ctree.crop" },
      { key: "t", cmd: "ctree.crop_toggle_mode" },
      { key: "space", cmd: "ctree.mark" },
      { key: "a", cmd: "ctree.auto" },
      { key: "x", cmd: "ctree.undo" },
      { key: "m", cmd: "ctree.merge" },
      { key: "i", cmd: "ctree.inspector" },
      { key: "u", cmd: "ctree.consumers" },
      { key: "y", cmd: "ctree.copy" },
      { key: "1", cmd: "ctree.mode_duration" },
      { key: "2", cmd: "ctree.mode_turns" },
      { key: "3", cmd: "ctree.mode_calls" },
      { key: "shift+d", cmd: "ctree.decisions" },
      { key: "shift+e", cmd: "ctree.export" },
      { key: "shift+l", cmd: "ctree.label" },
      { key: "f", cmd: "ctree.filter" },
      { key: "/", cmd: "ctree.search" },
      { key: "q", cmd: "ctree.back" },
      { key: "escape", cmd: "ctree.back" },
    ],
  })
  onCleanup(() => off())

  const title = () => (sessionID ? (api.state.session.get(sessionID)?.title ?? sessionID) : "no session")
  const headerRight = () => {
    const b = branchOfCurrent()
    const where = b ? `(${b.status}${b.model ? ` · ${b.model.split("/").pop()}` : ""})` : "trunk"
    return `${where}   ctx ${formatK(view().totalTokens)} · ${band()}`
  }

  return (
    <box flexDirection="column" padding={1} backgroundColor={t.background} width="100%" height="100%">
      <text fg={t.primary}>
        ┌ Context tree · {title()}   {headerRight()}
      </text>
      <Show when={showLanes()}>
        <text fg={t.info}>│ Input  {laneLine(laneSeries().input)}   {laneMode() === "duration" ? "[1] Duration" : " 1  duration"} · {laneMode() === "turns" ? "[2] Turns" : " 2  turns"} · {laneMode() === "calls" ? "[3] Calls" : " 3  calls"}</text>
        <text fg={t.accent}>│ Model  {laneLine(laneSeries().output)}</text>
        <text fg={t.warning}>│ Tools  {laneLine(laneSeries().tool)}   {lanes().columns.length} col · i inspector · u consumers</text>
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
                <text fg={sel() ? t.selectedListItemText : t.accent} bg={sel() ? t.backgroundElement : undefined}>
                  {sel() ? "›" : "│"} {d.hidden ? "◇ (hidden from model) " : "◆ "}{d.branchName}  · {new Date(d.recordedAt).toISOString().slice(0, 16).replace("T", " ")}{d.siblings.length ? ` · ✗ ${d.siblings.map((x) => x.name).join(", ")}` : ""}
                </text>
                <For each={sel() ? lines().slice(1) : []}>{(l) => <text fg={t.text}>│    {l.slice(0, width() - 6)}</text>}</For>
              </box>
            )
          }}
        </For>
      </Show>
      <Show when={panel() === "consumers"}>
        <text fg={t.accent}>│ what is filling the context · {formatK(view().totalTokens)} total · c crop · u/esc back</text>
        <For each={consumerRows()}>
          {(c, i) => {
            const sel = () => i() === consumerIndex()
            return (
              <text fg={sel() ? t.selectedListItemText : c.kind === "tool" ? t.warning : t.text} bg={sel() ? t.backgroundElement : undefined}>
                {sel() ? "›" : "│"} {c.source.padEnd(22).slice(0, 22)} {`${(c.share * 100).toFixed(0)}%`.padStart(4)} {bar(c.share, 24)} {formatK(c.tokens).padStart(6)} · {c.count} entr{c.count === 1 ? "y" : "ies"}
              </text>
            )
          }}
        </For>
      </Show>
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
            <text fg={isSel() ? t.selectedListItemText : (color() as never)} bg={isSel() ? t.backgroundElement : undefined}>
              {isSel() ? "›" : "│"} {mark()}
              {rowLine(row, (showInspector() ? width() - inspectorWidth() - 2 : width()) - (cropMode() ? 4 : 0))}
            </text>
          )
        }}
      </For>
      </box>
      <Show when={showInspector()}>
        <box flexDirection="column" width={inspectorWidth()} paddingLeft={1}>
          <For each={inspectorLines()}>{(l) => <text fg={l.fg as never}>┃ {l.text}</text>}</For>
        </box>
      </Show>
      </box>
      <text fg={t.textMuted}>
        └ ⏎ go  b branch  m merge  c crop  x undo  i inspect  u consumers  D decisions  L label  y copy  1/2/3 lanes  f filter  / search  q
      </text>
    </box>
  )
}
