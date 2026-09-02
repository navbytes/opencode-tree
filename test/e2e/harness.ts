/**
 * Shared plumbing for the e2e layer (test/e2e/*.test.ts): boot a real
 * `opencode serve` (or the interactive TUI, in a pty) against `harness/`'s
 * mock OpenAI-compatible provider, in throw-away temp dirs so tests never
 * touch the developer's real OpenCode config or the checked-in harness/.
 *
 * Mirrors the manual recipe in harness/README.md (restart.sh, test-server.sh,
 * pty-run.py) but wired up for `bun test` with fresh state per test file.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk"

export const REPO_ROOT = path.resolve(import.meta.dir, "../..")
export const HARNESS_DIR = path.join(REPO_ROOT, "harness")
export const TEMPLATE_PROJECT_DIR = path.join(HARNESS_DIR, "project")

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Picks a free TCP port by opening then immediately closing a listener on port 0. */
export function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const port = listener.port
  listener.stop(true)
  return port
}

async function run(cmd: string[], cwd: string, env?: Record<string, string | undefined>): Promise<void> {
  const proc = Bun.spawn({ cmd, cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] })
  const code = await proc.exited
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`command failed (${code}): ${cmd.join(" ")}\n${stderr}`)
  }
}

/**
 * Ensures a local `opencode` binary exists at harness/node_modules/.bin/opencode,
 * installing it with `npm i opencode-ai@1.18.26` in harness/ if missing. Writes a
 * minimal harness/package.json first if one isn't there yet (harness/package*.json
 * is gitignored) — otherwise a cwd-less `npm i` walks up to the repo root and
 * pollutes the root package.json instead of installing locally.
 */
export async function ensureOpencode(): Promise<string> {
  const bin = path.join(HARNESS_DIR, "node_modules/.bin/opencode")
  if (!existsSync(bin)) {
    const pkgJson = path.join(HARNESS_DIR, "package.json")
    if (!existsSync(pkgJson)) {
      writeFileSync(pkgJson, JSON.stringify({ name: "harness", version: "1.0.0", private: true }, null, 2) + "\n")
    }
    const proc = Bun.spawn({
      cmd: ["npm", "i", "opencode-ai@1.18.26"],
      cwd: HARNESS_DIR,
      stdio: ["inherit", "inherit", "inherit"],
    })
    const code = await proc.exited
    if (code !== 0) throw new Error(`npm i opencode-ai@1.18.26 failed in ${HARNESS_DIR} (exit ${code})`)
  }
  if (!existsSync(bin)) throw new Error(`opencode binary still missing at ${bin} after install`)
  return bin
}

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

export interface MockRequest {
  model: string
  body: any
}

export interface StartedMock {
  port: number
  logFile: string
  requests(): MockRequest[]
  clearRequests(): void
  stop(): Promise<void>
}

export interface StartMockOptions {
  /** MOCK_TOOL=1: the mock answers the first (non tool-result) turn with a scripted bash tool call. */
  tool?: boolean
  port?: number
  /** MOCK_REPLY override for the assistant's canned text reply. */
  reply?: string
}

