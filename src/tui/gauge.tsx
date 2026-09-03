/** @jsxImportSource @opentui/solid */
/**
 * The context gauge (DESIGN.md §6.7): `ctx ▓▓░░░ ~2.3k/32.8k · low · 95% cached`. One
 * component so the prompt slot and the `/tree` header can never drift apart — the bar's
 * filled cells split into a muted cached run and a band-coloured fresh run, and the cached
 * suffix is muted too. Renders the exact characters `formatContext` would, just recoloured.
 */
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { Show, type JSX } from "solid-js"
import { bandFor, cacheShare, contextBarCells, formatK, type ContextSize } from "../core/tokens.js"

const BAND_COLOR = { low: "success", healthy: "success", filling: "warning", red: "error" } as const

/** `@opentui/solid`'s `SpanProps` omits `fg`/`bg` even though the `SpanRenderable` it wraps
 *  accepts them the same as `<text fg=...>`'s `TextRenderable` does — one cast here rather
 *  than at every run below. */
function Span(props: { fg: unknown; children?: JSX.Element }) {
  return <span {...(props as any)} />
}

export function ContextGauge(props: { theme: TuiThemeCurrent; size: ContextSize; limit?: number; showCachedSuffix?: boolean }) {
  const band = () => bandFor(props.size.tokens, props.limit)
  const fg = () => props.theme[BAND_COLOR[band()]]
  const share = () => cacheShare(props.size)
  const cells = () => contextBarCells(props.size, props.limit ?? 0)
  const numbers = () => `${props.size.estimated ? "~" : ""}${formatK(props.size.tokens)}${props.limit ? `/${formatK(props.limit)}` : ""} · ${band()}`
  return (
    // one <text> of <span>s, not a row box: a box's children lay out side by side and clip
    // instead of soft-wrapping, which broke the narrow sidebar card (DESIGN.md §7 wrapping note)
    <text>
      <Span fg={fg()}>ctx </Span>
      <Show when={props.limit}>
        <Span fg={props.theme.textMuted}>{"▓".repeat(cells().cached)}</Span>
        <Span fg={fg()}>{`${"▓".repeat(cells().fresh)}${"░".repeat(cells().empty)} `}</Span>
      </Show>
      <Span fg={fg()}>{numbers()}</Span>
      {/* the narrow sidebar card passes false: its own absolute line right below already says it */}
      <Show when={share() !== undefined && props.showCachedSuffix !== false}>
        <Span fg={props.theme.textMuted}>{` · ${share()}% cached`}</Span>
      </Show>
    </text>
  )
}
