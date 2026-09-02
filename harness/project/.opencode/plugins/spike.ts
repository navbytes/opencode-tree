import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs"

const LOG = process.env.SPIKE_LOG || "/tmp/spike-plugin.log"
const log = (o: unknown) => fs.appendFileSync(LOG, JSON.stringify({ ts: Date.now(), ...(o as object) }) + "\n")

export const SpikePlugin: Plugin = async ({ directory }) => {
  log({ event: "loaded", directory })
  return {
    // (e) branch model override: if the user text contains [branch-b], force mock-b
    "chat.message": async (input, output) => {
      const text = output.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ")
      log({ event: "chat.message", inputModel: input.model, storedModel: output.message.model, text })
      if (text.includes("[branch-b]")) output.message.model = { providerID: "mock", modelID: "mock-b" }
    },
    // (b) crop: stub every completed bash tool output in place
    "experimental.chat.messages.transform": async (_input, output) => {
      const sessionID = output.messages[0]?.info.sessionID
      let stubbed = 0
      for (const m of output.messages) {
        for (const p of m.parts) {
          if (p.type === "tool" && p.state.status === "completed" && p.tool === "bash") {
            p.state.output = `[cropped: bash ${String((p.state.input as any)?.command ?? "").slice(0, 20)}, ~1 tokens, sha8 deadbeef]`
            stubbed++
          }
        }
      }
      log({ event: "transform", sessionID, messages: output.messages.length, stubbed })
    },
  }
}