export async function startMock(opts: StartMockOptions = {}): Promise<StartedMock> {
  const port = opts.port ?? freePort()
  const dir = await mkdtemp(path.join(tmpdir(), "ctree-e2e-mock-"))
  const logFile = path.join(dir, "requests.jsonl")
  writeFileSync(logFile, "")

  const proc = Bun.spawn({
    cmd: ["node", path.join(HARNESS_DIR, "mock-provider.mjs")],
    env: {
      ...process.env,
      MOCK_PORT: String(port),
      MOCK_LOG: logFile,
      MOCK_TOOL: opts.tool ? "1" : "0",
      ...(opts.reply ? { MOCK_REPLY: opts.reply } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  const base = `http://127.0.0.1:${port}`
  const start = Date.now()
  for (;;) {
    try {
      const res = await fetch(`${base}/v1/models`)
      if (res.ok) break
    } catch {}
    if (Date.now() - start > 10_000) throw new Error(`mock provider did not come up on ${base}`)
    await sleep(100)
  }

  return {
    port,
    logFile,
    requests() {
      const raw = existsSync(logFile) ? readFileSync(logFile, "utf8") : ""
      return raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          const parsed = JSON.parse(line)
          return { model: parsed.model, body: parsed.body }
        })
    },
    clearRequests() {
      writeFileSync(logFile, "")
    },
    async stop() {
      proc.kill()
      await proc.exited
      await rm(dir, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// Project directories (temp git repos seeded from harness/project/opencode.json)
// ---------------------------------------------------------------------------

export interface CreateProjectOptions {
  /** Port of a running mock provider; templated into opencode.json's provider.mock.options.baseURL. */
  mockPort: number
  /** Template directory to copy opencode.json from. Defaults to harness/project. */
  templateDir?: string
}

/**
 * Creates a fresh temp git repo seeded from the template's opencode.json (with the
 * mock provider's baseURL port substituted in), with one commit so OpenCode's git
 * integration has something to look at. Caller is responsible for copying in any
 * plugin files (.opencode/plugins/*.ts) and/or calling installPlugins() before
 * starting a server or TUI against it.
 */
export async function createProject(opts: CreateProjectOptions): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const template = opts.templateDir ?? TEMPLATE_PROJECT_DIR
  const dir = await mkdtemp(path.join(tmpdir(), "ctree-e2e-project-"))

  const configRaw = readFileSync(path.join(template, "opencode.json"), "utf8")
  const config = JSON.parse(configRaw)
  if (config.provider?.mock?.options) {
    config.provider.mock.options.baseURL = `http://127.0.0.1:${opts.mockPort}/v1`
  }
  writeFileSync(path.join(dir, "opencode.json"), JSON.stringify(config, null, 2) + "\n")

  await run(["git", "init", "-q"], dir)
  await run(["git", "config", "user.email", "e2e@ctree.test"], dir)
  await run(["git", "config", "user.name", "ctree e2e"], dir)
  writeFileSync(path.join(dir, "README.md"), "# e2e project\n")
  await run(["git", "add", "-A"], dir)
  await run(["git", "commit", "-q", "-m", "init"], dir, { GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" })

  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** A plugin entry as OpenCode accepts it: a path/package, optionally with its options object. */
export type PluginSpec = string | [string, Record<string, unknown>]

/** Merges plugin specs into the project's opencode.json ("plugin": [...]) and/or .opencode/tui.json. */
export async function installPlugins(opts: { projectDir: string; server?: PluginSpec[]; tui?: PluginSpec[] }): Promise<void> {
  if (opts.server && opts.server.length > 0) {
    const configPath = path.join(opts.projectDir, "opencode.json")
    const config = JSON.parse(readFileSync(configPath, "utf8"))
    config.plugin = [...(config.plugin ?? []), ...opts.server]
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")
  }
  if (opts.tui && opts.tui.length > 0) {
    const tuiDir = path.join(opts.projectDir, ".opencode")
    await Bun.write(path.join(tuiDir, ".keep"), "").catch(() => {})
    const tuiPath = path.join(tuiDir, "tui.json")
    const tuiConfig = existsSync(tuiPath) ? JSON.parse(readFileSync(tuiPath, "utf8")) : { $schema: "https://opencode.ai/tui.json" }
    tuiConfig.plugin = [...(tuiConfig.plugin ?? []), ...opts.tui]
    writeFileSync(tuiPath, JSON.stringify(tuiConfig, null, 2) + "\n")
  }
}

// ---------------------------------------------------------------------------
// Headless server (`opencode serve`)
// ---------------------------------------------------------------------------

export interface StartServerOptions {
  /** An already-created project directory (see createProject / installPlugins). */
  projectDir: string
  port?: number
  env?: Record<string, string>
}

export interface StartedServer {
  url: string
  dir: string
  client: OpencodeClient
  stop(): Promise<void>
}

async function waitForHealth(url: string, timeoutMs = 90_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    // per-attempt abort: a connect to a not-yet-listening port must not stall the loop
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2_000)
    try {
      const res = await fetch(`${url}/global/health`, { signal: controller.signal })
      if (res.ok) return
    } catch {
    } finally {
      clearTimeout(timer)
    }
    if (Date.now() - start > timeoutMs) throw new Error(`opencode serve did not become healthy at ${url}`)
    await sleep(150)
  }
}

export async function startServer(opts: StartServerOptions): Promise<StartedServer> {
  const bin = await ensureOpencode()
  const port = opts.port ?? freePort()
  const xdgRoot = await mkdtemp(path.join(tmpdir(), "ctree-e2e-xdg-"))

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    XDG_DATA_HOME: path.join(xdgRoot, "data"),
    XDG_CONFIG_HOME: path.join(xdgRoot, "config"),
    XDG_STATE_HOME: path.join(xdgRoot, "state"),
    XDG_CACHE_HOME: path.join(xdgRoot, "cache"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_PRUNE: "1",
    ...opts.env,
  }

  // Piping the server's stdio through Bun.spawn stalls `opencode serve` before it ever
  // listens (observed on 1.18.26); log to files instead and read them back on failure.
  const stderrPath = path.join(xdgRoot, "serve.stderr.log")
  const proc = Bun.spawn({
    cmd: [bin, "serve", "--port", String(port), "--hostname", "127.0.0.1"],
    cwd: opts.projectDir,
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: Bun.file(stderrPath),
  })

  const url = `http://127.0.0.1:${port}`
  try {
    await waitForHealth(url)
  } catch (e) {
    proc.kill()
    const stderr = existsSync(stderrPath) ? readFileSync(stderrPath, "utf8") : ""
    throw new Error(`${(e as Error).message}\nstderr:\n${stderr}`)
  }

  const client = createOpencodeClient({ baseUrl: url, directory: opts.projectDir })

  return {
    url,
    dir: opts.projectDir,
    client,
    async stop() {
      proc.kill()
      await proc.exited
      await rm(xdgRoot, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// TUI (scripted pty run of the interactive `opencode` binary)
// ---------------------------------------------------------------------------

export interface RunTuiOptions {
  projectDir: string
  env?: Record<string, string>
  /** [delaySeconds, text] pairs, or [regex, delaySeconds, text] triples that wait until the
   *  ANSI-stripped screen matches `regex` before sending; text uses pty-run.py's escapes
   *  verbatim, e.g. "hello\\r", "\\x03". Timed keys fire first, then conditional ones in order. */
  keys: Array<[number, string] | [string, number, string]>
  /** Stop capturing ~1 s after the last key was sent instead of waiting for `timeoutSec`. */
  exitWhenDone?: boolean
  timeoutSec?: number
  cols?: number
  rows?: number
}

/** Runs the interactive TUI in a pty with scripted keystrokes; returns the ANSI-stripped capture.
 *  `runTuiScreens` additionally returns the pyte-rendered screen before each key and at the end. */
export async function runTui(opts: RunTuiOptions): Promise<string> {
  return (await runTuiScreens(opts)).text
}

export async function runTuiScreens(opts: RunTuiOptions): Promise<{ text: string; screens: { label: string; screen: string }[] }> {
  const bin = await ensureOpencode()
  const outDir = await mkdtemp(path.join(tmpdir(), "ctree-e2e-pty-"))
  const outFile = path.join(outDir, "pty.out")
  // Same sandbox as startServer: without it the TUI reads the developer's real
  // ~/.local/state/opencode/kv.json, where a leftover `ctree.filter` silently changes
  // which rows a scripted keystroke lands on.
  const xdgRoot = await mkdtemp(path.join(tmpdir(), "ctree-e2e-tui-xdg-"))

  const args = [
    path.join(HARNESS_DIR, "pty-run.py"),
    "--cols",
    String(opts.cols ?? 120),
    "--rows",
    String(opts.rows ?? 30),
    "--timeout",
    String(opts.timeoutSec ?? 30),
    "--out",
    outFile,
  ]
  for (const key of opts.keys) {
    if (key.length === 2) args.push("--keys", `${key[0]}:${key[1]}`)
    else args.push("--keys", `@${key[0]}+${key[1]}:${key[2]}`)
  }
  if (opts.exitWhenDone) args.push("--exit-when-done")
  args.push("--", bin)

  const proc = Bun.spawn({
    cmd: ["python3", ...args],
    cwd: opts.projectDir,
    env: {
      ...process.env,
      XDG_DATA_HOME: path.join(xdgRoot, "data"),
      XDG_CONFIG_HOME: path.join(xdgRoot, "config"),
      XDG_STATE_HOME: path.join(xdgRoot, "state"),
      XDG_CACHE_HOME: path.join(xdgRoot, "cache"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_PRUNE: "1",
      ...opts.env,
      ...(opts.env?.EDITOR && !opts.env?.VISUAL ? { VISUAL: opts.env.EDITOR } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  await proc.exited

  const text = existsSync(`${outFile}.txt`) ? readFileSync(`${outFile}.txt`, "utf8") : ""
  const raw = existsSync(`${outFile}.screens.txt`) ? readFileSync(`${outFile}.screens.txt`, "utf8") : ""
  const screens = raw
    .split("\n===== ")
    .filter((s) => s.trim())
    .map((s) => {
      const nl = s.indexOf(" =====\n")
      return { label: s.slice(0, nl), screen: s.slice(nl + 7) }
    })
  await rm(outDir, { recursive: true, force: true }).catch(() => {})
  await rm(xdgRoot, { recursive: true, force: true }).catch(() => {})
  return { text, screens }
}
