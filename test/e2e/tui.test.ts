/**
 * TUI e2e: boots the real opencode TUI in a pty with the *built* plugin (dist/tui.js
 * + dist/server.js) and drives `/tree`. Gated by CTREE_E2E=1.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { createProject, installPlugins, REPO_ROOT, runTui, runTuiScreens, startMock, type StartedMock } from "./harness.js"

const e2e = process.env["CTREE_E2E"] === "1"

describe.skipIf(!e2e)("tui e2e: built plugin", () => {
  let mock: StartedMock
  let project: Awaited<ReturnType<typeof createProject>>

  beforeAll(async () => {
    const build = Bun.spawnSync({ cmd: ["bun", "run", "scripts/build.ts"], cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] })
    if (build.exitCode !== 0) throw new Error(`build failed: ${build.stderr.toString()}`)
    mock = await startMock({ tool: false })
    project = await createProject({ mockPort: mock.port })
    await installPlugins({
      projectDir: project.dir,
      server: [path.join(REPO_ROOT, "dist", "server.js")],
      tui: [path.join(REPO_ROOT, "dist", "tui.js")],
    })
  })

  afterAll(async () => {
    await mock?.stop()
    await project?.cleanup()
  })

  test("crop in the tree hides a tool result from the model; undo restores it", async () => {
    const toolMock = await startMock({ tool: true })
    const proj = await createProject({ mockPort: toolMock.port })
    await installPlugins({ projectDir: proj.dir, server: [path.join(REPO_ROOT, "dist", "server.js")], tui: [path.join(REPO_ROOT, "dist", "tui.js")] })
    try {
      await runTui({
        projectDir: proj.dir,
        keys: [
          ["Ask anything", 1, "run the tool\\r"],
          ["mock reply", 2, "second\\r"],
          ["mock reply", 8, "/tree"],
          ["Context tree", 0.5, "\\r"],
          ["Context tree ·", 2, "c"],
          ["crop mode", 1, "gg"],
          ["crop mode", 2, "j"],
          ["crop mode", 3, " "],
          ["crop mode", 4.5, " "],
          ["crop mode", 6, "\\r"],
          ["Crop 1 result", 1.5, "\\r"],
          ["Crop 1 result", 4, "q"],
          ["Crop 1 result", 6, "third\\r"],
          ["Crop 1 result", 16, "/tree"],
          ["Crop 1 result", 17, "\\r"],
          ["Crop 1 result", 20, "x"],
          ["Undo?", 1.5, "\\r"],
          ["Undo?", 4, "q"],
          ["Undo?", 6, "fourth\\r"],
          ["Undo?", 16, "\\x03"],
          ["Undo?", 17, "\\x03"],
        ],
        timeoutSec: 200,
        cols: 130,
        rows: 34,
        exitWhenDone: true,
      })
      const reqs = toolMock.requests()
      const toolMsgs = reqs.map((r) => (r.body.messages as { role: string; content: unknown }[]).filter((m) => m.role === "tool").map((m) => String(m.content)))
      const third = toolMsgs.find((t) => t.some((c) => c.startsWith("[cropped: bash")))
      expect(third).toBeDefined()
      const last = toolMsgs[toolMsgs.length - 1]!
      expect(last.some((c) => c.startsWith("mock-tool-output"))).toBe(true)
      const journal = readdirSync(path.join(proj.dir, ".opencode", "context-tree")).filter((f) => f.endsWith(".jsonl"))
      const lines = readFileSync(path.join(proj.dir, ".opencode", "context-tree", journal[0]!), "utf8")
      expect(lines).toContain('"type":"crop.applied"')
      expect(lines).toContain('"type":"crop.restored"')
    } finally {
      await toolMock.stop()
      await proj.cleanup()
    }
  }, 300_000)

  test("/branch, /merge (squash via $EDITOR) lands a ◆ record in the trunk; undo re-opens", async () => {
    const m = await startMock({ tool: false })
    const proj = await createProject({ mockPort: m.port })
    await installPlugins({ projectDir: proj.dir, server: [path.join(REPO_ROOT, "dist", "server.js")], tui: [path.join(REPO_ROOT, "dist", "tui.js")] })
    try {
      await runTui({
        projectDir: proj.dir,
        env: { EDITOR: path.join(REPO_ROOT, "harness", "fake-editor.sh"), SPIKE_LOG: path.join(proj.dir, "editor.log") },
        keys: [
          ["Ask anything", 1, "hello\\r"],
          ["mock reply", 1, "/branch"],
          ["Branch here", 0.5, "\\r"],
          ["new OpenCode session", 2, "fix-flaky"],
          ["new OpenCode session", 3, "\\r"],
          ["opened", 1, "second question\\r"],
          ["opened", 8, "/merge"],
          ["Merge branch", 0.5, "\\r"],
          ["Merge ⎇", 1.5, "\\r"],
          ["merged", 3, "third\\r"],
          ["merged", 12, "/tree"],
          ["merged", 13, "\\r"],
          ["merged", 16, "x"],
          ["Undo?", 1.5, "\\r"],
          ["Undo?", 5, "\\x03"],
          ["Undo?", 6, "\\x03"],
        ],
        timeoutSec: 240,
        cols: 130,
        rows: 34,
        exitWhenDone: true,
      })
      const users = m.requests().map((r) => (r.body.messages as { role: string; content: unknown }[]).filter((x) => x.role === "user").map((x) => String(x.content)))
      const withRecord = users.find((u) => u.some((c) => c.startsWith("◆ ## Decision: fix-flaky")))
      expect(withRecord).toBeDefined()
      expect(withRecord!.some((c) => c.includes("EDITED-BY-FAKE-EDITOR"))).toBe(true)
      const dir = path.join(proj.dir, ".opencode", "context-tree")
      const lines = readFileSync(path.join(dir, readdirSync(dir).find((f) => f.endsWith(".jsonl"))!), "utf8")
      for (const t of ["decision.recorded", "branch.closed"]) expect(lines).toContain(`"type":"${t}"`)
      expect(lines.split('"type":"branch.opened"').length - 1).toBe(2) // opened, squashed, re-opened by undo
    } finally {
      await m.stop()
      await proj.cleanup()
    }
  }, 320_000)

  test("⏎ on an earlier turn offers Pi's three fork choices; summarize lands a ≣ summary in the fork", async () => {
    const m = await startMock({ tool: false })
    const proj = await createProject({ mockPort: m.port })
    await installPlugins({ projectDir: proj.dir, server: [path.join(REPO_ROOT, "dist", "server.js")], tui: [path.join(REPO_ROOT, "dist", "tui.js")] })
    try {
      const text = await runTui({
        projectDir: proj.dir,
        keys: [
          ["Ask anything", 1, "first question\r"],
          ["mock reply", 6, "second question\r"],
          ["mock reply", 14, "/tree"],
          ["Context tree", 0.5, "\r"],
          // the first user turn, three turns above the tip: ⏎ there asks Pi's question
          ["Context tree ·", 2, "gg"],
          ["Context tree ·", 3, "\r"],
          // esc on the choices goes back to the row with nothing done (Pi's showTreeSelector)
          ["Fork & prefill this turn", 1.5, "\x1b"],
          ["Context tree ·", 3, "\r"],
          // ↓ once = "Summarize everything below this point"
          ["Fork & prefill this turn", 1.5, "\x1b[B"],
          ["Summarize everything below", 1.5, "\r"],
          // the fork opens with the turn pre-filled: send it, so the model request that
          // follows is the proof the injected summary is really in the fork's context
          ["mock reply|Ask anything", 16, "\r"],
          ["mock reply|Ask anything", 16, "\x03"],
          ["", 1, "\x03"],
        ],
        timeoutSec: 240,
        cols: 130,
        rows: 34,
        exitWhenDone: true,
      })
      // all three Pi answers, in Pi's order, from the one dialog ⏎ opens
      expect(text).toContain("Fork & prefill this turn")
      expect(text).toContain("No summary")
      expect(text).toContain("Summarize everything below this point")
      expect(text).toContain("Summarize with a custom prompt")

      const dir = path.join(proj.dir, ".opencode", "context-tree")
      const lines = readFileSync(path.join(dir, readdirSync(dir).find((f) => f.endsWith(".jsonl"))!), "utf8")
      // the escape round changed nothing: exactly one fork, from the one ⏎ we went through with
      expect(lines.split('"type":"branch.opened"').length - 1).toBe(1)
      expect(lines).toContain('"kind":"redo"')
      expect(lines).toContain('"type":"summary.recorded"')
      // the summary was drafted from the abandoned turns, and the fork's next model request
      // carries it: injected with noReply, it only reaches the provider on the following turn
      const users = m.requests().map((r) => (r.body.messages as { role: string; content: unknown }[]).filter((x) => x.role === "user").map((x) => String(x.content)))
      expect(users.some((u) => u.some((c) => c.includes("Create a structured summary of this conversation branch")))).toBe(true)
      expect(users.some((u) => u.some((c) => c.startsWith("The user explored a different conversation branch")))).toBe(true)
    } finally {
      await m.stop()
      await proj.cleanup()
    }
  }, 320_000)

  test("esc in the custom-prompt editor loops back to Pi's choices instead of cancelling the whole jump", async () => {
    const m = await startMock({ tool: false })
    const proj = await createProject({ mockPort: m.port })
    await installPlugins({ projectDir: proj.dir, server: [path.join(REPO_ROOT, "dist", "server.js")], tui: [path.join(REPO_ROOT, "dist", "tui.js")] })
    try {
      const { screens } = await runTuiScreens({
        projectDir: proj.dir,
        keys: [
          ["Ask anything", 1, "first question\r"],
          ["mock reply", 6, "second question\r"],
          ["mock reply", 14, "/tree"],
          ["Context tree", 0.5, "\r"],
          ["Context tree ·", 2, "gg"],
          ["Context tree ·", 3, "\r"],
          // ↓↓ = "Summarize with a custom prompt"
          ["Fork & prefill this turn", 1.5, "\x1b[B\x1b[B"],
          ["Summarize with a custom prompt", 1, "\r"],
          // the DialogPrompt's own title never lands as one contiguous run in the raw
          // ANSI-stripped stream (its text-cursor widget repaints unlike a plain title), so
          // wait on a single word from it instead of the full phrase
          ["instructions", 2, "focus on x"],
          // esc here must return to the 3-choice picker, not cancel the whole jump
          ["instructions", 1, "\x1b"],
          ["instructions", 2, "\r"],
          // confirms we really landed back on a live picker (not a dangling, unresolved
          // promise): finish the flow by picking "No summary" and sending the prefilled turn
          ["mock reply|Ask anything", 16, "\r"],
          ["mock reply|Ask anything", 16, "\x03"],
          ["", 1, "\x03"],
        ],
        timeoutSec: 240,
        cols: 130,
        rows: 34,
        exitWhenDone: true,
      })
      const afterEsc = screens.find((s) => s.label.includes("conditional key 10"))
      expect(afterEsc).toBeDefined()
      expect(afterEsc!.screen).toContain("Fork & prefill this turn?")
      expect(afterEsc!.screen).not.toContain("Custom summarization instructions")

      const dir = path.join(proj.dir, ".opencode", "context-tree")
      const lines = readFileSync(path.join(dir, readdirSync(dir).find((f) => f.endsWith(".jsonl"))!), "utf8")
      // the detour through the custom-prompt editor changed nothing else: exactly one fork
      expect(lines.split('"type":"branch.opened"').length - 1).toBe(1)
    } finally {
      await m.stop()
      await proj.cleanup()
    }
  }, 320_000)

  test("the server captures the real system prompt; consumers shows it as a bucket", async () => {
    const m = await startMock({ tool: false })
    const proj = await createProject({ mockPort: m.port })
    await installPlugins({ projectDir: proj.dir, server: [path.join(REPO_ROOT, "dist", "server.js")], tui: [path.join(REPO_ROOT, "dist", "tui.js")] })
    try {
      const log = path.join(proj.dir, "ctree-debug.log")
      const text = await runTui({
        projectDir: proj.dir,
        env: { CTREE_DEBUG: log },
        keys: [
          // a plain session that never branches: the case the capture must not miss
          ["Ask anything", 1, "hello\r"],
          ["mock reply", 8, "/tree"],
          ["Context tree", 0.5, "\r"],
          ["Context tree ·", 2, "s"],
          ["what is filling|system prompt|consumers", 3, "\x03"],
          ["", 1, "\x03"],
        ],
        timeoutSec: 180,
        cols: 130,
        rows: 34,
        exitWhenDone: true,
      })

      // 1. the assumption the whole feature rests on: `output.system` arrives carrying
      //    OpenCode's own parts, so there is something real to snapshot
      const debugLog = existsSync(log) ? readFileSync(log, "utf8") : "(no debug log)"
      const dir = path.join(proj.dir, ".opencode", "context-tree")
      if (!existsSync(dir)) throw new Error(`no context-tree dir. debug log:\n${debugLog.split("\n").filter((l) => l.includes("system")).join("\n") || debugLog.slice(0, 2000)}`)
      const snap = readdirSync(dir).find((f) => f.startsWith("system-") && f.endsWith(".json"))
      expect(snap).toBeDefined()
      const parsed = JSON.parse(readFileSync(path.join(dir, snap!), "utf8")) as { v: number; parts: { name: string; chars: number; text: string }[] }
      expect(parsed.v).toBe(1)
      expect(parsed.parts.length).toBeGreaterThan(0)
      expect(parsed.parts.reduce((n, p) => n + p.chars, 0)).toBeGreaterThan(200)

      // 2. our own note is NOT in the snapshot: it is captured before we push it
      expect(parsed.parts.some((p) => p.text.startsWith("Context notes:"))).toBe(false)

      // 3. and it reaches the consumers view
      expect(text).toContain("≡ system prompt")
    } finally {
      await m.stop()
      await proj.cleanup()
    }
  }, 300_000)

  test("/tree opens the context tree route with rows and a context header", async () => {
    const text = await runTui({
      projectDir: project.dir,
      keys: [
        ["Ask anything", 1, "hello\\r"],
        ["mock reply", 1, "/tree"],
        ["Context tree", 0.5, "\\r"],
        ["Context tree ·", 2, "q"],
        ["Ask anything|mock reply", 1, "\\x03"],
        ["", 1, "\\x03"],
      ],
      timeoutSec: 120,
      exitWhenDone: true,
      cols: 120,
      rows: 30,
    })
    expect(text).toContain("Context tree ·")
    expect(text).toContain("ctx ")
    expect(text).not.toMatch(/tui\.plugin.*error/i)
    expect(mock.requests().length).toBeGreaterThan(0)
  }, 90_000)
})
