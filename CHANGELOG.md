# Changelog

## 0.1.0 (unreleased)

First working version, built against OpenCode 1.18.26.

- `/tree` (`ctrl+q`, `/ctree`, `/panel`): combined tree + trajectory view — spine rows with a
  git-log gutter, fold/expand branches, jump (switch or fork with Pi's summarize-on-leave
  picker), labels, filters, search, Input/Model/Tools lanes with Duration/Turns/Calls
  modes, inspector pane, consumers view.
- The branch you are in is drawn at its fork point as `╰⎇ name … ← here`, with its own rows
  nested under it — so a freshly forked session no longer looks exactly like its trunk.
- `/branch`, `b`: fork into a named branch, optional model per branch (applied by the
  server half).
- `/merge`, `m`: squash to a human-confirmed ◆ decision record via `$EDITOR` (or in-app
  confirm), squash without LLM, discard, tournament; `/decisions`, `D`, export to markdown.
- `c` crop mode: stub tool results or drop whole turns from the model's context
  (append-only journal, applied per request by the server plugin), protections, auto rules,
  `hardCrop` option to also set OpenCode's compacted flag.
- `x` / `/ctree undo`: revert the last crop, branch, or merge on the current path.
- Gauge on the prompt line with absolute bands, trend and attribution, red-band and
  compaction-reserve toasts; sidebar card.
- Native forks (OpenCode's own `/fork`, `session.fork`) are adopted into the tree
  automatically — matched to their parent by the copied message prefix, journalled as
  `branch.opened { kind: "native" }` by both halves, and shown under their session title
  (they have no branch name). Only `… (fork #n)` titles are adopted blindly.
- Headless `/ctree status|branch|merge --discard|crop|undo|decisions [--export]` for
  non-TUI clients; `/ctree branch` mirrors the tree linkage into `session.metadata`.
- Options: `storage`, `jumpSummary`, `hardCrop`, `keybinds` (including `open`).
- Off-path branches: siblings and the trunk's continuation that are not on the active path
  appear as `┆⎇` rows at the bottom of the tree; `→` expands them, `⏎` switches. The trunk's
  own continuation reads `trunk continues` — it is not a branch of itself.
- Tool results are costed by size (`~`, chars/4) in rows and totals, so ⚠ fires on fat
  results; the context gauge counts the last assistant turn's own output, and the header's
  `~` appears only when part of the total really is a guess.
- Route keys are inactive while a dialog is open (they used to fire from text typed into the
  search / branch prompts); the sidebar card refreshes after every journal write; the layout
  follows terminal resizes; errored tool calls show in the Tools lane.
- Server half honours `storage` (use the same value in both config files), fetches whole
  transcripts (OpenCode's message paging cursor is not usable by clients), resolves the state
  dir without blocking startup, never fails a turn on journal I/O errors, and locks registry
  writes against the TUI half.
- `/ctree decisions --export` defaults to `./ctree-decisions.md`; `/ctree branch` names may
  contain spaces (a trailing `provider/model` picks the branch model); `--min-tokens` /
  `--older-than` reject non-numbers instead of silently doing nothing.
- Outside a git repo (OpenCode reports worktree `/`) the journal lives in OpenCode's state
  dir instead of the filesystem root.
- Harness: mock provider, pty driver with pyte screen snapshots (`@!regex` keys wait for fresh
  output), Bun e2e suite; pty runs are sandboxed with their own XDG dirs so they never read
  your real OpenCode config or write sessions into your real database.
