/**
 * Server-side e2e checks (DESIGN.md §8, docs/M0.md): boots `opencode serve`
 * against the mock provider with the *spike* server plugin (harness/project/
 * .opencode/plugins/spike.ts, copied into a throw-away project) and exercises
 * the OpenCode APIs the real plugin's server half relies on:
 *   - the prompt round-trip (system+user out, assistant reply stored)
 *   - `experimental.chat.messages.transform` reaching the provider in-place
 *   - `chat.message`'s per-branch model override
 *   - `session.metadata` PATCH/GET round-trip and fork carrying it forward
 *   - `noReply` prompts that store a message without calling the provider
 *
 * Skipped unless CTREE_E2E=1 (see package.json's test:e2e script).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cp, mkdir } from "node:fs/promises"
import path from "node:path"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { createProject, startMock, startServer, TEMPLATE_PROJECT_DIR, type StartedMock, type StartedServer, REPO_ROOT, installPlugins } from "./harness.js"

const e2e = process.env.CTREE_E2E === "1"

function unwrap<T>(res: { data?: T; error?: unknown }): T {
  if (res.data === undefined) throw new Error(`request failed: ${JSON.stringify(res.error)}`)
  return res.data
}

/** Every system message the provider was sent, joined — `output.system` parts may arrive as
 *  separate messages or as one, and structured content is stringified rather than assumed. */
function systemText(req: { body: { messages: { role: string; content: unknown }[] } }): string {
  return req.body.messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n")
}

async function installSpikePlugin(projectDir: string): Promise<void> {
  const pluginsDir = path.join(projectDir, ".opencode", "plugins")
  await mkdir(pluginsDir, { recursive: true })
  await cp(path.join(TEMPLATE_PROJECT_DIR, ".opencode", "plugins", "spike.ts"), path.join(pluginsDir, "spike.ts"))
}

