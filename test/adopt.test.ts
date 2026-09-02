import { describe, expect, test } from "bun:test"
import { expectedParentTitle, findForkParent, parseForkTitle, pickAdoptables, type ForkCandidate, type ForkMessage, type SessionInfo } from "../src/core/adopt.js"

function messages(prefix: string, roles: ("user" | "assistant")[], from = 1000): ForkMessage[] {
  return roles.map((role, i) => ({ id: `${prefix}_${i}`, role, created: from + i }))
}

function session(id: string, title: string, created: number, msgs: ForkMessage[], parentID?: string): ForkCandidate {
  return { id, title, created, messages: msgs, ...(parentID ? { parentID } : {}) }
}

describe("parseForkTitle", () => {
  test("parses the first fork", () => {
    expect(parseForkTitle("Fix the flaky test (fork #1)")).toEqual({ base: "Fix the flaky test", n: 1 })
  })

  test("parses double digits", () => {
    expect(parseForkTitle("Fix the flaky test (fork #12)")).toEqual({ base: "Fix the flaky test", n: 12 })
  })

  test("rejects titles that only look like forks", () => {
    expect(parseForkTitle("Fix the flaky test")).toBeUndefined()
    expect(parseForkTitle("(fork #1)")).toBeUndefined()
    expect(parseForkTitle("Fix (fork #x)")).toBeUndefined()
    expect(parseForkTitle("Fix (fork #0)")).toBeUndefined()
  })

  test("expectedParentTitle walks one step back up the chain", () => {
    expect(expectedParentTitle("Fix it (fork #1)")).toBe("Fix it")
    expect(expectedParentTitle("Fix it (fork #3)")).toBe("Fix it (fork #2)")
    expect(expectedParentTitle("Fix it")).toBeUndefined()
  })
})

describe("findForkParent", () => {
  const parentMessages = messages("m", ["user", "assistant", "user", "assistant"])

  test("matches the copied prefix and anchors at its last shared message", () => {
    const parent = session("s_parent", "Fix it", 100, parentMessages)
    const fork = session("s_fork", "Fix it (fork #1)", 200, messages("f", ["user", "assistant"]))
    expect(findForkParent(fork, [parent])).toEqual({ parentID: "s_parent", anchorMessageID: "m_1" })
  })

  test("a full copy anchors at the parent's last message", () => {
    const parent = session("s_parent", "Fix it", 100, parentMessages)
    const fork = session("s_fork", "Fix it (fork #1)", 200, messages("f", ["user", "assistant", "user", "assistant"]))
    expect(findForkParent(fork, [parent])?.anchorMessageID).toBe("m_3")
  })

  test("rejects a candidate whose roles or timestamps differ", () => {
    const parent = session("s_parent", "Fix it", 100, parentMessages)
    const wrongRole = session("s_other", "Fix it", 100, messages("o", ["assistant", "assistant", "user", "assistant"]))
    const wrongTime = session("s_late", "Fix it", 100, messages("l", ["user", "assistant", "user", "assistant"], 5000))
    const fork = session("s_fork", "Fix it (fork #1)", 200, messages("f", ["user", "assistant"]))
    expect(findForkParent(fork, [wrongRole, wrongTime])).toBeUndefined()
    expect(findForkParent(fork, [wrongRole, wrongTime, parent])?.parentID).toBe("s_parent")
  })

  test("rejects a candidate with fewer messages than the fork", () => {
    const shortParent = session("s_parent", "Fix it", 100, messages("m", ["user"]))
    const fork = session("s_fork", "Fix it (fork #1)", 200, messages("f", ["user", "assistant"]))
    expect(findForkParent(fork, [shortParent])).toBeUndefined()
  })

  test("a fork with no copied messages cannot be anchored", () => {
    const parent = session("s_parent", "Fix it", 100, parentMessages)
    const fork = session("s_fork", "Fix it (fork #1)", 200, [])
    expect(findForkParent(fork, [parent])).toBeUndefined()
  })

  test("prefers the expected title over a grandparent that also matches", () => {
    const grandparent = session("s_root", "Fix it", 100, parentMessages)
    const parent = session("s_mid", "Fix it (fork #1)", 150, parentMessages)
    const fork = session("s_fork", "Fix it (fork #2)", 200, messages("f", ["user", "assistant"]))
    // the grandparent is newer here, so only the title expectation can pick the right one
    expect(findForkParent(fork, [{ ...grandparent, created: 190 }, parent])?.parentID).toBe("s_mid")
  })

  test("falls back to the most recently created match", () => {
    const older = session("s_old", "Something else", 100, parentMessages)
    const newer = session("s_new", "Something else", 180, parentMessages)
    const fork = session("s_fork", "Renamed by the user", 200, messages("f", ["user", "assistant"]))
    expect(findForkParent(fork, [older, newer])?.parentID).toBe("s_new")
  })

  test("never matches a subagent child or the fork itself", () => {
    const child = session("s_child", "Fix it", 100, parentMessages, "s_parent")
    const fork = session("s_fork", "Fix it (fork #1)", 200, messages("f", ["user", "assistant"]))
    expect(findForkParent(fork, [child])).toBeUndefined()
    expect(findForkParent(fork, [{ ...fork, messages: parentMessages }])).toBeUndefined()
  })
})

describe("pickAdoptables", () => {
  const sessions: SessionInfo[] = [
    { id: "s_fork2", title: "Fix it (fork #2)", created: 300 },
    { id: "s_current", title: "Renamed by hand", created: 250 },
    { id: "s_fork1", title: "Fix it (fork #1)", created: 200 },
    { id: "s_plain", title: "Unrelated work", created: 150 },
    { id: "s_child", title: "Fix it (fork #1)", created: 120, parentID: "s_plain" },
  ]

  test("takes fork-titled sessions, oldest first", () => {
    expect(pickAdoptables(sessions, new Set()).map((s) => s.id)).toEqual(["s_fork1", "s_fork2"])
  })

  test("skips registered sessions, subagent children and untitled strangers", () => {
    expect(pickAdoptables(sessions, new Set(["s_fork1"])).map((s) => s.id)).toEqual(["s_fork2"])
  })

  test("a renamed fork — even the session you are in — is not adopted blindly", () => {
    expect(pickAdoptables(sessions, new Set()).map((s) => s.id)).not.toContain("s_current")
  })
})
