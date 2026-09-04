/**
 * Server plugin half (DESIGN.md §3.1, §8).
 *
 * Runs inside the OpenCode server. Owns the headless `/ctree` commands (status,
 * branch, merge --discard, crop, undo, decisions) and applies crops to the
 * messages OpenCode sends to the model, in place. Tree-shaping entries it does
 * not create itself (squash merges, labels, summaries) come from the TUI half.
 */
import fs from "node:fs"
import path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { activeCrops, withBranchLabel } from "../core/journal.js"
import { applyCrops, type CropSpec, type MinimalMessage } from "../core/crop.js"
import { JournalStore, type StorageMode } from "../shared/store.js"
import { CTREE_HELP, parseCtreeArgs } from "../core/ctree-args.js"
import { autoMark, planResultCrop, resultCandidates, topCandidate, type CropRules, DEFAULT_RULES } from "../core/cropplan.js"
import { planUndo } from "../core/undo.js"
import { exportDecisions } from "../core/decision.js"
import { PLUGIN_VERSION } from "../shared/version.js"
import { debug } from "../shared/debug.js"
import type { Transcript, TranscriptMessage } from "../core/transcript.js"
import { cacheShare, contextSizeOf, formatK, type MinimalMessage as MinimalTokenMessage } from "../core/tokens.js"
import { parseForkTitle } from "../core/adopt.js"
import { adoptNativeForks } from "../shared/adopt.js"

/**
 * Name the parts of an unlabelled system prompt so the consumers view can say *which* part
 * costs what — "my AGENTS.md is 4k" is a lever the user can actually pull, where OpenCode's
 * base prompt is not.
 *
 * The heuristics are deliberately shallow and never throw: an unrecognised part is "system
 * prompt" plus its index, which is still worth counting.
 */
function nameSystemPart(text: string, index: number): string {
  const head = text.slice(0, 400).toLowerCase()
  if (head.includes("agents.md")) return "AGENTS.md"
  if (head.includes("claude.md")) return "CLAUDE.md"
  if (/\bcontext notes:/.test(head)) return "context-tree note"
  if (head.includes("<env>") || head.includes("working directory")) return "environment"
  if (head.includes("today's date") || head.includes("current date")) return "date"
  return index === 0 ? "base prompt" : `system prompt ${index + 1}`
}

/**
 * Record the system parts for a session. Best effort in every direction: if the host ever hands
 * us an empty array (we append to it, so it arrives carrying OpenCode's own parts — the debug
 * line below is how to confirm that on a live server), nothing is written and every reader
 * treats the absence as "unknown", never as "zero".
 */
/** Last shape written per session, so an unchanged prompt costs no filesystem write at all —
 *  this hook runs on every single request. */
const lastSystem = new Map<string, string>()

function captureSystem(store: JournalStore, sessionID: string, system: readonly string[]): void {
  try {
    const parts = system
      .map((text, i) => ({ name: nameSystemPart(text, i), chars: text.length, text }))
      .filter((p) => p.chars > 0)
    const shape = parts.map((p) => `${p.name}:${p.chars}`).join("|")
    debug("system.captured", { sessionID, parts: parts.length, chars: parts.reduce((n, p) => n + p.chars, 0), unchanged: lastSystem.get(sessionID) === shape })
    if (parts.length === 0 || lastSystem.get(sessionID) === shape) return
    store.writeSystem(sessionID, { v: 1, ts: Date.now(), parts })
    lastSystem.set(sessionID, shape)
  } catch (e) {
    debug("system.capture.failed", { error: e instanceof Error ? e.message : String(e) })
  }
}

