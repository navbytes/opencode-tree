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
import { createNamedBranch, executeJump, setLabel, type ActionContext, type SummaryChoice } from "./actions.js"
import { fetchTranscript, liveTranscript } from "./transcripts.js"
import { debug } from "../shared/debug.js"

export type TreeRouteProps = {
  api: TuiPluginApi
  store: JournalStore
  directory: string
  sessionID?: string
  options: { jumpSummary: "ask" | "never" }
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
  const height = () => Math.max(8, ((api.renderer as unknown as { height?: number }).height ?? 30) - 7)
  const width = () => Math.max(60, ((api.renderer as unknown as { width?: number }).width ?? 120) - 4)
  const windowStart = createMemo(() => {
    const h = height()
    const s = selected()
    const n = view().rows.length
    const start = Math.max(0, Math.min(s - Math.floor(h / 2), n - h))
    return start
  })
  const visible = createMemo(() => view().rows.slice(windowStart(), windowStart() + height()))

  const band = () => bandFor(view().totalTokens)
  const branchOfCurrent = () => (sessionID ? state().sessions[sessionID] : undefined)

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

  const off = api.keymap.registerLayer({
    commands: [
      { name: "ctree.up", hidden: true, run: () => setSelected((i) => moveSelection(view().rows, i, -1)) },
      { name: "ctree.down", hidden: true, run: () => setSelected((i) => moveSelection(view().rows, i, 1)) },
      { name: "ctree.jump_up", hidden: true, run: () => setSelected((i) => moveSelection(view().rows, i, -20)) },
      { name: "ctree.jump_down", hidden: true, run: () => setSelected((i) => moveSelection(view().rows, i, 20)) },
      { name: "ctree.first", hidden: true, run: () => setSelected(0) },
      { name: "ctree.last", hidden: true, run: () => setSelected(Math.max(0, view().rows.length - 1)) },
      { name: "ctree.prev_branch", hidden: true, run: () => setSelected((i) => nextBranchIndex(view().rows, i, -1)) },
      { name: "ctree.next_branch", hidden: true, run: () => setSelected((i) => nextBranchIndex(view().rows, i, 1)) },
      { name: "ctree.fold", hidden: true, run: () => foldOrUnfold(false) },
      { name: "ctree.unfold", hidden: true, run: () => foldOrUnfold(true) },
      { name: "ctree.toggle", hidden: true, run: () => foldOrUnfold(!(current()?.kind === "branch" && (current() as Row & { kind: "branch" }).expanded)) },
      { name: "ctree.go", hidden: true, run: () => void jump() },
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
      { name: "ctree.back", hidden: true, run: () => back() },
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
      <text fg={t.textMuted}>
        │ filter: {filter()}
        {search() ? `   search: "${search()}"` : ""}
        {busy() ? `   … ${busy()}` : ""}   {view().rows.length} rows
      </text>
      <Show when={view().rows.length === 0}>
        <text fg={t.textMuted}>│ (no messages yet — chat first, then open the tree)</text>
      </Show>
      <For each={visible()}>
        {(row, i) => {
          const isSel = () => windowStart() + i() === selected()
          const color = () =>
            row.kind === "branch" ? statusColor(t, row) : row.kind === "turn" ? (row.isDecision ? t.accent : t.text) : row.isError ? t.error : row.warn ? t.warning : t.textMuted
          return (
            <text fg={isSel() ? t.selectedListItemText : (color() as never)} bg={isSel() ? t.backgroundElement : undefined}>
              {isSel() ? "›" : "│"} {rowLine(row, width())}
            </text>
          )
        }}
      </For>
      <text fg={t.textMuted}>
        └ ⏎ go here  b branch  L label  ←→ fold/unfold  [ ] branches  f filter  / search  g/G top/bottom  q back
      </text>
    </box>
  )
}
