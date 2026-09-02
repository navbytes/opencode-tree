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
  // private dir + 0600: the draft can quote source, and /tmp is world-readable
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctree-"))
  const file = path.join(dir, "decision.md")
  fs.writeFileSync(file, value, { mode: 0o600 })
  renderer.suspend()
  renderer.currentRenderBuffer?.clear?.()
  try {
    await new Promise<void>((resolve, reject) => {
      const options = { cwd: cwd && fs.existsSync(cwd) ? cwd : process.cwd(), stdio: "inherit" as const }
      // through the shell, like OpenCode's own openEditor(): $EDITOR may carry flags or quotes
      const child = process.platform === "win32" ? spawn(editor, [file], { ...options, shell: true }) : spawn("sh", ["-c", `${editor} "$1"`, "sh", file], options)
      child.on("error", reject)
      child.on("exit", (code, signal) => (code === 0 ? resolve() : reject(new Error(`editor exited with ${signal ? `signal ${signal}` : `code ${code}`}`))))
    })
    const text = fs.readFileSync(file, "utf8")
    return text.trim() ? text : undefined
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    renderer.currentRenderBuffer?.clear?.()
    renderer.resume()
    renderer.requestRender?.()
  }
}
