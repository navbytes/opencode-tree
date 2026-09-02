import solidPlugin from "@opentui/solid/bun-plugin"
const result = await Bun.build({
  entrypoints: ["./spike-route.tsx"],
  outdir: "./dist",
  target: "bun",
  format: "esm",
  plugins: [solidPlugin],
  external: ["solid-js", "solid-js/*", "@opentui/*", "@opencode-ai/*"],
})
if (!result.success) { console.error(result.logs); process.exit(1) }
console.log(result.outputs.map((o) => `${o.path} ${o.size}B`).join("\n"))
