# opencode-context-tree — design

**Goal.** Bring the Pi-style context tree — and the `pi-context-tree` git-style
workflow (`/branch`, `/merge`, `/crop`, `/undo`, `/panel`) — to OpenCode, and
fold a DeepSeek-Harness-style *trajectory* view (timeline lanes, per-step cost and
timing, inspector) into the same screen.

**Status.** Research + design. Nothing is implemented yet. Every OpenCode fact
below was verified against `@opencode-ai/plugin` / `@opencode-ai/sdk` 1.18.26 and
the OpenCode source at commit `69c172e` (2026-09-01) unless marked *[verify]*.

---

## 0. TL;DR — the decisions

| # | Decision | Why |
|---|---|---|
| D1 | **A branch is an OpenCode session.** The tree is a tree of sessions linked by `(parentSessionID, anchorMessageID)`. | OpenCode has no in-session tree. `session.fork(messageID)` is native, every client (TUI, desktop, web) renders a branch as a normal session, and nothing in OpenCode's storage has to be reinterpreted. |
| D2 | **Plugin state is an append-only journal** (`ctree.jsonl` per tree) **mirrored into `session.metadata.ctree`.** OpenCode's own storage is never rewritten. | Same "never mutate the source" invariant as `pi-context-tree`; the mirror lets the tree be rebuilt if the journal is lost and makes the linkage visible to other clients. |
| D3 | **Crop is a per-request view**, applied in `experimental.chat.messages.transform` from the journal. The transcript on screen keeps the originals; the model sees stubs. | The hook is the only place a plugin can change what the LLM sees. It is ephemeral and in-place, so crops are reversible by construction. No "reconstruction block" compromise is needed (unlike Pi). |
| D4 | **Merge = human-confirmed decision record** written into the trunk session as a `noReply` user message tagged in part metadata. Squash / discard / tournament as in `pi-context-tree`. | `session.prompt({noReply:true})` persists a message without running the model. Tagging via `TextPartInput.metadata` lets the hook and the panel recognise records. |
| D5 | **One full-screen route combines tree + trajectory.** Rows are trajectory steps; a git-log-style gutter draws branches at their anchors; a lane minimap on top; an inspector on the right. | Both views are projections of the same event stream: the tree is the *structure* axis, the trajectory is the *time / cost* axis. One screen answers "where else could I be" and "what is this costing me" together. |
| D6 | **Two halves, one package:** a server plugin (hooks, headless `/ctree` commands, journal) and a TUI plugin (route, slots, dialogs, keymap). | OpenCode runs plugins in two processes with different APIs. Display-only commands must live in the TUI half; context rewriting must live in the server half. |
| D7 | **Undo is journal-driven.** Every mutation records its anchor; `/undo` peels the last active one. | Same semantics as Pi's `/undo`. Cheap because crops are views and branches are sessions that still exist. |

Non-goals for v1: cherry-picking raw messages between branches, a web UI, automatic
(un-invoked) cropping or squashing, rewriting OpenCode's SQLite directly, and
OpenCode v2 (`opencode2`/next) support beyond keeping the core layer portable.

---

## 1. Who this is for, and the mental model they bring

You come from Pi, where:

- the session file **is** a tree (`id`/`parentId` per entry), the *leaf* is a
  pointer, and **what the model sees is exactly the root→leaf path**;
- `/tree` moves the leaf (nothing is copied or deleted); picking a *user* message
  means "redo this turn" (text pre-filled in the editor), picking anything else
  means "continue from here";
- `pi-context-tree` adds a git metaphor on top: a small **trunk**, side-work on
  **branches**, `/merge` squashes a branch back as a **◆ decision record** the human
  confirmed in `$EDITOR`, `/crop` stubs fat tool results, `/undo` reverts the last
  mutation, `/panel` shows per-node token cost, consumers, decisions, and a
  green→red health gauge with absolute bands (8k / 32k / 64k).

OpenCode's native model is different, and the design has to map one onto the other:

| Concept | Pi | OpenCode (verified) |
|---|---|---|
| History | one JSONL file, tree of entries | flat list of messages per session (SQLite `message`/`part`) |
| Branch | move the leaf pointer | `POST /session/:id/fork {messageID}` copies messages **strictly before** `messageID` into a **new session**. No `parentID` is set; `metadata` is cloned. |
| Undo | `/undo` moves the leaf | `/undo` = `session.revert` (git snapshot + pending marker). Reverted messages are **hard-deleted on the next prompt** (`revert.cleanup`), so revert cannot be a tree primitive. |
| Compaction | marker on the linear chain | user message with a `compaction` part + assistant `summary:true`; context = everything after the last completed compaction (+ retained tail) |
| Pruning | extension `context` hook | `experimental.chat.messages.transform` (in place, ephemeral, also runs during compaction), plus native `state.time.compacted` flag → `[Old tool result content cleared]` |
| Plugin UI | `ctx.ui.custom(overlay)` | TUI plugin API: routes, dialogs, slots, keymap layers, reactive state |

So "the leaf" becomes "which session is open", and "a branch" becomes "a session
whose origin we remember". Everything else in this document follows from that.

---

## 2. What already exists (and why not just use it)

