import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { JournalStore } from "../src/shared/store.js"

describe("JournalStore location", () => {
  test("local storage lives under the worktree", () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "ctree-store-"))
    expect(new JournalStore({ worktree: wt }).dir).toBe(path.join(wt, ".opencode", "context-tree"))
  })

  test("a root worktree (OpenCode's value outside git) falls back to the state dir", () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "ctree-state-"))
    const store = new JournalStore({ worktree: "/", stateDir: state })
    expect(store.dir).toBe(path.join(state, "plugins", "opencode-context-tree"))
    expect(new JournalStore({ worktree: "", stateDir: state }).dir).toBe(store.dir)
    store.ensureTree("ses_root_case", "tui")
    expect(fs.existsSync(path.join(store.dir, "registry.json"))).toBe(true)
  })
})

describe("JournalStore registry", () => {
  test("two stores registering different sessions both survive, and no lock is left behind", () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "ctree-registry-"))
    const tui = new JournalStore({ worktree: wt })
    const server = new JournalStore({ worktree: wt })

    const treeA = tui.ensureTree("ses_a", "tui")
    const treeB = server.ensureTree("ses_b", "server")
    tui.registerSession("ses_c", treeA) // read-modify-write on top of the other half's write

    const registry = JSON.parse(fs.readFileSync(path.join(tui.dir, "registry.json"), "utf8"))
    expect(registry).toEqual({ ses_a: treeA, ses_b: treeB, ses_c: treeA })
    expect(tui.treeIdFor("ses_b")).toBe(treeB)
    expect(server.treeIdFor("ses_c")).toBe(treeA)
    expect(fs.existsSync(path.join(tui.dir, "registry.json.lock"))).toBe(false)
  })

  test("a lock left behind by a crashed writer is broken at once, not waited for", () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "ctree-registry-lock-"))
    const store = new JournalStore({ worktree: wt })
    store.ensureTree("ses_a", "tui")
    const lock = path.join(store.dir, "registry.json.lock")
    fs.writeFileSync(lock, "")
    const crashed = new Date(Date.now() - 60_000)
    fs.utimesSync(lock, crashed, crashed)

    const started = Date.now()
    store.registerSession("ses_b", "t_stale")

    expect(store.treeIdFor("ses_b")).toBe("t_stale")
    expect(Date.now() - started).toBeLessThan(200) // the next hook must not busy-wait for it
    expect(fs.existsSync(lock)).toBe(false)
  })

  test("a lock taken just now is waited out first, then broken; the write always lands", () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "ctree-registry-held-"))
    const store = new JournalStore({ worktree: wt })
    store.ensureTree("ses_a", "tui")
    const lock = path.join(store.dir, "registry.json.lock")
    fs.writeFileSync(lock, "")

    const started = Date.now()
    store.registerSession("ses_b", "t_held")

    expect(store.treeIdFor("ses_b")).toBe("t_held")
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect(fs.existsSync(lock)).toBe(false)
  })

  test("ensureTree re-reads the registry under the lock, so one session never gets two trees", () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "ctree-ensure-race-"))
    const a = new JournalStore({ worktree: wt })
    const b = new JournalStore({ worktree: wt })
    const treeId = a.ensureTree("ses_aaa", "tui")
    const registry = path.join(a.dir, "registry.json")
    const tick = new Date(1_700_000_000_000)
    fs.utimesSync(registry, tick, tick)
    expect(b.treeIdFor("ses_aaa")).toBe(treeId) // b has the registry as it is now …

    // … and the other half registers ses_bbb inside the same mtime tick (same size, same
    // mtime), which is the race the lock has to close: b's cached copy stays stale
    fs.writeFileSync(registry, fs.readFileSync(registry, "utf8").replace("ses_aaa", "ses_bbb"))
    fs.utimesSync(registry, tick, tick)
    expect(b.treeIdFor("ses_bbb")).toBeUndefined()

    expect(b.ensureTree("ses_bbb", "server")).toBe(treeId)
    expect(fs.readdirSync(b.dir).filter((f) => f.endsWith(".jsonl"))).toEqual([`${treeId}.jsonl`])
    const created = fs.readFileSync(path.join(b.dir, `${treeId}.jsonl`), "utf8").trim().split("\n").filter((l) => JSON.parse(l).type === "tree.created")
    expect(created.length).toBe(1)
  })

  test("appends within one filesystem tick are not masked by the cache", () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "ctree-cache-"))
    const store = new JournalStore({ worktree: wt })
    const treeId = store.ensureTree("ses_a", "tui")
    expect(store.entriesFor(treeId).length).toBe(1)
    store.record(treeId, "label.set", { sessionID: "ses_a", messageID: "msg_1", label: "x" }, "tui")
    expect(store.entriesFor(treeId).length).toBe(2)
    expect(store.stateFor(treeId).labels["msg_1"]?.label).toBe("x")
  })
})
