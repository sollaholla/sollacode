import {
  EventId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  MessageId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerProvider,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { AGENT_CONTINUE_PROMPT } from "@t3tools/shared/agentMode";
import {
  activeTurnMessageIdFromSourceTurnId,
  activeTurnWorkSourceId,
  agentAutoResumeIds,
  providerAuthenticationResumeIds,
  shouldAutoContinueAgentThread,
  shouldResumeProviderAuthenticationPausedThread,
  startupAutoResumeIds,
  startupResumeSourceTurnId,
} from "./agentModeContinuation.ts";

const threadId = ThreadId.make("thread-agent");
const turnId = TurnId.make("turn-completed");

function shell(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: "Agent task",
    modelSelection: ModelSelection.make({
      instanceId: ProviderInstanceId.make("claude"),
      model: "claude-opus-5",
    }),
    runtimeMode: "full-access",
    interactionMode: "agent",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId,
      state: "completed",
      requestedAt: "2026-08-03T12:00:00.000Z",
      startedAt: "2026-08-03T12:00:01.000Z",
      completedAt: "2026-08-03T12:01:00.000Z",
      assistantMessageId: MessageId.make("assistant-1"),
    },
    createdAt: "2026-08-03T11:00:00.000Z",
    updatedAt: "2026-08-03T12:01:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: {
      threadId,
      status: "ready",
      providerName: "claudeAgent",
      providerInstanceId: ProviderInstanceId.make("claude"),
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-08-03T12:01:00.000Z",
    },
    latestUserMessageAt: "2026-08-03T12:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function assistantEvent(text = "Implemented the next piece cleanly."): AssistantMessageEvent {
  return {
    sequence: 10,
    eventId: EventId.make("event-10"),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-08-03T12:01:00.000Z",
    commandId: null,
    type: "thread.message-sent",
    payload: {
      threadId,
      messageId: MessageId.make("assistant-1"),
      role: "assistant",
      text,
      turnId,
      streaming: false,
      createdAt: "2026-08-03T12:00:01.000Z",
      updatedAt: "2026-08-03T12:01:00.000Z",
    },
  } as AssistantMessageEvent;
}

function authenticatedProvider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: "2.1.221",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-03T12:02:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

type AssistantMessageEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

describe("server-owned Agent continuation", () => {
  it("continues a clean completed Agent turn without a mounted client", () => {
    expect(shouldAutoContinueAgentThread(shell(), assistantEvent())).toBe(true);
  });

  it("uses the projected final message after a completion event with an empty delta", () => {
    expect(
      shouldAutoContinueAgentThread(shell(), assistantEvent(""), "Projected final reply"),
    ).toBe(true);
  });

  it("honors the terminal stop token and pending human input", () => {
    expect(shouldAutoContinueAgentThread(shell(), assistantEvent("Finished. AGENT_STOP"))).toBe(
      false,
    );
    expect(
      shouldAutoContinueAgentThread(shell({ hasPendingUserInput: true }), assistantEvent()),
    ).toBe(false);
    expect(
      shouldAutoContinueAgentThread(
        shell({ session: { ...shell().session!, status: "stopped" } }),
        assistantEvent(),
      ),
    ).toBe(false);
  });

  it("does not continue a deterministic fast-mode credit rejection", () => {
    expect(
      shouldAutoContinueAgentThread(
        shell(),
        assistantEvent("Usage credits are required for fast mode."),
      ),
    ).toBe(false);
    expect(
      shouldAutoContinueAgentThread(
        shell(),
        assistantEvent("Fast mode disabled · usage credits exhausted"),
      ),
    ).toBe(false);
  });

  it("does not continue a stale assistant event or a non-Agent thread", () => {
    expect(
      shouldAutoContinueAgentThread(
        shell({ latestTurn: { ...shell().latestTurn!, turnId: TurnId.make("newer-turn") } }),
        assistantEvent(),
      ),
    ).toBe(false);
    expect(
      shouldAutoContinueAgentThread(shell({ interactionMode: "default" }), assistantEvent()),
    ).toBe(false);
    expect(shouldAutoContinueAgentThread(shell(), assistantEvent(), undefined, "default")).toBe(
      false,
    );
  });

  it("uses stable continuation identifiers for cross-client and replay dedupe", () => {
    expect(agentAutoResumeIds({ threadId, completedTurnId: turnId })).toEqual({
      commandId: "agent-auto-resume-command:thread-agent:turn-completed",
      messageId: "agent-auto-resume-message:thread-agent:turn-completed",
    });
    expect(AGENT_CONTINUE_PROMPT).toContain("AGENT_STOP");
  });

  it("resumes an auth-paused Agent thread only after a newer authenticated probe", () => {
    const paused = shell({
      session: {
        ...shell().session!,
        status: "error",
        lastError: "Failed to authenticate: OAuth session expired and could not be refreshed",
      },
    });
    expect(shouldResumeProviderAuthenticationPausedThread(paused, authenticatedProvider())).toBe(
      true,
    );
    expect(
      shouldResumeProviderAuthenticationPausedThread(
        paused,
        authenticatedProvider({ checkedAt: paused.session!.updatedAt }),
      ),
    ).toBe(false);
    expect(
      shouldResumeProviderAuthenticationPausedThread(
        paused,
        authenticatedProvider({ auth: { status: "unauthenticated" } }),
      ),
    ).toBe(false);
    expect(
      shouldResumeProviderAuthenticationPausedThread(
        { ...paused, archivedAt: "2026-08-03T12:01:30.000Z" },
        authenticatedProvider(),
      ),
    ).toBe(false);
  });

  it("uses distinct stable identifiers for post-login continuation", () => {
    expect(providerAuthenticationResumeIds({ threadId, completedTurnId: turnId })).toEqual({
      commandId: "provider-auth-auto-resume-command:thread-agent:turn-completed",
      messageId: "provider-auth-auto-resume-message:thread-agent:turn-completed",
    });
  });

  it("round-trips durable explicit-turn and startup-resume identities", () => {
    const messageId = MessageId.make("message-explicit-turn");
    const sourceTurnId = activeTurnWorkSourceId(messageId);
    expect(activeTurnMessageIdFromSourceTurnId(sourceTurnId)).toBe(messageId);
    expect(activeTurnMessageIdFromSourceTurnId(TurnId.make("provider-turn"))).toBeNull();

    const startupIds = startupAutoResumeIds({
      threadId,
      incompleteTurnId: turnId,
    });
    expect(startupIds).toEqual({
      commandId: "startup-auto-resume-command:thread-agent:turn-completed",
      messageId: "startup-auto-resume-message:thread-agent:turn-completed",
    });
    expect(startupResumeSourceTurnId({ threadId, messageId: startupIds.messageId })).toBe(turnId);
  });
});
