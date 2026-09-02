# opencode-context-tree — usage

## Install

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
consumers copy mode_duration mode_turns mode_calls decisions export`.

## The loop

```
/branch            name it → (model picker) → you are on ⎇ name, a real OpenCode session
…side quest…
/merge             Squash → the branch model drafts a ◆ decision record → your $EDITOR →
                   save to confirm → the record lands in the trunk as one message; the
                   noisy turns stay on the branch
/tree              see where you are, what it costs, and jump anywhere
c … space … ⏎      crop a fat tool result (double space for protected ones) → the model
                   sees "[cropped: bash …]" from the next turn; the transcript keeps the text
x                  undo the last crop / branch / merge on this path
```

## `/tree` keys

| key | action |
|---|---|
| `↑↓` `j k` · `J K` (20) · `g G` | move |
| `[` `]` | previous / next branch row |
| `← →` `h l` `e` | fold / unfold a branch inline |
| `⏎` | go here: switch to a branch tip, or fork (a user turn = redo with the text pre-filled; a step = continue from there). Asks "Summarize the branch you are leaving?" (Pi) |
| `b` | branch here (name, then model) |
| `m` | merge: Squash / Squash without LLM / Discard / Tournament |
| `c` `space` `a` `t` `⏎` | crop mode: mark, auto-mark (≥10k tokens, older than 2 turns), result⇄turn, apply |
| `x` | undo |
| `D` `E` | decisions panel, export `ctree-decisions.md` |
| `u` | consumers: what is filling the context |
| `i` | inspector pane on/off (auto-hidden under 110 columns) |
| `1 2 3` | minimap lanes by duration / turns / tool calls |
| `L` | label the selected message |
| `f` `/` | filter cycle (default → no-tools → user-only → labeled → all), search |
| `y` | save the selected text to `.opencode/context-tree/last-copy.txt` |
| `q` `esc` | back (esc leaves crop mode / panels first) |

Palette: **Context tree**, **Branch here**, **Merge branch**, **Decisions**, **Label this point**.
`ctrl+q` opens the tree.

## Reading the screen

```
┌ Context tree · Fix flaky test   ⎇ fix-flaky (open · haiku)   ctx 46k/200k · filling ▲+24% (bash)
│ Input  ▁▂▃▄▅▆▇█▮…      Model ▪▪▪…      Tools ▪▪▪…      [2] Turns
│ T1  ● user      …                      1.2k  ┃ ⚙ bash · T1 · step 3
│     ⚙ tool      bash ls -la → total…   2.1k  ┃ Payload {"command": …}
│ T2  ● user      …                            ┃ Result  total 744 …
│  ├⎇ try-redis   ▸ squashed · 9 turns         ┃ Timing  started … · 21 ms
│  ╰⎇ fix-flaky   ▾ open · 6 turns · haiku     ┃ Crop    protected: latest-per-tool
│  │  ● user …
```

- Rows are the *active path*. Above the fork point they belong to the trunk (jumping there
  forks the trunk); below, to your branch. `T<n>` counts turns along the path.
- `⎇` rows hang off the message they were forked from. Colours: open green, squashed blue,
  rejected red, abandoned/deleted grey.
- From inside a branch, its own `⎇` row is drawn at the fork point with `← here`; the rows
  below it are the branch's own turns.
- `┆⎇` rows at the bottom are branches you cannot reach on the active path (siblings, or the
  trunk continuing past your fork point); `⏎` switches to them, `→` expands them.
- Sessions made with OpenCode's own `/fork` are adopted into the tree automatically (matched
  to their parent by the copied message prefix; they show under the session's title).
- Tokens: `~` means estimated (chars/4); assistant steps use the model's own counts.
- `⚠` ≥10k tokens, `✂` cropped, `✗` tool error, `◆` decision record, `◇` branch summary.
- The gauge on the prompt line: `ctx 46k/200k · filling ▲+24% (bash)` — absolute bands
  (<8k low · 8–32k healthy · 32–64k filling · ≥64k red), the jump since the last look and
  what caused it. One toast when you enter red; one when OpenCode's auto-compaction is near.

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
