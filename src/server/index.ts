/**
 * Server plugin half (DESIGN.md §3.1, §8).
 *
 * Runs inside the OpenCode server. Reads the journal (never writes tree-shaping
 * entries itself — those come from user actions in the TUI half or the headless
 * `/ctree` commands, not yet implemented here) and applies crops to the messages
 * OpenCode sends to the model, in place.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { activeCrops } from "../core/journal.js"
import { applyCrops, type CropSpec, type MinimalMessage } from "../core/crop.js"
import { JournalStore } from "../shared/store.js"

export const server: Plugin = async ({ worktree }) => {
  const store = new JournalStore({ worktree })

  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      const sessionID = output.messages[0]?.info.sessionID
      if (!sessionID) return

      const state = store.stateForSession(sessionID)
      if (!state) return // not a session the plugin knows about (DESIGN.md §3.1)

      // decision records of re-opened branches stay on screen but leave the context
      const hidden = Object.values(state.decisions).filter((d) => d.hidden && d.sessionID === sessionID).map((d) => d.messageID)
      if (hidden.length) {
        const lastUser = [...output.messages].reverse().find((m) => m.info.role === "user")
        for (let i = output.messages.length - 1; i >= 0; i--) {
          const m = output.messages[i]!
          if (hidden.includes(m.info.id) && m !== lastUser) output.messages.splice(i, 1)
        }
      }

      const crops: CropSpec[] = activeCrops(state, sessionID).map((crop) => ({
        mode: crop.mode,
        targets: crop.targets,
        anchorMessageID: crop.anchorMessageID,
      }))
      if (crops.length === 0) return

      applyCrops(output.messages as unknown as MinimalMessage[], crops)
    },

    // DESIGN.md §6.8: decision records survive compaction verbatim
    "experimental.session.compacting": async ({ sessionID }, output) => {
      const state = store.stateForSession(sessionID)
      if (!state) return
      const records = Object.values(state.decisions)
        .filter((d) => d.sessionID === sessionID && !d.hidden && d.text)
        .sort((a, b) => a.recordedAt - b.recordedAt)
      if (records.length === 0) return
      output.context.push(
        `The conversation contains human-confirmed decision records (marked ◆). Reproduce each of them VERBATIM in the summary under a "## Decisions" heading; never paraphrase them:\n\n${records.map((r) => r.text).join("\n\n")}`,
      )
    },

    // DESIGN.md §6.8: a system note so the model reads ◆ / ✂ markers correctly
    "experimental.chat.system.transform": async ({ sessionID }, output) => {
      if (!sessionID || !store.stateForSession(sessionID)) return
      output.system.push(
        "Context notes: messages starting with ◆ are decision records confirmed by the user — treat them as settled facts. Tool results reading [cropped: …] or turns reading [dropped turn …] were removed from your context on purpose to save space; if you need one back, ask the user to restore it (they can with /undo in the context tree).",
      )
    },

    "chat.message": async (input, output) => {
      const state = store.stateForSession(input.sessionID)
      if (!state) return

      const branch = state.sessions[input.sessionID]
      if (!branch?.model || branch.status !== "open") return

      const [providerID, modelID] = branch.model.split("/")
      if (!providerID || !modelID) return

      output.message.model = { providerID, modelID }
    },

    event: async ({ event }) => {
      if (event.type !== "session.deleted") return
      const sessionID = event.properties.info.id
      const treeId = store.treeIdFor(sessionID)
      if (!treeId) return

      store.append(treeId, {
        v: 1,
        id: `e_${crypto.randomUUID()}`,
        ts: Date.now(),
        type: "session.forgotten",
        actor: "server",
        data: { sessionID },
      })
    },
  }
}

export default { id: "opencode-context-tree", server }
