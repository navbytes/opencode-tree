import { describe, expect, test } from "bun:test"
import { buildSpineMap } from "../src/core/tree.js"
import { buildFixture, OPEN, TRUNK } from "./fixtures/tree.js"

const f = buildFixture()

describe("buildSpineMap", () => {
  const map = buildSpineMap({ state: f.state, transcripts: f.transcripts, currentSessionID: OPEN })
  test("prefix rows (trunk ids) map onto the branch's copied messages by position", () => {
    expect(map.toCurrent(TRUNK, "m1")).toBe("o-m1")
    expect(map.toCurrent(TRUNK, "a2")).toBe("o-a2")
    expect(map.toCurrent(TRUNK, "m3")).toBeUndefined() // past the fork point: not on the branch
    expect(map.partToCurrent(TRUNK, "a1", "a1-tool")).toBe("o-a1-tool")
  })
  test("own messages map to themselves", () => {
    expect(map.toCurrent(OPEN, "om1")).toBe("om1")
    expect(map.index.get(`${OPEN}:om1`)).toBe(4)
  })
  test("reverse mapping finds the spine owner and part", () => {
    expect(map.fromCurrent("o-a1")).toEqual({ sessionID: TRUNK, messageID: "a1" })
    expect(map.partFromCurrent("o-a1", "o-a1-tool")).toEqual({ sessionID: TRUNK, messageID: "a1", partID: "a1-tool" })
    expect(map.fromCurrent("om2")).toEqual({ sessionID: OPEN, messageID: "om2" })
  })
  test("positions ignore filters: built purely from transcripts", () => {
    const trunkMap = buildSpineMap({ state: f.state, transcripts: f.transcripts, currentSessionID: TRUNK })
    expect(trunkMap.toCurrent(TRUNK, "m3")).toBe("m3")
    expect(trunkMap.index.size).toBe(f.transcripts[TRUNK]!.messages.length)
  })
})
