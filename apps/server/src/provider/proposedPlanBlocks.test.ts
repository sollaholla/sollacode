import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeProposedPlanBlockTracker, makeProposedPlanCapture } from "./proposedPlanBlocks.ts";

describe("makeProposedPlanBlockTracker", () => {
  it("reports each block once, as its closing tag streams in", () => {
    const tracker = makeProposedPlanBlockTracker();
    expect(tracker.append("Here is the approach.\n<proposed_plan>\n# Auth")).toEqual([]);
    expect(tracker.append(" rewrite\n\nUse the session store.\n</proposed_pl")).toEqual([]);
    expect(tracker.append("an>\nAnd an alternative:\n")).toEqual([
      { itemId: "proposed-plan-0", planMarkdown: "# Auth rewrite\n\nUse the session store." },
    ]);
    // Text after a block never re-reports it, even on the closing tag's line.
    expect(tracker.append("More prose > with a bracket.\n")).toEqual([]);
    expect(tracker.append("<proposed_plan>\n# Token rotation\n</proposed_plan>")).toEqual([
      { itemId: "proposed-plan-1", planMarkdown: "# Token rotation" },
    ]);
  });

  it("ignores prose that only mentions the tags", () => {
    const tracker = makeProposedPlanBlockTracker();
    expect(tracker.append("Keep `<proposed_plan>` and `</proposed_plan>` exactly.")).toEqual([]);
  });
});

describe("makeProposedPlanCapture", () => {
  const delta = (turn: string, text: string, eventId: string): ProviderRuntimeEvent => ({
    type: "content.delta",
    eventId: EventId.make(eventId),
    provider: ProviderDriverKind.make("opencode"),
    threadId: ThreadId.make("thread-1"),
    createdAt: "2026-10-10T00:00:00.000Z",
    turnId: TurnId.make(turn),
    payload: { streamKind: "assistant_text", delta: text },
  });

  it("turns a block in assistant text into a plan for that turn", () => {
    const capture = makeProposedPlanCapture();
    expect(capture(delta("turn-1", "<proposed_plan>\n# Plan A\n", "event-1"))).toEqual([]);
    expect(capture(delta("turn-1", "</proposed_plan>\n", "event-2"))).toEqual([
      {
        type: "turn.proposed.completed",
        eventId: "event-2:proposed-plan-0",
        provider: "opencode",
        threadId: "thread-1",
        createdAt: "2026-10-10T00:00:00.000Z",
        turnId: "turn-1",
        itemId: "proposed-plan-0",
        payload: { planMarkdown: "# Plan A" },
      },
    ]);
  });

  it("starts every turn fresh, and never reads reasoning as a plan", () => {
    const capture = makeProposedPlanCapture();
    capture(delta("turn-1", "<proposed_plan>\n# Unfinished\n", "event-1"));
    capture({
      type: "turn.completed",
      eventId: EventId.make("event-2"),
      provider: ProviderDriverKind.make("opencode"),
      threadId: ThreadId.make("thread-1"),
      createdAt: "2026-10-10T00:00:00.000Z",
      turnId: TurnId.make("turn-1"),
      payload: { state: "completed" },
    });
    // The next turn's numbering restarts and the old open block is gone.
    expect(
      capture(delta("turn-2", "<proposed_plan>\n# Plan B\n</proposed_plan>", "event-3")),
    ).toMatchObject([
      { turnId: "turn-2", itemId: "proposed-plan-0", payload: { planMarkdown: "# Plan B" } },
    ]);
    expect(
      capture({
        ...delta("turn-2", "<proposed_plan>\n# Thought\n</proposed_plan>", "event-4"),
        payload: {
          streamKind: "reasoning_text",
          delta: "<proposed_plan>\n# Thought\n</proposed_plan>",
        },
      } as ProviderRuntimeEvent),
    ).toEqual([]);
  });
});
