# Changelog

## 0.1.0 (unreleased)

First working version, built against OpenCode 1.18.26.

- `/tree` (`ctrl+q`, `/ctree`, `/panel`): combined tree + trajectory view — spine rows with a
  git-log gutter, fold/expand branches, jump (switch or fork with Pi's summarize-on-leave
  picker), labels, filters, search, Input/Model/Tools lanes with Duration/Turns/Calls
  modes, inspector pane, consumers view.
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
- Headless `/ctree status|branch|crop|undo|decisions` for non-TUI clients.
- Options: `storage`, `jumpSummary`, `hardCrop`, `keybinds` (including `open`).
- Harness: mock provider, pty driver with pyte screen snapshots, Bun e2e suite.
