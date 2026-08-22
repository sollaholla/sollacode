import { MessageId, TurnId, type OrchestrationLatestTurn } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { runResumeIncompleteTurn } from "../ChatView.logic";
import type { ChatMessage } from "../../types";
import { RESUME_PROMPT } from "../../resumePrompt";
import {
  deriveResumableAssistantMessageId,
  deriveResumableRuntimeErrorActivityId,
} from "./MessagesTimeline.logic";

const TURN_ID = TurnId.make("turn-resumable-incomplete-turn");
const ASSISTANT_MESSAGE_ID = MessageId.make("message-resumable-incomplete-turn");
const TIMESTAMP = "2026-07-29T12:00:00.000Z";

function buildAssistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: ASSISTANT_MESSAGE_ID,
    role: "assistant",
    text: "I made progress, but",
    turnId: TURN_ID,
    streaming: true,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

function buildLatestTurn(
  overrides: Partial<OrchestrationLatestTurn> = {},
): OrchestrationLatestTurn {
  return {
    turnId: TURN_ID,
    state: "completed",
    requestedAt: TIMESTAMP,
    startedAt: TIMESTAMP,
    completedAt: TIMESTAMP,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    ...overrides,
  };
}

function deriveCandidate(input?: {
  messages?: ReadonlyArray<ChatMessage>;
  latestTurn?: OrchestrationLatestTurn | null;
  sessionStatus?: "idle" | "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
}) {
  return deriveResumableAssistantMessageId({
    messages: input?.messages ?? [buildAssistantMessage()],
    latestTurn: input?.latestTurn === undefined ? buildLatestTurn() : input.latestTurn,
    session: {
      status: input?.sessionStatus ?? "ready",
      activeTurnId: null,
    },
  });
}

describe("resumable incomplete turns", () => {
  it("offers Resume only for a conservatively detected unfinished assistant message", () => {
    expect(
      deriveCandidate({
        messages: [buildAssistantMessage({ streaming: false })],
        latestTurn: buildLatestTurn({ state: "incomplete" }),
        sessionStatus: "stopped",
      }),
    ).toBe(ASSISTANT_MESSAGE_ID);

    expect(
      deriveCandidate({
        latestTurn: buildLatestTurn({ state: "incomplete" }),
      }),
    ).toBe(ASSISTANT_MESSAGE_ID);

    expect(
      deriveCandidate({
        messages: [
          buildAssistantMessage(),
          {
            id: MessageId.make("message-newer-user"),
            role: "user",
            text: "A later user message",
            turnId: null,
            streaming: false,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
        ],
      }),
    ).toBeNull();
  });

  it.each([
    {
      name: "normally completed",
      latestTurn: buildLatestTurn(),
      message: buildAssistantMessage({ streaming: false }),
      sessionStatus: "ready" as const,
    },
    {
      name: "completed with a stale streaming bit",
      latestTurn: buildLatestTurn(),
      message: buildAssistantMessage(),
      sessionStatus: "stopped" as const,
    },
    {
      name: "still running",
      latestTurn: buildLatestTurn({
        state: "running",
        completedAt: null,
        assistantMessageId: null,
      }),
      message: buildAssistantMessage(),
      sessionStatus: "running" as const,
    },
    {
      name: "terminal provider error",
      latestTurn: buildLatestTurn({ state: "error" }),
      message: buildAssistantMessage(),
      sessionStatus: "error" as const,
    },
    {
      name: "manual cancellation",
      latestTurn: buildLatestTurn({ state: "interrupted" }),
      message: buildAssistantMessage(),
      sessionStatus: "stopped" as const,
    },
  ])("does not offer Resume for a $name turn", ({ latestTurn, message, sessionStatus }) => {
    expect(
      deriveCandidate({
        messages: [message],
        latestTurn,
        sessionStatus,
      }),
    ).toBeNull();
  });

  it("sends exactly one contextual resume prompt while an attempt is pending", async () => {
    let releaseSend: (() => void) | undefined;
    const send = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseSend = resolve;
        }),
    );
    const inFlightRef = { current: false };

    const firstAttempt = runResumeIncompleteTurn({ inFlightRef, send });
    const duplicateAttempt = await runResumeIncompleteTurn({ inFlightRef, send });

    expect(duplicateAttempt).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(RESUME_PROMPT);
    expect(inFlightRef.current).toBe(true);

    releaseSend?.();
    await expect(firstAttempt).resolves.toBe(true);
    expect(inFlightRef.current).toBe(false);
  });

  it("resets idempotency state after a failed send so the user can retry", async () => {
    const send = vi
      .fn<(message: typeof RESUME_PROMPT) => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce();
    const inFlightRef = { current: false };

    await expect(runResumeIncompleteTurn({ inFlightRef, send })).rejects.toThrow(
      "temporary failure",
    );
    expect(inFlightRef.current).toBe(false);

    await expect(runResumeIncompleteTurn({ inFlightRef, send })).resolves.toBe(true);
    expect(send).toHaveBeenNthCalledWith(1, RESUME_PROMPT);
    expect(send).toHaveBeenNthCalledWith(2, RESUME_PROMPT);
    expect(inFlightRef.current).toBe(false);
  });

  it("offers Resume for only the final runtime error of a completely dead turn", () => {
    const runtimeErrorEntry = {
      id: "runtime-error-activity",
      kind: "work" as const,
      createdAt: TIMESTAMP,
      entry: {
        id: "runtime-error-activity",
        createdAt: TIMESTAMP,
        turnId: TURN_ID,
        label: "Runtime error",
        detail: "Provider process exited",
        tone: "error" as const,
        sourceActivityKind: "runtime.error" as const,
      },
    };
    const erroredTurn = buildLatestTurn({ state: "error" });

    expect(
      deriveResumableRuntimeErrorActivityId({
        timelineEntries: [runtimeErrorEntry],
        latestTurn: erroredTurn,
        session: { status: "error", activeTurnId: null },
      }),
    ).toBe(runtimeErrorEntry.id);

    expect(
      deriveResumableRuntimeErrorActivityId({
        timelineEntries: [runtimeErrorEntry],
        latestTurn: erroredTurn,
        session: { status: "running", activeTurnId: TURN_ID },
      }),
    ).toBeNull();

    expect(
      deriveResumableRuntimeErrorActivityId({
        timelineEntries: [
          runtimeErrorEntry,
          {
            id: "later-message",
            kind: "message",
            createdAt: "2026-07-29T12:00:01.000Z",
            message: {
              id: MessageId.make("later-message"),
              role: "user",
              text: "Already continuing another way",
              turnId: null,
              streaming: false,
              createdAt: "2026-07-29T12:00:01.000Z",
              updatedAt: "2026-07-29T12:00:01.000Z",
            },
          },
        ],
        latestTurn: erroredTurn,
        session: { status: "error", activeTurnId: null },
      }),
    ).toBeNull();
  });
});
