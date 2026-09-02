# opencode-context-tree

Pi-style context tree for [OpenCode](https://opencode.ai), with the
[`pi-context-tree`](https://github.com/navbytes/pi-context-tree) git-style workflow
(`/branch`, `/merge`, `/crop`, `/undo`) and a DeepSeek-Harness-style trajectory view
(timeline lanes, per-step tokens — the model's own where it reports them, estimated `~`
elsewhere — timing, inspector) in one screen.

**Status: 0.1.0 release candidate — not yet published to npm; install from a checkout (see `docs/USAGE.md`).**
Branch, jump, labels, filters, search, crop + undo, squash/discard/tournament merge with a
`$EDITOR` gate, the timeline lanes, inspector and consumers views, the gauge, and the headless
`/ctree` commands all work against OpenCode 1.18 and are covered by pty-driven e2e tests
(`bun run test:e2e`). Read [DESIGN.md](./DESIGN.md) — it contains the research
(Pi, `pi-context-tree`, OpenCode plugin/SDK surface, existing plugins, DSH
trajectory), the end-user flows, the combined tree + trajectory mockup, the data
model, architecture, edge cases, and the roadmap.

## The idea in one screen

```
┌ Context tree · Fix flaky test · ⎇ fix-flaky-test (open)                    ctx ~46k/200k · filling ▲+24% (bash) ─┐
│ Input  ▁▁▂▂▃▃▄▄▅▅▆▆▇▇█        Model ▪ ▪ ▪  ▪ ▪       Tools ▪▪▪ ▪▪ ▪▪▪▪ ▪▪      [1] Duration [2] Turns [3] Calls │
│ turn  step                                    tokens ┬──────────────────────────────────────────────────────┤
│ T1  ● user      Build yourself a tool that…     1.2k │ ⚙ bash · T1 · step 3                                   │
│     ⚙ bash      ls -la ~/Documents/  → total…  ~2.1k │ Status   completed · 21 ms                             │
│ T2  ● user      decompress the session and…     0.2k │ Payload  {"command":"ls -la …"}                        │
│  ├⎇ try-redis      ▸ squashed · 9 turns        ~22k  │ Result   total 744 …                                   │
│  ╰⎇ fix-flaky-test ▾ open · 6 turns   ← here   ~14k  │ Tokens   ~2.1k · 4.6% of context                       │
│  │  ⚙ bash      bun test src/foo.test.ts ⚠     ~4.7k │ Crop     [c] stub result · [t] drop turn               │
│ T3  ◆ decision  Decision: try-redis — Outcome…  0.9k │                                                        │
├──────────────────────────────────────────────────────┴──────────────────────────────────────────────────────┤
│ ⏎ go  b branch  m merge  c crop  x undo  ? help  q back                                                      │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Rows are trajectory steps of the active path; the gutter draws branches at their
anchors (git-log style); the lanes on top are DeepSeek Harness's Input / Model /
Tools timeline; the right pane is its inspector. Branches off the active path (siblings, the trunk's
continuation) are listed below as `┆⎇` rows, and sessions made with OpenCode's own `/fork`
are adopted into the tree automatically.

## Screenshots

Real OpenCode 1.18 TUI, gemma4 via ollama. A trunk with a native `/fork` at turn 1, a squashed
`try-redis` branch (its ◆ decision record landed in the trunk as T5), a discarded `try-lru`
branch, and a second native fork:

![tree from the trunk](docs/screenshots/tree-trunk.png)

`→` expands branches inline; their turns continue the trunk's numbering from the fork point:

![tree with branches expanded](docs/screenshots/tree-expanded.png)

From inside a branch, `← here` marks it and the trunk's continuation and siblings appear as `┆⎇` rows:

![tree from a branch](docs/screenshots/tree-from-a-branch.png)

`D` decisions · `u` what's filling the context · `?` help · `m` merge · the sidebar card:

| | |
|---|---|
| ![decisions](docs/screenshots/decisions.png) | ![consumers](docs/screenshots/consumers.png) |
| ![help](docs/screenshots/help.png) | ![merge picker](docs/screenshots/merge-picker.png) |

![sidebar card](docs/screenshots/sidebar-card.png)

## Try it from source

```sh
bun install && bun run build
# opencode.json  →  "plugin": ["/abs/path/opencode-tree/dist/server.js"]
# tui.json       →  "plugin": ["/abs/path/opencode-tree/dist/tui.js"]
```

The footer inside `/tree` carries six keys — `⏎` go, `b` branch, `m` merge, `c` crop,
`x` undo, `q` back — and `?` opens a help overlay with the rest: crop mode (`space` mark,
double for protected, `a` auto, `t` result⇄turn, `⏎` apply), `i` inspector, `u` consumers,
`D` decisions (`E` export), `L` label, `←→` fold/unfold, `[ ]` hop branches, `f` filter,
`/` search, `g/G`, and how to read the screen.

## Commands

| Command | What it does |
|---|---|
| `/tree` (`Ctrl+Q`) | open the combined tree + trajectory view |
| `/branch <name> [model]` | fork here into a named branch, optionally on a cheaper model |
| `/merge [--pick \| --no-llm \| --discard \| --tournament]` | close the branch: **Squash** drafts a ◆ decision record you confirm, **Squash without LLM** lets you write it, **Discard** lands nothing, **Tournament** keeps one of several siblings. Your transcript is never rewritten; the record is appended to the trunk as a normal message |
| `/crop [--top \| --auto …]` | stub fat tool results or drop whole turns from what the model sees; append-only, reversible |
| `/undo` | revert the last branch / merge / crop |
| `/decisions [--export]` | list or export decision records |

## How it maps onto OpenCode

- a **branch is an OpenCode session** created with `session.fork`; the plugin
  remembers `(parent, anchor)` in an append-only journal and mirrors it into
  `session.metadata`;
- **crop** is applied per request in `experimental.chat.messages.transform`, so the
  transcript keeps the originals and the model sees stubs;
- **merge** writes the confirmed record with `session.prompt({ noReply: true })`;
- the UI is a TUI plugin (`@opencode-ai/plugin/tui`): a route, two slots (gauge,
  sidebar card), dialogs and a keymap layer.

Two config entries will be needed once it ships:

```jsonc
// opencode.json
{ "plugin": ["opencode-context-tree"] }
// tui.json
{ "plugin": ["opencode-context-tree"] }
```