describe.skipIf(!e2e)("server e2e: prompt/model/metadata/fork/noReply", () => {
  let mock: StartedMock
  let server: StartedServer
  let cleanupProject: () => Promise<void>

  beforeAll(async () => {
    mock = await startMock({ tool: false })
    const project = await createProject({ mockPort: mock.port })
    cleanupProject = project.cleanup
    await installSpikePlugin(project.dir)
    server = await startServer({ projectDir: project.dir, env: { SPIKE_LOG: path.join(project.dir, "spike.log") } })
  })

  afterAll(async () => {
    await server?.stop()
    await mock?.stop()
    await cleanupProject?.()
  })

  test("prompt round-trip: provider receives system+user, assistant reply is stored", async () => {
    mock.clearRequests()
    const session = unwrap(await server.client.session.create({ query: { directory: server.dir }, body: { title: "round-trip" } }))

    const result = unwrap(
      await server.client.session.prompt({
        path: { id: session.id },
        query: { directory: server.dir },
        body: { parts: [{ type: "text", text: "hello there" }] },
      }),
    )
    expect(result.info.role).toBe("assistant")

    const reqs = mock.requests()
    expect(reqs.length).toBeGreaterThan(0)
    const roles = reqs[0]!.body.messages.map((m: any) => m.role)
    expect(roles).toContain("system")
    expect(roles).toContain("user")

    const stored = unwrap(await server.client.session.messages({ path: { id: session.id }, query: { directory: server.dir } }))
    const assistant = stored.find((m) => m.info.role === "assistant")
    expect(assistant).toBeTruthy()
    const text = assistant!.parts
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("")
    expect(text).toContain("mock reply")
  })

  test("chat.message override: [branch-b] routes the request to mock-b and is persisted", async () => {
    mock.clearRequests()
    const session = unwrap(await server.client.session.create({ query: { directory: server.dir }, body: { title: "branch-b" } }))

    const result = unwrap(
      await server.client.session.prompt({
        path: { id: session.id },
        query: { directory: server.dir },
        body: { parts: [{ type: "text", text: "please branch [branch-b]" }] },
      }),
    )

    const reqs = mock.requests()
    expect(reqs.length).toBeGreaterThan(0)
    expect(reqs[reqs.length - 1]!.model).toBe("mock-b")
    expect((result.info as any).modelID).toBe("mock-b")
  })

  test("metadata round-trip and fork: PATCH+GET metadata, fork copies it and stops before the anchor", async () => {
    mock.clearRequests()
    const session = unwrap(await server.client.session.create({ query: { directory: server.dir }, body: { title: "metadata-fork" } }))

    unwrap(
      await server.client.session.prompt({
        path: { id: session.id },
        query: { directory: server.dir },
        body: { parts: [{ type: "text", text: "first turn" }] },
      }),
    )
    const turn2 = unwrap(
      await server.client.session.prompt({
        path: { id: session.id },
        query: { directory: server.dir },
        body: { parts: [{ type: "text", text: "second turn" }] },
      }),
    )
    const anchorMessageID = (turn2.info as any).parentID as string
    expect(anchorMessageID).toBeTruthy()

    const metadata = { ctree: { treeId: "t1", parentSessionID: null, anchorMessageID: null } }
    const updated = unwrap(
      await server.client.session.update({
        path: { id: session.id },
        query: { directory: server.dir },
        body: { metadata } as any,
      }),
    )
    expect((updated as any).metadata?.ctree).toEqual(metadata.ctree)

    const fetched = unwrap(await server.client.session.get({ path: { id: session.id }, query: { directory: server.dir } }))
    expect((fetched as any).metadata?.ctree).toEqual(metadata.ctree)

    const fork = unwrap(
      await server.client.session.fork({
        path: { id: session.id },
        query: { directory: server.dir },
        body: { messageID: anchorMessageID },
      }),
    )
    expect(fork.parentID == null).toBe(true)
    expect((fork as any).metadata?.ctree).toEqual(metadata.ctree)

    const forkMessages = unwrap(await server.client.session.messages({ path: { id: fork.id }, query: { directory: server.dir } }))
    expect(forkMessages.map((m) => m.info.role)).toEqual(["user", "assistant"])
    const forkedUserText = forkMessages[0]!.parts
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("")
    expect(forkedUserText).toContain("first turn")
    // the anchor (second user message) and everything at/after it must not be in the fork
    expect(forkMessages.some((m) => m.info.id === anchorMessageID)).toBe(false)
  })

  test("noReply: stores a user message without calling the provider", async () => {
    mock.clearRequests()
    const session = unwrap(await server.client.session.create({ query: { directory: server.dir }, body: { title: "no-reply" } }))

    const result = unwrap(
      await server.client.session.prompt({
        path: { id: session.id },
        query: { directory: server.dir },
        body: { parts: [{ type: "text", text: "just log this, don't reply" }], noReply: true },
      }),
    )
    expect((result.info as { role: string }).role).toBe("user")
    expect(mock.requests().length).toBe(0)

    const stored = unwrap(await server.client.session.messages({ path: { id: session.id }, query: { directory: server.dir } }))
    expect(stored.length).toBe(1)
    expect(stored[0]!.info.role).toBe("user")
  })
})

describe.skipIf(!e2e)("server e2e: experimental.chat.messages.transform", () => {
  let mock: StartedMock
  let server: StartedServer
  let cleanupProject: () => Promise<void>

  beforeAll(async () => {
    mock = await startMock({ tool: true })
    const project = await createProject({ mockPort: mock.port })
    cleanupProject = project.cleanup
    await installSpikePlugin(project.dir)
    server = await startServer({ projectDir: project.dir, env: { SPIKE_LOG: path.join(project.dir, "spike.log") } })
  })

  afterAll(async () => {
    await server?.stop()
    await mock?.stop()
    await cleanupProject?.()
  })

  test("crops the completed bash tool output before the follow-up provider request", async () => {
    mock.clearRequests()
    const session = unwrap(await server.client.session.create({ query: { directory: server.dir }, body: { title: "crop" } }))

    unwrap(
      await server.client.session.prompt({
        path: { id: session.id },
        query: { directory: server.dir },
        body: { parts: [{ type: "text", text: "run the tool" }] },
      }),
    )

    const reqs = mock.requests()
    // request 1: no tool result yet -> mock answers with a scripted bash tool call.
    // request 2: the tool has run -> its result is in the messages the transform hook must crop in place.
    expect(reqs.length).toBeGreaterThanOrEqual(2)
    const second = reqs[1]!.body.messages
    const toolMessages = second.filter((m: any) => m.role === "tool")
    expect(toolMessages.length).toBeGreaterThan(0)
    const content = String(toolMessages[0].content)
    expect(content.startsWith("[cropped: bash")).toBe(true)
  }, 30_000)
})


