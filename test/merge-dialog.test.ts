import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { COPY_HINT, TRUNK_LABEL, copyText, mergeDialogOptions, mergeDialogTitle, mergeTargetOf, ownTurnCount } from "../src/tui/actions.js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { TranscriptMessage } from "../src/core/transcript.js"

const msg = (role: "user" | "assistant", text: string, tokens?: number): TranscriptMessage => ({
  id: `${role}-${text.slice(0, 4)}`,
  role,
  time: { created: 0 },
  tokens: tokens === undefined ? undefined : { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  parts: [{ id: `p-${text.slice(0, 4)}`, type: "text", text }],
})

describe("mergeDialogTitle", () => {
  test("names the trunk, with the destination's own turns and tokens", () => {
    const target = mergeTargetOf(TRUNK_LABEL, [msg("user", "a"), msg("assistant", "b", 12_000), msg("user", "c")])
    expect(mergeDialogTitle("try-redis", target)).toBe("Merge ⎇ try-redis → trunk (2 turns, ~12k)")
  })
  test("a nested parent keeps its branch glyph and singular turn", () => {
    expect(mergeDialogTitle("try-redis", { label: "cache-spike", turns: 1, tokens: 800 })).toBe("Merge ⎇ try-redis → ⎇ cache-spike (1 turn, ~800)")
  })
  test("no target (or the old bare-title call) never quotes a session title", () => {
    expect(mergeDialogTitle("try-redis")).toBe("Merge ⎇ try-redis → the trunk")
    expect(mergeDialogTitle("try-redis", "What does git rebase do?")).toBe("Merge ⎇ try-redis → the trunk")
  })
})

describe("ownTurnCount", () => {
  test("counts only the turns past the anchor — the shared prefix is not folded", () => {
    const messages = [msg("user", "shared"), msg("assistant", "reply"), msg("user", "own")]
    expect(ownTurnCount(messages, { messageID: "assistant-repl", parentMessageIDs: ["user-shar", "assistant-repl"] })).toBe(1)
    expect(ownTurnCount(messages, { parentMessageIDs: [] })).toBe(2)
  })
})

describe("copyText", () => {
  test("prefers the terminal clipboard, falls back to the file, never copies nothing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ctree-copy-"))
    const apiWith = { renderer: { copyToClipboardOSC52: () => true } } as unknown as TuiPluginApi
    const apiWithout = { renderer: {} } as unknown as TuiPluginApi
    try {
      expect(copyText(apiWith, "hello", dir)).toEqual({ target: "clipboard", hint: "clipboard" })
      expect(copyText(apiWithout, "hello", dir)).toEqual({ target: "file", hint: COPY_HINT })
      expect(readFileSync(path.join(dir, COPY_HINT), "utf8")).toBe("hello")
      expect(copyText(apiWith, "", dir).target).toBe("file")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("mergeDialogOptions", () => {
  test("subtitles state the consequence; tournament needs a sibling", () => {
    const opts = mergeDialogOptions({ siblings: 0, turns: 4 })
    expect(opts.map((o) => o.value)).toEqual(["squash", "squash-no-llm", "discard"])
    expect(opts[0]!.description).toBe("1 model call · folds 4 turns into one ◆ record")
    expect(opts[1]!.description).toBe("you write it · no model call")
    expect(opts[2]!.description).toBe("rejected · nothing lands in the trunk")
    expect(mergeDialogOptions({ siblings: 1, turns: 1 })[3]!.value).toBe("tournament")
    expect(mergeDialogOptions({ siblings: 0 })[0]!.description).toBe("1 model call · folds the branch into one ◆ record")
  })
})
