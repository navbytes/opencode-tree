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

/** One-shot transcript of any session through the SDK. `limit` returns the *last* N and the
 *  `before` cursor is opaque (raw ids are rejected), so the whole session is fetched at once. */
export async function fetchTranscript(api: TuiPluginApi, sessionID: string, directory: string): Promise<Transcript> {
  const session = await api.client.session.get({ sessionID, directory }).catch(() => undefined)
  if (!session?.data) return { sessionID, title: sessionID, status: "deleted", messages: [] }
  const res = await api.client.session.messages({ sessionID, directory })
  const messages = ((res.data as unknown as { info: AnyMessage; parts: AnyPart[] }[] | undefined) ?? []).map((m) => toTranscriptMessage(m.info, m.parts))
  return { sessionID, title: (session.data as { title?: string }).title ?? sessionID, status: "available", messages }
}

/** Context window of the model that answered last, for the gauge and the Input lane scale. */
export function modelContextLimit(api: TuiPluginApi, sessionID: string): number | undefined {
  const last = [...(api.state.session.messages(sessionID) as unknown as { role: string; providerID?: string; modelID?: string }[])].reverse().find((m) => m.role === "assistant")
  if (!last?.providerID || !last.modelID) return undefined
  const provider = api.state.provider.find((p) => p.id === last.providerID)
  const model = provider?.models[last.modelID] as { limit?: { context?: number } } | undefined
  return model?.limit?.context
}
