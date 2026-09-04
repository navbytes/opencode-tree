# Handover: `claude/pi-context-tree-workflow-sjuutd`

You are taking over from a Claude Code **web** session. Its container cannot run the
plugin's server half at all (see §3), so one of the five commits on this branch is
**unverified** and must not be merged until you run one command (§4).

Delete this file before merging.

---

## 1. State

- Repo `navbytes/opencode-tree`, branch **`claude/pi-context-tree-workflow-sjuutd`**,
  5 commits on top of `main` (`2266966`). All pushed. No PR opened yet.
- `v0.2.3` is released. The changelog has an `## Unreleased` section for this work.
- Locally green: `bun run typecheck`, `bun test` (**289 pass, 0 fail**), `bun run build`.

```
12feb2a debug: log when the server half loads
8e28af4 e2e: say why the system snapshot is missing instead of ENOENT
8adb027 Capture the system prompt on plain sessions too, and prove it end to end
25a78d3 Count the system prompt in the consumers view
9abd80c Lanes fill the terminal, like the rows do
```

## 2. What the commits do, and how far each is trusted

### `9abd80c` — lanes fill the terminal. **Verified. Merge with confidence.**

The three lane rows stopped short of the right edge for two reasons in one expression:

```ts
const laneWidth = () => Math.max(10, Math.min(width() - 61, 80))
```

A hard **cap of 80** cells (71 blank columns at 200 cols, 111 at 240), and a **reserve of
61** for chrome that prints 49 — stale, because it was sized for a mode legend that still
said `· 3 calls`.

Now `width() + 2 - LANE_CHROME`. The `+ 2` matters: a row draws its `│ ` prefix *outside*
its padded width while a lane label carries its own inside its 12, so without it the lanes
land two columns short of the rows. `LANE_CHROME` is now **measured** from the label and
legend strings in `core/lanes.ts`, not written down — that's the fix for the bug class, and
4 tests pin the invariants it needs (legend same width in both modes, label fixed width for
every lane name with and without a cue, etc.).

### `25a78d3` — `≡ system prompt` bucket in consumers. **Pure layer verified; the wiring is not.**

Consumers walked the transcript only, so its total could never reconcile with the `ctx …`
gauge two lines above it, which reads `tokens.input` and *does* include the system prompt —
a silently missing 5–15k on an agent with a big base prompt and an `AGENTS.md`.

8 tests cover `consumers()` directly: bucket accounting, one entry per part sorted
biggest-first, none croppable, shares still summing to 1, and absent-vs-empty (no snapshot
shows **no bucket**, never a misleading `0`). Store round-trip/overwrite/corrupt-file/
per-session isolation are covered too.

What is **not** covered: whether the snapshot the TUI reads ever gets written. That is §4.

### `8adb027` — capture on plain sessions + the e2e. **UNVERIFIED. Do not merge yet.**

Two things:

1. A **real bug fix**, sound regardless of §4: the capture was gated on
   `stateForSession(sessionID)`, but a session is only registered by a branch/fork/adoption
   — so on a plain session that never branches (the common case) the capture would never
   have fired and the bucket would silently never appear. The capture is now ungated; the
   `Context notes:` push below it keeps its gate, because that note only makes sense for
   sessions the plugin manages.
2. The e2e that is supposed to prove the whole thing, which could not run here.

### `8e28af4`, `12feb2a` — diagnostics. Keep.

The e2e now fails with the capture's own debug lines instead of a bare `ENOENT`, and the
server plugin logs `server.loaded`. These are what §4 reads.

## 3. Why the web session could not verify it — read this before you debug anything

**The plugin's server half does not run in that container.** Established, not assumed:

- `opencode serve` never binds there. A bare `opencode serve` in an empty directory with
  **no plugin installed** was started and killed at timeout having printed nothing.
- The `test/e2e/server.test.ts` suite fails 5/9 with `ConnectionRefused`, in isolation.
- Decisively: the **crop** TUI e2e (`crop in the tree hides a tool result…`), which requires
  `experimental.chat.messages.transform` to run, **fails identically on clean `main`** at
  the same assertion (`tui.test.ts:71`, `[cropped: bash` never reaching the provider). It
  was run in a separate worktree at `2266966` with none of this branch's changes.

