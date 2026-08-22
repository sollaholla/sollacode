import type {
  IsoDateTime,
  MessageId,
  VmAgentArtifact,
  VmAgentArtifactDefinition,
  VmAgentArtifactId,
  VmAgentId,
  VmAgentNotificationId,
  VmAgentNotificationKind,
  VmAgentNotificationPreferences,
  VmAgentTask,
  VmAgentTaskApprovalState,
  VmAgentTaskCreatedBy,
  VmAgentTaskId,
  VmAgentTaskNotificationPolicy,
  VmAgentTaskRun,
  VmAgentTaskRunId,
  VmAgentTaskSchedule,
  VmAgentTaskStatus,
  VmAgentWorkspaceSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../Errors.ts";

export interface CreateVmAgentTaskInput {
  readonly taskId: VmAgentTaskId;
  readonly vmAgentId: VmAgentId;
  readonly title: string;
  readonly prompt: string;
  readonly completionCriteria: ReadonlyArray<string>;
  readonly status: VmAgentTaskStatus;
  readonly schedule: VmAgentTaskSchedule | null;
  readonly nextRunAt: IsoDateTime | null;
  readonly createdBy: VmAgentTaskCreatedBy;
  readonly approvalState: VmAgentTaskApprovalState;
  readonly notificationPolicy: VmAgentTaskNotificationPolicy;
  readonly artifactId: VmAgentArtifactId | null;
  readonly createdAt: IsoDateTime;
}

export interface UpdateVmAgentTaskInput {
  readonly taskId: VmAgentTaskId;
  readonly vmAgentId: VmAgentId;
  readonly title: string;
  readonly prompt: string;
  readonly completionCriteria: ReadonlyArray<string>;
  readonly status: VmAgentTaskStatus;
  readonly schedule: VmAgentTaskSchedule | null;
  readonly nextRunAt: IsoDateTime | null;
  readonly approvalState: VmAgentTaskApprovalState;
  readonly notificationPolicy: VmAgentTaskNotificationPolicy;
  readonly updatedAt: IsoDateTime;
}

export interface ClaimVmAgentTaskInput {
  readonly runId: VmAgentTaskRunId;
  readonly now: IsoDateTime;
}

export interface SetVmAgentTaskRunRunningInput {
  readonly runId: VmAgentTaskRunId;
  readonly messageId: MessageId;
  readonly startedAt: IsoDateTime;
}

export interface CompleteVmAgentTaskRunInput {
  readonly runId: VmAgentTaskRunId;
  readonly status: "completed" | "failed" | "cancelled";
  readonly turnId: string | null;
  readonly resultSummary: string | null;
  readonly error: string | null;
  readonly completedAt: IsoDateTime;
}

export interface VmAgentTaskRunObservation {
  readonly run: VmAgentTaskRun;
  readonly projectionState:
    | "pending"
    | "running"
    | "interrupted"
    | "incomplete"
    | "completed"
    | "error"
    | null;
  readonly projectionTurnId: string | null;
  readonly assistantText: string | null;
}

export interface CreateVmAgentNotificationInput {
  readonly notificationId: VmAgentNotificationId;
  readonly vmAgentId: VmAgentId;
  readonly taskId: VmAgentTaskId | null;
  readonly runId: VmAgentTaskRunId | null;
  readonly kind: VmAgentNotificationKind;
  readonly title: string;
  readonly body: string;
  readonly deepLink: string;
  readonly dedupeKey: string;
  readonly createdAt: IsoDateTime;
}

export interface UpsertVmAgentArtifactInput {
  readonly artifactId: VmAgentArtifactId;
  readonly vmAgentId: VmAgentId;
  readonly title: string;
  readonly definition: VmAgentArtifactDefinition;
  readonly updatedAt: IsoDateTime;
}

export interface VmAgentWorkspaceStoreShape {
  readonly ensureDefaults: (input: {
    readonly vmAgentId: VmAgentId;
    readonly artifactId: VmAgentArtifactId;
    readonly now: IsoDateTime;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly snapshot: (
    vmAgentId: VmAgentId,
  ) => Effect.Effect<VmAgentWorkspaceSnapshot, ProjectionRepositoryError>;
  readonly getTask: (
    vmAgentId: VmAgentId,
    taskId: VmAgentTaskId,
  ) => Effect.Effect<Option.Option<VmAgentTask>, ProjectionRepositoryError>;
  readonly createTask: (
    input: CreateVmAgentTaskInput,
  ) => Effect.Effect<VmAgentTask, ProjectionRepositoryError>;
  readonly updateTask: (
    input: UpdateVmAgentTaskInput,
  ) => Effect.Effect<VmAgentTask, ProjectionRepositoryError>;
  readonly deleteTask: (
    vmAgentId: VmAgentId,
    taskId: VmAgentTaskId,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly runTaskNow: (input: {
    readonly vmAgentId: VmAgentId;
    readonly taskId: VmAgentTaskId;
    readonly now: IsoDateTime;
  }) => Effect.Effect<VmAgentTask, ProjectionRepositoryError>;
  readonly claimNextDue: (
    input: ClaimVmAgentTaskInput,
  ) => Effect.Effect<
    Option.Option<{ readonly task: VmAgentTask; readonly run: VmAgentTaskRun }>,
    ProjectionRepositoryError
  >;
  readonly setRunBooting: (
    runId: VmAgentTaskRunId,
    updatedAt: IsoDateTime,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly setRunRunning: (
    input: SetVmAgentTaskRunRunningInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly completeRun: (
    input: CompleteVmAgentTaskRunInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listRunObservations: () => Effect.Effect<
    ReadonlyArray<VmAgentTaskRunObservation>,
    ProjectionRepositoryError
  >;
  readonly createNotification: (
    input: CreateVmAgentNotificationInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly markNotificationRead: (input: {
    readonly vmAgentId: VmAgentId;
    readonly notificationId: VmAgentNotificationId;
    readonly readAt: IsoDateTime;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly updateNotificationPreferences: (
    preferences: VmAgentNotificationPreferences,
  ) => Effect.Effect<VmAgentNotificationPreferences, ProjectionRepositoryError>;
  readonly upsertArtifact: (
    input: UpsertVmAgentArtifactInput,
  ) => Effect.Effect<VmAgentArtifact, ProjectionRepositoryError>;
}

export class VmAgentWorkspaceStore extends Context.Service<
  VmAgentWorkspaceStore,
  VmAgentWorkspaceStoreShape
>()("t3/persistence/Services/VmAgentWorkspaces/VmAgentWorkspaceStore") {}
