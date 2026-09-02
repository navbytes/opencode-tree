/** @jsxImportSource @opentui/solid */
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { createMemo, For } from "solid-js"
import fs from "node:fs"
const LOG = process.env.SPIKE_LOG || "/tmp/spike-plugin.log"
const log = (o: unknown) => fs.appendFileSync(LOG, JSON.stringify({ ts: Date.now(), ...(o as object) }) + "\n")

const tui: TuiPlugin = async (api) => {
  log({ event: "route-plugin.loaded" })
  api.keymap.registerLayer({
    commands: [{ namespace: "palette", name: "spike.route", title: "Spike: tree route", category: "Spike", slashName: "spikeroute",
      run: () => { const cur = api.route.current; api.route.navigate("spike-tree", cur.name === "session" ? { sessionID: (cur.params as any).sessionID } : {}); api.ui.dialog.clear() } }],
  })
  api.route.register([{
    name: "spike-tree",
    render: ({ params }) => {
      const sid = () => (params?.sessionID as string | undefined)
      const rows = createMemo(() => {
        const id = sid(); if (!id) return []
        return api.state.session.messages(id).map((m) => {
          const parts = api.state.part(m.id)
          const text = parts.map((p) => (p.type === "text" ? p.text : p.type === "tool" ? `[${p.tool}]` : "")).join(" ").slice(0, 60)
          const tok = m.role === "assistant" ? (m as any).tokens?.input : undefined
          return `${m.role === "user" ? "●" : "○"} ${m.role.padEnd(9)} ${text}${tok ? `  ${tok}t` : ""}`
        })
      })
      log({ event: "route.render", sid: sid(), rows: rows().length })
      api.keymap.registerLayer({ commands: [{ name: "spike.route.back", hidden: true, run: () => api.route.navigate("session", { sessionID: sid() }) }], bindings: [{ key: "escape", cmd: "spike.route.back" }, { key: "q", cmd: "spike.route.back" }] })
      const t = api.theme.current
      return (
        <box flexDirection="column" padding={1} backgroundColor={t.background}>
          <text fg={t.primary}>┌ Spike context tree · {sid() ?? "no session"} ─ {rows().length} rows</text>
          <For each={rows()}>{(r) => <text fg={t.text}>│ {r}</text>}</For>
          <text fg={t.textMuted}>└ q/esc back</text>
        </box>
      )
    },
  }])
}
export default { id: "spike-route", tui }
