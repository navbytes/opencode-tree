import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const CORE_DIR = path.join(import.meta.dir, "..", "src", "core")
const FORBIDDEN = [/@opencode-ai/, /@opentui/, /(^|["'])solid-js(["'/]|$)/]

function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listFiles(full))
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full)
  }
  return out
}

describe("core purity", () => {
  const files = listFiles(CORE_DIR)

  test("finds core source files to check", () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of listFiles(CORE_DIR)) {
    test(`${path.relative(CORE_DIR, file)} imports nothing from OpenCode/opentui/solid-js`, () => {
      const contents = readFileSync(file, "utf8")
      const importLines = contents
        .split("\n")
        .filter((line) => /^\s*import\b/.test(line) || /^\s*export\s+.*\bfrom\b/.test(line))
      for (const line of importLines) {
        for (const pattern of FORBIDDEN) {
          expect(pattern.test(line)).toBe(false)
        }
      }
    })
  }
})
