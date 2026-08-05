import {
  CommandId,
  MessageId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  isProviderAuthenticationFailure,
  shouldAgentContinueAfterReply,
} from "@t3tools/shared/agentMode";
import type { ThreadWorkKind } from "../persistence/Services/ThreadWorkObligations.ts";

type AssistantMessageEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

export function shouldAutoContinueCompletedAgentTurn(
  thread: OrchestrationThreadShell,
  input: {
    readonly turnId: string;
    readonly assistantText: string;
    readonly turnInteractionMode: OrchestrationThreadShell["interactionMode"];
  },
): boolean {
  if (input.turnInteractionMode !== "agent" || thread.interactionMode !== "agent") return false;
  if (thread.latestTurn?.turnId !== input.turnId || thread.latestTurn.state !== "completed") {
    return false;
  }
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.session?.activeTurnId !== null && thread.session?.activeTurnId !== undefined) {
    return false;
  }
  // "stopped" is continuable: the CLI simply exited between turns (idle exit,
  // watchdog restart, a deploy) and dispatching the continuation spawns a
  // fresh session, exactly like a startup resume does. Declining on it
  // orphaned agent threads whose CLI died in the seconds between the turn
  // settling and the continuation being claimed. Only "error" stays terminal
  // so a failing provider is never hammered (62099dc3b).
  if (thread.session?.status === "error") return false;
  return shouldAgentContinueAfterReply(input.assistantText);
}

/**
 * The server owns Agent continuation so inactive tabs, disconnected clients,
 * and side chats all follow the same durable lifecycle.
 */
export function shouldAutoContinueAgentThread(
  thread: OrchestrationThreadShell,
  event: AssistantMessageEvent,
  assistantText = event.payload.text,
  turnInteractionMode: OrchestrationThreadShell["interactionMode"] = thread.interactionMode,
): boolean {
  if (event.payload.role !== "assistant" || event.payload.streaming) return false;
  if (event.payload.turnId === null) return false;
  return shouldAutoContinueCompletedAgentTurn(thread, {
    turnId: event.payload.turnId,
    assistantText,
    turnInteractionMode,
  });
}

/** Stable IDs make repeated finalization events and reconnect races idempotent. */
export function agentAutoResumeIds(input: {
  readonly threadId: string;
  readonly completedTurnId: string;
}): { readonly commandId: CommandId; readonly messageId: MessageId } {
  const key = `${input.threadId}:${input.completedTurnId}`;
  return {
    commandId: CommandId.make(`agent-auto-resume-command:${key}`),
    messageId: MessageId.make(`agent-auto-resume-message:${key}`),
  };
}

const ACTIVE_TURN_WORK_SOURCE_PREFIX = "turn-start:";

/**
 * A provider turn id does not exist when a user message is first projected.
 * Keying the durable obligation by its immutable message id gives retries and
 * restart recovery one stable identity before the provider process starts.
 */
export function activeTurnWorkSourceId(messageId: MessageId): TurnId {
  return TurnId.make(`${ACTIVE_TURN_WORK_SOURCE_PREFIX}${messageId}`);
}

export function activeTurnMessageIdFromSourceTurnId(sourceTurnId: TurnId): MessageId | null {
  const value = String(sourceTurnId);
  if (!value.startsWith(ACTIVE_TURN_WORK_SOURCE_PREFIX)) return null;
  const messageId = value.slice(ACTIVE_TURN_WORK_SOURCE_PREFIX.length);
  return messageId.length > 0 ? MessageId.make(messageId) : null;
}

/** Stable ids shared with the client-side startup prompt race. */
export function startupAutoResumeIds(input: {
  readonly threadId: string;
  readonly incompleteTurnId: string;
}): { readonly commandId: CommandId; readonly messageId: MessageId } {
  const key = `${input.threadId}:${input.incompleteTurnId}`;
  return {
    commandId: CommandId.make(`startup-auto-resume-command:${key}`),
    messageId: MessageId.make(`startup-auto-resume-message:${key}`),
  };
}

export function startupResumeSourceTurnId(input: {
  readonly threadId: string;
  readonly messageId: MessageId;
}): TurnId | null {
  const prefix = `startup-auto-resume-message:${input.threadId}:`;
  const value = String(input.messageId);
  if (!value.startsWith(prefix)) return null;
  const sourceTurnId = value.slice(prefix.length);
  return sourceTurnId.length > 0 ? TurnId.make(sourceTurnId) : null;
}

export function threadWorkObligationId(input: {
  readonly threadId: string;
  readonly sourceTurnId: string;
  readonly kind: ThreadWorkKind;
}): string {
  return `thread-work:${input.kind}:${input.threadId}:${input.sourceTurnId}`;
}

export function shouldResumeProviderAuthenticationPausedThread(
  thread: OrchestrationThreadShell,
  provider: ServerProvider,
): boolean {
  const session = thread.session;
  const latestTurn = thread.latestTurn;
  if (
    thread.archivedAt !== null ||
    thread.interactionMode !== "agent" ||
    session?.status !== "error" ||
    session.activeTurnId !== null ||
    !isProviderAuthenticationFailure(session.lastError ?? "") ||
    latestTurn?.state !== "completed" ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput
  ) {
    return false;
  }
  const providerInstanceId = session.providerInstanceId ?? thread.modelSelection.instanceId;
  if (
    provider.instanceId !== providerInstanceId ||
    provider.status !== "ready" ||
    provider.auth.status !== "authenticated"
  ) {
    return false;
  }
  const providerCheckedAt = Date.parse(provider.checkedAt);
  const pausedAt = Date.parse(session.updatedAt);
  return (
    Number.isFinite(providerCheckedAt) && Number.isFinite(pausedAt) && providerCheckedAt > pausedAt
  );
}

/** Stable IDs make repeated provider snapshots and reconnect replay idempotent. */
export function providerAuthenticationResumeIds(input: {
  readonly threadId: string;
  readonly completedTurnId: string;
}): { readonly commandId: CommandId; readonly messageId: MessageId } {
  const key = `${input.threadId}:${input.completedTurnId}`;
  return {
    commandId: CommandId.make(`provider-auth-auto-resume-command:${key}`),
    messageId: MessageId.make(`provider-auth-auto-resume-message:${key}`),
  };
}
