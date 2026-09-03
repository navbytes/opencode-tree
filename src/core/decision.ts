/**
 * Decision records (DESIGN.md §6.4, template from pi-context-tree spec §6).
 * Pure: prompt/template builders and transcript serialisation for the merge draft.
 */
import type { TreeState } from "./journal.js"
import type { Transcript, TranscriptMessage } from "./transcript.js"

export const DECISION_SYSTEM =
  "You write concise engineering decision records. You are given the transcript of a side branch of a coding session. Do NOT continue the conversation. Output ONLY the record in the exact markdown template requested, nothing else."

export function decisionTemplate(branchName: string, model?: string, date = new Date()): string {
  return `## Decision: ${branchName}
**Date:** ${date.toISOString().slice(0, 10)} · **Model:** ${model ?? "unknown"} · **Branch:** ${branchName}
**Outcome:** <1–3 sentences: what was concluded / built>
**Why:** 
- <≤5 bullets>
**Assumptions:** <taken as true but not verified — the trunk must know these>
**Changes:** <files touched, or "none">
**Gotchas:** <traps found on the way>
**Open questions:** <what is still unknown>
**Confidence / revisit-if:** <high|medium|low; what would change the decision>

### Rejected alternatives
- **<name>:** <one-line reason>
`
}

/**
 * Serialise the branch's own messages (after its anchor) for the drafting model.
 * The anchor id lives in the *parent* (fork copies the shared prefix with fresh ids), so
 * it is resolved against `parentMessageIDs` and applied positionally. Omitting
 * `messageID` asks for the whole transcript; an id the parent no longer has is an error,
 * never a silent "include the shared prefix too".
 */
export function branchTranscriptText(transcript: Transcript, anchor: { messageID?: string; parentMessageIDs: string[] }, toolChars = 2000): string {
  let anchorIndex = -1
  if (anchor.messageID) {
    anchorIndex = anchor.parentMessageIDs.indexOf(anchor.messageID)
    if (anchorIndex === -1) throw new Error(`anchor message ${anchor.messageID} is no longer in the parent session — cannot tell this branch's own turns from the shared prefix`)
  }
  const msgs = transcript.messages.slice(anchorIndex + 1)
  return msgs
    .map((m) => messageText(m, toolChars))
    .filter(Boolean)
    .join("\n\n")
}

function messageText(m: TranscriptMessage, toolChars: number): string {
  const role = m.role === "user" ? "[User]" : "[Assistant]"
  const body = m.parts
    .map((p) => {
      if (p.type === "text") return p.text ?? ""
      if (p.type === "tool") {
        const input = JSON.stringify(p.state?.input ?? {}).slice(0, 300)
        const output = String(p.state?.output ?? "")
        return `(tool ${p.tool ?? "?"} ${input} → ${output.length > toolChars ? `${output.slice(0, toolChars)}… [${output.length - toolChars} more chars]` : output})`
      }
      return ""
    })
    .filter(Boolean)
    .join("\n")
  return body ? `${role}: ${body}` : ""
}

export function buildDecisionDraftPrompt(input: { branchName: string; model?: string; transcript: string; siblings?: { name: string; transcript: string }[] }): string {
  const siblings = input.siblings?.length
    ? `\n\nThe following sibling branches explored alternatives that LOST to this one. Add one line each under "Rejected alternatives" — an epitaph that stops the trunk model from proposing them again:\n${input.siblings.map((s) => `\n<sibling name="${s.name}">\n${s.transcript}\n</sibling>`).join("\n")}`
    : ""
  return `<branch name="${input.branchName}">\n${input.transcript}\n</branch>${siblings}\n\nFill in this template exactly (keep the headings, replace every <placeholder>, drop bullets you cannot fill, target 300–800 words, preserve exact file paths, function names and error messages):\n\n${decisionTemplate(input.branchName, input.model)}`
}

/** The text that lands in the trunk: a ◆ header the user can scan plus the record body. */
export function decisionMessageText(record: string, branchName: string): string {
  const body = record.trim()
  return body.startsWith("## Decision:") ? `◆ ${body}` : `◆ ## Decision: ${branchName}\n${body}`
}

