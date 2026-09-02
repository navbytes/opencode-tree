/** @jsxImportSource @opentui/solid */
/**
 * TUI plugin half (DESIGN.md §3.2, §5, §7): `/tree` (aliases `/ctree`, `/panel`),
 * `/branch`, `/label`, the `ctree` route, and the prompt-side gauge slot.
 */
import type { TuiPluginApi, TuiPlugin } from "@opencode-ai/plugin/tui"
import { createMemo } from "solid-js"
import { bandFor, contextSizeOf, type MinimalMessage, type MinimalPart } from "../core/tokens.js"
import { JournalStore, type StorageMode } from "../shared/store.js"
import { debug } from "../shared/debug.js"
import { createNamedBranch, setLabel } from "./actions.js"
import { TreeRoute, formatK } from "./route.js"

const BAND_COLOR = { low: "success", healthy: "success", filling: "warning", red: "error" } as const

type Options = { storage: StorageMode; jumpSummary: "ask" | "never" }

function parseOptions(raw: Record<string, unknown> | undefined): Options {
  return {
    storage: raw?.["storage"] === "global" ? "global" : "local",
    jumpSummary: raw?.["jumpSummary"] === "never" ? "never" : "ask",
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

function currentSession(api: TuiPluginApi): string | undefined {
  const cur = api.route.current
  return cur.name === "session" ? ((cur.params as { sessionID?: string } | undefined)?.sessionID ?? undefined) : undefined
}

const tui: TuiPlugin = async (api, rawOptions) => {
  const options = parseOptions(rawOptions as Record<string, unknown> | undefined)
  const directory = api.state.path.directory
  const store = new JournalStore({ worktree: api.state.path.worktree || directory, stateDir: api.state.path.state, mode: options.storage })
  debug("tui.loaded", { path: api.state.path, options })

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
          const name = await promptDialog("Branch name", "fix-flaky-test")
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
    bindings: [{ key: "ctrl+q", cmd: "ctree.open" }],
  })

  api.route.register([
    {
      name: "ctree",
      render: ({ params }) => (
        <TreeRoute api={api} store={store} directory={directory} sessionID={params?.["sessionID"] as string | undefined} options={{ jumpSummary: options.jumpSummary }} />
      ),
    },
  ])

  api.slots.register({
    slots: {
      sidebar_content: (_ctx, props: { session_id: string }) => {
        const t = api.theme.current
        const st = () => store.stateForSession(props.session_id)
        const branch = () => st()?.sessions[props.session_id]
        const crops = () => st()?.activeCrops(props.session_id) ?? []
        const hidden = () => crops().reduce((s, c) => s + c.targets.reduce((x, y) => x + y.estTokens, 0), 0)
        const siblings = () => Object.values(st()?.sessions ?? {}).filter((b) => b.parentSessionID === props.session_id && b.status === "open").length
        return (
          <box flexDirection="column">
            <text fg={t.textMuted}>Context tree</text>
            <text fg={branch() ? t.success : t.text}>{branch() ? `⎇ ${branch()!.name ?? "branch"} · ${branch()!.status}` : `trunk${siblings() ? ` · ${siblings()} open branch${siblings() === 1 ? "" : "es"}` : ""}`}</text>
            <text fg={crops().length ? t.warning : t.textMuted}>{crops().length ? `✂ ${crops().length} crop${crops().length === 1 ? "" : "s"} · ~${formatK(hidden())} hidden from model` : "no crops"}</text>
            <text fg={t.textMuted}>/tree · ctrl+q</text>
          </box>
        )
      },
      session_prompt_right: (_ctx, props: { session_id: string }) => {
        const size = createMemo(() => contextSizeOf(toMinimalMessages(api.state.session.messages(props.session_id), api.state.part)))
        const t = api.theme.current
        const band = () => bandFor(size().tokens)
        const branch = () => store.stateForSession(props.session_id)?.sessions[props.session_id]
        return (
          <text fg={t[BAND_COLOR[band()]]}>
            {branch() ? `⎇ ${branch()!.name ?? "branch"} · ` : ""}ctx {formatK(size().tokens)}
          </text>
        )
      },
    },
  })
}

export default { id: "opencode-context-tree", tui }