| | What it does | Gap for us |
|---|---|---|
| **OpenCode built-ins** | `/fork` (pick a user message → new session, prompt pre-filled), `/undo` `/redo` (revert with file restore), `/timeline` (`<leader>g`, rewind), `/compact`, native tool-output pruning after 40k tokens, `session.metadata`, `noReply` prompts, delete/patch part & message endpoints. | No link from a fork to its origin; no tree UI; revert deletes; no merge; pruning is automatic and coarse; no per-step cost view. |
| **`@ishaksebsib/opencode-tree` 0.4.2** ("Pi-style /tree", MIT) | TUI-only route `/tree`; registry + snapshot files recording `parentSessionId` / `anchorMessageId`; select a message → `session.fork`, optional Pi-style branch summary generated in a throw-away helper session and injected with `noReply`; Pi keybinds (j/k, h/l, shift-jump). | No crop, merge, undo, labels, filters, token costs, gauge, inspector; no server half so it cannot change what the LLM sees. Good reference for route/keymap code; ~640 kB bundled. |
| **DCP** (`@tarquinen/opencode-dcp` 3.1.15, AGPL) | Mature pruning pipeline in `experimental.chat.messages.transform`: dedupe, purge errors, `compress` tool, `/dcp sweep|context|stats`, placeholders, per-session state under `storage/plugin/dcp/`. TUI panel. | Automatic/agent-driven, not tree-aware, AGPL. Excellent proof that dropping whole messages and rewriting tool outputs in the hook works, and of the `config`-hook trick to register `/commands` server-side. |
| **opencode-rewind / checkpoint** | git `commit-tree` checkpoints of files on `session.idle`. | Files only. Complementary (see §9). |
| **Other agents** | Claude Code `/rewind` + "summarize from/up to here"; Codex `/fork`, `/side`; Amp handoff; Cursor/Zed file-only checkpoints; Claude Code issue #32631 proposes `/tree /switch /merge --summary`. | Nobody ships human-confirmed merge or per-node cost; the decision-record merge is still unique to `pi-context-tree`. |

**Conclusion.** Build a new plugin, borrow the route/keymap scaffolding pattern from
`opencode-tree` and the hook mechanics from DCP, and port the *semantics* from
`pi-context-tree` (whose core layer is already pure and portable).

---

## 3. Verified OpenCode surface we build on

### 3.1 Server plugin (`@opencode-ai/plugin`, runs inside the OpenCode server)

```ts
export default { id: "opencode-context-tree", server: async ({ client, directory, worktree }, options) => ({
  "experimental.chat.messages.transform": async (_input, output) => { /* mutate output.messages IN PLACE */ },
  "experimental.chat.system.transform":   async ({ sessionID, model }, out) => { /* add one paragraph about ◆/✂ markers */ },
  "experimental.session.compacting":      async ({ sessionID }, out) => { out.context.push(/* decisions on path */) },
  "command.execute.before":               async ({ command, sessionID, arguments: args }, out) => { /* headless /ctree … */ },
  "chat.message":                          async (input, out) => { /* branch model override (verified M0) */ },
  config: async (cfg) => { cfg.command["ctree"] = { template: "", description: "…" } /* DCP pattern */ },
  event: async ({ event }) => { /* session.deleted, message.removed, session.compacted → journal upkeep */ },
})}
```

Facts that constrain the design (from source):

- `messages.transform` input is `{}`. Derive the session from
  `output.messages[0].info.sessionID`. It also fires **during compaction** on a clone
  of the head (so stubs flow into the summary — desirable) and for **subagent
  sessions** (gate on the journal: only sessions we know about).
- The array is consumed by `toModelMessages` **by reference**. Reassigning
  `output.messages` does nothing; `splice`, `length = 0`, `push`, and editing
  `part.state.output` work.
- `lastUser` and tool availability are computed **before** the hook: never drop the
  last user message; never orphan a tool call from its result.
- Text parts with `ignored: true` are skipped by `toModelMessages`; tool parts with
  `state.time.compacted` render as `[Old tool result content cleared]`. Both are
  settable through `PATCH /session/:id/message/:mid/part/:pid` (upsert of a full
  `Part`). Nothing can rewrite message *info*.
- `session.prompt({ noReply: true, parts: [{ type: "text", text, metadata }] })`
  stores a user message and returns without running the model. `TextPartInput` has
  `synthetic?`, `ignored?`, `metadata?: Record<string, any>`.