describe.skipIf(!e2e)("server e2e: built plugin headless /ctree commands", () => {
  let mock: StartedMock
  let server: StartedServer
  let cleanupProject: () => Promise<void>
  let dir: string

  beforeAll(async () => {
    const build = Bun.spawnSync({ cmd: ["bun", "run", "scripts/build.ts"], cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] })
    if (build.exitCode !== 0) throw new Error(`build failed: ${build.stderr.toString()}`)
    mock = await startMock({ tool: true })
    const project = await createProject({ mockPort: mock.port })
    cleanupProject = project.cleanup
    dir = project.dir
    await installPlugins({ projectDir: project.dir, server: [path.join(REPO_ROOT, "dist", "server.js")] })
    server = await startServer({ projectDir: project.dir })
  })

  afterAll(async () => {
    await server?.stop()
    await mock?.stop()
    await cleanupProject?.()
  })

  test("/ctree status, crop --top --apply, undo drive the journal and the provider sees the stub", async () => {
    const session = unwrap(await server.client.session.create({ query: { directory: server.dir }, body: { title: "headless" } }))
    // two tool turns (MOCK_TOOL=1 answers "…tool…" prompts with a bash call) so the older
    // result is unprotected; then a plain turn
    unwrap(await server.client.session.prompt({ path: { id: session.id }, query: { directory: server.dir }, body: { parts: [{ type: "text", text: "run the tool" }] } }))
    unwrap(await server.client.session.prompt({ path: { id: session.id }, query: { directory: server.dir }, body: { parts: [{ type: "text", text: "run the tool again" }] } }))
    unwrap(await server.client.session.prompt({ path: { id: session.id }, query: { directory: server.dir }, body: { parts: [{ type: "text", text: "second" }] } }))
    mock.clearRequests()

    const status = unwrap(await server.client.session.command({ path: { id: session.id }, query: { directory: server.dir }, body: { command: "ctree", arguments: "status" } }))
    expect(status.info.role).toBe("assistant")
    let last = mock.requests().at(-1)!.body.messages as { role: string; content: unknown }[]
    expect(String(last.filter((m) => m.role === "user").at(-1)!.content)).toContain("[context tree]")
    expect(String(last.filter((m) => m.role === "user").at(-1)!.content)).toContain("not in a tree yet")

    unwrap(await server.client.session.command({ path: { id: session.id }, query: { directory: server.dir }, body: { command: "ctree", arguments: "crop --top --apply" } }))
    const journalDir = path.join(dir, ".opencode", "context-tree")
    const file = readdirSync(journalDir).find((f) => f.endsWith(".jsonl"))!
    expect(readFileSync(path.join(journalDir, file), "utf8")).toContain('"type":"crop.applied"')

    mock.clearRequests()
    unwrap(await server.client.session.prompt({ path: { id: session.id }, query: { directory: server.dir }, body: { parts: [{ type: "text", text: "after crop" }] } }))
    last = mock.requests().at(-1)!.body.messages as { role: string; content: unknown }[]
    const toolMsgs = last.filter((m) => m.role === "tool").map((m) => String(m.content))
    expect(toolMsgs.length).toBe(2)
    expect(toolMsgs[0]!.startsWith("[cropped: bash")).toBe(true) // the older result
    expect(toolMsgs[1]!.startsWith("mock-tool-output")).toBe(true) // latest per tool stays

    unwrap(await server.client.session.command({ path: { id: session.id }, query: { directory: server.dir }, body: { command: "ctree", arguments: "undo" } }))
    expect(readFileSync(path.join(journalDir, file), "utf8")).toContain('"type":"crop.restored"')
    mock.clearRequests()
    unwrap(await server.client.session.prompt({ path: { id: session.id }, query: { directory: server.dir }, body: { parts: [{ type: "text", text: "after undo" }] } }))
    last = mock.requests().at(-1)!.body.messages as { role: string; content: unknown }[]
    expect(last.filter((m) => m.role === "tool").every((m) => !String(m.content).startsWith("[cropped"))).toBe(true)
  }, 180_000)

  test("/ctree branch mirrors metadata; merge --discard closes it; decisions --export writes a file", async () => {
    const session = unwrap(await server.client.session.create({ query: { directory: server.dir }, body: { title: "headless-branch" } }))
    unwrap(await server.client.session.prompt({ path: { id: session.id }, query: { directory: server.dir }, body: { parts: [{ type: "text", text: "seed turn" }] } }))

    unwrap(await server.client.session.command({ path: { id: session.id }, query: { directory: server.dir }, body: { command: "ctree", arguments: "branch side-quest mock/mock-b" } }))
    const listed = unwrap(await server.client.session.list({ query: { directory: server.dir } }))
    const arr = (Array.isArray(listed) ? listed : Object.values(listed)) as { id: string; title?: string; metadata?: any }[]
    const fork = arr.find((s) => s.title === "⎇ side-quest")
    expect(fork).toBeTruthy()

    const forkMeta = (fork as any).metadata?.ctree
    expect(forkMeta?.parentSessionID).toBe(session.id)
    expect(forkMeta?.name).toBe("side-quest")
    expect(forkMeta?.status).toBe("open")

    // the branch model recorded by /ctree branch is what chat.message routes the branch to
    mock.clearRequests()
    unwrap(await server.client.session.prompt({ path: { id: fork!.id }, query: { directory: server.dir }, body: { parts: [{ type: "text", text: "which model" }] } }))
    expect(mock.requests().at(-1)!.model).toBe("mock-b")

    unwrap(await server.client.session.command({ path: { id: fork!.id }, query: { directory: server.dir }, body: { command: "ctree", arguments: "merge --discard dead end" } }))
    const journalDir = path.join(server.dir, ".opencode", "context-tree")
    const journal = readdirSync(journalDir).map((f) => readFileSync(path.join(journalDir, f), "utf8")).join("")
    expect(journal).toContain('"type":"branch.closed"')
    expect(journal).toContain('"status":"rejected"')
    expect(journal).toContain('"note":"dead end"')
    const refetched = unwrap(await server.client.session.get({ path: { id: fork!.id }, query: { directory: server.dir } })) as any
    expect(refetched.metadata?.ctree?.status).toBe("rejected")

    const outPath = path.join(server.dir, "ctree-exported.md")
    unwrap(await server.client.session.command({ path: { id: session.id }, query: { directory: server.dir }, body: { command: "ctree", arguments: `decisions --export ${outPath}` } }))
    expect(readFileSync(outPath, "utf8")).toContain("# Decisions")

    // no path -> the documented default, relative to the project directory
    unwrap(await server.client.session.command({ path: { id: session.id }, query: { directory: server.dir }, body: { command: "ctree", arguments: "decisions --export" } }))
    expect(readFileSync(path.join(server.dir, "ctree-decisions.md"), "utf8")).toContain("# Decisions")
  }, 180_000)

  // DESIGN.md §6.8. `applyCrops` ships `[cropped: …]` stubs and `◆` records to the model; this
  // note is the only thing that tells it how to read them, and nothing proved the note survived
  // `experimental.chat.system.transform` into the actual provider request. It is gated on tree
  // membership, so a plain session legitimately has none — branch first, then look.
  test("the ◆/crop system note reaches the provider once the session is in a tree", async () => {
    const session = unwrap(await server.client.session.create({ query: { directory: server.dir }, body: { title: "system-note" } }))

    mock.clearRequests()
    unwrap(await server.client.session.prompt({ path: { id: session.id }, query: { directory: server.dir }, body: { parts: [{ type: "text", text: "seed turn" }] } }))
    expect(systemText(mock.requests().at(-1)!)).not.toContain("Context notes:")

    unwrap(await server.client.session.command({ path: { id: session.id }, query: { directory: server.dir }, body: { command: "ctree", arguments: "branch note-check mock/mock-b" } }))

    mock.clearRequests()
    unwrap(await server.client.session.prompt({ path: { id: session.id }, query: { directory: server.dir }, body: { parts: [{ type: "text", text: "second turn" }] } }))
    const sys = systemText(mock.requests().at(-1)!)
    expect(sys).toContain("Context notes:")
    // and it is appended to OpenCode's own prompt, not sent instead of it
    expect(sys.length).toBeGreaterThan(500)
  }, 180_000)

  test("a native session.fork (no plugin command) is adopted into the tree", async () => {
    const session = unwrap(await server.client.session.create({ query: { directory: server.dir }, body: { title: "native-fork" } }))
    unwrap(await server.client.session.prompt({ path: { id: session.id }, query: { directory: server.dir }, body: { parts: [{ type: "text", text: "seed turn" }] } }))

    const fork = unwrap(await server.client.session.fork({ path: { id: session.id }, query: { directory: server.dir } }))
    expect(fork.title).toBe("native-fork (fork #1)")
    // the messages are copied after session.created fires; the plugin retries for ~3 s
    await new Promise((r) => setTimeout(r, 3_000))

    mock.clearRequests()
    unwrap(await server.client.session.command({ path: { id: session.id }, query: { directory: server.dir }, body: { command: "ctree", arguments: "status" } }))
    const last = mock.requests().at(-1)!.body.messages as { role: string; content: unknown }[]
    const status = String(last.filter((m) => m.role === "user").at(-1)!.content)
    expect(status).toContain("1 branch(es)")
    // an adopted fork has no journal name: status names it by title, never by raw session id
    expect(status).toContain(`${fork.title} [open]`)
    expect(status).not.toContain(fork.id)

    const journalDir = path.join(server.dir, ".opencode", "context-tree")
    const journal = readdirSync(journalDir).map((f) => readFileSync(path.join(journalDir, f), "utf8")).join("")
    expect(journal).toContain('"kind":"native"')
    expect(journal).toContain(`"sessionID":"${fork.id}"`)
  }, 180_000)
})

