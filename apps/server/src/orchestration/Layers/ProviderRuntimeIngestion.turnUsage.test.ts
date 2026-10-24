import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

const completed = (payload: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>["payload"]) =>
  ({
    type: "turn.completed",
    eventId: EventId.make("evt-turn-completed"),
    provider: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    createdAt: "2026-10-11T00:00:00.000Z",
    threadId: ThreadId.make("thread-1"),
    turnId: TurnId.make("turn-1"),
    payload,
  }) satisfies ProviderRuntimeEvent;

describe("runtimeEventToActivities turn usage", () => {
  it("records a turn's usage once, with the provider that ran it", () => {
    const [activity, ...rest] = runtimeEventToActivities(
      completed({
        state: "completed",
        turnUsage: {
          inputTokens: 10,
          cachedInputTokens: 900,
          cacheWriteTokens: 100,
          outputTokens: 50,
          costUsd: 0.25,
          model: "claude-opus-5-5",
        },
      }),
    );
    expect(rest).toEqual([]);
    expect(activity).toMatchObject({
      id: "turn-usage:thread-1:turn-1",
      kind: "turn.usage",
      turnId: "turn-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claudeAgent",
        inputTokens: 10,
        cachedInputTokens: 900,
        cacheWriteTokens: 100,
        outputTokens: 50,
        costUsd: 0.25,
      },
    });
  });

  it("records nothing for a turn whose provider reported no usage", () => {
    expect(runtimeEventToActivities(completed({ state: "completed" }))).toEqual([]);
  });
});
