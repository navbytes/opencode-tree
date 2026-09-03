# opencode-context-tree — usage

## Install

The short way — OpenCode registers both halves for you:

```sh
opencode plugin opencode-context-tree -g     # global; drop -g for the current project
```

By hand, the package name must be listed in **both** files (the TUI half is read from
`tui.json` only; listing it just in `opencode.json` gives you `/ctree` but no `/tree`):

```jsonc
// opencode.json (server half: crops, branch model, headless /ctree commands)
{ "plugin": [["opencode-context-tree", { "storage": "local" }]] }
// tui.json (TUI half: /tree, /branch, /merge, /decisions, gauge, sidebar card)
{ "plugin": [["opencode-context-tree", { "storage": "local", "jumpSummary": "ask" }]] }
```

Each half only sees the options of its own file, and both halves read `storage` — so if you
change it, **set the same `storage` in both files**, or the TUI and the server end up with
two different journals (crops written by one would never reach the other). The remaining
options only matter to the half that implements them (`storage` both; `jumpSummary`,
`hardCrop`, `keybinds` TUI-only). Plain `{ "plugin": ["opencode-context-tree"] }` in both
files is fine and uses the defaults.

From a checkout: `bun install && bun run build`, then list `/abs/path/dist/server.js` and
`/abs/path/dist/tui.js` instead of the package name.

