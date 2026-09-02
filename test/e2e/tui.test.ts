/**
 * TUI e2e: boots the real opencode TUI in a pty with the *built* plugin (dist/tui.js
 * + dist/server.js) and drives `/tree`. Gated by CTREE_E2E=1.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "node:path"
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
