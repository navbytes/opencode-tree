/**
 * Adapters from OpenCode's live message/part shapes (api.state, SDK) to core's
 * `Transcript`, plus a small async loader for sessions other than the current one.
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { StepPart, Transcript, TranscriptMessage } from "../core/transcript.js"

type AnyMessage = { id: string; role: string; time: { created: number; completed?: number }; tokens?: TranscriptMessage["tokens"]; summary?: unknown }
type AnyPart = { id: string; type: string; text?: string; tool?: string; callID?: string; state?: StepPart["state"]; time?: StepPart["time"]; metadata?: Record<string, unknown> }

export function toStepPart(p: AnyPart): StepPart {
  return { id: p.id, type: p.type, text: p.text, tool: p.tool, callID: p.callID, state: p.state, time: p.time, metadata: p.metadata }
}

export function toTranscriptMessage(m: AnyMessage, parts: readonly AnyPart[]): TranscriptMessage {
  return {
    id: m.id,
    role: m.role === "user" ? "user" : "assistant",
    time: m.time,
    tokens: m.tokens,
    summary: m.role === "assistant" && m.summary === true ? true : undefined,
    parts: parts.map(toStepPart),
  }
}

/** Reactive transcript of the session the TUI has loaded (api.state is a Solid store). */
export function liveTranscript(api: TuiPluginApi, sessionID: string): Transcript {
  const messages = api.state.session.messages(sessionID) as unknown as readonly AnyMessage[]
  const title = api.state.session.get(sessionID)?.title ?? sessionID
  return {
    sessionID,
    title,
    status: "available",
    messages: messages.map((m) => toTranscriptMessage(m, api.state.part(m.id) as unknown as readonly AnyPart[])),
  }
}

/** One-shot transcript of any session through the SDK (paged). */
export async function fetchTranscript(api: TuiPluginApi, sessionID: string, directory: string): Promise<Transcript> {
  const session = await api.client.session.get({ sessionID, directory }).catch(() => undefined)
  if (!session?.data) return { sessionID, title: sessionID, status: "deleted", messages: [] }
  const all: TranscriptMessage[] = []
  let before: string | undefined
  for (let page = 0; page < 50; page++) {
    const res = await api.client.session.messages({ sessionID, directory, limit: 200, before })
    const items = ((res.data as unknown as { info: AnyMessage; parts: AnyPart[] }[] | undefined) ?? []).map((m) => toTranscriptMessage(m.info, m.parts))
    if (items.length === 0) break
    all.unshift(...items)
    if (items.length < 200) break
    before = items[0]!.id
  }
  return { sessionID, title: (session.data as { title?: string }).title ?? sessionID, status: "available", messages: all }
}