Options: `storage` `"local"` (default, `.opencode/context-tree/` in the worktree, gitignored)
or `"global"` (OpenCode's state dir); `jumpSummary` `"ask"` (default, Pi behaviour) or `"never"`;
`hardCrop` `true` also sets OpenCode's own "compacted" flag on cropped tool parts so the
transcript shows `[Old tool result content cleared]` (reversible by undo, but it touches
OpenCode storage — off by default); `keybinds` overrides any route key by command name,
e.g. `{ "keybinds": { "open": "ctrl+t", "up": "k,up", "copy": "none" } }` — names are
`open up down jump_up jump_down half_up half_down first last prev_branch next_branch fold
unfold toggle go branch label filter_pick filter_prev search search_next search_prev back
crop crop_toggle_mode mark auto undo merge inspector consumers copy mode_duration mode_turns
mode_calls lanes_off decisions export help`.
- On long sessions the lanes show a window of the timeline: it opens at the newest events, stays
  put while the cursor moves inside it, and follows the cursor in steps when it nears an edge
  (`gg`/`G` jump it to the start/end). `…37` / `12…` at the edges count hidden events, and a dim
  `all` track under the lanes shows where the window sits, with red ticks at failed tool calls.

## Upgrading

OpenCode caches the version it installed and does not re-resolve `@latest` on restart. Pin the new
release, which also rewrites both config entries:

```sh
opencode plugin opencode-context-tree@0.2.0 -g --force     # drop -g for the current project
```

or delete `~/.cache/opencode/packages/opencode-context-tree@latest` and restart. `?` in `/tree` and
`/ctree status` print the running version.

## The loop

```
/branch            name it → you are on ⎇ name, a real OpenCode session (b in the tree
                   also asks "Model for this branch", Enter keeps the current one)
…side quest…
/merge             Squash → the branch model drafts a ◆ decision record → your $EDITOR →
                   save to confirm → the record lands in the trunk as one message; the
                   noisy turns stay on the branch
/tree              see where you are, what it costs, and jump anywhere
c … space … ⏎      crop a fat tool result (double space for protected ones) → the model
                   sees "[cropped: bash …]" from the next turn; the transcript keeps the text
u                  undo the last crop / branch / merge on this path (alias x)
```

`/merge` asks how to close the branch:

| option | what it does |
|---|---|
| **Squash** | drafts a ◆ decision record you confirm — one model call, then your `$EDITOR` (or an in-app confirm when none is set); it lands in the trunk as one message |
| **Squash without LLM** | you write the record yourself, from the empty template |
| **Discard** | rejected; nothing lands in the trunk |
| **Tournament** | compare sibling branches and keep one — only offered when the branch has open siblings |

Every confirmation repeats the promise: *your transcript is never rewritten; the record is
appended to the trunk as a normal message.*

## `/tree` keys

| key | action |
|---|---|
| `↑↓` `j k` · `J K` (20) · `ctrl+d` `ctrl+u` · `gg` `G` | move · half page · top / bottom |
| `[` `]` | previous / next branch row |
| `← →` `h l` · `Tab` (or `e`) | fold / unfold a branch inline |
| `⏎` | go here — the footer names what it will do for the row you are on: switch to a `⎇` branch, fork & prefill a user turn, fork after a step. Confirms first, then asks "Summarize the branch you are leaving?" (Pi); `u` undoes it |
| `b` | branch here: name it, then "Model for this branch" (Enter keeps the current one) |
| `m` | merge: Squash / Squash without LLM / Discard / Tournament (siblings only) |
| `c` `space` `a` `t` `⏎` | crop mode: mark (`space` alone enters it on a croppable row), auto-mark (≥10k tokens, older than 2 turns), result⇄turn, apply |
| `u` (`x`) | undo |
| `D` `E` | decisions panel, export `ctree-decisions.md` |
| `s` | consumers: what is filling the context (`⏎` opens a bucket, `space` marks one entry for crop) |
| `i` | inspector pane on/off (auto-hidden under 110 columns) |
| `1 2 3` `0` | timeline lanes by duration / turns / tool calls; `0` off |
| `L` | label the selected message |
| `f` `F` | filter picker (default → no-tools → user-only → labeled → all); `F` steps back |
| `/` `n` `N` | live search: typing re-filters the rows, `⏎` keeps the filter, `esc` clears; `n` `N` next / previous match |
| `y` | copy the selected text — the terminal's clipboard when it allows it, else `.opencode/context-tree/last-copy.txt` |
| `?` | help pane under the tree: how to read the screen + every key (`?` or `esc` closes) |
| `q` `esc` | back (esc leaves crop mode / a panel / a search first) |

The footer follows the panel and the row under the cursor — on the tree `⏎ fork & prefill
this turn  b branch  m merge  c crop  u undo  s consumers  ? help  q back`; the rest live
behind `?`.

Palette: **Context tree**, **Branch here**, **Merge branch**, **Decisions**, **Label this point**.
`ctrl+q` opens the tree.

## Reading the screen

```
┌ Context tree · Fix flaky test · trunk                  ctx ▓▓░░░ ~46k/200k · filling
│ filter: default   4/24 rows
│ ● user: build yourself a tool that reads the context window…              ~1.2k
│ ○ assistant: I'll start by inspecting my environment…                      0.3k
│ ⚙ [bash $ ls -la ~/Documents/] → total 744 …                              ~2.1k
│ ● user: decompress the session and show the structure                     ~0.2k
│ ╰⎇ try-redis  ▸ squashed · 9 turns                                         ~22k
│ ╰⎇ fix-flaky  ▾ open · 6 turns  ← here                                     ~14k
│ │ ● user: the bun test is flaky, find the race                            ~0.4k
│ │ ⚙ [bash $ bun test src/foo.test.ts] ⚠                                    ~4.7k
│ ◆ Decision: try-redis · Outcome: switched to a write-through cache…        ~0.9k
└ ⏎ fork & prefill this turn  b branch  m merge  c crop  u undo  s consumers  ? help  q back
```

- `/tree` is an outline of the *whole* tree: one content-forward row per message (`● user:` /
  `○ assistant:`) and tool step (`⚙ [bash $ …]` / `[tool: arg] → out`). From anywhere you see the
  whole tree — your branch open with `← here`, the rest folded to their `⎇` header (`→` opens one).
- The Input/Model/Tools lanes and the right-hand inspector (DeepSeek-Harness trajectory) are OFF by
  default so the first screen is the clean outline; `1/2/3` bring in the lanes, `i` the inspector.
  The lanes are an event strip — one `▬` pill per prompt / model step / tool call on a shared time
  axis, coloured by lane (nothing is scaled by tokens); the row you are on draws inverted.
- On a long session the lanes are a window on that axis, and the window follows the cursor: move up
  into older rows (`k`, `gg`) and it scrolls back in steps, `G` returns to the newest. `…12` next to
  `Input` and `12…` after the lane count the events hidden either side, and the `all` line under
  `Tools` is the whole timeline in miniature — `━` is the part you are looking at, red `·` is a
  failed tool call outside it.
- The header's context string is the same one the prompt gauge shows, character for
  character. The lanes only appear once there are three turns to plot; a session with no
  messages says so instead of drawing an empty frame.
- `⎇` rows hang off the message they were forked from. Colours: open green, squashed blue,
  rejected red, abandoned/deleted grey.
- From inside a branch, its own `⎇` row is drawn at the fork point with `← here`; the rows
  below it are the branch's own turns. The header reads `⎇ <branch> ← <trunk title>`.
- Rows the model is not shown — an ancestor's turns past the point where your path forked — are
  dimmed, under a `── not in this branch's context ──` line.
- `┆⎇` rows at the bottom are branches you cannot reach on the active path (siblings, or the
  trunk continuing past your fork point); `⏎` switches to them, `→` expands them.
- Sessions made with OpenCode's own `/fork` are adopted into the tree automatically (matched
  to their parent by the copied message prefix; they show under the session's title).
- Tokens: a leading `~` means estimated (chars/4); assistant steps use the model's own counts.
  Step durations and lane heights are read from the same data — estimated wherever the `~` is.
- `⚠` ≥10k tokens, `✂` cropped, `✗` tool error, `◆` decision record, `◇` branch summary.
- A branch you just made says `just branched, nothing here yet` — there is nothing to unfold.
- The gauge on the prompt line: `⎇ fix-flaky · ctx ~46k/200k · filling ▲+24% (bash)` —
  absolute bands (<8k low · 8–32k healthy · 32–64k filling · ≥64k red), the jump since the
  last look and what caused it. One toast when you enter red; one when OpenCode's
  auto-compaction is near.
- The sidebar card, under a **Context tree** heading: `⎇ <branch>` and, on its own line,
  `open · from "<the session you forked>"` — or `trunk · 2 branches` when you are on the
  trunk. Active crops add `✂ 2 crops · ~31k hidden`; last line is the `/tree · ctrl+q` hint.

## Headless (desktop / web / scripts)

`/ctree status` · `/ctree branch <name> [provider/model]` · `/ctree merge --discard [note]` ·
`/ctree crop --top [--apply]` ·
`/ctree crop --auto [--apply] [--min-tokens N] [--older-than N] [--keep glob]` · `/ctree undo` ·
`/ctree decisions [--export [path]]` (no path → `./ctree-decisions.md`, relative to the
project directory). These run as OpenCode commands, so the model answers with a one-line
acknowledgement. (Squash merges need the TUI's `$EDITOR` gate.)

`/ctree branch` takes the whole rest of the line as the name unless the last word looks like
a model (`provider/model`): `/ctree branch fix flaky test` names the branch "fix flaky test",
`/ctree branch fix anthropic/claude-haiku-4-5` names it "fix" and runs it on that model.

## What is (and is not) touched

- Branch = OpenCode session (`session.fork`). The plugin remembers `(parent, anchor)` in
  `.opencode/context-tree/<tree>.jsonl` (append-only) and mirrors it into `session.metadata`.
- Sessions you fork with OpenCode's own `/fork` are adopted into the tree automatically (the
  copied message prefix identifies the parent); they show up under it with their session
  title. Adoption only appends a journal line — the sessions themselves are untouched.
- Crops and hidden records are applied per request in the server plugin; OpenCode's own
  storage is never rewritten. `/undo` appends, never deletes.
- Decision records are ordinary user messages (`noReply`) tagged in part metadata; they are
  re-injected verbatim when OpenCode compacts.

## Releasing (maintainers)

GitHub → Actions → **Release** → *Run workflow*: pick `patch` / `minor` / `major` (relative to
the latest `v*` tag) or type an exact version. The workflow runs typecheck and tests, tags the
current `main` as `vX.Y.Z`, creates the GitHub Release with generated notes, and dispatches the
publish workflow on that tag, which publishes to npm through trusted publishing (OIDC, no token).
Tick *dry run* to see the version it would cut without doing anything.

The tag is the version: `package.json` on `main` says `0.0.0-dev` and is stamped from the tag at
publish time, so no commit ever has to land on the protected branch. Keep `CHANGELOG.md` by hand
(the workflow warns when the section for the new version is missing).
