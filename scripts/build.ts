/**
 * Builds the two plugin entry points (DESIGN.md §8):
 *   src/server/index.ts  -> dist/server.js  (plain Bun bundle)
 *   src/tui/index.tsx    -> dist/tui.js     (Solid JSX, via @opentui/solid's bun plugin)
 *
 * Both externalize @opencode-ai/*, @opentui/*, and solid-js: the host TUI/server
 * provide those at runtime (see DESIGN.md §3.2 and the verified build recipe).
 */
import solidPlugin from "@opentui/solid/bun-plugin"
import pkg from "../package.json"

const EXTERNAL = ["@opencode-ai/*", "@opentui/*", "solid-js", "solid-js/*"]

async function build(entrypoint: string, outdir: string, outFile: string, withSolid: boolean) {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: "bun",
    format: "esm",
    naming: outFile,
    plugins: withSolid ? [solidPlugin] : [],
    external: EXTERNAL,
    define: { __CTREE_VERSION__: JSON.stringify(pkg.version) },
  })
  if (!result.success) {
    console.error(`build failed: ${entrypoint}`)
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  for (const output of result.outputs) console.log(`${output.path} ${output.size}B`)
}

// Both entry files are literally named "index" (index.ts vs index.tsx), so each
// build passes an explicit `naming` to land at dist/server.js and dist/tui.js —
// matching package.json's "exports".
await build("src/server/index.ts", "dist", "server.js", false)
await build("src/tui/index.tsx", "dist", "tui.js", true)
