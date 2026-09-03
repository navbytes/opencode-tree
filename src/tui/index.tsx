/** @jsxImportSource @opentui/solid */
/**
 * TUI plugin half (DESIGN.md §3.2, §5, §7): `/tree` (aliases `/ctree`, `/panel`),
 * `/branch`, `/label`, the `ctree` route, and the prompt-side gauge slot.
 */
import type { TuiPluginApi, TuiPlugin } from "@opencode-ai/plugin/tui"
import { Show, createEffect, createMemo, createSignal, on } from "solid-js"
import { bandFor, contextSizeOf, formatContext, formatK, type MinimalMessage, type MinimalPart } from "../core/tokens.js"
import { JournalStore, type StorageMode } from "../shared/store.js"
import { debug } from "../shared/debug.js"
import { BRANCH_DIALOG, MERGE_TRUST, TRUNK_LABEL, bumpJournal, clip, createNamedBranch, journalRevision, mergeBranch, mergeDialogOptions, mergeDialogTitle, mergeTargetOf, ownTurnCount, setLabel, type MergeMode } from "./actions.js"
import { openSiblings } from "../core/decision.js"
import { hasEditor } from "./editor.js"
import { TreeRoute } from "./route.js"
import { parseForkTitle } from "../core/adopt.js"
import { adoptNativeForks } from "../shared/adopt.js"
import { fetchTranscript, modelContextLimit } from "./transcripts.js"

const BAND_COLOR = { low: "success", healthy: "success", filling: "warning", red: "error" } as const

type Options = { storage: StorageMode; jumpSummary: "ask" | "never"; hardCrop: boolean; keybinds: Record<string, string[]>; open: string[] }

/** `"k,up"` or `["k","up"]` → `["k","up"]`; `"none"`/`false` → `[]`. */
function keys(v: unknown): string[] | undefined {
  if (v === undefined) return undefined
  if (v === false || v === "none") return []
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string")
  if (typeof v === "string") return v.split(",").map((x) => x.trim()).filter(Boolean)
  return undefined
}

function parseOptions(raw: Record<string, unknown> | undefined): Options {
  const kb = (raw?.["keybinds"] as Record<string, unknown> | undefined) ?? {}
  const keybinds: Record<string, string[]> = {}
  for (const [name, v] of Object.entries(kb)) {
    const k = keys(v)
    if (k) keybinds[name] = k
  }
  return {
    storage: raw?.["storage"] === "global" ? "global" : "local",
    jumpSummary: raw?.["jumpSummary"] === "never" ? "never" : "ask",
    hardCrop: raw?.["hardCrop"] === true,
    keybinds,
    open: keys(kb["open"]) ?? ["ctrl+q"],
  }
}

function toMinimalMessages(messages: readonly any[], part: (messageID: string) => readonly any[]): MinimalMessage[] {
  return messages.map((m) => ({
    info: m.role === "assistant" ? { role: "assistant", tokens: m.tokens } : { role: m.role },
    parts: part(m.id).map(
      (p): MinimalPart => ({
        type: p.type,
        text: p.type === "text" || p.type === "reasoning" ? p.text : undefined,
        tool: p.type === "tool" ? p.tool : undefined,
        state: p.type === "tool" ? { status: p.state?.status, input: p.state?.input, output: p.state?.output } : undefined,
      }),
    ),
  }))
}

/** A branch's display name: adopted native forks carry no journal `name`, so fall back to
 *  the session's own title (DESIGN.md §4.1's `kind: "native"`). */
function branchLabel(api: TuiPluginApi, sessionID: string, name: string | undefined, max?: number): string {
  const label = name ?? api.state.session.get(sessionID)?.title ?? "branch"
  return max === undefined ? label : clip(label, max)
}

/** OpenCode's sidebar is narrow; anything longer wraps and orphans the tail of the line. */
const CARD_COLUMNS = 28

function currentSession(api: TuiPluginApi): string | undefined {
  const cur = api.route.current
  return cur.name === "session" ? ((cur.params as { sessionID?: string } | undefined)?.sessionID ?? undefined) : undefined
}

