# Changelog

## 0.2.3 — 2026-09-04

- **The inspector shows the whole field now, and pages through it.** It used to cap each field
  at a fixed 8 (Payload) / 10 (Result) / 14 (Text) lines whatever the terminal, so a tall
  window sat half empty under a dead `… 61 more lines (y to copy)`, and it had no scroll state
  at all.
  - The window is sized from the terminal, so a taller terminal shows more with no keys at all.
  - `PgUp` / `PgDn` page it — no focus mode, since `j`/`k` must keep choosing which row the
    inspector is describing. The foot of the pane reads `12–40 of 118 · PgUp/PgDn · y copy ·
    I full`, and the offset resets when you move to another row.
  - `shift+i` opens the inspector **full screen** (and from closed, opens it there directly);
    `esc` returns it to the side pane. A ~40-column pane is not a JSON viewer, so this is the
    "show me all of it" answer; `y` remains the answer for actually reading a large payload
    somewhere with search and folding.
- **Fixed:** below 110 columns the side pane does not fit, and `i` flipped a flag that rendered
  nothing and gave no feedback — the inspector was simply dead on an 80-column terminal. It now
  opens full screen there, which is what DESIGN.md §7.1 promised and never shipped.

- **Turns and Calls drew the same chart.** The lane modes only ever differed by one blank cell
  at each turn boundary — everything else (which events, which lanes, glyphs, colours) was
  identical, so switching between them looked like nothing happened. Checking DeepSeek Harness
  settled the fix: its Trajectory Overview has no mode toggle at all, marks turns with rules,
  and gets "just the tool calls" from search and interval-focus rather than a mode.
  - `1` / `2` now select only the **x-axis**: Duration (proportional to wall clock) or Turns
    (one cell per event). `3` is gone.
  - A turn boundary is drawn as a `│` **rule across all three lanes**, in both modes, instead of
    a wider gap you had to measure.
  - "What did I run" is now a row filter, not a mode: `f` cycles through a new **`tools-only`**,
    and the lanes follow the active filter — so `tools-only` thins the rows and the lanes
    together, and `no-tools` / `user-only` do too. `labeled` leaves the lanes whole (a label is
    not an event), and thinking stays on the Model lane under every filter.
  - A `ctree.lanes` of `"calls"` stored by an older version falls back to Turns.
- Deleted the original magnitude-column lane model (`buildLanes`, `sparkline`, `fitColumns`,
  `durationWeighted`, `columnFor`) and `buildEventStrip`, superseded by the windowed layout in
  0.2.2. None of it was reachable from the route; it survived only because its tests kept
  passing, which is how the Turns/Calls bug shipped in the first place.

- The tree's status line shows what the provider was really sent at the row under the cursor,
  right-aligned under the header gauge: `T2 reply · prompt 43.7k · 30.1k cached`. Unlike the
  per-row token column — a marginal, chars/4 estimate — this is the provider's own
  `tokens.input` (+ cache), so it includes the system prompt and the tool definitions, and the
  two numbers stack in one column to be read against each other. A user turn shows the reply to
  it; a turn with no reply yet reads `not sent yet`; branch headers have none. It is history: an
  older row's figure is what went out then, and does not shrink when you crop something above it
  later.

Pi's fork-from-an-earlier-message flow, ported whole:

- `⏎` on a row above where you are now opens Pi's tree-selector question — **No summary** /
  **Summarize everything below this point** / **Summarize with a custom prompt** — and that
  question is the confirmation, so the fork is one dialog instead of a yes/no followed by a
  second one. The option lines say how much you are leaving (`drop the 3 turns · ~14k below
  this point`).
- The summary now covers **what the jump abandons**, not the whole session: the turns from
  where you are back to the point your path and the target's path last shared, computed across
  sessions from their spines (Pi's "old leaf → common ancestor"). Redoing trunk turn 2
  summarizes turns 2–3; switching from a branch to a sibling summarizes the branch's own turns
  and not the shared trunk.
- `esc` in the picker now really cancels: it puts you back on the same row with nothing forked,
  where before it moved you anyway without a summary. Cancelling the custom-prompt editor goes
  back to the three choices instead of quietly meaning "no summary".
- Nothing moves until the summary exists. The draft runs first, so `esc` while it is being
  written aborts the draft *and* the jump (the helper session's reply is aborted too) and
  leaves you where you were. A summary that fails outright still lets the move through, with a
  notice. A streaming reply on the session you are leaving is aborted before the draft, so the
  summary covers the reply as it actually ended.
- A jump with nothing below the selected point, and `jumpSummary: "never"`, skip the question
  and show the plain confirm.

## 0.2.2 — 2026-09-03

Found by a long driven session on a real model (13 tool-using turns, three fork paths, three
merge paths, result and turn crops, undo, resume) and 50/100/200-turn scale runs:

- The context gauge counts cached prompt tokens (`tokens.cache.read`/`write`). On caching
  providers it showed ~200 when the real context was 28k, which also skewed the bands, the red
  and compaction toasts and the consumers view. It also follows OpenCode's sidebar rule (the last
  assistant reply that produced output tokens), so the two numbers agree.
- The gauge shows the provider's cache: `· 95% cached` after the band, in muted colour, and the
  bar's filled cells split into a dim cached part and a bright fresh part. It appears once the
  provider has reported cache tokens in the session, so a `0% cached` right after a crop, merge
  or fork means the prompt cache was reset. The sidebar card, `/ctree status` and the inspector
  show the absolute figures. Limits above a million tokens print as `1.3M`, not `1310.7k`.
- `/tree` no longer caps the outline at the ~100 most recent messages OpenCode's TUI keeps in
  memory: the current session is fetched in full once per open and merged with the live state,
  so turn 1 is reachable (`gg`) and croppable in a 200-turn session.
- Squash without LLM with no `$EDITOR` now asks for the record's Outcome and Why in-app (with no
  second "accept as-is?" gate for text you just typed), and no merge path writes a record that
  still contains template placeholders.
- Adopted native forks are named by their session title in the merge/discard dialogs and
  `/ctree status`; decision records carry the real model; two branches off one anchor keep both
  labels (`⎇ a, ⎇ b`); the merge title counts the branch's own turns from the full transcript
  (not the 100-message window); `m` on a trunk with no open branch says so.
- Feedback inside `/tree` goes to a status-line notice: toasts raised from the route never
  reached the screen, so crop, undo and copy confirmations were being lost. The undo notice no
  longer rounds small reclaims to `~0k`.
- Lanes follow the cursor on long sessions. The timeline is laid out in full and the strip shows a
  window of it: it opens at the newest events, stays put while the cursor moves inside it, and
  shifts in chunks of a third of the width when the cursor nears an edge, so the highlighted step
  is always visible (`gg`/`G` jump it to the start/end). Hidden counts (`…37` / `12…`) sit at the
  edges, and when the timeline overflows a one-line overview track under the lanes shows where
  the window sits in the whole session, with red ticks at failed tool calls even when they are
  out of view.

## 0.2.1 — 2026-09-03

- Lanes: the cursor now highlights the thinking pills folded into the selected row (they never
  lit up before); the `?` legend explains the lane colours (Input green you / grey context ·
  Model purple answer / grey thinking · Tools orange call / red failed).
- `?` help and `/ctree status` print the running plugin version.
- Docs: how to upgrade (OpenCode pins the version it installed and does not re-check `@latest`;
  pin a version with `opencode plugin opencode-context-tree@<version> -g --force`), and a note
  that the trajectory panels are off by default (`1/2/3` show them, `i` the inspector).

## 0.2.0 — 2026-09-03 — UI/UX pass from a four-lens review

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
