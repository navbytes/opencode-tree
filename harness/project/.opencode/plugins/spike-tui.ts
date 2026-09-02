import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

const LOG = process.env.SPIKE_LOG || "/tmp/spike-plugin.log"
const log = (o: unknown) => fs.appendFileSync(LOG, JSON.stringify({ ts: Date.now(), ...(o as object) }) + "\n")

async function openEditor(renderer: any, value: string) {
  const editor = process.env.VISUAL || process.env.EDITOR
  if (!editor) return
  const file = path.join(os.tmpdir(), `ctree-${Date.now()}.md`)
  fs.writeFileSync(file, value)
  renderer.suspend()
  renderer.currentRenderBuffer?.clear?.()
  try {
    await new Promise<void>((resolve, reject) => {
      const parts = editor.split(" ")
      const child = spawn(parts[0]!, [...parts.slice(1), file], { stdio: "inherit" })
      child.on("error", reject)
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))
    })
    return fs.readFileSync(file, "utf8")
  } finally {
    fs.rmSync(file, { force: true })
    renderer.currentRenderBuffer?.clear?.()
    renderer.resume()
    renderer.requestRender()
  }
}

const tui: TuiPlugin = async (api, options, meta) => {
  log({ event: "tui.loaded", id: meta.id, source: meta.source, state: meta.state, route: api.route.current?.name, keys: Object.keys(api) })
  api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: "spike.editor",
        title: "Spike: editor gate",
        category: "Spike",
        slashName: "spikeedit",
        run: async () => {
          log({ event: "spike.editor.run" })
          try {
            const text = await openEditor(api.renderer, "## Decision: spike\n")
            log({ event: "spike.editor.done", text })
            api.ui.toast({ variant: "success", message: `editor returned ${text?.length ?? 0} chars` })
          } catch (e) {
            log({ event: "spike.editor.error", error: String(e) })
            api.ui.toast({ variant: "error", message: String(e) })
          }
        },
      },
      {
        namespace: "palette",
        name: "spike.state",
        title: "Spike: dump state",
        category: "Spike",
        slashName: "spikestate",
        run: () => {
          const cur = api.route.current
          const sid = cur.name === "session" ? (cur.params as any).sessionID : undefined
          const msgs = sid ? api.state.session.messages(sid) : []
          log({ event: "spike.state", route: cur.name, sid, messages: msgs.length, roles: msgs.map((m) => m.role) })
          api.ui.toast({ message: `route=${cur.name} messages=${msgs.length}` })
        },
      },
    ],
  })
}

export default { id: "spike-tui", tui }