So the pty-driven TUI e2e boots a real OpenCode whose **server-side plugin never executes**.
Four diagnostic runs were spent before this was pinned down; they measured nothing.

**Corollary:** if the crop e2e also fails on your machine, stop and fix the harness first —
nothing server-side can be verified until it passes, and this branch is not the cause.

## 4. The one thing to run

```sh
bun install
CTREE_E2E=1 CTREE_DEBUG=/tmp/ctree.log bun test --timeout 400000 \
  -t "captures the real system prompt" test/e2e/tui.test.ts
```

First run downloads `opencode-ai@1.18.26` into `harness/` (~3 min, and it counts against
the test's own timeout — a first run may time out; just run it again).

The test drives a real TUI on a **plain session that never branches**, then asserts:

1. `.opencode/context-tree/system-<id>.json` exists with ≥1 part and >200 chars,
2. our own `Context notes:` is **not** in the snapshot (captured before we push it),
3. `≡ system prompt` appears on screen after pressing `s` in `/tree`.

### Reading the outcome from `/tmp/ctree.log`

| What you see | Meaning | Do |
|---|---|---|
| `system.captured` with `parts: N>0`, test green | The assumption holds | Merge all 5. Open a PR; delete this file. |
| `system.captured` with `parts: 0` | `output.system` arrives **empty** | See §5 — this is a shipped bug, and `25a78d3`/`8adb027` need rethinking |
| No `system.captured`, but `server.loaded` present | The hook never fires on this path | Same as above |
| Neither line | The server half isn't loading on your machine either | Harness problem — run the crop test as a control |

## 5. The pre-existing bug this may expose

The whole feature rests on `experimental.chat.system.transform` handing us
`output: { system: string[] }` **already carrying OpenCode's own parts**, so appending adds
our note. The hook name is correct — it is present in the 1.18.26 binary (verified by
`grep`ing it). But:

- **Nothing has ever tested that this hook fires.** `test/e2e/server.test.ts:52` asserts the
  provider receives *a* system message; nothing asserts our `Context notes:` string is in it.
- If §4 shows `parts: 0` or no call at all, then the plugin's `Context notes:` — which tells
  the model how to read `◆` records and `[cropped: …]` stubs — **has never been delivered**,
  and `applyCrops` has been shipping stubs the model was never told how to interpret.

That would be a bigger bug than the feature that surfaced it. Worth a focused test either
way: assert `Context notes:` reaches the mock provider's system message on a session that
*has* branched (the note is gated on tree membership, so a plain session legitimately won't
have it — don't be fooled by that).

## 6. Known gaps, deliberately left

- **Tool-definition schemas are still uncounted.** `client.tool.list` gives descriptions but
  not what the provider actually receives, so the estimate would be rough enough to mislead.
  That is the last unattributed chunk between consumers' total and the `ctx` gauge.
- **Snapshot files grow with sessions** — one small JSON per session that ever made a
  request, in the gitignored plugin dir, overwritten in place and skipped entirely when the
  prompt shape is unchanged (in-memory hash per session). Bounded per session, unbounded in
  session count. Prune if it ever matters.
- **Part naming is a shallow heuristic** (`AGENTS.md`, `CLAUDE.md`, `environment`, `date`,
  else `base prompt`) over the first 400 chars. It never throws; a miss just reads
  `system prompt N`.
- **`y` is the only way to read a system part.** It is not a message, so it has no row and
  no inspector. `y` in the consumers panel copies the selected part in full.

## 7. If you need to change direction

If §4 comes back bad, the fallback that needs no hook: derive the system prompt's *size*
(not its text) by subtracting everything else from an assistant message's `tokens.input`.
That gives one number for a `≡ system + tools` bucket with no per-part breakdown and no
copyable text — much weaker, but it cannot be wrong about the total, and it would also cover
the tool definitions from §6.
