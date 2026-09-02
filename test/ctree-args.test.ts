import { describe, expect, test } from "bun:test"
import { parseCtreeArgs } from "../src/core/ctree-args.js"

describe("parseCtreeArgs", () => {
  test("subcommands", () => {
    expect(parseCtreeArgs("")).toEqual({ kind: "help" })
    expect(parseCtreeArgs("status")).toEqual({ kind: "status" })
    expect(parseCtreeArgs("branch fix haiku/x")).toEqual({ kind: "branch", name: "fix", model: "haiku/x" })
    // only a provider/model-shaped last token is a model; a multi-word name stays a name
    expect(parseCtreeArgs("branch fix flaky test")).toEqual({ kind: "branch", name: "fix flaky test", model: undefined })
    expect(parseCtreeArgs("branch fix flaky test anthropic/haiku-4.5")).toEqual({ kind: "branch", name: "fix flaky test", model: "anthropic/haiku-4.5" })
    expect(parseCtreeArgs("branch").kind).toBe("help")
    expect(parseCtreeArgs("crop --top")).toEqual({ kind: "crop-top", apply: false, force: false })
    expect(parseCtreeArgs("crop --top --apply --force")).toEqual({ kind: "crop-top", apply: true, force: true })
    expect(parseCtreeArgs("crop --auto --apply --min-tokens 5000 --older-than 3 --keep chrome.* --keep read")).toEqual({ kind: "crop-auto", apply: true, minTokens: 5000, olderThan: 3, keep: ["chrome.*", "read"] })
    expect(parseCtreeArgs("crop").kind).toBe("help")
    expect(parseCtreeArgs("undo")).toEqual({ kind: "undo" })
    expect(parseCtreeArgs("merge").kind).toBe("help")
    expect(parseCtreeArgs("merge --squash").kind).toBe("help")
    expect(parseCtreeArgs("merge --discard")).toEqual({ kind: "merge-discard", note: undefined })
    expect(parseCtreeArgs("merge --discard dead end")).toEqual({ kind: "merge-discard", note: "dead end" })
    expect(parseCtreeArgs("decisions")).toEqual({ kind: "decisions", export: undefined })
    expect(parseCtreeArgs("decisions --export")).toEqual({ kind: "decisions", export: "ctree-decisions.md" })
    expect(parseCtreeArgs("decisions --export out/dec.md")).toEqual({ kind: "decisions", export: "out/dec.md" })
    expect(parseCtreeArgs("bogus").kind).toBe("help")
  })
  test("crop --auto rejects non-numeric values and never eats the next flag", () => {
    expect(parseCtreeArgs("crop --auto --apply --min-tokens abc")).toEqual({ kind: "help", error: "--min-tokens needs a number, e.g. --min-tokens 10000" })
    expect(parseCtreeArgs("crop --auto --min-tokens --apply").kind).toBe("help")
    expect(parseCtreeArgs("crop --auto --older-than 1.5x").kind).toBe("help")
    expect(parseCtreeArgs("crop --auto --keep --apply").kind).toBe("help")
    expect(parseCtreeArgs("crop --auto --apply")).toEqual({ kind: "crop-auto", apply: true, minTokens: undefined, olderThan: undefined, keep: [] })
  })
})
