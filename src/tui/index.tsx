/** @jsxImportSource @opentui/solid */
/**
 * TUI plugin half (DESIGN.md §3.2, §5, §7).
 *
 * Registers the `/tree` palette command + `ctree` route (a first cut of the
 * combined tree + trajectory view: for now just the trajectory rows of the
 * active session, with a context-size header) and the `session_prompt_right`
 * gauge slot. No crop/merge UI yet — that lands once the server half's crop
 * plumbing has a TUI-side journal writer to drive it.
 */
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { createMemo, For } from "solid-js"
import { bandFor, contextSizeOf, estimateTokens, type MinimalMessage, type MinimalPart } from "../core/tokens.js"

const BAND_COLOR: Record<ReturnType<typeof bandFor>, "success" | "warning" | "error"> = {
  low: "success",
  healthy: "success",
  filling: "warning",
  red: "error",
}

function formatK(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const k = (tokens / 1000).toFixed(1)
  return `${k.endsWith(".0") ? k.slice(0, -2) : k}k`
}

/** Bridges `api.state`'s live Message/Part shapes into core/tokens's minimal structural type. */
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

function rowGlyph(role: string): string {
  return role === "user" ? "●" : role === "assistant" ? "○" : "◇"
}

function rowPreview(part: (messageID: string) => readonly any[], messageID: string): string {
  return part(messageID)
    .map((p) => (p.type === "text" ? p.text : p.type === "tool" ? `[${p.tool}]` : ""))
    .filter(Boolean)
    .join(" ")
    .slice(0, 60)
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: "ctree.open",
        title: "Context tree",
        category: "Context",
        slashName: "tree",
        slashAliases: ["ctree", "panel"],
        run: () => {
          const current = api.route.current
          api.route.navigate("ctree", current.name === "session" ? { sessionID: (current.params as any).sessionID } : {})
          api.ui.dialog.clear()
        },
      },
    ],
  })

  api.route.register([
    {
      name: "ctree",
      render: ({ params }) => {
        const sessionID = () => params?.["sessionID"] as string | undefined

        const rows = createMemo(() => {
          const id = sessionID()
          if (!id) return []
          return api.state.session.messages(id).map((m) => {
            const preview = rowPreview(api.state.part, m.id)
            const tokens =
              m.role === "assistant" && typeof (m as any).tokens?.input === "number"
                ? (m as any).tokens.input
                : estimateTokens(preview)
            return { role: m.role, glyph: rowGlyph(m.role), preview, tokens }
          })
        })

        const contextSize = createMemo(() => {
          const id = sessionID()
          if (!id) return { tokens: 0, estimated: true as const }
          return contextSizeOf(toMinimalMessages(api.state.session.messages(id), api.state.part))
        })
        const band = createMemo(() => bandFor(contextSize().tokens))

        api.keymap.registerLayer({
          commands: [
            {
              name: "ctree.back",
              hidden: true,
              run: () => api.route.navigate("session", { sessionID: sessionID() }),
            },
          ],
          bindings: [
            { key: "escape", cmd: "ctree.back" },
            { key: "q", cmd: "ctree.back" },
          ],
        })

        const t = api.theme.current

        return (
          <box flexDirection="column" padding={1} backgroundColor={t.background}>
            <text fg={t.primary}>
              ┌ Context tree · {sessionID() ?? "no session"} ─ {rows().length} rows
            </text>
            <text fg={t[BAND_COLOR[band()]]}>
              │ ctx {formatK(contextSize().tokens)}
              {contextSize().estimated ? "~" : ""} · {band()}
            </text>
            <For each={rows()}>
              {(r) => (
                <text fg={t.text}>
                  │ {r.glyph} {r.role.padEnd(9)} {r.preview} {formatK(r.tokens)}t
                </text>
              )}
            </For>
            <text fg={t.textMuted}>└ q/esc back</text>
          </box>
        )
      },
    },
  ])

  api.slots.register({
    slots: {
      session_prompt_right: (_ctx, props: { session_id: string }) => {
        const size = createMemo(() =>
          contextSizeOf(toMinimalMessages(api.state.session.messages(props.session_id), api.state.part)),
        )
        const t = api.theme.current
        const band = () => bandFor(size().tokens)
        return <text fg={t[BAND_COLOR[band()]]}>ctx {formatK(size().tokens)}</text>
      },
    },
  })
}

export default { id: "opencode-context-tree", tui }
