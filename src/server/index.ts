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
import { JournalStore } from "./store.js"

export const server: Plugin = async ({ worktree }) => {
  const store = new JournalStore({ worktree })

  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      const sessionID = output.messages[0]?.info.sessionID
      if (!sessionID) return

      const state = store.stateForSession(sessionID)
      if (!state) return // not a session the plugin knows about (DESIGN.md §3.1)

      const crops: CropSpec[] = activeCrops(state, sessionID).map((crop) => ({
        mode: crop.mode,
        targets: crop.targets,
        anchorMessageID: crop.anchorMessageID,
      }))
      if (crops.length === 0) return

      applyCrops(output.messages as unknown as MinimalMessage[], crops)
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
