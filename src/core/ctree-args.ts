/** Argument parsing for the headless `/ctree …` server command (DESIGN.md §5). Pure. */
export type CtreeCommand =
  | { kind: "status" }
  | { kind: "branch"; name: string; model?: string }
  | { kind: "crop-top"; apply: boolean; force: boolean }
  | { kind: "crop-auto"; apply: boolean; minTokens?: number; olderThan?: number; keep: string[] }
  | { kind: "undo" }
  | { kind: "decisions" }
  | { kind: "help"; error?: string }

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
      const [name, model] = rest
      if (!name) return { kind: "help", error: "branch needs a name: /ctree branch <name> [provider/model]" }
      return { kind: "branch", name, model }
    }
    case "crop": {
      const apply = rest.includes("--apply")
      if (rest.includes("--top")) return { kind: "crop-top", apply, force: rest.includes("--force") }
      if (rest.includes("--auto")) {
        const num = (flag: string) => {
          const i = rest.indexOf(flag)
          return i >= 0 && rest[i + 1] ? Number(rest[i + 1]) : undefined
        }
        const keep: string[] = []
        rest.forEach((a, i) => {
          if (a === "--keep" && rest[i + 1]) keep.push(rest[i + 1]!)
        })
        return { kind: "crop-auto", apply, minTokens: num("--min-tokens"), olderThan: num("--older-than"), keep }
      }
      return { kind: "help", error: "crop needs --top or --auto (add --apply to write; without it, dry run)" }
    }
    case "undo":
      return { kind: "undo" }
    case "decisions":
      return { kind: "decisions" }
    default:
      return { kind: "help", error: `unknown subcommand "${sub}"` }
  }
}

export const CTREE_HELP = `context tree — headless commands
  /ctree status                       tree, branch, crops of this session
  /ctree branch <name> [provider/model]  fork here into a named branch
  /ctree crop --top [--apply] [--force]  biggest unprotected tool result (dry run unless --apply; --force ignores "latest per tool")
  /ctree crop --auto [--apply] [--min-tokens N] [--older-than N] [--keep glob]
  /ctree undo                         revert the last crop / branch / merge on this path
  /ctree decisions                    list ◆ decision records
The TUI has the full experience: /tree (ctrl+q), /branch, /merge, /decisions.`
