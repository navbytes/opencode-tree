import { describe, expect, test } from "bun:test"
import { mergeTranscripts } from "../src/tui/transcripts.js"
import type { Transcript, TranscriptMessage } from "../src/core/transcript.js"

const msg = (id: string, text: string): TranscriptMessage => ({
  id,
  role: id.startsWith("u") ? "user" : "assistant",
  time: { created: Number(id.slice(1)) },
  parts: [{ id: `${id}-p`, type: "text", text }],
})

const tr = (messages: TranscriptMessage[]): Transcript => ({ sessionID: "s", title: "t", status: "available", messages })

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