export const server: Plugin = async ({ worktree, client, directory }, options) => {
  // same option parsing as the TUI half, so both write to the same place (docs/USAGE.md)
  const mode: StorageMode = options?.["storage"] === "global" ? "global" : "local"
  // awaiting an SDK call in the plugin factory deadlocks the server (plugin init blocks
  // request handling), so the state dir is resolved off the critical path
  const stateDir = mode === "global" ? client.path.get({ query: { directory } }).then((res) => res.data?.state).catch(() => undefined) : Promise.resolve(undefined)
  const journal = stateDir.then((dir) => new JournalStore({ worktree, stateDir: dir, mode }))

  const say = (output: { parts: any[] }, text: string) => {
    output.parts.length = 0
    output.parts.push({ id: `prt_ctree_${Date.now().toString(36)}`, type: "text", text: `[context tree]\n${text}\n\n(Acknowledge in one short line; do not act on this.)` })
  }

  /** Mirror tree linkage into `session.metadata.ctree` (DESIGN.md §4.2), merging with what is there. Best effort. */
  async function mirrorMetadata(sessionID: string, ctree: Record<string, unknown>): Promise<void> {
    const existing = await client.session.get({ path: { id: sessionID }, query: { directory } }).catch(() => undefined)
    const info = existing?.data as { metadata?: { ctree?: Record<string, unknown> } } | undefined
    if (!info) return // the PATCH replaces `metadata` wholesale: without the current value we would wipe other plugins' keys
    const meta = (info.metadata ?? {}) as { ctree?: Record<string, unknown> }
    await client.session
      .update({ path: { id: sessionID }, query: { directory }, body: { metadata: { ...meta, ctree: { ...(meta.ctree ?? {}), ...ctree } } } as unknown as { title?: string } })
      .catch(() => undefined)
  }

  /** A branch's display name: an adopted native fork carries no journal `name`, so fall back
   *  to the session's own title rather than printing a raw session id (DESIGN.md §4.1). */
  async function branchLabel(sessionID: string, name?: string): Promise<string> {
    if (name) return name
    const res = await client.session.get({ path: { id: sessionID }, query: { directory } }).catch(() => undefined)
    return (res?.data as { title?: string } | undefined)?.title || "branch"
  }

  /** One request, no paging: `before` is an opaque cursor the response never exposes, and
   *  omitting `limit` returns the whole session ascending (a `limit` would silently truncate). */
  async function transcriptOf(sessionID: string): Promise<Transcript> {
    const res = await client.session.messages({ path: { id: sessionID }, query: { directory } })
    if (res.error || !Array.isArray(res.data)) throw new Error(`could not read the messages of ${sessionID}: ${res.error ? JSON.stringify(res.error) : `unexpected response (${typeof res.data})`}`)
    const messages: TranscriptMessage[] = (res.data as any[]).map((m) => ({
      id: m.info.id as string,
      role: (m.info.role === "user" ? "user" : "assistant") as "user" | "assistant",
      time: m.info.time,
      tokens: m.info.tokens,
      summary: m.info.summary === true ? true : undefined,
      parts: (m.parts as any[]).map((p) => ({ id: p.id, type: p.type, text: p.text, tool: p.tool, callID: p.callID, state: p.state, time: p.time, metadata: p.metadata })),
    }))
    return { sessionID, title: sessionID, status: "available", messages }
  }

  /** Journal native `/fork` sessions the plugin did not create itself (DESIGN.md §4.1). */
  async function adopt() {
    return adoptNativeForks({
      store: await journal,
      directory,
      actor: "server",
      listSessions: async () => {
        const res = await client.session.list({ query: { directory } })
        return ((res.data as any[]) ?? []).map((s) => ({ id: s.id as string, title: (s.title as string) ?? "", created: (s.time?.created as number) ?? 0, parentID: s.parentID as string | undefined, directory: s.directory as string | undefined }))
      },
      messagesOf: async (sessionID) => (await transcriptOf(sessionID)).messages.map((m) => ({ id: m.id, role: m.role, created: m.time.created })),
    })
  }

  /** The `session.created` event fires before the fork's messages are copied, so wait, then retry. */
  async function adoptSoon(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((r) => setTimeout(r, 1000))
      if ((await adopt()).length > 0) return
    }
  }

  return {
    config: async (cfg) => {
      const c = cfg as { command?: Record<string, unknown> }
      if (c.command?.["ctree"]) return // a user-defined /ctree command wins
      c.command = { ...(c.command ?? {}), ctree: { template: "$ARGUMENTS", description: "Context tree (headless): status | branch | merge --discard | crop | undo | decisions — no /tree? run: opencode plugin opencode-context-tree -g" } }
    },

    "command.execute.before": async (input, output) => {
      if (input.command !== "ctree") return
      const sessionID = input.sessionID
      try {
        const store = await journal
        const cmd = parseCtreeArgs(input.arguments)
        switch (cmd.kind) {
          case "help":
            return say(output, `${cmd.error ? `error: ${cmd.error}\n\n` : ""}${CTREE_HELP}\n(opencode-context-tree ${PLUGIN_VERSION})`)
          case "status": {
            await adopt() // headless clients have no TUI half to do it for them
            const state = store.stateForSession(sessionID)
            if (!state) return say(output, "this session is not in a tree yet (nothing branched, cropped or labelled).")
            const me = state.sessions[sessionID]
            const crops = state.activeCrops(sessionID)
            const hidden = crops.reduce((s, c) => s + c.targets.reduce((x, y) => x + y.estTokens, 0), 0)
            const branches = Object.values(state.sessions).filter((b) => b.parentSessionID === sessionID)
            const listed = await Promise.all(branches.map(async (b) => `${await branchLabel(b.sessionID, b.name)} [${b.status}]`))
            const tr = await transcriptOf(sessionID)
            const size = contextSizeOf(tr.messages.map((m): MinimalTokenMessage => ({ info: m.role === "assistant" ? { role: "assistant", tokens: m.tokens } : { role: "user" }, parts: m.parts })))
            const share = cacheShare(size)
            const contextLine = `context ${size.estimated ? "~" : ""}${formatK(size.tokens)}${share !== undefined ? ` · ${formatK(size.cached!)} cached (${share}%)` : ""}`
            return say(output, [`opencode-context-tree ${PLUGIN_VERSION} · tree ${state.treeId}`, me ? `this session is ⎇ ${await branchLabel(sessionID, me.name)} (${me.status}) of ${me.parentSessionID}${me.note ? ` — ${me.note}` : ""}` : "this session is the trunk", contextLine, `${branches.length} branch(es) from here: ${listed.join(", ") || "none"}`, `${crops.length} active crop(s), ~${hidden} tokens hidden`, `${Object.values(state.decisions).filter((d) => d.sessionID === sessionID && !d.hidden).length} decision record(s) here`].join("\n"))
          }
          case "branch": {
            const tr = await transcriptOf(sessionID)
            const last = tr.messages.at(-1)
            if (!last) return say(output, "nothing to branch from yet.")
            const treeId = store.ensureTree(sessionID, "server")
            const forked = await client.session.fork({ path: { id: sessionID }, query: { directory } })
            const forkedID = (forked.data as any)?.id as string | undefined
            if (!forkedID) return say(output, "fork failed.")
            store.registerSession(forkedID, treeId)
            store.record(treeId, "branch.opened", { sessionID: forkedID, parentSessionID: sessionID, anchorMessageID: last.id, name: cmd.name, kind: "explicit", branchModel: cmd.model }, "server")
            // a second branch off the same anchor must not replace the first one's label
            store.record(treeId, "label.set", { sessionID, messageID: last.id, label: withBranchLabel(store.stateFor(treeId).labels[last.id]?.label, cmd.name) }, "server")
            await client.session.update({ path: { id: forkedID }, query: { directory }, body: { title: `⎇ ${cmd.name}` } }).catch(() => undefined)
            await mirrorMetadata(forkedID, { treeId, parentSessionID: sessionID, anchorMessageID: last.id, name: cmd.name, status: "open" })
            await mirrorMetadata(sessionID, { treeId })
            await client.tui.publish({ query: { directory }, body: { type: "tui.session.select", properties: { sessionID: forkedID } } as any }).catch(() => undefined)
            return say(output, `⎇ ${cmd.name} opened as session ${forkedID}${cmd.model ? ` on ${cmd.model}` : ""}. Switch to it with /sessions if the TUI did not follow.`)
          }
          case "merge-discard": {
            const state = store.stateForSession(sessionID)
            const branch = state?.sessions[sessionID]
            if (!state || !branch || branch.status !== "open") return say(output, "this session is not an open branch — /ctree branch first.")
            store.record(state.treeId, "branch.closed", { sessionID, status: "rejected", note: cmd.note }, "server")
            await mirrorMetadata(sessionID, { status: "rejected" })
            await client.tui.publish({ query: { directory }, body: { type: "tui.session.select", properties: { sessionID: branch.parentSessionID } } as any }).catch(() => undefined)
            return say(output, `⎇ ${await branchLabel(sessionID, branch.name)} discarded${cmd.note ? ` (${cmd.note})` : ""} — back on the trunk (${branch.parentSessionID}); /ctree undo from there re-opens it.`)
          }
          case "crop-top":
          case "crop-auto": {
            const tr = await transcriptOf(sessionID)
            const state = store.stateForSession(sessionID)
            const already = new Set<string>()
            if (state) for (const c of state.activeCrops(sessionID)) for (const t of c.targets) already.add(t.partID ?? t.messageID)
            const rules: CropRules = cmd.kind === "crop-auto" ? { minTokens: cmd.minTokens ?? DEFAULT_RULES.minTokens, olderThanTurns: cmd.olderThan ?? DEFAULT_RULES.olderThanTurns, keep: cmd.keep } : DEFAULT_RULES
            const cands = resultCandidates(tr, { alreadyCropped: already, keep: rules.keep })
            const picks = cmd.kind === "crop-top" ? [topCandidate(cands, cmd.force)].filter((c): c is NonNullable<typeof c> => Boolean(c)) : autoMark(cands, rules)
            if (picks.length === 0) {
              const blocked = cands.filter((c) => !c.protections.includes("already-cropped")).sort((a, b) => b.estTokens - a.estTokens)[0]
              return say(output, blocked ? `nothing unprotected to crop. Biggest candidate: ${blocked.tool} "${blocked.arg.slice(0, 40)}" ~${blocked.estTokens} tokens is protected (${blocked.protections.join(", ")}); use --force to waive "latest-per-tool".` : "nothing to crop: no completed tool results.")
            }
            const total = picks.reduce((s, c) => s + c.estTokens, 0)
            const listing = picks.map((c) => `  ✂ ${c.tool} "${c.arg.slice(0, 40)}" ~${c.estTokens} tokens (turn ${c.turn})`).join("\n")
            if (!cmd.apply) return say(output, `dry run — would crop ${picks.length} result(s), ~${total} tokens:\n${listing}\nRe-run with --apply to write it.`)
            const plan = planResultCrop(sessionID, picks)!
            const treeId = store.ensureTree(sessionID, "server")
            store.record(treeId, "crop.applied", plan, "server")
            return say(output, `cropped ${picks.length} result(s), ~${total} tokens leave the context from the next turn:\n${listing}\n/ctree undo restores.`)
          }
          case "undo": {
            const state = store.stateForSession(sessionID)
            if (!state) return say(output, "nothing to undo.")
            const plan = planUndo(store.entriesFor(state.treeId), state, sessionID)
            if (plan.kind === "restore-crop") {
              store.record(state.treeId, "crop.restored", { cropID: plan.cropID }, "server")
              return say(output, `restored the ${plan.mode === "turn" ? "dropped turn" : "cropped result"} (~${plan.estTokens} tokens back).`)
            }
            if (plan.kind === "abandon-branch") {
              store.record(state.treeId, "branch.closed", { sessionID: plan.sessionID, status: "abandoned" }, "server")
              await client.tui.publish({ query: { directory }, body: { type: "tui.session.select", properties: { sessionID: plan.parentSessionID } } as any }).catch(() => undefined)
              return say(output, `left ⎇ ${await branchLabel(plan.sessionID, plan.name)}; parent session is ${plan.parentSessionID}.`)
            }
            if (plan.kind === "reopen-branch") {
              const b = state.sessions[plan.sessionID]!
              store.record(state.treeId, "branch.opened", { sessionID: b.sessionID, parentSessionID: b.parentSessionID, anchorMessageID: b.anchorMessageID, name: b.name, kind: b.kind, branchModel: b.branchModel, trunkModel: b.trunkModel }, "server")
              return say(output, `re-opened ⎇ ${await branchLabel(plan.sessionID, b.name)} (${plan.sessionID}); its decision record is hidden from the model.`)
            }
            return say(output, "nothing to undo on this path.")
          }
          case "decisions": {
            const state = store.stateForSession(sessionID)
            const records = state ? Object.values(state.decisions).filter((d) => d.sessionID === sessionID).sort((a, b) => a.recordedAt - b.recordedAt) : []
            if (cmd.export !== undefined) {
              const file = path.resolve(directory, cmd.export)
              // a hidden record belongs to a re-opened branch: it is not a decision yet
              const written = records.filter((d) => !d.hidden && d.text)
              fs.writeFileSync(file, exportDecisions(written.map((d) => ({ branchName: d.branchName, text: d.text!, sessionID: d.sessionID, at: d.recordedAt }))))
              return say(output, `wrote ${written.length} record(s) → ${file}`)
            }
            if (records.length === 0) return say(output, "no decision records in this session.")
            return say(output, records.map((d) => `${d.hidden ? "◇ (hidden)" : "◆"} ${d.branchName} · ${new Date(d.recordedAt).toISOString().slice(0, 16)}\n${(d.text ?? "").split("\n").slice(1, 6).join("\n")}`).join("\n\n"))
          }
        }
      } catch (e) {
        say(output, `error: ${e instanceof Error ? e.message : String(e)}`)
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const sessionID = output.messages[0]?.info.sessionID
      if (!sessionID) return

      const state = (await journal).stateForSession(sessionID)
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

      const __t0 = performance.now()

      applyCrops(output.messages as unknown as MinimalMessage[], crops)

      debug("transform.applyCrops", { sessionID, messages: output.messages.length, ms: Math.round((performance.now() - __t0) * 100) / 100 })
    },

    // DESIGN.md §6.8: decision records survive compaction verbatim
    "experimental.session.compacting": async ({ sessionID }, output) => {
      const state = (await journal).stateForSession(sessionID)
      if (!state) return
      const records = Object.values(state.decisions)
        .filter((d) => d.sessionID === sessionID && !d.hidden && d.text)
        .sort((a, b) => a.recordedAt - b.recordedAt)
      if (records.length === 0) return
      output.context.push(
        `The conversation contains human-confirmed decision records (marked ◆). Reproduce each of them VERBATIM in the summary under a "## Decisions" heading; never paraphrase them:\n\n${records.map((r) => r.text).join("\n\n")}`,
      )
    },

    // DESIGN.md §6.8: a system note so the model reads ◆ / ✂ markers correctly, and §7.4:
    // this is the one place the plugin can see what the provider is really sent as its system
    // prompt, so it is also where the consumers view gets the bucket it was missing.
    "experimental.chat.system.transform": async ({ sessionID }, output) => {
      if (!sessionID) return
      // Snapshot what OpenCode assembled, BEFORE our own note joins it — the note is ours, and
      // counting it as part of the user's prompt would be a small lie in the one view that
      // exists to say where the context went.
      //
      // Deliberately NOT gated on the session being in a tree, unlike the note below: a session
      // is only registered by a branch/fork/adoption, so gating here would mean a plain session
      // never captured its prompt and the consumers bucket silently never appeared — which is
      // the common case, not the edge one.
      captureSystem(await journal, sessionID, output.system)
      if (!(await journal).stateForSession(sessionID)) return
      output.system.push(
        "Context notes: messages starting with ◆ are decision records confirmed by the user — treat them as settled facts. Tool results reading [cropped: …] or turns reading [dropped turn …] were removed from your context on purpose to save space; if you need one back, ask the user to restore it (they can with /undo in the context tree).",
      )
    },

    "chat.message": async (input, output) => {
      const state = (await journal).stateForSession(input.sessionID)
      if (!state) return

      const branch = state.sessions[input.sessionID]
      if (!branch?.model || branch.status !== "open") return

      const providerID = branch.model.split("/")[0]
      const modelID = branch.model.split("/").slice(1).join("/")
      if (!providerID || !modelID) return

      output.message.model = { providerID, modelID }
    },

    event: async ({ event }) => {
      if (event.type === "session.created") {
        const info = event.properties.info
        if (!info.parentID && parseForkTitle(info.title ?? "")) void adoptSoon()
        return
      }
      if (event.type !== "session.deleted") return
      const sessionID = event.properties.info.id
      const store = await journal
      const treeId = store.treeIdFor(sessionID)
      if (!treeId) return

      store.record(treeId, "session.forgotten", { sessionID }, "server")
    },
  }
}

export default { id: "opencode-context-tree", server }
