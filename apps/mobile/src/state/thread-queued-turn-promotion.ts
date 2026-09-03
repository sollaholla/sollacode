import type {
  CommandId,
  EnvironmentId,
  MessageId,
  OrchestrationMessage,
  OrchestrationThreadActivity,
  ThreadId,
} from "@t3tools/contracts";
import {
  resolveQueuedTurnPromotionOutcome,
  type QueuedTurnPromotionOutcome,
} from "@t3tools/client-runtime/state/queued-turn-promotion";
import { Atom } from "effect/unstable/reactivity";

import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";

export {
  collectDeliveredMessageIds,
  nextQueuedMessageToPromote,
  QUEUED_MESSAGE_AUTO_PROMOTE_DELAY_MS,
  queuedMessageAutoPromoteDelayMs,
} from "@t3tools/client-runtime/state/queued-turn-promotion";

const MESSAGE_DELIVERED_ACTIVITY_KIND = "message.delivered";
const QUEUED_MESSAGES_PROMOTED_ACTIVITY_KIND = "provider.queue.promoted";

export interface QueuedTurnPromotionRequest {
  readonly commandId: CommandId;
  readonly environmentId: EnvironmentId;
  readonly messageIds: ReadonlyArray<MessageId>;
  readonly serverProjectionRequiredMessageIds: ReadonlyArray<MessageId>;
  readonly threadId: ThreadId;
}

export type QueuedTurnPromotionPhase = "requested" | "awaiting-projection";

export interface QueuedTurnPromotionState extends QueuedTurnPromotionRequest {
  readonly phase: QueuedTurnPromotionPhase;
}

export const queuedTurnPromotionRequestsAtom = Atom.make<Record<string, QueuedTurnPromotionState>>(
  {},
).pipe(Atom.keepAlive, Atom.withLabel("mobile:thread-queue:promotion-requests"));

function activityMessageIds(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  kind: string,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const activity of activities) {
    if (
      activity.kind !== kind ||
      typeof activity.payload !== "object" ||
      activity.payload === null
    ) {
      continue;
    }
    const payload = activity.payload as Record<string, unknown>;
    const values =
      kind === MESSAGE_DELIVERED_ACTIVITY_KIND ? [payload.messageId] : payload.messageIds;
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (typeof value === "string" && value.length > 0) ids.add(value);
    }
  }
  return ids;
}

function expandDeliveredMessageIds(
  orderedUserMessageIds: ReadonlyArray<string>,
  delivered: ReadonlySet<string>,
): ReadonlySet<string> {
  let newestDeliveredIndex = -1;
  for (const [index, messageId] of orderedUserMessageIds.entries()) {
    if (delivered.has(messageId)) newestDeliveredIndex = index;
  }
  if (newestDeliveredIndex < 0) return delivered;
  return new Set([...delivered, ...orderedUserMessageIds.slice(0, newestDeliveredIndex)]);
}

/**
 * Server-persisted user messages that are still waiting behind Grok's active
 * turn. Local outbox rows are tracked separately because they have not reached
 * the server yet and must drain before promotion is dispatched.
 */
export function queuedTurnMessageIds(input: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly activeWorkStartedAt: string | null;
}): ReadonlyArray<MessageId> {
  const orderedUserMessageIds = input.messages
    .filter((message) => message.role === "user" && message.voiceTranscript !== true)
    .map((message) => message.id);
  const delivered = expandDeliveredMessageIds(
    orderedUserMessageIds,
    activityMessageIds(input.activities, MESSAGE_DELIVERED_ACTIVITY_KIND),
  );
  const promoted = activityMessageIds(input.activities, QUEUED_MESSAGES_PROMOTED_ACTIVITY_KIND);

  return input.messages
    .filter(
      (message) =>
        message.role === "user" &&
        message.voiceTranscript !== true &&
        message.turnId === null &&
        (input.activeWorkStartedAt === null || message.createdAt > input.activeWorkStartedAt) &&
        !delivered.has(message.id) &&
        !promoted.has(message.id),
    )
    .map((message) => message.id);
}

/**
 * Combines native-queue rows already projected by the server with local
 * outbox rows that must be projected before promotion. Creation time is the
 * shared ordering key across both stores. If the same message exists in both,
 * the server copy wins the tie because it has already reached native admission.
 */
export function orderedQueuedTurnPromotionMessageIds(input: {
  readonly localMessages: ReadonlyArray<{
    readonly messageId: MessageId;
    readonly createdAt: string;
  }>;
  readonly serverMessages: ReadonlyArray<OrchestrationMessage>;
  readonly serverQueuedMessageIds: ReadonlyArray<MessageId>;
}): ReadonlyArray<MessageId> {
  const serverQueuedIds = new Set(input.serverQueuedMessageIds);
  const candidates = [
    ...input.serverMessages
      .filter((message) => serverQueuedIds.has(message.id))
      .map((message, sourceIndex) => ({
        messageId: message.id,
        createdAt: message.createdAt,
        sourceRank: 0,
        sourceIndex,
      })),
    ...input.localMessages.map((message, sourceIndex) => ({
      messageId: message.messageId,
      createdAt: message.createdAt,
      sourceRank: 1,
      sourceIndex,
    })),
  ].sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt < right.createdAt ? -1 : 1;
    }
    if (left.sourceRank !== right.sourceRank) {
      return left.sourceRank - right.sourceRank;
    }
    return left.sourceIndex - right.sourceIndex;
  });
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    if (seen.has(candidate.messageId)) return [];
    seen.add(candidate.messageId);
    return [candidate.messageId];
  });
}

export function requestQueuedTurnPromotion(input: QueuedTurnPromotionRequest): void {
  const key = scopedThreadKey(input.environmentId, input.threadId);
  const current = appAtomRegistry.get(queuedTurnPromotionRequestsAtom);
  if (current[key]) return;
  appAtomRegistry.set(queuedTurnPromotionRequestsAtom, {
    ...current,
    [key]: { ...input, phase: "requested" },
  });
}

export function markQueuedTurnPromotionAwaitingProjection(input: QueuedTurnPromotionRequest): void {
  const key = scopedThreadKey(input.environmentId, input.threadId);
  const current = appAtomRegistry.get(queuedTurnPromotionRequestsAtom);
  const request = current[key];
  if (!request || request.phase === "awaiting-projection") return;
  appAtomRegistry.set(queuedTurnPromotionRequestsAtom, {
    ...current,
    [key]: { ...request, phase: "awaiting-projection" },
  });
}

export function queuedTurnPromotionOutcome(input: {
  readonly state: QueuedTurnPromotionState;
  readonly projectedMessageIds: ReadonlyArray<MessageId>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}): QueuedTurnPromotionOutcome | null {
  if (input.state.phase !== "awaiting-projection") return null;
  const projectedMessageIds = new Set(input.projectedMessageIds);
  if (
    input.state.serverProjectionRequiredMessageIds.some(
      (messageId) => !projectedMessageIds.has(messageId),
    )
  ) {
    return null;
  }
  return resolveQueuedTurnPromotionOutcome({
    activities: input.activities,
    expectedMessageIds: input.state.messageIds,
    requestId: input.state.commandId,
  });
}

export function clearQueuedTurnPromotionRequest(input: QueuedTurnPromotionRequest): void {
  const key = scopedThreadKey(input.environmentId, input.threadId);
  const current = appAtomRegistry.get(queuedTurnPromotionRequestsAtom);
  if (!current[key]) return;
  const next = { ...current };
  delete next[key];
  appAtomRegistry.set(queuedTurnPromotionRequestsAtom, next);
}
