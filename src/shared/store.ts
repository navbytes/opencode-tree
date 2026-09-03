/**
 * Journal IO (DESIGN.md §4.1, §4.2, §8 "server/ journal IO (mtime cache)").
 *
 * Reads and appends `.opencode/context-tree/<treeId>.jsonl` plus its
 * `registry.json` (sessionID → treeId), local to a worktree. This is the only
 * place in the plugin that touches the filesystem for journal state.
 */
import fs from "node:fs"
import path from "node:path"
import { foldJournal, parseJournal, type JournalActor, type JournalEntry, type TreeState } from "../core/journal.js"

export type StorageMode = "local" | "global"

export type JournalStoreOptions = {
  /** The git worktree root (DESIGN.md §4.1's `local` storage default). */
  worktree: string
  /** `opencode`'s state directory, used only when `mode` is `"global"`. */
  stateDir?: string
  mode?: StorageMode
}

type CacheEntry = {
  key: string
  entries: JournalEntry[]
  state: TreeState
}

const REGISTRY_FILE = "registry.json"
/** Past this, a lock is assumed to belong to a crashed writer: it is removed and taken over. */
const LOCK_TIMEOUT_MS = 250

export class JournalStore {
  private readonly baseDir: string
  private readonly cache = new Map<string, CacheEntry>()
  private registryCache: { key: string; data: Record<string, string> } | undefined

  constructor(options: JournalStoreOptions) {
    // OpenCode reports worktree "/" for directories outside git; never write at the fs root
    const local = options.mode !== "global" && !isFsRoot(options.worktree)
    this.baseDir = local
      ? path.join(options.worktree, ".opencode", "context-tree")
      : path.join(options.stateDir ?? defaultStateDir(), "plugins", "opencode-context-tree")
  }

  /** Where this store keeps its files (for messages and tests). */
  get dir(): string {
    return this.baseDir
  }

  private ensureDir(): void {
    if (fs.existsSync(this.baseDir)) return
    fs.mkdirSync(this.baseDir, { recursive: true })
    const gitignorePath = path.join(this.baseDir, ".gitignore")
    if (!fs.existsSync(gitignorePath)) fs.writeFileSync(gitignorePath, "*\n")
  }

  private journalPath(treeId: string): string {
    return path.join(this.baseDir, `${treeId}.jsonl`)
  }

  private registryPath(): string {
    return path.join(this.baseDir, REGISTRY_FILE)
  }

  /** sessionID -> treeId, read fresh only when the registry file has changed. */
  readRegistry(): Record<string, string> {
    const registryPath = this.registryPath()
    const key = statKey(registryPath)
    // unreadable (removed, EACCES) must never take a hook down: keep the last good copy
    if (key === undefined) return this.registryCache?.data ?? {}
    if (this.registryCache && this.registryCache.key === key) return this.registryCache.data
    let data: Record<string, string> = this.registryCache?.data ?? {}
    try {
      const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8")) as unknown
      if (parsed && typeof parsed === "object") data = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>
    } catch {
      // a truncated/corrupt registry keeps the last good copy too
    }
    this.registryCache = { key, data }
    return data
  }

  treeIdFor(sessionID: string): string | undefined {
    return this.readRegistry()[sessionID]
  }

