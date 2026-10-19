import { describe, it, expect } from "vitest"
import { heuristicReasons, observeTurn } from "../src/heuristics"
import { RELAY_MARKER } from "../src/defaults"
import type { OcMessage } from "../src/types"

const user = (id: string, text = "do it"): OcMessage =>
  ({ info: { id, role: "user", agent: "build" }, parts: [{ type: "text", text }] })
const handover = (id: string): OcMessage =>
  ({ info: { id, role: "user", agent: "build" }, parts: [{ type: "text", text: `${RELAY_MARKER}\ncontinue` }] })
const asst = (id: string, model?: string, parts: OcMessage["parts"] = []): OcMessage =>
  ({ info: { id, role: "assistant", ...(model ? { providerID: "a", modelID: model } : {}) }, parts })
const tool = (name: string, status: string, input: unknown, id = "t"): OcMessage =>
  ({ info: { id, role: "assistant", providerID: "a", modelID: "1" }, parts: [{ type: "tool", tool: name, state: { status, input } }] })
const textPart = (id: string, text: string, model = "1"): OcMessage =>
  ({ info: { id, role: "assistant", providerID: "a", modelID: model }, parts: [{ type: "text", text }] })

const sameCall = (n: number): OcMessage[] => [
  user("u1"),
  ...Array.from({ length: n }, (_, i) => tool("bash", "completed", { command: "git push" }, `t${i}`)),
  asst("a", "1", [{ type: "text", text: "done" }]),
]

describe("observeTurn", () => {
  it("scopes to the newest real user message and skips our own handover prompt", () => {
    const msgs = [...sameCall(3), handover("h1"), asst("a2", "1", [{ type: "text", text: "more text" }])]
    const obs = observeTurn(msgs)
    expect(obs).toEqual({
      sawAssistant: true, assistantText: true, successfulTool: true,
      maxRepeatedCalls: 3, maxConsecutiveErrors: 0,
    })
  })

  it("counts within-turn identical calls, including errors", () => {
    expect(observeTurn(sameCall(3)).maxRepeatedCalls).toBe(3)
    expect(observeTurn(sameCall(2)).maxRepeatedCalls).toBe(2)
    // identical calls that fail still count as a loop signal
    const failing = [
      user("u1"),
      ...Array.from({ length: 3 }, (_, i) => tool("bash", "error", { command: "git push" }, `t${i}`)),
      asst("a", "1", [{ type: "text", text: "tried" }]),
    ]
    const obs = observeTurn(failing)
    expect(obs.maxRepeatedCalls).toBe(3)
    expect(obs.maxConsecutiveErrors).toBe(3)
    expect(heuristicReasons(obs)).toEqual(["loop", "repeated_tool_errors"])
  })

  it("tracks a consecutive error run at the tail", () => {
    const msgs = [
      user("u1"),
      tool("read", "completed", { filePath: "a.ts" }, "t1"),
      tool("read", "error", { filePath: "b.ts" }, "t2"),
      tool("edit", "error", { filePath: "c.ts" }, "t3"),
      textPart("a1", "still trying"),
    ]
    const obs = observeTurn(msgs)
    expect(obs.maxConsecutiveErrors).toBe(2)
    // two errors in a row stay below the run threshold (3): the judge never sees this turn
    expect(heuristicReasons(obs)).toEqual([])
  })

  it("no_output: no assistant text and no successful tool call", () => {
    const msgs = [user("u1"), tool("read", "error", { filePath: "x" }, "t1"), asst("a1", "1", [{ type: "step-start" }])]
    const obs = observeTurn(msgs)
    expect(heuristicReasons(obs)).toEqual(["no_output"])
  })

  it("a real turn with text or a successful tool call is healthy", () => {
    expect(heuristicReasons(observeTurn([user("u1"), textPart("a1", "done, all green")]))).toEqual([])
    expect(heuristicReasons(observeTurn([user("u1"), tool("read", "completed", { filePath: "x" }, "t1")]))).toEqual([])
  })

  it("never throws on hostile inputs", () => {
    expect(observeTurn(null).maxRepeatedCalls).toBe(0)
    expect(heuristicReasons(observeTurn([5, "x", { info: {} }, { info: { role: "user" }, parts: 5 }, undefined]))).toEqual([])
  })
})
