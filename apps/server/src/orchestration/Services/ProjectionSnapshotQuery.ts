/**
 * ProjectionSnapshotQuery - Read-model snapshot query service interface.
 *
 * Exposes the current orchestration projection snapshot for read-only API
 * access.
 *
 * @module ProjectionSnapshotQuery
 */
import type {
  CheckpointRef,
  EventId,
  MessageId,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationEvent,
  OrchestrationLatestTurn,
  OrchestrationProject,
  OrchestrationProjectShell,
  OrchestrationProposedPlan,
  OrchestrationReadModel,
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadHistoryPage,
  OrchestrationThreadHistoryPageInput,
  OrchestrationThreadShell,
  ProviderInteractionMode,
  ProjectId,
  ThreadId,
  TurnId,
  VmAgentDelegationId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Option from "effect/Option";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ProjectionSnapshotCounts {
  readonly projectCount: number;
  readonly threadCount: number;
}

export interface ProjectionSnapshotSequence {
  readonly snapshotSequence: number;
}

export interface ProjectionThreadCheckpointContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
}

export interface ProjectionFullThreadDiffContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly latestCheckpointTurnCount: number;
  readonly toCheckpointRef: CheckpointRef | null;
}

export interface ProjectionThreadIngestionContext {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly proposedPlans: ReadonlyArray<OrchestrationProposedPlan>;
  readonly taskTitle: string | null;
}

export interface ProjectionThreadAssetSource {
  readonly activity: OrchestrationThreadActivity | null;
  readonly message: OrchestrationMessage | null;
}

export interface ProjectionLatestTurnStartContext {
  readonly interactionMode: ProviderInteractionMode;
}

export type ProjectionThreadTurnStartContext = Extract<
  OrchestrationEvent,
  { readonly type: "thread.turn-start-requested" }
>["payload"];

export interface ProjectionPersistedTurnStartContext {
  readonly payload: ProjectionThreadTurnStartContext;
  readonly sequence: number;
  readonly hasLaterRealUserTurn: boolean;
  readonly providerTurnId: TurnId | null;
  readonly providerTurnState: OrchestrationLatestTurn["state"] | null;
}

export interface ProjectionProviderTurnForMessage {
  readonly turnId: TurnId;
  readonly state: OrchestrationLatestTurn["state"];
  /** Immutable user message that launched this turn, when the projection has one. */
  readonly sourceMessageId?: MessageId | null;
}

/**
 * Server-owned delegation provenance for the exact turn currently running on
 * a thread. This is intentionally narrower than "is this an agent thread": a
 * named agent can also be serving an unrelated user turn at the same time a
 * delegation remains queued for it.
 */
export interface ProjectionActiveTurnDelegation {
  readonly delegationId: VmAgentDelegationId;
}

/**
 * ProjectionSnapshotQueryShape - Service API for read-model snapshots.
 */
export interface ProjectionSnapshotQueryShape {
  /**
   * Read the lightweight command snapshot used to bootstrap the in-memory
   * orchestration engine without hydrating message/activity/checkpoint bodies.
   */
  readonly getCommandReadModel: () => Effect.Effect<
    OrchestrationReadModel,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest orchestration projection snapshot.
   *
   * Rehydrates from projection tables and derives snapshot sequence from
   * projector cursor state.
   */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;

  /**
   * Read the latest orchestration shell snapshot.
   *
   * Returns only projects and thread shell summaries so clients can bootstrap
   * lightweight navigation state without hydrating every thread body.
   */
  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read archived thread shell summaries for the archive page.
   *
   * This query is separate from the main shell snapshot so archived threads
   * are never bootstrapped into normal navigation state.
   */
  readonly getArchivedShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Search active thread navigation metadata, user messages, and canonical
   * assistant outputs without hydrating thread detail snapshots.
   */
  readonly searchThreads: (
    input: OrchestrationSearchThreadsInput,
  ) => Effect.Effect<OrchestrationSearchThreadsResult, ProjectionRepositoryError>;

  /**
   * Read the latest projection snapshot sequence without hydrating read-model
   * entities.
   */
  readonly getSnapshotSequence: () => Effect.Effect<
    ProjectionSnapshotSequence,
    ProjectionRepositoryError
  >;