  /**
   * Serialize the registry's read-modify-write against the other plugin half (DESIGN.md §8).
   * Blocking is fine: the critical section is one small write, and a crashed holder's lock
   * is broken rather than obeyed.
   */
  private withRegistryLock<T>(fn: () => T): T {
    const lockPath = `${this.registryPath()}.lock`
    const startedAt = Date.now()
    const deadline = startedAt + LOCK_TIMEOUT_MS
    let fd: number | undefined
    let broke = false
    for (;;) {
      try {
        fd = fs.openSync(lockPath, "wx")
        break
      } catch {
        // a lock older than the wait window belongs to a crashed writer: remove it once,
        // rather than have every later write busy-wait the whole window inside a hook
        if (!broke && lockAgeMs(lockPath) >= LOCK_TIMEOUT_MS) {
          broke = true
          try {
            fs.unlinkSync(lockPath)
          } catch {}
          continue
        }
        if (Date.now() >= deadline) {
          // the whole window has passed: a lock that predates our wait belongs to a dead
          // holder (the critical section is one small write), so break it instead of
          // leaving it to tax every later write with another full wait
          if (lockMtimeMs(lockPath) <= startedAt) {
            try {
              fs.unlinkSync(lockPath)
            } catch {}
          }
          break
        }
        sleepSync(5)
      }
    }
    try {
      return fn()
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd)
          fs.unlinkSync(lockPath)
        } catch {}
      }
    }
  }

  /** Registry read-modify-write; the caller must hold the registry lock. */
  private putLocked(sessionID: string, treeId: string): void {
    this.registryCache = undefined // the other half may have written while we waited for the lock
    const registry = { ...this.readRegistry(), [sessionID]: treeId }
    // atomic: temp file + rename, so a concurrent reader never sees a partial file
    const tmp = `${this.registryPath()}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`)
    fs.renameSync(tmp, this.registryPath())
    this.registryCache = undefined
  }

  /** Registers a session under a tree, creating the tree if this is its first session. */
  registerSession(sessionID: string, treeId: string): void {
    this.ensureDir()
    if (this.readRegistry()[sessionID] === treeId) return
    this.withRegistryLock(() => this.putLocked(sessionID, treeId))
  }

  /** Append one journal line. Append-only: existing lines are never rewritten. */
  append(treeId: string, entry: JournalEntry): void {
    this.ensureDir()
    fs.appendFileSync(this.journalPath(treeId), `${JSON.stringify(entry)}\n`)
    this.cache.delete(treeId) // our own append must be visible even inside one filesystem mtime tick
  }

  /** Read + parse a tree's journal, with a stat-checked cache so repeated reads within one
   *  transform hook (DESIGN.md §8's "sub-millisecond mtime check") are cheap. */
  private readEntries(treeId: string): JournalEntry[] {
    const cached = this.cache.get(treeId)
    const key = statKey(this.journalPath(treeId))
    if (key === undefined) return cached?.entries ?? []
    if (cached && cached.key === key) return cached.entries
    let raw: string
    try {
      raw = fs.readFileSync(this.journalPath(treeId), "utf8")
    } catch {
      return cached?.entries ?? []
    }
    const entries = parseJournal(raw)
    const state = foldJournal(entries, treeId)
    this.cache.set(treeId, { key, entries, state })
    return entries
  }

  /** Raw journal entries of a tree in file order (for undo planning). */
  entriesFor(treeId: string): JournalEntry[] {
    return this.readEntries(treeId)
  }

  /** Folded tree state for a tree, from cache when the journal file hasn't changed. */
  stateFor(treeId: string): TreeState {
    this.readEntries(treeId) // populates/refreshes the cache as a side effect
    const cached = this.cache.get(treeId)
    return cached?.state ?? foldJournal([], treeId)
  }

  /** Build a journal envelope. IDs are time-sortable so a fold's tie-breaks are stable. */
  static entry<T extends JournalEntry["type"]>(
    type: T,
    data: Extract<JournalEntry, { type: T }>["data"],
    actor: JournalActor,
  ): JournalEntry {
    return { v: 1, id: `e_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`, ts: Date.now(), type, actor, data } as JournalEntry
  }

  /** Append a typed entry (envelope built here). Returns the entry so callers can reference its id. */
  record<T extends JournalEntry["type"]>(
    treeId: string,
    type: T,
    data: Extract<JournalEntry, { type: T }>["data"],
    actor: JournalActor,
  ): JournalEntry {
    // generic forwarding trips TS's intersection of all data shapes; the public signature stays typed
    const entry = JournalStore.entry(type, data as never, actor)
    this.append(treeId, entry)
    return entry
  }

  /** The tree a session belongs to, creating a fresh tree rooted at the session when it has none. */
  ensureTree(sessionID: string, actor: JournalActor): string {
    const existing = this.treeIdFor(sessionID)
    if (existing) return existing
    this.ensureDir()
    // minting and registering must be one critical section: both halves adopt the same
    // `session.created`, and an unlocked read-then-write mints two trees for one session
    return this.withRegistryLock(() => {
      this.registryCache = undefined
      const raced = this.readRegistry()[sessionID]
      if (raced) return raced
      const treeId = `t_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`
      this.putLocked(sessionID, treeId)
      this.record(treeId, "tree.created", { rootSessionID: sessionID }, actor)
      return treeId
    })
  }

  /** Folded tree state for a session, or `undefined` if the session has no tree yet. */
  stateForSession(sessionID: string): TreeState | undefined {
    const treeId = this.treeIdFor(sessionID)
    if (!treeId) return undefined
    return this.stateFor(treeId)
  }
}

/** Cache key: mtime alone cannot separate two writes inside one filesystem tick. */
function statKey(file: string): string | undefined {
  try {
    const st = fs.statSync(file)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return undefined
  }
}

/** When a lock file was created; `Infinity` when it is already gone (so "predates X" is false). */
function lockMtimeMs(lockPath: string): number {
  try {
    return fs.statSync(lockPath).mtimeMs
  } catch {
    return Infinity
  }
}

/** How long a lock file has existed; `Infinity` when it is already gone. */
function lockAgeMs(lockPath: string): number {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs
  } catch {
    return Infinity
  }
}

const SLEEP_SLOT = new Int32Array(new SharedArrayBuffer(4))

function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_SLOT, 0, 0, ms)
}

function isFsRoot(p: string): boolean {
  if (!p) return true
  const abs = path.resolve(p)
  return abs === path.parse(abs).root
}

function defaultStateDir(): string {
  if (process.env["XDG_STATE_HOME"]) return path.join(process.env["XDG_STATE_HOME"], "opencode")
  return path.join(process.env["HOME"] ?? "", ".local", "state", "opencode")
}
