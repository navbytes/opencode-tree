/**
 * TUI e2e: boots the real opencode TUI in a pty with the *built* plugin (dist/tui.js
 * + dist/server.js) and drives `/tree`. Gated by CTREE_E2E=1.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { readFileSync, readdirSync } from "node:fs"
import { createProject, installPlugins, REPO_ROOT, runTui, startMock, type StartedMock } from "./harness.js"

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
  }, 120_000)

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
          ["crop mode", 1, "g"],
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
