import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { COPY_HINT, TRUNK_LABEL, copyText, lastAnsweringModel, mergeBranch, mergeDialogOptions, mergeDialogTitle, mergeTargetOf, ownTurnCount } from "../src/tui/actions.js"
import { templatePlaceholders } from "../src/core/decision.js"
import { JournalStore } from "../src/shared/store.js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { TranscriptMessage } from "../src/core/transcript.js"

const msg = (role: "user" | "assistant", text: string, tokens?: number): TranscriptMessage => ({
  id: `${role}-${text.slice(0, 4)}`,
  role,
  time: { created: 0 },
  tokens: tokens === undefined ? undefined : { input: tokens - 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
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
  test("the branch's own turns are named as its own, so neither count reads as the other", () => {
    const messages = [msg("user", "a"), msg("assistant", "b", 12_000), msg("user", "c")]
    expect(mergeDialogTitle("try-redis", mergeTargetOf(TRUNK_LABEL, messages), 2)).toBe("Merge ⎇ try-redis (2 turns) → trunk (2 turns, ~12k)")
    expect(mergeDialogTitle("try-redis", undefined, 1)).toBe("Merge ⎇ try-redis (1 turn) → the trunk")
  })
  test("a nested destination is measured past its own anchor, like its tree row", () => {
    // the parent branch inherited "shared" from the trunk; only "own" is its own turn
    const parent = [msg("user", "shared"), msg("assistant", "reply", 900), msg("user", "own")]
    const anchored = mergeTargetOf("cache-spike", parent, { messageID: "assistant-repl", parentMessageIDs: ["user-shar", "assistant-repl"] })
    expect(anchored.turns).toBe(1)
    expect(mergeTargetOf("cache-spike", parent).turns).toBe(2) // no anchor: the trunk counts all of them
    expect(anchored.tokens).toBe(mergeTargetOf("cache-spike", parent).tokens) // the destination still costs what it costs
  })
})

describe("lastAnsweringModel", () => {
  test("the model that answered last, never a record that says unknown", () => {
    expect(
      lastAnsweringModel([
        { role: "user" },
        { role: "assistant", providerID: "mock", modelID: "mock-a" },
        { role: "assistant", providerID: "mock", modelID: "mock-b" },
        { role: "user" },
      ]),
    ).toBe("mock/mock-b")
    expect(lastAnsweringModel([{ role: "user" }, { role: "assistant" }])).toBeUndefined()
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

// --- the merge gate, driven through the real mergeBranch --------------------

const PARENT = "ses_parent"
const BRANCH = "ses_branch"

const sdkMessage = (id: string, role: "user" | "assistant", text: string, model?: string) => ({
  info: { id, role, time: { created: 0 }, ...(model ? { providerID: model.split("/")[0], modelID: model.split("/")[1] } : {}) },
  parts: [{ id: `p_${id}`, type: "text", text }],
})

/** A branch with one own turn past the anchor, answered by mock/mock-b, and no journal name. */
function fakeMerge(answers: (string | undefined)[] = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "ctree-merge-"))
  const store = new JournalStore({ worktree: dir })
  const treeId = store.ensureTree(PARENT, "tui")
  store.registerSession(BRANCH, treeId)
  store.record(treeId, "branch.opened", { sessionID: BRANCH, parentSessionID: PARENT, anchorMessageID: "m_p2", kind: "native" }, "tui")
  const messages: Record<string, unknown[]> = {
    [PARENT]: [sdkMessage("m_p1", "user", "trunk turn"), sdkMessage("m_p2", "assistant", "trunk reply", "mock/mock-a")],
    [BRANCH]: [sdkMessage("m_b1", "user", "trunk turn"), sdkMessage("m_b2", "assistant", "trunk reply", "mock/mock-a"), sdkMessage("m_b3", "user", "try redis"), sdkMessage("m_b4", "assistant", "no, keep it in memory", "mock/mock-b")],
  }
  const toasts: string[] = []
  const landed: { text: string }[] = []
  const api = {
    client: {
      session: {
        get: async () => ({ data: { metadata: {} } }),
        update: async () => ({ data: {} }),
        messages: async ({ sessionID }: { sessionID: string }) => ({ data: messages[sessionID] ?? [] }),
        prompt: async (p: { parts: { text: string }[] }) => {
          landed.push({ text: p.parts[0]!.text })
          return { data: { info: { id: "m_landed" } } }
        },
      },
    },
    state: { session: { status: () => undefined, get: () => ({ title: "⎇ try-redis (fork #1)" }), messages: () => [] } },
    ui: {
      toast: (t: { message: string }) => toasts.push(t.message),
      dialog: { replace: (factory: () => unknown) => factory(), clear: () => {} },
      DialogPrompt: (props: { onConfirm?: (v: string) => void; onCancel?: () => void }) => {
        const answer = answers.shift()
        if (answer === undefined) props.onCancel?.()
        else props.onConfirm?.(answer)
        return null
      },
    },
    route: { navigate: () => {} },
    renderer: {},
  } as unknown as TuiPluginApi
  return { ctx: { api, store, directory: dir }, toasts, landed, treeId, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** `hasEditor()` reads the environment, and the gate branches on it. */
async function withEditor(present: boolean, fn: () => Promise<void>): Promise<void> {
  const before = { VISUAL: process.env["VISUAL"], EDITOR: process.env["EDITOR"] }
  if (present) process.env["EDITOR"] = "true"
  else {
    delete process.env["VISUAL"]
    delete process.env["EDITOR"]
  }
  try {
    await fn()
  } finally {
    for (const [k, v] of Object.entries(before)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
}

describe("mergeBranch: squash without an LLM", () => {
  test("an unfilled template is refused: nothing lands and the branch stays open", async () => {
    const f = fakeMerge()
    try {
      await withEditor(true, async () => {
        const result = await mergeBranch(f.ctx, { sessionID: BRANCH, mode: "squash-no-llm", confirm: async (draft) => draft })
        expect(result).toBeUndefined()
      })
      expect(f.landed).toEqual([])
      expect(f.toasts.at(-1)).toBe("record not written: fill in the template")
      expect(f.ctx.store.stateFor(f.treeId).sessions[BRANCH]!.status).toBe("open")
    } finally {
      f.cleanup()
    }
  })

  test("with no $EDITOR the fields are asked one dialog at a time, and Esc aborts", async () => {
    const filled = fakeMerge(["Kept the in-memory cache.", "the set is small; CI stays fast"])
    const escaped = fakeMerge([undefined])
    try {
      await withEditor(false, async () => {
        expect(await mergeBranch(filled.ctx, { sessionID: BRANCH, mode: "squash-no-llm" })).toBe(PARENT)
        expect(await mergeBranch(escaped.ctx, { sessionID: BRANCH, mode: "squash-no-llm" })).toBeUndefined()
      })
      const text = filled.landed[0]!.text
      expect(text).toContain("**Outcome:** Kept the in-memory cache.")
      expect(text).toContain("- CI stays fast")
      expect(templatePlaceholders(text)).toEqual([])
      // no journal name (an adopted fork) and no journal model: the title and the model that answered stand in
      expect(text).toContain("## Decision: ⎇ try-redis (fork #1)")
      expect(text).toContain("**Model:** mock/mock-b")
      expect(text).not.toContain("unknown")
      expect(filled.ctx.store.stateFor(filled.treeId).sessions[BRANCH]!.status).toBe("squashed")

      expect(escaped.landed).toEqual([])
      expect(escaped.toasts.at(-1)).toBe("merge aborted — nothing written")
      expect(escaped.ctx.store.stateFor(escaped.treeId).sessions[BRANCH]!.status).toBe("open")
    } finally {
      filled.cleanup()
      escaped.cleanup()
    }
  })

  test("the typed path never opens the caller's accept-drafted dialog, and still refuses placeholder text", async () => {
    // route.tsx/index.tsx always pass a `confirm` (their "Accept the drafted record as-is?"
    // dialog) whenever there's no $EDITOR — this stands in for it, so a call means the gate reopened
    let confirmCalls = 0
    const spyConfirm = async (draft: string) => {
      confirmCalls++
      return draft
    }
    const filled = fakeMerge(["Kept the in-memory cache.", "the set is small; CI stays fast"])
    const placeholder = fakeMerge(["<traps found on the way>", ""])
    try {
      await withEditor(false, async () => {
        expect(await mergeBranch(filled.ctx, { sessionID: BRANCH, mode: "squash-no-llm", confirm: spyConfirm })).toBe(PARENT)
        expect(confirmCalls).toBe(0)
        expect(filled.landed).toHaveLength(1)
        expect(filled.ctx.store.stateFor(filled.treeId).sessions[BRANCH]!.status).toBe("squashed")

        expect(await mergeBranch(placeholder.ctx, { sessionID: BRANCH, mode: "squash-no-llm", confirm: spyConfirm })).toBeUndefined()
        expect(confirmCalls).toBe(0)
        expect(placeholder.landed).toEqual([])
        expect(placeholder.toasts.at(-1)).toBe("record not written: fill in the template")
        expect(placeholder.ctx.store.stateFor(placeholder.treeId).sessions[BRANCH]!.status).toBe("open")
      })
    } finally {
      filled.cleanup()
      placeholder.cleanup()
    }
  })
})