// ---------------------------------------------------------------------------
// Rendering a record in the TUI (DESIGN.md §7.4's ◆ cards).
// ---------------------------------------------------------------------------

const BULLET = /^(\s*)[-*•]\s+/
/** the `◆` a landed record carries survives; the `#` markers do not */
const HEADING = /^(\s*(?:◆\s*)?)#{1,6}\s*/

/** Markdown emphasis is noise in a terminal; bullets and blank lines are structure. */
function stripMarkdown(text: string): string {
  return text.replace(/[*`]/g, "")
}

function wrapLine(body: string, width: number, marker: string): string[] {
  const room = Math.max(1, width - marker.length)
  const indent = " ".repeat(marker.length)
  const lines: string[] = []
  let current = ""
  for (const raw of body.split(/\s+/).filter(Boolean)) {
    // the only mid-word cut: one token that cannot fit on a line of its own
    const word = raw.length > room ? `${raw.slice(0, Math.max(1, room - 1))}…` : raw
    if (current === "") current = word
    else if (current.length + 1 + word.length <= room) current += ` ${word}`
    else {
      lines.push(current)
      current = word
    }
  }
  lines.push(current)
  return lines.map((line, i) => `${i === 0 ? marker : indent}${line}`.trimEnd())
}

/** A decision record as terminal lines: emphasis and heading markers gone, list bullets and
 *  paragraph breaks kept, every line word-wrapped to `width` with a hanging indent. */
export function renderDecision(text: string, width: number): string[] {
  const out: string[] = []
  for (const raw of text.replace(/\r/g, "").trim().split("\n")) {
    const line = raw.trimEnd()
    if (line.trim() === "") {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("")
      continue
    }
    const bullet = BULLET.exec(line)
    const marker = bullet ? `${bullet[1]}- ` : ""
    const body = stripMarkdown(bullet ? line.slice(bullet[0].length) : line.replace(HEADING, "$1"))
    out.push(...wrapLine(body, width, marker))
  }
  return out
}

/** The one-line form of a record: its `## Decision: <name>` title and `Outcome:` line. */
export function decisionSummary(text: string): { title: string; outcome?: string } {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => stripMarkdown(l.replace(/^\s*◆\s*/, "").replace(HEADING, "$1").replace(BULLET, "")).trim())
  const heading = lines.find((l) => /^Decision:\s*\S/i.test(l))
  const title = heading ? heading.replace(/^Decision:\s*/i, "").trim() : (lines.find((l) => l !== "") ?? "")
  const outcome = lines.find((l) => /^Outcome:\s*\S/i.test(l))?.replace(/^Outcome:\s*/i, "").trim()
  return outcome ? { title, outcome } : { title }
}

/** Open sibling branches forked from the same point (tournament, DESIGN.md §6.4). */
export function openSiblings(state: TreeState, sessionID: string): string[] {
  const me = state.sessions[sessionID]
  if (!me) return []
  return Object.values(state.sessions)
    .filter((b) => b.sessionID !== sessionID && b.status === "open" && b.parentSessionID === me.parentSessionID && b.anchorMessageID === me.anchorMessageID)
    .map((b) => b.sessionID)
}

/** Markdown export of every decision on a session's path (`/decisions --export`). */
export function exportDecisions(records: { branchName: string; text: string; sessionID: string; at?: number }[]): string {
  if (records.length === 0) return "# Decisions\n\n_(none yet)_\n"
  const one = (r: { branchName: string; text: string; sessionID: string; at?: number }) => {
    const when = r.at ? new Date(r.at).toISOString() : "date unknown"
    // the heading already names the branch, so the record's own "## Decision: <name>" goes
    const body = r.text.replace(/^◆ /, "").replace(/^## Decision:[^\n]*\n?/, "").trim()
    return `## ⎇ ${r.branchName} · ${when}\n_session ${r.sessionID}_\n\n${body}`
  }
  return `# Decisions\n\n${records.map(one).join("\n\n---\n\n")}\n`
}
