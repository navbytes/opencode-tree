# Changelog

## 0.2.0 (unreleased) — UI/UX pass from a four-lens review

Findings from reviewers with lazygit/tig, k9s/btop, Helix/fzf and agent-tooling PM backgrounds,
working from real screenshots.

- Context bands are relative to the model window (<25 / 60 / 85 %), with a `▓▓░░░` bar; the
  gauge, tree header and sidebar card show one identical string.
- Thinking steps fold into their assistant row (`· 9.8s thought`) instead of being half the outline.
- From inside a branch, trunk rows past the fork point are dimmed under a
  `── not in this branch's context ──` separator: they are not sent to the model.
- Decision records render as wrapped text (no raw `**`, no mid-word clipping).
- Per-panel footer and scoped keys: `b`/`m`/`u` no longer fire from the help, decisions or
  consumers panels.
- `/` filters as you type with match highlighting, an honest zero-result state and a `4/17`
  position; `n`/`N` step through matches.
- Confirmations: Discard is gated and Esc cancels it; `⏎` names what it will do for the selected
  row and confirms session switches; the merge picker names the trunk with turn and token counts.
- Consumers show percent of the window, expand into their entries, and crop a tool result in
  place; provider reasoning is labelled as not croppable.
- Header dedupes the branch title and truncates to fit; crop marks survive mode changes and crop
  mode is exclusive.
- Keys aligned with vim: `u` undo (`x` kept), `s` consumers, `gg`/`G`, `ctrl+d`/`ctrl+u`,
  `Tab` toggles a fold, `f` opens a filter picker (`F` reverses).
- Lanes are an event strip like DeepSeek Harness's, not a bar chart: one pill per event on a
  shared axis (Input / Model / Tools), a gap between neighbours, width by duration in Duration
  mode, categorical colours, red for a failed tool call, the selected step inverted, an empty
  lane says so, and nothing is scaled by tokens (the row column already has them).

## 0.1.1 — 2026-09-03

- Install with OpenCode's own `opencode plugin opencode-context-tree [-g]`, which registers
  both halves (server entry in `opencode.json`, TUI entry in `tui.json`); README and USAGE
  lead with it.
- If only the server half is installed (you see `/ctree` but no `/tree`), the `/ctree` help
  and its palette description now say exactly that and point at the command above.
- Published through npm trusted publishing (OIDC, no token) from the GitHub Release.

## 0.1.0 — 2026-09-03

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
- `/tree` is now a Pi-style outline of the whole session tree by default: one content-forward row
  per message and tool step (`● user:` / `○ assistant:` / `⚙ [bash $ …]`), branches drawn at their
  fork points with `│ ├ ╰` connectors and folded to their `⎇` header until opened; from any session
  you see the whole tree, your branch open with `← here`. The DeepSeek-Harness trajectory (Input/
  Model/Tools lanes, per-step inspector) is off by default and one keystroke away (`1/2/3`, `i`).
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

### UX pass over the real screens

- The prompt gauge and the tree header print the identical context string
  (`ctx ~2.3k/32.8k · low`), so the two surfaces can no longer disagree.
- Sidebar card: **Context tree** is a heading like OpenCode's own `Context` and `LSP`; the
  branch name and its status sit on separate lines (a long name used to wrap and orphan
  `· open`), and the status line names where you came from — `open · from "Fix flaky test"`.
- Sidebar card: the crops line only appears when there are crops (`✂ 2 crops · ~31k hidden`),
  and the trunk reads `trunk · 2 branches` when it has any.
- Merge picker: the title says where the branch is going (`Merge ⎇ try-redis → Fix flaky
  test`), every option carries a subtitle, and **Tournament** is offered only when the branch
  has open siblings. The "no `$EDITOR`" fallback no longer leaks into the option labels.
- Every merge confirmation — the in-app one and the `$EDITOR` gate — states that your
  transcript is never rewritten and the record is appended to the trunk as a normal message;
  the file `$EDITOR` opens explains that saving is the confirmation.
- `/branch` from the palette asks with the same wording as `b` in the tree
  (`Branch here → new OpenCode session`), and the model picker that follows says
  `Model for this branch (Enter keeps the current one)`.
- The tree footer lists the six keys you need (`⏎ go  b branch  m merge  c crop  x undo
  ? help  q back`); `?` opens a help overlay with how to read the screen and every other key.
- Rows sit under a `turn  step … tokens` column header, the selected row is drawn with a
  readable contrast, previews no longer show raw markdown (`**`, backticks), and estimated
  token counts read `~2.1k` instead of `2.1k~`.
- The timeline lanes stay hidden until there are three turns to plot; a session with no
  messages says so instead of drawing an empty frame; a branch you just made reads
  `just branched, nothing here yet` instead of offering an empty fold.
- The crop confirmation says what actually happens: the tokens leave the model's context on
  the next turn, your transcript is never rewritten, `/undo` restores.