describe.skipIf(!e2e)('server e2e: storage "global" option', () => {
  let mock: StartedMock
  let server: StartedServer
  let cleanupProject: () => Promise<void>
  let dir: string

  beforeAll(async () => {
    const build = Bun.spawnSync({ cmd: ["bun", "run", "scripts/build.ts"], cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] })
    if (build.exitCode !== 0) throw new Error(`build failed: ${build.stderr.toString()}`)
    mock = await startMock({ tool: false })
    const project = await createProject({ mockPort: mock.port })
    cleanupProject = project.cleanup
    dir = project.dir
    await installPlugins({ projectDir: project.dir, server: [[path.join(REPO_ROOT, "dist", "server.js"), { storage: "global" }]] })
    server = await startServer({ projectDir: project.dir })
  })

  afterAll(async () => {
    await server?.stop()
    await mock?.stop()
    await cleanupProject?.()
  })

  test("the server writes and reads the journal in OpenCode's state dir, not the worktree", async () => {
    const session = unwrap(await server.client.session.create({ query: { directory: server.dir }, body: { title: "global-storage" } }))
    unwrap(await server.client.session.prompt({ path: { id: session.id }, query: { directory: server.dir }, body: { parts: [{ type: "text", text: "seed turn" }] } }))
    unwrap(await server.client.session.command({ path: { id: session.id }, query: { directory: server.dir }, body: { command: "ctree", arguments: "branch away" } }))

    const state = unwrap(await server.client.path.get({ query: { directory: server.dir } })).state
    const globalDir = path.join(state, "plugins", "opencode-context-tree")
    expect(readdirSync(globalDir).some((f) => f.endsWith(".jsonl"))).toBe(true)
    expect(existsSync(path.join(dir, ".opencode", "context-tree"))).toBe(false)

    // and the same store is what the hooks read back
    mock.clearRequests()
    unwrap(await server.client.session.command({ path: { id: session.id }, query: { directory: server.dir }, body: { command: "ctree", arguments: "status" } }))
    const last = mock.requests().at(-1)!.body.messages as { role: string; content: unknown }[]
    expect(String(last.filter((m) => m.role === "user").at(-1)!.content)).toContain("1 branch(es)")
  }, 180_000)
})
