import { describe, expect, test } from "bun:test"
import { parseCtreeArgs } from "../src/core/ctree-args.js"

describe("parseCtreeArgs", () => {
  test("subcommands", () => {
    expect(parseCtreeArgs("")).toEqual({ kind: "help" })
    expect(parseCtreeArgs("status")).toEqual({ kind: "status" })
    expect(parseCtreeArgs("branch fix haiku/x")).toEqual({ kind: "branch", name: "fix", model: "haiku/x" })
    expect(parseCtreeArgs("branch").kind).toBe("help")
    expect(parseCtreeArgs("crop --top")).toEqual({ kind: "crop-top", apply: false, force: false })
    expect(parseCtreeArgs("crop --top --apply --force")).toEqual({ kind: "crop-top", apply: true, force: true })
    expect(parseCtreeArgs("crop --auto --apply --min-tokens 5000 --older-than 3 --keep chrome.* --keep read")).toEqual({ kind: "crop-auto", apply: true, minTokens: 5000, olderThan: 3, keep: ["chrome.*", "read"] })
    expect(parseCtreeArgs("crop").kind).toBe("help")
    expect(parseCtreeArgs("undo")).toEqual({ kind: "undo" })
    expect(parseCtreeArgs("bogus").kind).toBe("help")
  })
})
