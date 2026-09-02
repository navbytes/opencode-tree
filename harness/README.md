# harness — run OpenCode headless against a mock provider

Used for the M0 spike and for the integration tests going forward. Nothing here
touches your real OpenCode config: all XDG dirs are redirected under `harness/env/`.

```sh
cd harness && npm init -y >/dev/null && npm i opencode-ai@1.18.26   # local binary
source env.sh
./restart.sh 1            # mock provider on :4010 (MOCK_TOOL=1 answers the first turn with a bash tool call) + `opencode serve` on :4096
./test-server.sh          # server-side checks: transform hook, chat.message model override, metadata round-trip, fork
# TUI checks (scripted keys into a pty; EDITOR is a fake editor that appends a line):
cd project && SPIKE_LOG=../spike-plugin.log EDITOR=../fake-editor.sh python3 ../pty-run.py --cols 120 --rows 30 --timeout 30 \
   --keys '8:hello\r' --keys '15:/spikeedit' --keys '17:\r' --keys '25:\x03' --keys '27:\x03' -- opencode
```

- `mock-provider.mjs` — OpenAI-compatible chat/completions (SSE + JSON), records every request body to `requests.jsonl`.
- `project/` — a throw-away git repo with `opencode.json` (provider `mock`, models `mock-a`/`mock-b`) and `.opencode/tui.json` listing the TUI spike plugins.
- `project/.opencode/plugins/spike.ts` — server spike (crop stub in `experimental.chat.messages.transform`, model override in `chat.message`).
- `project/.opencode/plugins/spike-tui.ts` — TUI spike without JSX (`/spikestate`, `/spikeedit` editor gate).
- `project/.opencode/plugins/spike-route.tsx` + `build.ts` — JSX route spike; build with `bun run build.ts` after `bun add @opencode-ai/plugin@1.18.26 solid-js @opentui/core @opentui/solid @opentui/keymap`, then list `./plugins/spike-route.js` in `tui.json`.
- `pty-run.py` — pty driver: `--keys "<seconds>:<text>"` (timed) or `--keys "@<regex>+<seconds>:<text>"` (wait for text on screen), `\r` Enter, `\x03` ctrl+c, `\x1b` Esc; `--exit-when-done`. Writes the raw capture, an ANSI-stripped dump, and — when `pyte` is installed (`pip install pyte`) — `<out>.screens.txt` with the fully composed screen before every key and at the end. Screen dumps are the reliable thing to assert on; the stripped stream is diff-based and misses redraws.

## Bun e2e (`bun run test:e2e`)

`test/e2e/harness.ts` wraps the same pieces for `bun test`: `startMock()`, `createProject()`
(temp git repo seeded from `harness/project/opencode.json`), `installPlugins()`, `startServer()`
(fresh XDG dirs per run), `runTui()` (pty with timed or wait-for-text keys). Gated by
`CTREE_E2E=1`; plain `bun test` skips it.

Two Bun quirks the harness works around, both observed on Bun 1.3.11 / OpenCode 1.18.26:

- piping `opencode serve`'s stdio through `Bun.spawn` stalls the server before it listens, so
  stderr goes to a file and stdout is ignored;
- a `fetch` issued before the port is bound can hang instead of failing, so every health probe
  has its own 2 s abort.
