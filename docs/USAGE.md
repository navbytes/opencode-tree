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
`open up down jump_up jump_down first last prev_branch next_branch fold unfold toggle go
branch label filter search back crop crop_toggle_mode mark auto undo merge inspector
consumers copy mode_duration mode_turns mode_calls decisions export help`.

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
x                  undo the last crop / branch / merge on this path
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
| `↑↓` `j k` · `J K` (20) · `g G` | move |
| `[` `]` | previous / next branch row |
| `← →` `h l` `e` | fold / unfold a branch inline |
| `⏎` | go here: switch to a branch tip, or fork (a user turn = redo with the text pre-filled; a step = continue from there). Asks "Summarize the branch you are leaving?" (Pi) |
| `b` | branch here: name it, then "Model for this branch" (Enter keeps the current one) |
| `m` | merge: Squash / Squash without LLM / Discard / Tournament (siblings only) |
| `c` `space` `a` `t` `⏎` | crop mode: mark, auto-mark (≥10k tokens, older than 2 turns), result⇄turn, apply |
| `x` | undo |
| `D` `E` | decisions panel, export `ctree-decisions.md` |
| `u` | consumers: what is filling the context |
| `i` | inspector pane on/off (auto-hidden under 110 columns) |
| `1 2 3` | minimap lanes by duration / turns / tool calls |
| `L` | label the selected message |
| `f` `/` | filter cycle (default → no-tools → user-only → labeled → all), search |
| `y` | save the selected text to `.opencode/context-tree/last-copy.txt` |
| `?` | help overlay: how to read the screen + every key (`?` or `esc` closes) |
| `q` `esc` | back (esc leaves crop mode / panels first) |

The footer only lists the six you need — `⏎ go  b branch  m merge  c crop  x undo  ? help
q back`; the rest live behind `?`.

Palette: **Context tree**, **Branch here**, **Merge branch**, **Decisions**, **Label this point**.
`ctrl+q` opens the tree.

## Reading the screen

```
┌ Context tree · Fix flaky test · trunk                        ctx ~46k/200k · filling
│ filter: default 24 rows
│ ● user: build yourself a tool that reads the context window…              ~1.2k
│ ○ assistant: I'll start by inspecting my environment…                      0.3k
│ ⚙ [bash $ ls -la ~/Documents/] → total 744 …                              ~2.1k
│ ● user: decompress the session and show the structure                     ~0.2k
│ ╰⎇ try-redis  ▸ squashed · 9 turns                                         ~22k
│ ╰⎇ fix-flaky  ▾ open · 6 turns  ← here                                     ~14k
│ │ ● user: the bun test is flaky, find the race                            ~0.4k
│ │ ⚙ [bash $ bun test src/foo.test.ts] ⚠                                    ~4.7k
│ ◆ Decision: try-redis · Outcome: switched to a write-through cache…        ~0.9k
└ ⏎ go  b branch  m merge  c crop  i inspector  1·2·3 lanes  x undo  ? help  q back
```

- `/tree` is an outline of the *whole* tree: one content-forward row per message (`● user:` /
  `○ assistant:`) and tool step (`⚙ [bash $ …]` / `[tool: arg] → out`). From anywhere you see the
  whole tree — your branch open with `← here`, the rest folded to their `⎇` header (`→` opens one).
- The Input/Model/Tools lanes and the right-hand inspector (DeepSeek-Harness trajectory) are OFF by
  default so the first screen is the clean outline; `1/2/3` bring in the lanes, `i` the inspector.
- The header's context string is the same one the prompt gauge shows, character for
  character. The lanes only appear once there are three turns to plot; a session with no
  messages says so instead of drawing an empty frame.
- `⎇` rows hang off the message they were forked from. Colours: open green, squashed blue,
  rejected red, abandoned/deleted grey.
- From inside a branch, its own `⎇` row is drawn at the fork point with `← here`; the rows
  below it are the branch's own turns.
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