- `session.fork({ sessionID, messageID? })` → new session titled `"<title> (fork #N)"`,
  messages `slice(0, indexOf(messageID))` with fresh IDs, `metadata` deep-copied,
  **`parentID` not set** (that field means "subagent child" and would put the branch
  in the TUI's child-session navigation — we do not want that).
- `DELETE /session/:id/message/:mid` refuses with 409 while the session is busy.
- Compaction: `experimental.session.compacting` can append context or replace the
  prompt; `experimental.compaction.autocontinue` can suppress the synthetic
  "Continue…" turn.
- Server plugins are declared in `opencode.json` `"plugin": ["pkg", ["pkg", {…}]]` or
  dropped into `.opencode/plugins/`.

### 3.2 TUI plugin (`@opencode-ai/plugin/tui`, runs inside the opentui/solid TUI)

```ts
export default { id: "opencode-context-tree", tui: async (api, options, meta) => {
  api.keymap.registerLayer({ commands: [{ namespace: "palette", name: "ctree.open", title: "Context tree",
    category: "Context", slashName: "tree", slashAliases: ["panel"], run: () => api.route.navigate("ctree", {…}) }],
    bindings: [{ key: "ctrl+q", cmd: "ctree.open" }] })
  api.route.register([{ name: "ctree", render: ({ params }) => <TreeRoute … /> }])
  api.slots.register({ slots: { session_prompt_right: GaugeSlot, sidebar_content: BranchCard } })
}}
```

- `api.ui`: `dialog.replace/clear/setSize`, `DialogSelect`, `DialogPrompt`,
  `DialogConfirm`, `toast`. `api.state.session.messages(id)` / `api.state.part(mid)`
  are reactive. `api.event.on(type, fn)`. `api.kv` persists small UI state.
  `api.client` is the v2 SDK (`client.session.fork({ sessionID, messageID })`).
  `api.renderer` is the `CliRenderer`, so the plugin can do exactly what OpenCode's
  own `openEditor()` does: `renderer.suspend()`, spawn `$VISUAL || $EDITOR` on a temp
  file, `renderer.resume()`. That is the merge editor gate.
- Slots available to plugins: `session_prompt_right`, `sidebar_title/content/footer`,
  `app_bottom`, `home_*`.
- Declared **only** in `tui.json` `"plugin": ["pkg", ["pkg", {…}], "./relative/file.js"]`
  (global, `OPENCODE_TUI_CONFIG`, project, `.opencode/tui.json`); installed with
  `opencode plugin <pkg> [--global]`. The TUI never scans `.opencode/plugins/` and the
  server glob is `*.{ts,js}` only, so a package ships two entry points (`./server`,
  `./tui`) and needs one line in `opencode.json` and one in `tui.json` (verified in M0,
  see `docs/M0.md`). Peer deps `@opentui/{core,keymap,solid}`; JSX must be compiled
  with `@opentui/solid/bun-plugin` and `solid-js` / `@opentui/*` left external, because
  the host provides them (bundling `solid-js` pulls its server build and breaks).
- Known bug to design around: DialogSelect `onSelect` on Enter (anomalyco/opencode
  #22610) — use our own list component inside the route, not `DialogSelect`, for the
  main tree.

### 3.3 Data we can read for cost and timing

- `AssistantMessage.tokens.{input,output,reasoning,cache}` and `cost` per assistant
  turn; `step-finish` parts carry per-step `tokens` and `cost`. **`tokens.input` of
  the latest assistant turn is the real context size** at that turn — that is the
  gauge and the *Input* lane.
- `tool` parts: `state.time.{start,end}` → duration; `state.input`/`output`/`title`;
  `callID`; `tool` name.
- `text`/`reasoning` parts: `time.{start,end}`.
- Everything after the last assistant turn that produced output tokens is estimated at chars/4 and shown with `~`.

---

## 4. Data model

### 4.1 Journal (plugin-owned, append-only)

One JSONL file per tree, `ctree/<treeId>.jsonl`, plus `registry.json` mapping
`sessionID → treeId`. Location (option `storage`, default **`local`**):
`local` → `<worktree>/.opencode/context-tree/` (gitignored by default via a generated
`.gitignore` inside it; commit it deliberately if teammates should see decisions and
branch history), or `global` → `<opencode state dir>/plugins/opencode-context-tree/`
(Linux `~/.local/state/opencode`). Every line:

```jsonc
{ "v": 1, "id": "e_01J…", "ts": 1788300000000, "type": "<kind>", "actor": "tui|server|cli", "data": { … } }
```

| `type` | `data` | Meaning |
|---|---|---|
| `tree.created` | `{ rootSessionID }` | first time a session is touched by the plugin |
| `branch.opened` | `{ sessionID, parentSessionID, anchorMessageID, name?, trunkModel?, branchModel?, kind: "explicit" \| "jump" \| "redo" \| "native" }` | a fork we made (via `/branch`, or by jumping in the tree), or one of OpenCode's own `/fork` sessions adopted by matching its copied message prefix (`core/adopt.ts`) |
| `branch.closed` | `{ sessionID, status: "squashed" \| "rejected" \| "discarded" \| "abandoned", decisionMessageID?, note? }` | `/merge` result or undo of `/branch` |
| `summary.recorded` | `{ sessionID, messageID, fromSessionID, fromMessageID }` | a Pi-style auto summary injected on jump (◇, unreviewed) |
| `decision.recorded` | `{ sessionID, messageID, forkSessionID, branchName, siblings: [{ name, reason }] }` | the ◆ record message we wrote into the trunk |
| `crop.applied` | `{ sessionID, mode: "result" \| "turn", targets: [{ messageID, partID?, callID?, tool?, estTokens, sha8 }], anchorMessageID }` | what to stub / drop, by stable IDs |
| `crop.restored` | `{ cropID }` | undo of a crop |
| `label.set` | `{ sessionID, messageID, label: string \| null }` | bookmark |
| `session.forgotten` | `{ sessionID }` | session deleted in OpenCode; keep the edge for the tree drawing (rendered greyed) |

Rules: never edit a line; derive state by folding the file; the fold is a pure
function in `core` and is unit-tested with fixtures (same approach as
`pi-context-tree`'s `SessionBuilder` goldens).

### 4.2 Mirror in OpenCode (`session.metadata.ctree`)

On every `branch.opened`/`closed` we `PATCH /session/:id { metadata: { ctree: { treeId,
parentSessionID, anchorMessageID, name, status } } }`. `session.fork` deep-copies
metadata, so a fork of a branch inherits `treeId` automatically (we then overwrite
`parentSessionID`/`anchor`). If the journal is missing, the tree can be reconstructed
from `session.list()` + metadata (lossy: crops and labels are journal-only).

### 4.3 Decision records inside the trunk

A ◆ record is a real user message created with `session.prompt({ noReply: true,
parts: [{ type: "text", text: "◆ Decision: <branch>\n…", metadata: { ctree: { kind: "decision",
forkSessionID, branchName } } }] })`. It is visible in the transcript as a user message
(the TUI cannot render custom message types; the `◆` header and markdown make it
scannable), is part of the LLM context, and survives compaction because
`experimental.session.compacting` re-injects all decision records on the path into the
compaction prompt.

### 4.4 What "on the path" means

For a session `S`: the path is `S`'s own messages, preceded by `parent`'s messages up
to the anchor, recursively. Because `session.fork` *copies* the prefix, `S` already
contains its inherited messages; the journal only needs the anchor to draw the
branch point and to attribute cost. The LLM context of `S` is therefore exactly what
OpenCode computes for `S` (after compaction filtering), minus our crops. No
cross-session assembly is ever needed for the model — only for the picture.

---

## 5. Commands, keys, and where they run

| Command | Runs in | Also as | What it does |
|---|---|---|---|
| `/tree` (alias `/panel`, `Ctrl+Q`) | TUI | palette "Context tree" | opens the combined tree + trajectory route (§7) |
| `/branch` (prompts for name, then model picker) | TUI | `/ctree branch <name> [model]` (server, headless) | label the current point and fork here; optionally switch the branch to a cheaper model. TUI slash commands cannot take arguments (M0), hence the dialogs. |
| `/merge [--pick \| --no-llm \| --discard [note] \| --tournament]` | TUI (needs the editor gate) | `/ctree merge --discard` only, headless | close the nearest open branch containing the current session |
| `/crop [--top \| --auto [--apply] \| --dry-run \| --min-tokens N \| --older-than N \| --keep glob]` | TUI (interactive) / server (`--auto --apply`, `--top` with confirm) | `/ctree crop …` | stub fat results or drop whole Q&A turns, as a view |
| `/undo` | TUI | `/ctree undo` | revert the last active mutation (branch / merge / crop) |
| `/decisions [--export path]` | TUI | `/ctree decisions [--export [path]]` (default `./ctree-decisions.md`) | decisions view / markdown export |
| `/label [text]` | TUI | — | bookmark the selected (or last) message |

The gauge is not command-driven: it renders in the `session_prompt_right` TUI slot
(always on); an earlier `/gauge bar\|off` placement command was dropped in M6.

Rationale for the split: server-side custom commands *always* run a model turn
(`command.execute.before` cannot suppress it and throwing crashes the TUI), so
display-only commands must be TUI commands. Server `/ctree …` variants exist for the
desktop/web clients and scripts; they answer through a `noReply` message or toast.

**Keys** (all rebindable through plugin options, like `opencode-tree` does; the
built-in `tui.json` keybinds table only covers OpenCode's own action names):

- open: `ctrl+q` (matches `pi-context-tree`) — `<leader>t` suggested in README because
  many terminals eat `ctrl+q`.
- inside the route: `↑↓`/`j k` move · `g G` top/bottom · `shift+↑↓`/`J K` jump 20 ·
  `←→`/`h l` fold/unfold branch · `⏎` go here · `b` branch · `m` merge · `c` crop mark ·
  `t` result⇄turn · `a` auto-mark · `x` undo · `i` inspector · `u` consumers ·
  `D` decisions · `L` label · `/` search · `f` filter cycle · `1 2 3` lane mode ·
  `y` copy · `e` expand branch inline · `q`/`esc` back.

---

## 6. Flows, from the user's chair

Each flow: what you do → what you see → what happened → what the model sees on the
next turn → how to undo.

### 6.1 Open the tree and look around

`/tree`. The route opens on the **current session**, cursor on your last message, the
active path expanded, sibling branches folded to one row each at their anchor point.
The minimap shows the whole active path; the status line shows
`ctx 46k/200k · filling ▲ +24% (bash)` (same gauge as the prompt slot). Nothing
happens to the session. `q` returns to the chat exactly as it was.

### 6.2 Jump ("go here") — the Pi `/tree` move

Select any row, press `⏎`.

- Row is the **tip of a branch** (its last message) → switch to that session
  (`route.navigate("session")`). No fork. This is Pi's "move the leaf to an existing
  leaf".
- Row is a **user message** in the middle → confirm dialog *"Redo this turn on a new
  branch?"* → `session.fork({ messageID })` (copies everything *before* it) →
  `branch.opened{kind:"jump"}` → open the new session → the user text is pre-filled in
  the prompt (`tui.appendPrompt`). Identical to Pi's user-message semantics and to
  OpenCode's own `/fork`.
- Row is an **assistant/tool step** → fork at the *next* message (so the step is
  included) with an empty prompt: "continue from here".
- Row is a **branch header** → same as its tip.

If the current session is streaming, we abort it first (`session.abort`) and say so,
as Pi does since #7022. The old branch is untouched and stays visible. Undo: `x`
closes the jump branch as `abandoned` and returns to where you were.

After a jump that leaves an open path behind, the plugin asks Pi's question:
**"Summarize the branch you are leaving? No / Summarize / Summarize with custom
prompt"** (option `jumpSummary`, default `"ask"`; `"never"` for the pure
`pi-context-tree` stance). *Summarize* generates the Pi-format branch summary (Goal /
Constraints / Progress / Key decisions / Next steps) in a throw-away helper session,
deletes it, and injects the text into the destination session with
`session.prompt({ noReply: true })` prefixed by "The user explored a different
conversation branch before returning here", tagged `metadata.ctree.kind = "summary"`,
exactly as `opencode-tree` does. `Esc` in the picker returns to the tree at the same
row. The summary is journalled (`summary.recorded`) so `/undo` can hide it and the
decisions view can distinguish ◆ confirmed records from ◇ auto summaries. `/merge`
remains the reviewed path; a summary is never written when a merge closes the branch.

### 6.3 `/branch fix-flaky-test [haiku-4.5]`

From the chat or the tree. Result: a new session titled `⎇ fix-flaky-test` forked at
the current tip, journal `branch.opened{kind:"explicit", name, trunkModel, branchModel}`,
metadata mirrored, TUI switched to it, sidebar card shows `⎇ fix-flaky-test · open ·
from "Fix flaky test" @ msg 12`. The trunk session gets a `label.set` at the anchor so
the branch point is a named checkpoint in the tree.

Model switch: the TUI's model picker is per-TUI state, not per-session; the branch
model is applied by the server half in `chat.message` by overriding
`output.message.model` for sessions whose journal entry has `branchModel`. Verified in
M0: the hook's message is persisted before the loop reads it, and the provider request
used the overridden model.

### 6.4 `/merge` — squash (default), discard, tournament

Precondition: the current session is an open branch (or contains one on its path).

1. **Draft.** Collect the branch transcript (messages after the anchor, tool outputs
   truncated to 2,000 chars, decisions kept verbatim) and ask the *branch* model for a
   decision record using the `pi-context-tree` template (Outcome / Why / Assumptions /
   Changes / Gotchas / Open questions / Confidence / Rejected alternatives). Done in a
   throw-away helper session with `system:` override and a hard `maxOutputTokens`,
   then deleted — the same trick `opencode-tree` uses, so no provider keys are needed.
2. **Gate.** `renderer.suspend()` → `$EDITOR` on the draft (exactly OpenCode's
   `openEditor()`), or the in-route textarea when no `$EDITOR`. Save = confirm; empty
   file or non-zero exit = abort everything. `--no-llm` skips step 1 and opens the
   empty template. `r` redrafts.
3. **Land.** Switch to the parent session; write the record as a `noReply` user
   message with `metadata.ctree.kind = "decision"`; append `decision.recorded` and
   `branch.closed{status:"squashed"}`; mirror metadata (`status: "squashed"`);
   optionally archive the branch session (`time.archived`, option `archiveOnMerge`,
   default off so it stays in `/sessions`). Toast: `◆ merged fix-flaky-test → 0.9k
   tokens added to trunk`.
4. **Discard** skips 1–2, lands `branch.closed{status:"rejected", note}`; nothing is
   written into the trunk. **Tournament** requires open siblings with the same
   `(parentSessionID, anchorMessageID)`: the current branch wins, each loser gets a
   one-line drafted epitaph in the same record, all siblings are closed at once.

What the model sees next turn in the trunk: its own history + one ◆ message. The
noisy branch turns are in another session and never enter the trunk context. Undo:
`x` → `branch.closed` is superseded by a new `branch.opened` (re-open), the ◆ message is
hidden by the transform hook (`ignored` via journal) or deleted with
`session.deleteMessage` if the trunk is idle (option `undoDeletesRecord`, default
hide), and the TUI switches back to the branch tip.

### 6.5 `/crop` — stub a result, or drop a turn

Interactive (default): the route enters **crop mode**: rows show their estimated
token cost, `space` marks a tool result (result mode) or a whole Q&A turn (`t` → turn
mode: the user message plus every assistant/tool step until the next user message),
`a` pre-marks by rules (≥ `minTokens` 10k, older than `olderThan` 2 turns, never the
latest result per tool, never `keep` globs, never decision records, never the current
turn), a running total shows `~19.4k reclaimed`, `⏎` applies with a confirm.
`/crop --top` skips the panel: `✂ bash "bun test …" ~4.7k → crop? [y/N]`.

Apply = one `crop.applied` line. No OpenCode data changes. From then on, in
`messages.transform` for that session:

- **result mode**: `part.state.output = "[cropped: <tool> <arg>, ~4.7k tokens, sha8 3f9a1c2e]"`
  (input args kept so the call/result pair stays valid);
- **turn mode**: the user message and its assistant/tool messages are `splice`d out and
  replaced by one synthetic user message `[dropped turn — 7 steps, ~12k tokens,
  recoverable: sha8]` at the anchor, so user/assistant alternation is preserved.

The transcript on screen keeps the full originals (the TUI cannot annotate messages
it did not create); instead the sidebar card lists active crops (`✂ 3 results, 1 turn ·
~31k hidden from model`) and the tree route shows `✂` on cropped rows. A one-line
paragraph in `system.transform` tells the model what `[cropped: …]` means and that it
can ask the user to restore.

**Hard crop** (option, off by default): additionally `PATCH` the tool part with
`state.time.compacted = now` so OpenCode itself renders `[Old tool result content
cleared]` and hides it in the TUI. Still reversible (clear the flag), but it touches
OpenCode storage, so it stays opt-in. Deleting messages (`deleteMessage`) is offered
only behind an explicit `--purge` and is *not* undoable.

Undo: `x` → `crop.restored{cropID}`; the next turn sends the originals again.

### 6.6 `/undo`

Finds the most recent journal mutation still *active* on the current session's path
(`branch.opened` without close, `branch.closed`, `crop.applied` without restore) and
reverts it as described in 6.2–6.5, with a confirm naming what will happen
(`↶ re-open branch fix-flaky-test (squashed 3 min ago)?`). Run again to peel further.

### 6.7 The gauge and the sidebar card (ambient, no panel)

> **Revised after the 0.1.1 UX review.** The bands are relative to the model's context window when
> OpenCode knows it (<25% low · <60% healthy · <85% filling · else red), with the absolute 8k / 32k /
> 64k bands only as the fallback: 30k is "healthy" on a 200k model and one prompt from compaction on
> a 32k one. Every surface (prompt gauge, tree header, sidebar card) shows the same string,
> `ctx ▓▓░░░ ~2.3k/32.8k · low`, from one helper (`formatContext`).

`session_prompt_right` slot: `ctx 46k/200k ▓▓▓▓░░ filling ▲+24% (bash)` coloured by
band relative to the model limit (<25% · <60% · <85% · red; absolute <8k · 8–32k · 32–64k · ≥64k
when the limit is unknown), from the last assistant reply with output tokens:
`input + output + reasoning + cache.read + cache.write`, OpenCode's own sidebar rule
(+ chars/4 for anything newer, shown as `~`), then `· 95% cached`: the share of that prompt
served from the provider's cache, shown once the provider has reported cache tokens in the
session (so `0% cached` after a crop, merge or fork means the cache was reset), with the bar's
filled cells split dim-cached / bright-fresh; attribution = the biggest new part since
the last turn. One-time toast when entering red; a separate warning when within the
compaction reserve (`model.limit.context − compaction.reserved`), because OpenCode's
auto-compaction is the *lossy* event the user wants to pre-empt with `/crop` or
`/merge`. `sidebar_content` slot: `⎇ fix-flaky-test · open · parent "Fix flaky test"`,
active crops, decisions on path, `[/tree]`.

### 6.8 Compaction interplay

- The transform hook runs during compaction too, so cropped results are already
  stubs in the summary input — the summary cannot resurrect them.
- `experimental.session.compacting`: push every ◆ record on the path into
  `output.context` so decisions survive the summary verbatim.
- After a compaction, crops that target messages before the compaction boundary are
  moot; the panel greys them out and `/undo` skips them.
- `/compact` itself gets the same philosophy warning as in `pi-context-tree`, never a
  block.

### 6.9 Subagents, child sessions, and other clients

Sessions with `parentID` (task/subagent children) are never treated as branches; in
the trajectory they appear as nested rows under their `subtask` part, DSH-style. The
desktop/web clients see branches as ordinary sessions with a `⎇ name` title, decision
records as user messages, and can use the headless `/ctree` commands.

---

## 7. The combined tree + trajectory view

### 7.1 Can they be combined? Yes — they are two axes of one thing

> **Revised after the 0.1.1 UX review.** The lanes are an *event strip*, as in DSH: one pill per
> event on one shared axis across Input / Model / Tools, one cell of gap between neighbours (two at
> a turn boundary in Turns mode), width proportional to duration in Duration mode, categorical
> colours (input green / context grey, model purple, tools orange, error red), the selected step
> inverted. Nothing is scaled by token count — height-as-magnitude produced flat or solid lanes on
> real sessions; tokens live in the row column. When the strip does not fit, the newest events are
> kept and the count dropped on the left is shown. `src/core/lanes.ts` `buildEventStrip`.
>
> **Windowing (0.2.2).** The timeline is laid out unbounded (`layoutEventStrip`) and the strip
> renders a window of it chosen by `windowFor`: end of the session by default, unchanged while the
> cursor's event stays inside a scroll-off margin (width/8), shifted in chunks of width/3 when it
> nears an edge, clamped to the layout. Squashing the whole session into the width was rejected:
> cells would merge and the pills would stop being countable events. When the layout overflows,
> a one-line overview track under the lanes shows the window's position and red ticks at failed
> tool calls, so global orientation survives without giving up pill fidelity.

DSH's Trajectory tab and Pi's `/tree` both render the *same* append-only event
stream. DSH orders it by **time** and annotates each step with **cost and duration**
(three lanes on top, an inspector on the right, role badges, turn markers). Pi orders
it by **ancestry** and shows *alternatives*. A git log has solved this exact problem
already: `git log --graph --stat` is a linear list (time axis) with a gutter that draws
the branch structure (ancestry axis). That is the layout:

- **rows = trajectory steps** of the active path (turn markers, role glyph, preview,
  tokens, duration, ⚠ for ≥10k, ✂ if cropped, ◆ for decisions);
- **gutter = tree**: at each anchor a branch row `⎇ name (status · turns · ~tokens)`
  is drawn with `├⎇` / `╰⎇` (branches that are not on the active path — siblings, the
  trunk's continuation past your fork point — are listed at the bottom as `┆⎇` rows);
  `e`/`→` expands it inline (its steps appear indented under
  the anchor, drawn with `│`), `←` folds it. Only the active path is expanded by
  default, exactly like Pi orders the active branch first and DSH keeps one linear
  list;
- **minimap on top = DSH lanes** for the active path: `Input` (context size at each
  assistant turn — this is the gauge over time), `Model` (one block per assistant
  step, shaded by output tokens), `Tools` (one block per tool call, shaded by result
  size, red if error). Cursor position is mirrored in the lanes;
- **inspector on the right = DSH inspector**: Summary / Payload / Result / Schema /
  Timing / Crop for the selected row; toggled with `i`; below 110 columns it becomes a
  full-screen view instead (this is `pi-context-tree`'s *inspect* view).

### 7.2 Mockup (≥110 columns)

```
┌ Context tree · Fix flaky test  ⎇ fix-flaky-test (open · haiku-4.5)     ctx 46k/200k ▓▓▓░░ filling ▲+24% (bash)            ┐
│ Input  ▁▁▂▂▂▃▃▃▄▄▄▅▅▅▆▆▆▆▇▇▇█                 mode: [1] Duration [2] Turns [3] Calls   / search   f: default               │
│ Model  ▪  ▪  ▪   ▪  ▪ ▪    ▪   ▪                                                                                           │
│ Tools  ▪▪▪ ▪▪ ▪▪▪▪ ▪▪ ▪▪▪▪▪▪ ▪▪ ▪▪▪                                                                                        │
├─────────────────────────────────────────────────────────────────┬─────────────────────────────────────────────────────────┤
│ T1  ● user      Build yourself a tool that reads the…    1.2k   │ ⚙ bash · T1 · step 3              [s]um [p]ay [r]es     │
│     ○ assistant I'll start by understanding my env…       0.3k  │ Status    completed · 21 ms                             │
│     ⚙ bash      pwd && echo "---DSH ENV---" → total 4240  0.4k  │ Hierarchy T1 › assistant › step 3                       │
│  ›  ⚙ bash      ls -la ~/Documents/         → total 744   2.1k  │ Payload   {"command":"ls -la /Users/…","desc…"}         │
│     ○ assistant Key findings: DSH_HOME=…                  0.5k  │ Result    total 744                                     │
│ T2  ● user      decompress the session and inspect…       0.2k  │           drwx------@ 41 tn.shen staff 1312 Aug…        │
│  ├⎇ try-redis       squashed → ◆ T3 · 9 turns · ~22k            │ Timing    started 15:20:37.236 · 21 ms · session ts     │
│  ╰⎇ fix-flaky-test  open · 6 turns · ~14k · haiku-4.5  ← here   │ Tokens    ~2.1k (chars/4) · 4.6% of context             │
│  │  ● user      the test flakes on CI only…               0.2k  │ Crop      [c] stub result · [t] drop turn               │
│  │  ⚙ bash      bun test src/foo.test.ts → 3 failed  ⚠   4.7k   │ Branch    fix-flaky-test · anchor T2 · parent…          │
│  │  ○ assistant The failures share a timing assump…       0.6k  │                                                         │
│ T3  ◆ decision  Decision: try-redis — Outcome: keep in-…   0.9k │                                                         │
│ T4  ● user      now make it pass on CI                    0.1k  │                                                         │
├─────────────────────────────────────────────────────────────────┴─────────────────────────────────────────────────────────┤
│ ⏎ go here  b branch  m merge  c crop  t result⇄turn  a auto  x undo  i inspector  u consumers  D decisions  L label  q     │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Reading it: T1/T2 are trunk turns; at T2 two branches were opened — `try-redis` was
squashed and its ◆ record is T3 on the trunk; `fix-flaky-test` is where you are, so it
is expanded under its anchor; the `bun test` result is 4.7k and flagged as a crop
candidate; the inspector shows the selected `ls -la` call with DSH's five facets.

### 7.3 Modes (the `Duration | Turns | Calls` toggle)

They change the *x-scale of the minimap* and the *grouping of rows*:

| Mode | Minimap x-axis | Rows |
|---|---|---|
| **Turns** (default) | one column per user turn | one row per step, grouped under `T<n>` markers (what the mockup shows) |
| **Calls** | one column per tool call | tool rows only (assistant text folded into the turn header) — the "what did I run" view, also the natural crop view |
| **Duration** | proportional to wall-clock (`time.start`/`end`) | rows carry `+12.3s` gaps; long gaps (user thinking, permission waits) are drawn as `┆ 4m idle` separators |

### 7.4 Secondary views (`u`, `D`, crop mode) — from `pi-context-tree`

- **Consumers** (`u`): tokens by source — `bash 31% ▰▰▰▰▰▰▰▰ · read 22% · assistant text
  18% · decisions 3%` — `c` jumps to crop with that source pre-marked.
- **Decisions** (`D`): ◆ cards (date, model, branch, ✓ human-confirmed, epitaphs);
  `⏎` jumps to the record row; `/decisions --export` writes markdown.
- **Crop mode** (`c`): the same list with checkboxes and a running reclaimed total;
  the inspector's *Crop* facet explains protection (latest per tool, current turn,
  decision, `keep` glob).

### 7.5 Filters and search (from Pi)

`f` cycles `default → no-tools → user-only → labeled → all` (default hides
`step-start/finish`, `snapshot`, `patch`, `retry`; no-tools hides tool rows;
labeled shows only `L`-labelled rows). `/` filters rows incrementally by role, tool
name, label, and text — every token must match, like Pi. Folding state resets on
filter change (as in Pi) and is otherwise remembered per session in `api.kv`.

### 7.6 Narrow terminals

Below 110 columns the inspector is hidden and `i` opens it full-screen; below 80 the
minimap collapses to a single `Input` sparkline line. Row layout always keeps
`glyph · preview · tokens`.

### 7.7 What we deliberately do not copy from DSH

DSH is a web GUI with unlimited space and mouse; its Payload/Schema tabs show full
JSON. In the TUI, Payload is pretty-printed and truncated with `y` to copy the full
text to the clipboard, Schema shows the tool description only (from
`client.tool.list`), and there is no export button — `/decisions --export` and
OpenCode's own `/export` cover it.

---

## 8. Architecture

```
packages/
  core/        pure TS, zero OpenCode imports: journal fold, tree model, path/anchor math,
               token estimator, crop planner (rules + protections), view-models
               (tree rows, lanes, consumers, decisions) as (state, key) → state reducers
  server/      @opencode-ai/plugin server half: hooks, /ctree headless commands,
               journal IO (bun file watcher + mtime cache), metadata mirror, events
  tui/         @opencode-ai/plugin/tui half: route, slots, dialogs, keymap layer,
               editor gate, journal writes for user actions
  package (root) "opencode-context-tree": exports { "./server", "./tui" } — one npm name,
               listed once in opencode.json and once in tui.json
```

- **Process boundary.** The TUI and the server are separate processes with separate
  plugin runtimes. They share state only through the journal file and
  `session.metadata`. The TUI writes journal lines for user actions and patches
  metadata; the server re-reads the journal (mtime check, sub-millisecond) at every
  `messages.transform` and on `session.updated` events. No RPC is needed and either
  half works alone (server-only = headless crops and `/ctree`; TUI-only = tree without
  crops, with a "install the server half" hint).
- **Multiple TUIs on one server** are fine: the journal is append-only and every
  write is a whole line; a lock file guards `registry.json` updates.
- **Build.** Bun + `bun build` for two entry points; JSX `@opentui/solid`; peer deps
  as `opencode-tree` declares them; `engines.opencode ">=1.18"`. `core` is plain TS,
  runnable in Node for tests.
- **Tests.** `core` with fixtures (journal folds, crop plans, reducers as tables —
  ported from `pi-context-tree`'s testkit); `server` against a fake `output.messages`
  array asserting in-place mutation invariants; `tui` snapshot of rendered rows via
  opentui's test renderer *[verify availability]*; one end-to-end run against
  `opencode serve` with a mock provider for fork/merge/crop goldens.

### 8.1 Invariants the transform hook enforces (unit-tested)

1. Never remove or alter the **last user message** (OpenCode picked it before the hook).
2. A `tool` part is stubbed by rewriting `state.output` only; `callID`, `state.input`
   and status are untouched, so call/result pairing survives.
3. A dropped turn removes **user + all assistant/tool messages up to the next user
   message**, then inserts exactly one synthetic user message, so roles still alternate.
4. Never touch messages before the last completed compaction boundary (they are not
   in the array anyway) and never touch subagent sessions unless the journal knows them.
5. Decision records (`metadata.ctree.kind === "decision"`) are never cropped.
6. The hook is idempotent: running it twice on the same array yields the same result.

---

## 9. Edge cases and failure modes

| Situation | Behaviour |
|---|---|
| Jump/branch while the assistant is streaming | abort first (`session.abort`), toast, then fork. (Pi #7022 lesson.) |
| Fork of a session with a pending revert | OpenCode deletes reverted messages on the next prompt; we fork *before* that, so the fork contains them. Warn: "session has a pending undo; `/redo` first?" |
| Session deleted in OpenCode (`session.deleted` event) | `session.forgotten` line; the tree keeps the edge, drawn grey; its children re-anchor visually to the grandparent. |
| Journal lost | rebuild edges from `session.list()` + `metadata.ctree`; crops/labels are gone; toast once. |
| Compaction happened on the trunk | ◆ records re-injected via `session.compacting`; crops before the boundary marked moot. |
| Merge draft fails (model error, abort) | nothing written; helper session deleted; toast with the error. |
| Editor exits non-zero or file empty | abort; branch stays open. |
| Server half missing | tree/branch/merge/undo work; `/crop` shows "needs server plugin" with the config snippet. |
| Hook fires for a subagent session | journal has no entry → no-op. |
| Two branches named the same | allowed; disambiguated by anchor in the UI, `--tournament` uses `(parent, anchor)` not names. |
| Very long sessions (>2k messages) | `session.messages` is paged (`limit`/`before`); the route loads the active session fully and other branches lazily on expand (as `opencode-tree` does). |
| OpenCode v2 (`opencode2`, next) | TUI plugin loading from `tui.json` is currently broken there (#36525); v2 adds `session.context`, staged reverts, `SessionMessageCompaction`. Keep `core` free of SDK types and put the v1↔v2 mapping in `server`/`tui` adapters. |

"Toast" above means OpenCode's toast when the action runs from the palette or after the route has navigated away; inside `/tree` the same message goes to the route's status-line notice, because toasts raised while the route is mounted never render.

---

## 10. Comparison

| Capability | Pi `/tree` | `pi-context-tree` | OpenCode built-in | `@ishaksebsib/opencode-tree` | **this plugin** |
|---|---|---|---|---|---|
| Tree of branches | in-file | in-file | none (flat forks) | tree of sessions | tree of sessions + trajectory |
| Jump to any node | ✓ | ✓ | `/fork` (user msgs only) | ✓ | ✓ (fork or switch) |
| Named branch, model per branch | ✗ / ✗ | ✓ / ✓ | ✗ | ✗ | ✓ / ✓ |
| Merge as human-confirmed record | ✗ (auto summary) | ✓ squash/discard/tournament | ✗ | ✗ (auto summary) | ✓ same modes |
| Crop results / drop turns | ✗ | ✓ (reconstruction block) | auto prune only | ✗ | ✓ true per-message view |
| Undo of mutations | leaf move | ✓ | revert (deletes) | ✗ | ✓ |
| Per-node tokens, consumers, gauge | ✗ | ✓ | ✗ | ✗ | ✓ |
| Timing lanes, inspector (DSH) | ✗ | ✗ | ✗ | ✗ | ✓ |
| Labels, filters, search | ✓ | ✓ | ✗ | ✗ | ✓ |
| Works in desktop/web clients | n/a | n/a | ✓ | ✗ | partially (headless `/ctree`, branches as sessions) |

---

## 11. Roadmap

| Milestone | Deliverable | Verifies |
|---|---|---|
| **M0 spike** — done, see `docs/M0.md` | harness + spike plugins for both halves; all five behaviours verified, plus a bundled JSX route | tui.json-only loading; in-place hook mutation; `metadata` round-trip; `renderer.suspend`; `chat.message` model override |
| **M1 tree** — done | route with gutter, fold/expand, jump (fork/switch), `/branch`, labels, filters, search, `api.kv` memory | pty e2e: branch, switch both ways |
| **M2 cost** — done | tokens per row, minimap lanes, gauge slot with trend/attribution and compaction guard, consumers view, sidebar card | screen snapshots |
| **M3 crop** — done | crop mode (result/turn), `--top`, `--auto`, protections, `/undo` for crops, headless `/ctree crop` | e2e: stub reaches the provider, undo restores |
| **M4 merge** — done | draft → editor gate → ◆ record; discard; tournament; decisions view + export; `/undo` for merges; compaction re-injection | e2e: record reaches the provider, undo re-opens |
| **M5 trajectory** — done (partly) | inspector facets, Duration/Turns/Calls modes; idle separators and nested subagent rows not yet | screen snapshots |
| **M6 polish** — in progress | docs/USAGE.md, headless `/ctree`, LICENSE, package metadata done; keybind options, v2 adapter, hard-crop option, `--purge`, npm release pending | |

---

## 12. Decisions made (2026-09-02)

| # | Decision | Chosen |
|---|---|---|
| 1 | Package and slash names | **`opencode-context-tree`**; slash `/tree` with alias `/ctree`; headless server commands are `/ctree …`. The `/tree` name only collides if `@ishaksebsib/opencode-tree` is installed alongside. |
| 2 | Journal location | **Local**, `<worktree>/.opencode/context-tree/`, gitignored by default. `storage: "global"` remains an option. |
| 3 | Summarize on jump | **Ask every time** (Pi behaviour): No / Summarize / Custom prompt. `jumpSummary: "never"` opts out. Summaries are journalled as ◇ unreviewed and are distinct from ◆ merge records. |
| 4 | Undo of a squash | **Hide the ◆ record from the model, keep it on screen.** Journal marks it inactive; the hook drops it; OpenCode storage untouched. No delete path in v1. |
| 5 | Code base | **From scratch, spec-driven.** Port the `pi-context-tree` *semantics* (merge modes, crop protections, undo rules, gauge bands, decision template) and its *method* (pure `core` reducers, journal fold, golden fixtures, table-driven view-model tests), but write all code against OpenCode's message/part/session model. Do not fork `@ishaksebsib/opencode-tree` (unmaintained) or copy Pi entry-based code; read both only as API references. Reliability rule: every OpenCode API the plugin depends on gets an integration test against `opencode serve` with a mock provider before it is used by a feature. |

## Appendix A — sources

- OpenCode source `anomalyco/opencode` @ `69c172e`: `packages/plugin/src/{index,tui,tool}.ts`,
  `packages/opencode/src/session/{prompt,compaction,message-v2,session,revert}.ts`,
  `packages/tui/src/editor.ts`, `packages/opencode/src/plugin/tui/runtime.ts`.
- `@opencode-ai/plugin` / `@opencode-ai/sdk` 1.18.26 type declarations (npm).
- OpenCode docs: plugins, tui, keybinds. Issues #22610, #36525, #1020, #25494, #29980.
- Pi `earendil-works/pi` @ `b8b873b`: `session-manager.ts`, `tree-selector.ts`,
  `agent-session.ts#navigateTree`, `branch-summarization.ts`, docs `sessions.md`,
  `session-format.md`, `compaction.md`; issues #735, #5366, #982, #2796, #6910.
- `navbytes/pi-context-tree` 0.3.1: README, `docs/USAGE.md`, `docs/pi-context-tree-spec.md`,
  `docs/pi-context-tree-architecture.md`.
- `@ishaksebsib/opencode-tree` 0.4.2 (npm dist + README), `Opencode-DCP` 3.1.15 source.
- DeepSeek Harness v0.1: screenshot of the Trajectory tab, deepseek.com/harness, gigazine
  2026-08-14, community write-ups (session log envelope `{type, seq, time, data}`).
