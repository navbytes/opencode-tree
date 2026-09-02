/**
 * Deterministic fixture: a trunk with 3 turns, one squashed branch and one open
 * branch both anchored at trunk turn 2's last assistant message (the "last shared
 * message"), the open branch having 2 turns of its own. Message IDs differ between
 * the trunk and the copies, as `session.fork` really does.
 */
import { foldJournal, type JournalEntry, type TreeState } from "../../src/core/journal.js"
import type { Transcript, TranscriptMessage } from "../../src/core/transcript.js"

let t = 1_700_000_000_000
const tick = () => (t += 1000)

export function user(id: string, text: string): TranscriptMessage {
  return { id, role: "user", time: { created: tick() }, parts: [{ id: `${id}-p0`, type: "text", text }] }
}
export function assistant(id: string, opts: { text?: string; tool?: { name: string; input: unknown; output: string; ms?: number }; input?: number; output?: number }): TranscriptMessage {
  const parts: TranscriptMessage["parts"] = [{ id: `${id}-ss`, type: "step-start" }]
  if (opts.tool) {
    const start = tick()
    parts.push({ id: `${id}-tool`, type: "tool", tool: opts.tool.name, callID: `call-${id}`, state: { status: "completed", input: opts.tool.input, output: opts.tool.output, title: opts.tool.name, time: { start, end: start + (opts.tool.ms ?? 21) } } })
  }
  if (opts.text) parts.push({ id: `${id}-text`, type: "text", text: opts.text })
  parts.push({ id: `${id}-sf`, type: "step-finish" })
  return { id, role: "assistant", time: { created: tick() }, tokens: { input: opts.input ?? 1000, output: opts.output ?? 50, reasoning: 0, cache: { read: 0, write: 0 } }, parts }
}

/** Copy a prefix the way `session.fork` does: same content, fresh IDs. */
export function copyPrefix(messages: TranscriptMessage[], prefix: string): TranscriptMessage[] {
  return messages.map((m) => ({ ...m, id: `${prefix}-${m.id}`, parts: m.parts.map((p) => ({ ...p, id: `${prefix}-${p.id}` })) }))
}

export const TRUNK = "ses_trunk"
export const OPEN = "ses_open"
export const SQUASHED = "ses_squashed"

export function buildFixture(): { state: TreeState; transcripts: Record<string, Transcript>; anchor: string } {
  const trunk: TranscriptMessage[] = [
    user("m1", "Build yourself a tool that reads the context window"),
    assistant("a1", { text: "I'll start by understanding my env", tool: { name: "bash", input: { command: "ls -la ~/Documents/" }, output: "total 744\n" + "x".repeat(8000) }, input: 1200, output: 80 }),
    user("m2", "decompress the session and inspect it"),
    assistant("a2", { text: "Key findings: DSH_HOME=...", input: 2400, output: 60 }),
    user("m3", "now make it pass on CI"),
    assistant("a3", { text: "Done.", input: 3000, output: 10 }),
  ]
  const anchor = "a2" // last shared message: trunk turn 2's assistant reply
  const shared = trunk.slice(0, 4)
  const openMsgs: TranscriptMessage[] = [
    ...copyPrefix(shared, "o"),
    user("om1", "the test flakes on CI only"),
    assistant("oa1", { tool: { name: "bash", input: { command: "bun test src/foo.test.ts" }, output: "3 failed\n" + "y".repeat(20000), ms: 4200 }, text: "The failures share a timing assumption", input: 5000, output: 90 }),
    user("om2", "fix the timing assumption"),
    assistant("oa2", { text: "Patched.", input: 6000, output: 12 }),
  ]
  const squashedMsgs: TranscriptMessage[] = [...copyPrefix(shared, "s"), user("sm1", "try redis instead"), assistant("sa1", { text: "Redis is overkill here.", input: 4000, output: 30 })]

  const entries: JournalEntry[] = [
    { v: 1, id: "e1", ts: 1, type: "tree.created", actor: "tui", data: { rootSessionID: TRUNK } },
    { v: 1, id: "e2", ts: 2, type: "branch.opened", actor: "tui", data: { sessionID: SQUASHED, parentSessionID: TRUNK, anchorMessageID: anchor, name: "try-redis", kind: "explicit" } },
    { v: 1, id: "e3", ts: 3, type: "branch.opened", actor: "tui", data: { sessionID: OPEN, parentSessionID: TRUNK, anchorMessageID: anchor, name: "fix-flaky-test", kind: "explicit", branchModel: "mock/mock-b" } },
    { v: 1, id: "e4", ts: 4, type: "branch.closed", actor: "tui", data: { sessionID: SQUASHED, status: "squashed" } },
  ]
  const state = foldJournal(entries, "t_fixture")
  const transcripts: Record<string, Transcript> = {
    [TRUNK]: { sessionID: TRUNK, title: "Fix flaky test", status: "available", messages: trunk },
    [OPEN]: { sessionID: OPEN, title: "⎇ fix-flaky-test", status: "available", messages: openMsgs },
    [SQUASHED]: { sessionID: SQUASHED, title: "⎇ try-redis", status: "available", messages: squashedMsgs },
  }
  return { state, transcripts, anchor }
}

export const EARLY = "ses_early"
export const LATE = "ses_late"

/**
 * The same trunk with two branches forked at *different* points: `early` at a2 and
 * `late` at a3. Viewed from `early`, neither `late` nor the trunk's own tail (m3/a3)
 * is on the rendered path — they only appear in the "elsewhere" group.
 */
export function buildOffPathFixture(): { state: TreeState; transcripts: Record<string, Transcript> } {
  const trunk = buildFixture().transcripts[TRUNK]!.messages
  const earlyMsgs: TranscriptMessage[] = [...copyPrefix(trunk.slice(0, 4), "e"), user("em1", "try the early idea"), assistant("ea1", { text: "Early idea done.", input: 2600, output: 20 })]
  const lateMsgs: TranscriptMessage[] = [...copyPrefix(trunk.slice(0, 6), "l"), user("lm1", "try the late idea"), assistant("la1", { text: "Late idea done.", input: 3200, output: 20 })]

  const entries: JournalEntry[] = [
    { v: 1, id: "e1", ts: 1, type: "tree.created", actor: "tui", data: { rootSessionID: TRUNK } },
    { v: 1, id: "e2", ts: 2, type: "branch.opened", actor: "tui", data: { sessionID: EARLY, parentSessionID: TRUNK, anchorMessageID: "a2", name: "early", kind: "explicit" } },
    { v: 1, id: "e3", ts: 3, type: "branch.opened", actor: "tui", data: { sessionID: LATE, parentSessionID: TRUNK, anchorMessageID: "a3", name: "late", kind: "explicit" } },
  ]
  return {
    state: foldJournal(entries, "t_offpath"),
    transcripts: {
      [TRUNK]: { sessionID: TRUNK, title: "Fix flaky test", status: "available", messages: trunk },
      [EARLY]: { sessionID: EARLY, title: "⎇ early", status: "available", messages: earlyMsgs },
      [LATE]: { sessionID: LATE, title: "⎇ late", status: "available", messages: lateMsgs },
    },
  }
}
