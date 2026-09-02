/** Opt-in file logging: set CTREE_DEBUG=/path/to/log. No-op otherwise. */
import fs from "node:fs"
const target = process.env["CTREE_DEBUG"]
export function debug(event: string, data?: Record<string, unknown>): void {
  if (!target) return
  try {
    fs.appendFileSync(target, `${JSON.stringify({ ts: Date.now(), event, ...data })}\n`)
  } catch {}
}
