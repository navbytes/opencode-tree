import { describe, expect, test } from "bun:test"
import { applyCrops, type CropSpec, type MinimalMessage } from "../src/core/crop.js"

function fixture(): MinimalMessage[] {
  return [
    {
      info: { id: "m1", role: "user", sessionID: "s1" },
      parts: [{ id: "m1p1", type: "text", text: "Build yourself a tool" }],
    },
    {
      info: { id: "m2", role: "assistant", sessionID: "s1" },
      parts: [
        {
          id: "m2p1",
          type: "tool",
          tool: "bash",
          callID: "c1",
          state: { status: "completed", input: { command: "bun test src/foo.test.ts" }, output: "total 744 tests, 0 failed" },
        },
      ],
    },
    {
      info: { id: "m3", role: "user", sessionID: "s1" },
      parts: [{ id: "m3p1", type: "text", text: "decompress the session and continue" }],
    },
  ]
}

describe("applyCrops — result mode", () => {
  test("stubs a completed bash tool result, keeping input/callID intact", () => {
    const messages = fixture()
    const crop: CropSpec = {
      mode: "result",
      anchorMessageID: "m2",
      targets: [{ messageID: "m2", callID: "c1", tool: "bash", estTokens: 4700, sha8: "3f9a1c2e" }],
    }
    applyCrops(messages, [crop])

    const toolPart = messages[1]!.parts[0]!
    expect(toolPart.state?.output).toBe('[cropped: bash "bun test src/foo.test.ts", ~4.7k tokens, sha8 3f9a1c2e]')
    expect(toolPart.callID).toBe("c1")
    expect(toolPart.state?.status).toBe("completed")
    expect((toolPart.state?.input as any).command).toBe("bun test src/foo.test.ts")
  })

  test("never touches the last user message", () => {
    const messages = fixture()
    // Retarget at the trailing user message's own (nonexistent) tool part — no-op either way,
    // but assert the message itself is unchanged even if a target claims to hit it.
    const before = JSON.stringify(messages[2])
    const crop: CropSpec = {
      mode: "result",
      anchorMessageID: "m3",
      targets: [{ messageID: "m3", partID: "m3p1", estTokens: 100, sha8: "deadbeef" }],
    }
    applyCrops(messages, [crop])
    expect(JSON.stringify(messages[2])).toBe(before)
  })

  test("is idempotent", () => {
    const messages = fixture()
    const crop: CropSpec = {
      mode: "result",
      anchorMessageID: "m2",
      targets: [{ messageID: "m2", callID: "c1", tool: "bash", estTokens: 4700, sha8: "3f9a1c2e" }],
    }
    applyCrops(messages, [crop])
    const once = JSON.stringify(messages)
    applyCrops(messages, [crop])
    expect(JSON.stringify(messages)).toBe(once)
  })

  test("never crops a decision record, even one carrying a tool part", () => {
    const messages: MinimalMessage[] = [
      {
        info: { id: "d1", role: "user", sessionID: "s1" },
        parts: [
          { id: "d1p1", type: "text", text: "◆ Decision: try-redis", metadata: { ctree: { kind: "decision" } } },
          { id: "d1p2", type: "tool", tool: "bash", callID: "c9", state: { status: "completed", input: {}, output: "x" } },
        ],
      },
      { info: { id: "m2", role: "user", sessionID: "s1" }, parts: [{ id: "m2p1", type: "text", text: "next" }] },
    ]
    const crop: CropSpec = {
      mode: "result",
      anchorMessageID: "d1",
      targets: [{ messageID: "d1", callID: "c9", tool: "bash", estTokens: 10, sha8: "aaaaaaaa" }],
    }
    const before = JSON.stringify(messages[0])
    applyCrops(messages, [crop])
    expect(JSON.stringify(messages[0])).toBe(before)
  })
})

describe("applyCrops — turn mode", () => {
  function turnFixture(): MinimalMessage[] {
    return [
      { info: { id: "m1", role: "user", sessionID: "s1" }, parts: [{ id: "m1p1", type: "text", text: "try redis" }] },
      {
        info: { id: "m2", role: "assistant", sessionID: "s1" },
        parts: [{ id: "m2p1", type: "tool", tool: "bash", callID: "c1", state: { status: "completed", input: {}, output: "x" } }],
      },
      {
        info: { id: "m3", role: "assistant", sessionID: "s1" },
        parts: [{ id: "m3p1", type: "text", text: "done trying redis" }],
      },
      { info: { id: "m4", role: "user", sessionID: "s1" }, parts: [{ id: "m4p1", type: "text", text: "actually revert" }] },
    ]
  }

  test("drops a whole turn and preserves role alternation", () => {
    const messages = turnFixture()
    const crop: CropSpec = {
      mode: "turn",
      anchorMessageID: "m1",
      targets: [{ messageID: "m1", estTokens: 12000, sha8: "deadbeef" }],
    }
    applyCrops(messages, [crop])

    expect(messages).toHaveLength(2)
    expect(messages[0]!.info.role).toBe("user")
    expect(messages[0]!.info.id).toBe("m1")
    expect((messages[0]!.parts[0] as any).text).toContain("[dropped turn — 3 steps")
    expect(messages[1]!.info.id).toBe("m4")
  })

  test("never drops the last user message's turn", () => {
    const messages = turnFixture()
    const crop: CropSpec = {
      mode: "turn",
      anchorMessageID: "m4",
      targets: [{ messageID: "m4", estTokens: 100, sha8: "cafebabe" }],
    }
    applyCrops(messages, [crop])
    expect(messages).toHaveLength(4) // unchanged
  })

  test("never drops a message after the last user message either", () => {
    const messages = [...turnFixture(), { info: { id: "m5", role: "assistant" as const, sessionID: "s1" }, parts: [{ id: "m5p1", type: "text", text: "on it" }] }]
    const crop: CropSpec = { mode: "turn", anchorMessageID: "m5", targets: [{ messageID: "m5", estTokens: 100, sha8: "cafebabe" }] }
    applyCrops(messages, [crop])
    expect(messages).toHaveLength(5) // unchanged
  })

  test("is idempotent", () => {
    const messages = turnFixture()
    const crop: CropSpec = { mode: "turn", anchorMessageID: "m1", targets: [{ messageID: "m1", estTokens: 12000, sha8: "deadbeef" }] }
    applyCrops(messages, [crop])
    const once = JSON.stringify(messages)
    applyCrops(messages, [crop])
    expect(JSON.stringify(messages)).toBe(once)
  })
})
