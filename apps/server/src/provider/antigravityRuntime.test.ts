import {
  EventId,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { parseAntigravityEventLine } from "./antigravityProtocol.ts";
import {
  ANTIGRAVITY_DRIVER_KIND,
  EMPTY_ANTIGRAVITY_USAGE_TALLY,
  antigravityContextWindowTokens,
  foldAntigravityUsage,
  mapAntigravityEvent,
} from "./antigravityRuntime.ts";

const base = {
  eventId: EventId.make("event"),
  provider: ANTIGRAVITY_DRIVER_KIND,
  providerInstanceId: ProviderInstanceId.make("agy"),
  threadId: ThreadId.make("thread"),
  turnId: TurnId.make("turn"),
  createdAt: "2026-09-04T20:00:00.000Z",
};
const decodeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
function map(event: string, payload: unknown) {
  const frame = parseAntigravityEventLine(JSON.stringify({ event, [event]: payload }));
  if (!frame) throw new Error("Missing frame");
  return mapAntigravityEvent(frame, base).map((event) => decodeEvent(event));
}

describe("Antigravity runtime mapping", () => {
  it("emits the DONE text before closing the assistant item", () => {
    const events = map("step_update", {
      step_index: 1,
      state: "DONE",
      step_type: "agent_response",
      text_delta: "\n",
    });
    expect(events.map((event) => event.type)).toEqual(["content.delta", "item.completed"]);
    expect(events[0]?.payload).toEqual({ streamKind: "assistant_text", delta: "\n" });
  });
  it("keeps a partial tool frame and completed output on the same item", () => {
    const partial = map("step_update", {
      step_index: 2,
      state: "ACTIVE",
      step_type: "tool",
      tool_info: { name: "run_command", parameters: { CommandLine: "cat sample.txt" } },
    });
    const completed = map("step_update", {
      step_index: 2,
      state: "DONE",
      step_type: "tool",
      tool_info: { name: "run_command", output: "content" },
    });
    expect(partial[0]?.itemId).toBe(completed[0]?.itemId);
    expect(completed[0]?.payload).toMatchObject({ status: "completed", detail: "content" });
  });
  it.each(["SUCCESS", "ERROR", "CANCELED", "INTERRUPTED", "INVALID"])(
    "maps terminal state %s without duplicating response text",
    (status) => {
      const events = map("result", { status, response: "already streamed" });
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("turn.completed");
    },
  );
  it.each(["WAITING", "RUNNING"])("does not invent completion for %s", (status) => {
    expect(map("result", { status })).toEqual([]);
  });
  it("ignores additive protocol events", () => {
    expect(map("future_event", { version: 2 })).toEqual([]);
  });
});

describe("Antigravity usage tally", () => {
  const usage = {
    inputTokens: 13_713,
    outputTokens: 1,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 13_714,
  };

  it("knows the context window for the model families agy exposes", () => {
    expect(antigravityContextWindowTokens("gemini-3.8-flash-low")).toBe(1_048_576);
    expect(antigravityContextWindowTokens("claude-opus-4-6-thinking")).toBe(200_000);
    expect(antigravityContextWindowTokens("gpt-oss-120b-medium")).toBe(131_072);
    expect(antigravityContextWindowTokens("something-new")).toBeUndefined();
    expect(antigravityContextWindowTokens(null)).toBeUndefined();
  });

  it("reports the latest model call as the live context", () => {
    const step = foldAntigravityUsage({
      tally: EMPTY_ANTIGRAVITY_USAGE_TALLY,
      kind: "step_update",
      usage,
      model: "gemini-3.8-flash-high",
    });
    expect(step.snapshot).toMatchObject({
      usedTokens: 13_714,
      maxTokens: 1_048_576,
      inputTokens: 13_713,
      outputTokens: 1,
      lastUsedTokens: 13_714,
    });
    expect(step.snapshot?.totalProcessedTokens).toBeUndefined();
    expect(step.tally.turnTokens).toBe(13_714);
  });

  it("settles the turn on the result without double counting the steps", () => {
    const first = foldAntigravityUsage({
      tally: EMPTY_ANTIGRAVITY_USAGE_TALLY,
      kind: "step_update",
      usage,
      model: "gemini-3.8-flash-high",
    });
    const second = foldAntigravityUsage({
      tally: first.tally,
      kind: "step_update",
      usage: { ...usage, inputTokens: 20_000, totalTokens: 20_001 },
      model: "gemini-3.8-flash-high",
    });
    const settled = foldAntigravityUsage({
      tally: second.tally,
      kind: "result",
      usage: { ...usage, inputTokens: 33_713, totalTokens: 33_715 },
      model: "gemini-3.8-flash-high",
    });
    expect(second.snapshot).toMatchObject({ usedTokens: 20_001, totalProcessedTokens: 33_715 });
    expect(settled.snapshot).toMatchObject({ usedTokens: 20_001, totalProcessedTokens: 33_715 });
    expect(settled.tally).toMatchObject({ settledTokens: 33_715, turnTokens: 0 });
    const nextTurn = foldAntigravityUsage({
      tally: settled.tally,
      kind: "step_update",
      usage,
      model: "gemini-3.8-flash-high",
    });
    expect(nextTurn.snapshot).toMatchObject({ usedTokens: 13_714, totalProcessedTokens: 47_429 });
  });

  it("falls back to the result usage when no step carried any", () => {
    const settled = foldAntigravityUsage({
      tally: EMPTY_ANTIGRAVITY_USAGE_TALLY,
      kind: "result",
      usage,
      model: "unknown-model",
    });
    expect(settled.snapshot).toMatchObject({ usedTokens: 13_714 });
    expect(settled.snapshot?.maxTokens).toBeUndefined();
  });

  it("produces no snapshot for an empty usage frame", () => {
    const folded = foldAntigravityUsage({
      tally: EMPTY_ANTIGRAVITY_USAGE_TALLY,
      kind: "step_update",
      usage: { ...usage, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      model: "gemini-3.8-flash-high",
    });
    expect(folded.snapshot).toBeNull();
    expect(folded.tally).toEqual(EMPTY_ANTIGRAVITY_USAGE_TALLY);
  });
});
