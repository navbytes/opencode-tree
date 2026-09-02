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

/** Serialise the branch's own messages (after its anchor) for the drafting model. */
export function branchTranscriptText(transcript: Transcript, anchorIndex: number, toolChars = 2000): string {
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
  return `# Decisions\n\n${records.map((r) => r.text.replace(/^◆ /, "")).join("\n\n---\n\n")}\n`
}
