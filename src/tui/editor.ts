/**
 * The merge editor gate (DESIGN.md §6.4): suspend the renderer, hand the draft to
 * $VISUAL/$EDITOR on a temp file, resume. Mirrors OpenCode's own `openEditor()`.
 * Returns `undefined` when no editor is configured or the user aborted (non-zero
 * exit / empty file).
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

type RendererLike = { suspend(): void; resume(): void; requestRender?(): void; currentRenderBuffer?: { clear?(): void } }

export function hasEditor(): boolean {
  return Boolean(process.env["VISUAL"] || process.env["EDITOR"])
}

export async function editInExternalEditor(renderer: RendererLike, value: string, cwd?: string): Promise<string | undefined> {
  const editor = process.env["VISUAL"] || process.env["EDITOR"]
  if (!editor) return undefined
  const file = path.join(os.tmpdir(), `ctree-decision-${Date.now()}.md`)
  fs.writeFileSync(file, value)
  renderer.suspend()
  renderer.currentRenderBuffer?.clear?.()
  try {
    await new Promise<void>((resolve, reject) => {
      const parts = editor.split(" ")
      const child = spawn(parts[0]!, [...parts.slice(1), file], { cwd: cwd && fs.existsSync(cwd) ? cwd : process.cwd(), stdio: "inherit", shell: process.platform === "win32" })
      child.on("error", reject)
      child.on("exit", (code, signal) => (code === 0 ? resolve() : reject(new Error(`editor exited with ${signal ? `signal ${signal}` : `code ${code}`}`))))
    })
    const text = fs.readFileSync(file, "utf8")
    return text.trim() ? text : undefined
  } finally {
    fs.rmSync(file, { force: true })
    renderer.currentRenderBuffer?.clear?.()
    renderer.resume()
    renderer.requestRender?.()
  }
}