  /**
   * Read aggregate projection counts without hydrating the full read model.
   */
  readonly getCounts: () => Effect.Effect<ProjectionSnapshotCounts, ProjectionRepositoryError>;

  /**
   * Read the active project for an exact workspace root match.
   */
  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, ProjectionRepositoryError>;

  /**
   * Read a single active project shell row by id.
   */
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectionRepositoryError>;

  /**
   * Read the earliest active thread for a project.
   */
  readonly getFirstActiveThreadIdByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>;

  /**
   * Read the checkpoint context needed to resolve a single thread diff.
   */
  readonly getThreadCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadCheckpointContext>, ProjectionRepositoryError>;

  /**
   * Read only the narrow context needed to compute a full-thread diff from
   * checkpoint 0 to a specific turn count.
   */
  readonly getFullThreadDiffContext: (
    threadId: ThreadId,
    toTurnCount: number,
  ) => Effect.Effect<Option.Option<ProjectionFullThreadDiffContext>, ProjectionRepositoryError>;

  /**
   * Read a single active thread shell row by id.
   */
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;

  /**
   * Reads how the latest concrete turn was started without replaying the
   * thread transcript. Optional for compatibility with narrow test doubles.
   */
  readonly getThreadLatestTurnStartContext?: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionLatestTurnStartContext>, ProjectionRepositoryError>;

  /**
   * Read the immutable start request for one projected user message. Durable
   * work uses this instead of retaining renderer or event-stream state.
   */
  readonly getThreadTurnStartContext?: (
    threadId: ThreadId,
    messageId: MessageId,
  ) => Effect.Effect<Option.Option<ProjectionPersistedTurnStartContext>, ProjectionRepositoryError>;

  /**
   * Read the newest provider turn started from one exact delivery message id.
   * Unlike getThreadTurnStartContext, this also supports internal recovery
   * deliveries that intentionally have no projected user message.
   */
  readonly getThreadProviderTurnForMessage?: (
    threadId: ThreadId,
    messageId: MessageId,
  ) => Effect.Effect<Option.Option<ProjectionProviderTurnForMessage>, ProjectionRepositoryError>;

  /**
   * Read one exact provider turn independently of the thread's latest-turn
   * pointer. Durable work uses this when provider failover has already made a
   * successor turn the latest while the original delivery is still settling.
   */
  readonly getThreadProviderTurnById?: (
    threadId: ThreadId,
    turnId: TurnId,
  ) => Effect.Effect<Option.Option<ProjectionProviderTurnForMessage>, ProjectionRepositoryError>;

  /** Resolve delegation provenance from the active turn's exact input message. */
  readonly getActiveTurnDelegation?: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionActiveTurnDelegation>, ProjectionRepositoryError>;

  /**
   * Read only the bounded message/plan state needed while ingesting provider
   * events. This deliberately excludes activities and checkpoints, whose
   * payload history can be hundreds of megabytes on long-running threads.
   */
  readonly getThreadIngestionContext: (
    threadId: ThreadId,
    taskId?: string,
  ) => Effect.Effect<Option.Option<ProjectionThreadIngestionContext>, ProjectionRepositoryError>;

  /**
   * Read only the exact activity/message named by an asset URL request.
   * Optional for compatibility with lightweight test doubles; the live
   * implementation always provides it.
   */
  readonly getThreadAssetSource?: (
    threadId: ThreadId,
    source: {
      readonly activityId?: EventId;
      readonly messageId?: MessageId;
    },
  ) => Effect.Effect<ProjectionThreadAssetSource, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot by id.
   */
  readonly getThreadDetailById: (
    threadId: ThreadId,
    options?: { readonly activityLimit?: number },
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail together with the projection snapshot
   * sequence in one consistent transaction, so the returned `snapshotSequence`
   * exactly matches the state reflected in `thread` (no interleaving projector
   * update between the two reads).
   */
  readonly getThreadDetailSnapshot: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>, ProjectionRepositoryError>;

  /** Read one bounded page older than the supplied snapshot/history cursors. */
  readonly getThreadHistoryPage?: (
    threadId: ThreadId,
    input: OrchestrationThreadHistoryPageInput,
  ) => Effect.Effect<Option.Option<OrchestrationThreadHistoryPage>, ProjectionRepositoryError>;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("t3/orchestration/Services/ProjectionSnapshotQuery") {}
