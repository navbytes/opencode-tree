import { describe, expect, test } from "bun:test"
import { mergeTranscripts, toTranscriptMessage } from "../src/tui/transcripts.js"
import type { Transcript, TranscriptMessage } from "../src/core/transcript.js"

const msg = (id: string, text: string): TranscriptMessage => ({
  id,
  role: id.startsWith("u") ? "user" : "assistant",
  time: { created: Number(id.slice(1)) },
  parts: [{ id: `${id}-p`, type: "text", text }],
})

const tr = (messages: TranscriptMessage[]): Transcript => ({ sessionID: "s", title: "t", status: "available", messages })

describe("toTranscriptMessage", () => {
  const base = { id: "a1", role: "assistant", time: { created: 1 } }

  test("carries providerID/modelID as model on an assistant message", () => {
    const m = toTranscriptMessage({ ...base, providerID: "anthropic", modelID: "claude-sonnet-5" }, [])
    expect(m.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-5" })
  })

  test("no model on a user message, even if the fields are somehow present", () => {
    const m = toTranscriptMessage({ id: "u1", role: "user", time: { created: 1 }, providerID: "anthropic", modelID: "claude-sonnet-5" }, [])
    expect(m.model).toBeUndefined()
  })

  test("missing either field: no model, not a half-filled one", () => {
    expect(toTranscriptMessage({ ...base, providerID: "anthropic" }, []).model).toBeUndefined()
    expect(toTranscriptMessage({ ...base, modelID: "claude-sonnet-5" }, []).model).toBeUndefined()
    expect(toTranscriptMessage(base, []).model).toBeUndefined()
  })
})

describe("mergeTranscripts", () => {
  const full = tr([msg("u1", "one"), msg("a2", "two"), msg("u3", "three")])

  test("the SDK history supplies messages the live window has dropped", () => {
    const merged = mergeTranscripts(full, tr([msg("u3", "three")]))
    expect(merged.messages.map((m) => m.id)).toEqual(["u1", "a2", "u3"])
  })

  test("a message in both takes the live version (streaming updates)", () => {
    const merged = mergeTranscripts(full, tr([msg("u3", "three, still typing…")]))
    expect(merged.messages.at(-1)!.parts[0]!.text).toBe("three, still typing…")
  })

  test("messages newer than the fetch are appended", () => {
    const merged = mergeTranscripts(full, tr([msg("u3", "three"), msg("a4", "four")]))
    expect(merged.messages.map((m) => m.id)).toEqual(["u1", "a2", "u3", "a4"])
  })

  test("no fetch yet, or a stale one, leaves the live transcript alone", () => {
    const live = tr([msg("u1", "one"), msg("a2", "two"), msg("u3", "three"), msg("a4", "four")])
    expect(mergeTranscripts(undefined, live)).toBe(live)
    expect(mergeTranscripts(full, live)).toBe(live)
  })
})
