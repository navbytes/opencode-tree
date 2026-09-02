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
- `pty-run.py` — minimal pty driver (`--keys "<seconds>:<text>"`, `\r` Enter, `\x03` ctrl+c, `\x1b` Esc); writes raw and ANSI-stripped captures.
