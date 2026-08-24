import type {
  IsoDateTime,
  MessageId,
  VmAgentDelegation,
  VmAgentDelegationId,
  VmAgentDelegationListItem,
  VmAgentDelegationMessage,
  VmAgentDelegationMessageId,
  VmAgentDelegationStatus,
  VmAgentId,
  VmAgentTaskId,
  VmAgentTaskRunId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../Errors.ts";

export interface CreateVmAgentDelegationInput {
  readonly delegation: VmAgentDelegation;
  readonly idempotencyKey: string;
  readonly initialMessage: VmAgentDelegationMessage;
  /** Durable agent row used only as the existing task scheduler's carrier. */
  readonly schedulerVmAgentId: VmAgentId;
}

export interface AppendVmAgentDelegationMessageInput {
  readonly messageId: VmAgentDelegationMessageId;
  readonly delegationId: VmAgentDelegationId;
  readonly sender: "source-agent" | "target-agent" | "user" | "system";
  readonly senderVmAgentId: VmAgentId | null;
  readonly kind: "note" | "question" | "answer";
  readonly delivery: "pending" | "delivered";
  readonly text: string;
  readonly createdAt: IsoDateTime;
  readonly incrementFollowup: boolean;
  readonly nextStatus?: VmAgentDelegationStatus | undefined;
  readonly deliveryMessageId?: MessageId | undefined;
}

export interface CompleteVmAgentDelegationInput {
  readonly runId: VmAgentTaskRunId;
  readonly status: "completed" | "failed" | "cancelled" | "expired";
  readonly summary: string | null;
  readonly error: string | null;
  readonly completedAt: IsoDateTime;
  readonly messageId?: VmAgentDelegationMessageId | undefined;
}

export interface VmAgentDelegationMessagePage {
  readonly messages: ReadonlyArray<VmAgentDelegationMessage>;
  readonly hasEarlierMessages: boolean;
}

export interface VmAgentCollaborationStoreShape {
  readonly list: () => Effect.Effect<ReadonlyArray<VmAgentDelegation>, ProjectionRepositoryError>;
  readonly listForAgent: (
    vmAgentId: VmAgentId,
  ) => Effect.Effect<ReadonlyArray<VmAgentDelegation>, ProjectionRepositoryError>;
  /** Bounded rows for snapshots and list surfaces; full payload columns never cross the SQL boundary. */
  readonly listSummaries: () => Effect.Effect<
    ReadonlyArray<VmAgentDelegationListItem>,
    ProjectionRepositoryError
  >;
  readonly listSummariesForAgent: (
    vmAgentId: VmAgentId,
  ) => Effect.Effect<ReadonlyArray<VmAgentDelegationListItem>, ProjectionRepositoryError>;
  readonly getById: (
    delegationId: VmAgentDelegationId,
  ) => Effect.Effect<Option.Option<VmAgentDelegation>, ProjectionRepositoryError>;
  readonly getByRunId: (
    runId: VmAgentTaskRunId,
  ) => Effect.Effect<Option.Option<VmAgentDelegation>, ProjectionRepositoryError>;
  readonly getByTaskId: (
    taskId: VmAgentTaskId,
  ) => Effect.Effect<Option.Option<VmAgentDelegation>, ProjectionRepositoryError>;
  readonly getByWorkerThreadId: (
    threadId: string,
  ) => Effect.Effect<Option.Option<VmAgentDelegation>, ProjectionRepositoryError>;
  readonly getByIdempotencyKey: (
    sourceVmAgentId: VmAgentId,
    idempotencyKey: string,
  ) => Effect.Effect<Option.Option<VmAgentDelegation>, ProjectionRepositoryError>;
  readonly listMessages: (
    delegationId: VmAgentDelegationId,
  ) => Effect.Effect<ReadonlyArray<VmAgentDelegationMessage>, ProjectionRepositoryError>;
  readonly listMessagesPage: (
    delegationId: VmAgentDelegationId,
    beforeSequence: number | null,
    limit: number,
  ) => Effect.Effect<VmAgentDelegationMessagePage, ProjectionRepositoryError>;
  readonly create: (
    input: CreateVmAgentDelegationInput,
  ) => Effect.Effect<VmAgentDelegation, ProjectionRepositoryError>;
  readonly markRunClaimed: (input: {
    readonly taskId: VmAgentTaskId;
    readonly runId: VmAgentTaskRunId;
    readonly updatedAt: IsoDateTime;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly markRunning: (input: {
    readonly runId: VmAgentTaskRunId;
    readonly startedAt: IsoDateTime;
    readonly messageId: MessageId;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly setWorkerThread: (input: {
    readonly delegationId: VmAgentDelegationId;
    readonly threadId: string;
    readonly updatedAt: IsoDateTime;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly appendMessage: (
    input: AppendVmAgentDelegationMessageInput,
  ) => Effect.Effect<VmAgentDelegationMessage, ProjectionRepositoryError>;
  readonly markMessageDelivered: (input: {
    readonly messageId: VmAgentDelegationMessageId;
    readonly updatedAt: IsoDateTime;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Re-arm the one-shot scheduler carrier after its current turn settles. */
  readonly requeuePendingFollowup: (input: {
    readonly delegationId: VmAgentDelegationId;
    readonly updatedAt: IsoDateTime;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly complete: (
    input: CompleteVmAgentDelegationInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly cancel: (input: {
    readonly delegationId: VmAgentDelegationId;
    readonly status: "cancelled" | "expired";
    readonly detail: string;
    readonly completedAt: IsoDateTime;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listExpired: (
    now: IsoDateTime,
  ) => Effect.Effect<ReadonlyArray<VmAgentDelegation>, ProjectionRepositoryError>;
  readonly countActiveForRoot: (
    vmAgentId: VmAgentId,
  ) => Effect.Effect<number, ProjectionRepositoryError>;
  readonly findActiveForTarget: (
    vmAgentId: VmAgentId,
  ) => Effect.Effect<Option.Option<VmAgentDelegation>, ProjectionRepositoryError>;
  readonly hasActiveTargetThread: (
    threadId: string,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
}

export class VmAgentCollaborationStore extends Context.Service<
  VmAgentCollaborationStore,
  VmAgentCollaborationStoreShape
>()("t3/persistence/Services/VmAgentCollaborations/VmAgentCollaborationStore") {}
