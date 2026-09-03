/** Argument parsing for the headless `/ctree …` server command (DESIGN.md §5). Pure. */
export type CtreeCommand =
  | { kind: "status" }
  | { kind: "branch"; name: string; model?: string }
  | { kind: "merge-discard"; note?: string }
  | { kind: "crop-top"; apply: boolean; force: boolean }
  | { kind: "crop-auto"; apply: boolean; minTokens?: number; olderThan?: number; keep: string[] }
  | { kind: "undo" }
  | { kind: "decisions"; export?: string }
  | { kind: "help"; error?: string }

/** Relative to the project directory, as promised by `CTREE_HELP` and docs/USAGE.md. */
export const DEFAULT_DECISIONS_EXPORT = "ctree-decisions.md"

export function parseCtreeArgs(raw: string): CtreeCommand {
  const args = raw.trim().split(/\s+/).filter(Boolean)
  const [sub, ...rest] = args
  switch (sub) {
    case undefined:
    case "help":
      return { kind: "help" }
    case "status":
      return { kind: "status" }
    case "branch": {
      // only a `provider/model`-shaped last token is a model, so `branch fix flaky test` keeps its name
      const model = rest.length > 1 && rest[rest.length - 1]!.includes("/") ? rest.pop() : undefined
      const name = rest.join(" ")
      if (!name) return { kind: "help", error: "branch needs a name: /ctree branch <name> [provider/model]" }
      return { kind: "branch", name, model }
    }
    case "merge": {
      if (rest[0] !== "--discard") return { kind: "help", error: "headless merge supports --discard only (squash needs the TUI's editor gate): /ctree merge --discard [note]" }
      const note = rest.slice(1).join(" ").trim() || undefined
      return { kind: "merge-discard", note }
    }
    case "crop": {
      const apply = rest.includes("--apply")
      if (rest.includes("--top")) return { kind: "crop-top", apply, force: rest.includes("--force") }
      if (rest.includes("--auto")) {
        // a `--`-prefixed token is the next flag, never this flag's value
        const value = (flag: string): string | undefined => {
          const i = rest.indexOf(flag)
          if (i < 0) return undefined
          const v = rest[i + 1]
          return v && !v.startsWith("--") ? v : ""
        }
        const num = (flag: string): number | undefined | null => {
          const raw = value(flag)
          if (raw === undefined) return undefined
          const n = Number(raw)
          return raw !== "" && Number.isFinite(n) && n >= 0 ? n : null
        }
        const minTokens = num("--min-tokens")
        if (minTokens === null) return { kind: "help", error: "--min-tokens needs a number, e.g. --min-tokens 10000" }
        const olderThan = num("--older-than")
        if (olderThan === null) return { kind: "help", error: "--older-than needs a number of turns, e.g. --older-than 2" }
        const keep: string[] = []
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] !== "--keep") continue
          const glob = rest[i + 1]
          if (!glob || glob.startsWith("--")) return { kind: "help", error: "--keep needs a glob, e.g. --keep chrome.*" }
          keep.push(glob)
        }
        return { kind: "crop-auto", apply, minTokens, olderThan, keep }
      }
      return { kind: "help", error: "crop needs --top or --auto (add --apply to write; without it, dry run)" }
    }
    case "undo":
      return { kind: "undo" }
    case "decisions": {
      const i = rest.indexOf("--export")
      if (i < 0) return { kind: "decisions" }
      const target = rest[i + 1] && !rest[i + 1]!.startsWith("--") ? rest[i + 1]! : DEFAULT_DECISIONS_EXPORT
      return { kind: "decisions", export: target }
    }
    default:
      return { kind: "help", error: `unknown subcommand "${sub}"` }
  }
}

export const CTREE_HELP = `context tree — headless commands
  /ctree status                       tree, branch, crops of this session
  /ctree branch <name> [provider/model]  fork here into a named branch
  /ctree merge --discard [note]       close this branch as rejected, back to the parent
  /ctree crop --top [--apply] [--force]  biggest unprotected tool result (dry run unless --apply; --force ignores "latest per tool")
  /ctree crop --auto [--apply] [--min-tokens N] [--older-than N] [--keep glob]
  /ctree undo                         revert the last crop / branch / merge on this path
  /ctree decisions [--export [path]]  list ◆ decision records (default export: ./ctree-decisions.md)
The TUI has the full experience: /tree (ctrl+q), /branch, /merge, /decisions.
Not seeing /tree? The UI half is loaded from tui.json, not opencode.json. Let OpenCode write
both files:  opencode plugin opencode-context-tree -g   (drop -g for this project only).`
