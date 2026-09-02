/**
 * Journal IO (DESIGN.md §4.1, §4.2, §8 "server/ journal IO (mtime cache)").
 *
 * Reads and appends `.opencode/context-tree/<treeId>.jsonl` plus its
 * `registry.json` (sessionID → treeId), local to a worktree. This is the only
 * place in the plugin that touches the filesystem for journal state.
 */
import fs from "node:fs"
import path from "node:path"
import { foldJournal, parseJournal, type JournalEntry, type TreeState } from "../core/journal.js"

export type StorageMode = "local" | "global"

export type JournalStoreOptions = {
  /** The git worktree root (DESIGN.md §4.1's `local` storage default). */
  worktree: string
  /** `opencode`'s state directory, used only when `mode` is `"global"`. */
  stateDir?: string
  mode?: StorageMode
}

type CacheEntry = {
  mtimeMs: number
  entries: JournalEntry[]
  state: TreeState
}

const REGISTRY_FILE = "registry.json"

export class JournalStore {
  private readonly baseDir: string
  private readonly cache = new Map<string, CacheEntry>()
  private registryCache: { mtimeMs: number; data: Record<string, string> } | undefined

  constructor(options: JournalStoreOptions) {
    this.baseDir =
      options.mode === "global"
        ? path.join(options.stateDir ?? defaultStateDir(), "plugins", "opencode-context-tree")
        : path.join(options.worktree, ".opencode", "context-tree")
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

  /** sessionID -> treeId, read fresh only when the registry file's mtime has changed. */
  readRegistry(): Record<string, string> {
    const registryPath = this.registryPath()
    if (!fs.existsSync(registryPath)) return {}
    const mtimeMs = fs.statSync(registryPath).mtimeMs
    if (this.registryCache && this.registryCache.mtimeMs === mtimeMs) return this.registryCache.data
    const data = JSON.parse(fs.readFileSync(registryPath, "utf8")) as Record<string, string>
    this.registryCache = { mtimeMs, data }
    return data
  }

  treeIdFor(sessionID: string): string | undefined {
    return this.readRegistry()[sessionID]
  }

  /** Registers a session under a tree, creating the tree if this is its first session. */
  registerSession(sessionID: string, treeId: string): void {
    this.ensureDir()
    const registry = { ...this.readRegistry() }
    if (registry[sessionID] === treeId) return
    registry[sessionID] = treeId
    fs.writeFileSync(this.registryPath(), `${JSON.stringify(registry, null, 2)}\n`)
    this.registryCache = { mtimeMs: fs.statSync(this.registryPath()).mtimeMs, data: registry }
  }

  /** Append one journal line. Append-only: existing lines are never rewritten. */
  append(treeId: string, entry: JournalEntry): void {
    this.ensureDir()
    fs.appendFileSync(this.journalPath(treeId), `${JSON.stringify(entry)}\n`)
  }

  /** Read + parse a tree's journal, with an mtime-checked cache so repeated reads within one
   *  transform hook (DESIGN.md §8's "sub-millisecond mtime check") are cheap. */
  private readEntries(treeId: string): JournalEntry[] {
    const journalPath = this.journalPath(treeId)
    if (!fs.existsSync(journalPath)) return []
    const mtimeMs = fs.statSync(journalPath).mtimeMs
    const cached = this.cache.get(treeId)
    if (cached && cached.mtimeMs === mtimeMs) return cached.entries
    const entries = parseJournal(fs.readFileSync(journalPath, "utf8"))
    const state = foldJournal(entries, treeId)
    this.cache.set(treeId, { mtimeMs, entries, state })
    return entries
  }

  /** Folded tree state for a tree, from cache when the journal file hasn't changed. */
  stateFor(treeId: string): TreeState {
    this.readEntries(treeId) // populates/refreshes the cache as a side effect
    const cached = this.cache.get(treeId)
    return cached?.state ?? foldJournal([], treeId)
  }

  /** Folded tree state for a session, or `undefined` if the session has no tree yet. */
  stateForSession(sessionID: string): TreeState | undefined {
    const treeId = this.treeIdFor(sessionID)
    if (!treeId) return undefined
    return this.stateFor(treeId)
  }
}

function defaultStateDir(): string {
  if (process.env["XDG_STATE_HOME"]) return path.join(process.env["XDG_STATE_HOME"], "opencode")
  return path.join(process.env["HOME"] ?? "", ".local", "state", "opencode")
}