const tui: TuiPlugin = async (api, rawOptions) => {
  const options = parseOptions(rawOptions as Record<string, unknown> | undefined)
  const directory = api.state.path.directory
  const store = new JournalStore({ worktree: api.state.path.worktree || directory, stateDir: api.state.path.state, mode: options.storage })
  debug("tui.loaded", { path: api.state.path, options })

  // Native `/fork` sessions are invisible to the journal until adopted; `adopted` lets an
  // open route know a branch appeared (DESIGN.md §4.1's `kind: "native"`).
  const [adopted, setAdopted] = createSignal(0)
  const adopt = async () => {
    const found = await adoptNativeForks({
      store,
      directory,
      actor: "tui",
      listSessions: async () => {
        const res = await api.client.session.list({ directory })
        return ((res.data as any[]) ?? []).map((s) => ({ id: s.id as string, title: (s.title as string) ?? "", created: (s.time?.created as number) ?? 0, parentID: s.parentID as string | undefined, directory: s.directory as string | undefined }))
      },
      messagesOf: async (sessionID) => (await fetchTranscript(api, sessionID, directory)).messages.map((m) => ({ id: m.id, role: m.role, created: m.time.created })),
    })
    // the server half may have adopted first: refresh either way so the card and route re-read
    setAdopted((n) => n + 1)
    bumpJournal()
    return found
  }

  /** The `session.created` event fires before the fork's messages are copied, so wait, then retry. */
  const adoptSoon = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((r) => setTimeout(r, 1000))
      if ((await adopt()).length > 0) return
    }
  }

  const offCreated = api.event.on("session.created", (event) => {
    const info = event.properties.info
    if (!info.parentID && parseForkTitle(info.title ?? "")) void adoptSoon()
  })
  api.lifecycle?.onDispose(offCreated)

  const promptDialog = (title: string, placeholder?: string) =>
    new Promise<string | undefined>((resolve) => {
      api.ui.dialog.replace(
        () =>
          api.ui.DialogPrompt({
            title,
            placeholder,
            onConfirm: (v) => {
              debug("prompt.confirm", { v })
              resolve(v)
              api.ui.dialog.clear()
            },
            onCancel: () => {
              debug("prompt.cancel")
              resolve(undefined)
              api.ui.dialog.clear()
            },
          }),
        () => {
          debug("prompt.close")
          resolve(undefined)
        },
      )
    })

  // Palette `run` handlers must return synchronously: an awaited promise keeps the palette
  // open, and its own close then clears any dialog we opened. Fire-and-forget instead.
  const detached = (fn: () => Promise<void>) => () => {
    void fn().catch((e) => api.ui.toast({ variant: "error", message: e instanceof Error ? e.message : String(e) }))
  }

  api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: "ctree.open",
        title: "Context tree",
        description: "Tree + trajectory of this session",
        category: "Context",
        slashName: "tree",
        slashAliases: ["ctree", "panel"],
        run: () => {
          const sessionID = currentSession(api)
          void adopt()
          api.route.navigate("ctree", sessionID ? { sessionID } : {})
          api.ui.dialog.clear()
        },
      },
      {
        namespace: "palette",
        name: "ctree.branch",
        title: "Branch here",
        description: "Fork the current session into a named branch",
        category: "Context",
        slashName: "branch",
        enabled: () => Boolean(currentSession(api)),
        run: detached(async () => {
          const sessionID = currentSession(api)
          if (!sessionID) return
          await new Promise((r) => setTimeout(r, 30))
          const name = await promptDialog(BRANCH_DIALOG.title, BRANCH_DIALOG.placeholder)
          debug("branch.named", { name })
          if (!name) return
          try {
            await createNamedBranch({ api, store, directory }, { sessionID, name })
          } catch (e) {
            api.ui.toast({ variant: "error", message: `branch: ${e instanceof Error ? e.message : String(e)}` })
          }
        }),
      },
      {
        namespace: "palette",
        name: "ctree.label",
        title: "Label this point",
        description: "Bookmark the last message of the session",
        category: "Context",
        slashName: "label",
        enabled: () => Boolean(currentSession(api)),
        run: detached(async () => {
          const sessionID = currentSession(api)
          if (!sessionID) return
          await new Promise((r) => setTimeout(r, 30))
          const last = api.state.session.messages(sessionID).at(-1)
          if (!last) return
          const value = await promptDialog("Label (empty to remove)", "checkpoint")
          if (value === undefined) return
          setLabel({ api, store, directory }, { sessionID, messageID: last.id, label: value.trim() || null })
          api.ui.toast({ variant: "success", message: value.trim() ? `labelled: ${value.trim()}` : "label removed" })
        }),
      },
    ],
    bindings: options.open.map((key) => ({ key, cmd: "ctree.open" })),
  })

  api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: "ctree.merge",
        title: "Merge branch",
        description: "Close this branch: squash to a ◆ decision record, discard, or tournament",
        category: "Context",
        slashName: "merge",
        enabled: () => Boolean(currentSession(api)),
        run: detached(async () => {
          const sessionID = currentSession(api)
          if (!sessionID) return
          await new Promise((r) => setTimeout(r, 30))
          const state = store.stateForSession(sessionID)
          const branch = state?.sessions[sessionID]
          if (!state || !branch || branch.status !== "open") {
            api.ui.toast({ message: "not on an open branch — /branch first" })
            return
          }
          // the parent is usually not the loaded session, so its turn/token figures come over the SDK
          const parent = await fetchTranscript(api, branch.parentSessionID, directory).catch(() => undefined)
          const parentLabel = branch.parentSessionID === state.root ? TRUNK_LABEL : (state.sessions[branch.parentSessionID]?.name ?? TRUNK_LABEL)
          const turns = ownTurnCount(api.state.session.messages(sessionID), { messageID: branch.anchorMessageID, parentMessageIDs: parent?.messages.map((m) => m.id) ?? [] })
          const mode = await new Promise<MergeMode | undefined>((resolve) => {
            api.ui.dialog.replace(
              () =>
                api.ui.DialogSelect<MergeMode>({
                  title: mergeDialogTitle(branch.name ?? "branch", parent ? mergeTargetOf(parentLabel, parent.messages) : undefined),
                  options: mergeDialogOptions({ siblings: openSiblings(state, sessionID).length, turns }),
                  onSelect: (o) => {
                    resolve(o.value)
                    api.ui.dialog.clear()
                  },
                }),
              () => resolve(undefined),
            )
          })
          if (!mode) return
          const inApp = !hasEditor()
            ? async (draft: string) =>
                new Promise<string | undefined>((resolve) => {
                  api.ui.dialog.replace(
                    () =>
                      api.ui.DialogConfirm({
                        title: "Accept the drafted record as-is?",
                        message: `${draft.slice(0, 400)}${draft.length > 400 ? "…" : ""}\n\n${MERGE_TRUST}`,
                        onConfirm: () => {
                          resolve(draft)
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
            : undefined
          try {
            await mergeBranch({ api, store, directory }, { sessionID, mode, confirm: inApp })
          } catch (e) {
            api.ui.toast({ variant: "error", message: `merge: ${e instanceof Error ? e.message : String(e)}` })
          }
        }),
      },
      {
        namespace: "palette",
        name: "ctree.decisions",
        title: "Decisions",
        description: "◆ decision records on this tree",
        category: "Context",
        slashName: "decisions",
        run: () => {
          const sessionID = currentSession(api)
          api.route.navigate("ctree", sessionID ? { sessionID, view: "decisions" } : { view: "decisions" })
          api.ui.dialog.clear()
        },
      },
    ],
  })

  api.route.register([
    {
      name: "ctree",
      render: ({ params }) => (
        <TreeRoute
          api={api}
          store={store}
          directory={directory}
          sessionID={params?.["sessionID"] as string | undefined}
          refresh={adopted}
          options={{ jumpSummary: options.jumpSummary, hardCrop: options.hardCrop, keybinds: options.keybinds }}
          initialView={params?.["view"] === "decisions" ? "decisions" : "tree"}
        />
      ),
    },
  ])

  api.slots.register({
    slots: {
      sidebar_content: (_ctx, props: { session_id: string }) => {
        const t = api.theme.current
        // the journal is plain files: without the revision the card would render once per session
        const st = createMemo(() => {
          journalRevision()
          return store.stateForSession(props.session_id)
        })
        const branch = () => st()?.sessions[props.session_id]
        // the gauge's own string, so the card and the prompt line never show two numbers
        const size = createMemo(() => contextSizeOf(toMinimalMessages(api.state.session.messages(props.session_id), api.state.part)))
        const limit = createMemo(() => modelContextLimit(api, props.session_id))
        const crops = () => st()?.activeCrops(props.session_id) ?? []
        const hidden = () => crops().reduce((s, c) => s + c.targets.reduce((x, y) => x + y.estTokens, 0), 0)
        const siblings = () => Object.values(st()?.sessions ?? {}).filter((b) => b.parentSessionID === props.session_id && b.status === "open").length
        // status and parent go on their own line: a branch name long enough to wrap used to
        // leave "· open" orphaned underneath it
        const status = () => {
          const b = branch()!
          const title = api.state.session.get(b.parentSessionID)?.title
          const room = CARD_COLUMNS - b.status.length - 10
          return `${b.status}${title && room > 3 ? ` · from "${clip(title, room)}"` : ""}`
        }
        return (
          <box flexDirection="column">
            <text fg={t.text}>
              <b>Context tree</b>
            </text>
            <Show when={branch()} fallback={<text fg={t.text}>{`trunk${siblings() ? ` · ${siblings()} branch${siblings() === 1 ? "" : "es"}` : ""}`}</text>}>
              <text fg={t.success}>{`⎇ ${branchLabel(api, props.session_id, branch()!.name, CARD_COLUMNS - 2)}`}</text>
              <text fg={t.textMuted}>{status()}</text>
            </Show>
            <text fg={t[BAND_COLOR[bandFor(size().tokens, limit())]]}>{formatContext(size(), limit())}</text>
            <Show when={crops().length}>
              <text fg={t.warning}>{`✂ ${crops().length} crop${crops().length === 1 ? "" : "s"} · ~${formatK(hidden())} hidden`}</text>
            </Show>
            <text fg={t.textMuted}>/tree · ctrl+q</text>
          </box>
        )
      },
      session_prompt_right: (_ctx, props: { session_id: string }) => {
        const t = api.theme.current
        const size = createMemo(() => contextSizeOf(toMinimalMessages(api.state.session.messages(props.session_id), api.state.part)))
        const branch = () => {
          journalRevision() // the journal is plain files: without the revision `⎇ name` never refreshes
          return store.stateForSession(props.session_id)?.sessions[props.session_id]
        }
        // model context limit + compaction reserve, for the bands and the guard (DESIGN.md §6.7)
        const limit = createMemo(() => modelContextLimit(api, props.session_id))
        const band = () => bandFor(size().tokens, limit())
        const reserve = () => (api.state.config as { compaction?: { reserved?: number } }).compaction?.reserved ?? 16_384
        // trend + attribution: an effect compares each new size with the previous one
        // (side effects and closure state stay out of the memo graph)
        const [trend, setTrend] = createSignal("")
        let prevTokens = 0
        let prevParts = new Map<string, number>()
        let redNudged = false
        let guardNudged = false
        // the slot is reused across sessions: carrying this over reports a bogus trend and
        // swallows the first red/guard nudge of the session we just moved to
        createEffect(
          on(
            () => props.session_id,
            () => {
              prevTokens = 0
              prevParts = new Map()
              redNudged = false
              guardNudged = false
              setTrend("")
            },
            { defer: true },
          ),
        )
        const partSizes = createMemo(() => {
          const parts = new Map<string, { len: number; key: string }>()
          for (const m of api.state.session.messages(props.session_id)) {
            for (const p of api.state.part(m.id) as unknown as { id: string; type: string; tool?: string; text?: string; state?: { output?: string } }[]) {
              const len = p.type === "tool" ? (p.state?.output?.length ?? 0) : (p.text?.length ?? 0)
              parts.set(p.id, { len, key: p.type === "tool" ? (p.tool ?? "tool") : p.type === "text" ? "text" : p.type })
            }
          }
          return parts
        })
        createEffect(() => {
          const now = size().tokens
          const parts = partSizes()
          let biggest: { key: string; delta: number } | undefined
          for (const [id, { len, key }] of parts) {
            const delta = len - (prevParts.get(id) ?? 0)
            if (delta > 0 && (!biggest || delta > biggest.delta)) biggest = { key, delta }
          }
          const rise = prevTokens > 0 ? (now - prevTokens) / prevTokens : 0
          if (now !== prevTokens) setTrend(rise >= 0.1 && biggest ? ` ▲ +${Math.round(rise * 100)}% (${biggest.key})` : "")
          prevTokens = now
          prevParts = new Map([...parts].map(([id, v]) => [id, v.len]))
        })
        createEffect(() => {
          const b = band()
          if (b === "red" && !redNudged) {
            redNudged = true
            api.ui.toast({ variant: "warning", message: `context is in the red band (${limit() ? "≥85% of the window" : "≥64k"}) — consider /tree → c crop, or /merge a branch`, duration: 6000 })
          } else if (b === "low" || b === "healthy") redNudged = false
          const lim = limit()
          if (lim && size().tokens >= lim - reserve() && !guardNudged) {
            guardNudged = true
            api.ui.toast({ variant: "error", message: "OpenCode will auto-compact soon (lossy). Crop or merge first if you want to keep the source material.", duration: 8000 })
          } else if (lim && size().tokens < lim - reserve() * 2) guardNudged = false
        })
        return (
          // the same string the tree header shows, so both surfaces read identically
          <text fg={t[BAND_COLOR[band()]]}>{`${branch() ? `⎇ ${branchLabel(api, props.session_id, branch()!.name, 24)} · ` : ""}${formatContext(size(), limit())}${trend()}`}</text>
        )
      },
    },
  })
}

export default { id: "opencode-context-tree", tui }
