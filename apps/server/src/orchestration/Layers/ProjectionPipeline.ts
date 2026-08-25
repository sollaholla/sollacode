import {
  ApprovalRequestId,
  type ChatAttachment,
  EventId,
  MessageId,
  ProviderInstanceId,
  type OrchestrationEvent,
  type OrchestrationSessionStatus,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  appendAgentStreamText,
  emittedAgentStop,
  isProviderAuthenticationFailure,
  shouldAgentContinueAfterReply,
} from "@t3tools/shared/agentMode";
import { isBrowserTabCleanupMessageId } from "@t3tools/shared/browserTabCleanup";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { refreshProjectionThreadPendingWork } from "../../persistence/PendingWorkProjection.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import {
  ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON,
  ACTIVE_TURN_STEER_DELIVERY_UNKNOWN_REASON,
  ThreadWorkObligationRepository,
} from "../../persistence/Services/ThreadWorkObligations.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { type ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import {
  type ProjectionThreadMessage,
  ProjectionThreadMessageRepository,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import {
  type ProjectionThreadProposedPlan,
  ProjectionThreadProposedPlanRepository,
} from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import {
  type ProjectionTurn,
  ProjectionTurnRepository,
} from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../persistence/Layers/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionStateRepositoryLive } from "../../persistence/Layers/ProjectionState.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../../persistence/Layers/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepositoryLive } from "../../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { ThreadWorkObligationRepositoryLive } from "../../persistence/Layers/ThreadWorkObligations.ts";
import { ServerConfig } from "../../config.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import {
  attachmentRelativePath,
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";
import {
  activeTurnWorkSourceId,
  agentContinuationSourceTurnId,
  isAgentAutoResumeMessageId,
  isVmAgentTaskPromptMessageId,
  KILLED_BACKGROUND_TASK_RESUME_MAX_AGE_MS,
  startupResumeSourceTurnId,
  threadLostBackgroundTaskAtRestart,
  threadWorkObligationId,
} from "../agentModeContinuation.ts";
import {
  increment,
  threadWorkAuthenticationTransitionsTotal,
} from "../../observability/Metrics.ts";

export const ORCHESTRATION_PROJECTOR_NAMES = {
  projects: "projection.projects",
  threads: "projection.threads",
  threadMessages: "projection.thread-messages",
  threadProposedPlans: "projection.thread-proposed-plans",
  threadActivities: "projection.thread-activities",
  threadSessions: "projection.thread-sessions",
  threadTurns: "projection.thread-turns",
  checkpoints: "projection.checkpoints",
  pendingApprovals: "projection.pending-approvals",
  threadWork: "projection.thread-work",
} as const;

type ProjectorName =
  (typeof ORCHESTRATION_PROJECTOR_NAMES)[keyof typeof ORCHESTRATION_PROJECTOR_NAMES];

/**
 * Turn state to settle still-running turns with when their session leaves the
 * "running" status, or null while the session is (re)starting or running and
 * turns must stay unsettled.
 */
export function settledTurnStateForSessionStatus(
  status: OrchestrationSessionStatus,
): "completed" | "interrupted" | "incomplete" | "error" | null {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "incomplete";
    case "starting":
    case "running":
      return null;
  }
}

interface ProjectorDefinition {
  readonly name: ProjectorName;
  readonly apply: (
    event: OrchestrationEvent,
    attachmentSideEffects: AttachmentSideEffects,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

interface AttachmentSideEffects {
  readonly deletedThreadIds: Set<string>;
  readonly prunedThreadRelativePaths: Map<string, Set<string>>;
  readonly forkedAttachments: Array<{
    readonly source: ChatAttachment;
    readonly target: ChatAttachment;
  }>;
}

const materializeAttachmentsForProjection = Effect.fn("materializeAttachmentsForProjection")(
  (input: { readonly attachments: ReadonlyArray<ChatAttachment> }) =>
    Effect.succeed(input.attachments.length === 0 ? [] : input.attachments),
);

const forkedProjectionMessageId = (threadId: ThreadId, messageId: string) =>
  MessageId.make(`${threadId}:fork:${messageId}`);
const forkedProjectionTurnId = (threadId: ThreadId, turnId: string) =>
  TurnId.make(`${threadId}:fork:${turnId}`);
const forkedProjectionActivityId = (threadId: ThreadId, activityId: string) =>
  EventId.make(`${threadId}:fork:${activityId}`);

function forkedProjectionAttachment(
  threadId: ThreadId,
  attachment: ChatAttachment,
): ChatAttachment {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  const uuidSuffix = attachment.id.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  )?.[1];
  if (!threadSegment || !uuidSuffix) {
    return attachment;
  }
  return {
    ...attachment,
    id: `${threadSegment}-${uuidSuffix}` as typeof attachment.id,
  };
}

function extractActivityRequestId(payload: unknown): ApprovalRequestId | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? ApprovalRequestId.make(requestId) : null;
}

function isStalePendingApprovalFailureDetail(detail: string | null): boolean {
  if (detail === null) {
    return false;
  }
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request")
  );
}

function retainProjectionMessagesAfterRevert(
  messages: ReadonlyArray<ProjectionThreadMessage>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadMessage> {
  const retainedMessageIds = new Set<string>();
  const retainedTurnIds = new Set<string>();
  const keptTurns = turns.filter(
    (turn) =>
      turn.turnId !== null &&
      turn.checkpointTurnCount !== null &&
      turn.checkpointTurnCount <= turnCount,
  );
  for (const turn of keptTurns) {
    if (turn.turnId !== null) {
      retainedTurnIds.add(turn.turnId);
    }
    if (turn.pendingMessageId !== null) {
      retainedMessageIds.add(turn.pendingMessageId);
    }
    if (turn.assistantMessageId !== null) {
      retainedMessageIds.add(turn.assistantMessageId);
    }
  }

  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.messageId);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.messageId));
}

function retainProjectionActivitiesAfterRevert(
  activities: ReadonlyArray<ProjectionThreadActivity>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadActivity> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainProjectionProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<ProjectionThreadProposedPlan>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadProposedPlan> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function collectThreadAttachmentRelativePaths(
  threadId: string,
  messages: ReadonlyArray<ProjectionThreadMessage>,
): Set<string> {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return new Set();
  }
  const relativePaths = new Set<string>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.type !== "image") {
        continue;
      }
      const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachment.id);
      if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
        continue;
      }
      relativePaths.add(attachmentRelativePath(attachment));
    }
  }
  return relativePaths;
}

const runAttachmentSideEffects = Effect.fn("runAttachmentSideEffects")(function* (
  sideEffects: AttachmentSideEffects,
) {
  const serverConfig = yield* Effect.service(ServerConfig);
  const fileSystem = yield* Effect.service(FileSystem.FileSystem);
  const path = yield* Effect.service(Path.Path);

  const attachmentsRootDir = serverConfig.attachmentsDir;
  const readAttachmentRootEntries = fileSystem
    .readDirectory(attachmentsRootDir, { recursive: false })
    .pipe(Effect.orElseSucceed(() => [] as Array<string>));

  const copyForkedAttachment = Effect.fn("copyForkedAttachment")(function* (input: {
    readonly source: ChatAttachment;
    readonly target: ChatAttachment;
  }) {
    if (input.source.id === input.target.id) {
      return;
    }
    const sourcePath = path.join(attachmentsRootDir, attachmentRelativePath(input.source));
    const targetPath = path.join(attachmentsRootDir, attachmentRelativePath(input.target));
    yield* fileSystem.copyFile(sourcePath, targetPath).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("failed to copy attachment into forked conversation", {
          sourceAttachmentId: input.source.id,
          targetAttachmentId: input.target.id,
          cause,
        }),
      ),
    );
  });

  const removeDeletedThreadAttachmentEntry = Effect.fn("removeDeletedThreadAttachmentEntry")(
    function* (threadSegment: string, entry: string) {
      const normalizedEntry = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
      if (normalizedEntry.length === 0 || normalizedEntry.includes("/")) {
        return;
      }
      const attachmentId = parseAttachmentIdFromRelativePath(normalizedEntry);
      if (!attachmentId) {
        return;
      }
      const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
      if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
        return;
      }
      yield* fileSystem.remove(path.join(attachmentsRootDir, normalizedEntry), {
        force: true,
      });
    },
  );

  const deleteThreadAttachments = Effect.fn("deleteThreadAttachments")(function* (
    threadId: string,
  ) {
    const threadSegment = toSafeThreadAttachmentSegment(threadId);
    if (!threadSegment) {
      yield* Effect.logWarning("skipping attachment cleanup for unsafe thread id", {
        threadId,
      });
      return;
    }

    const entries = yield* readAttachmentRootEntries;
    yield* Effect.forEach(
      entries,
      (entry) => removeDeletedThreadAttachmentEntry(threadSegment, entry),
      {
        concurrency: 1,
      },
    );
  });

  const pruneThreadAttachmentEntry = Effect.fn("pruneThreadAttachmentEntry")(function* (
    threadSegment: string,
    keptThreadRelativePaths: Set<string>,
    entry: string,
  ) {
    const relativePath = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
    if (relativePath.length === 0 || relativePath.includes("/")) {
      return;
    }
    const attachmentId = parseAttachmentIdFromRelativePath(relativePath);
    if (!attachmentId) {
      return;
    }
    const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
      return;
    }

    const absolutePath = path.join(attachmentsRootDir, relativePath);
    const fileInfo = yield* fileSystem.stat(absolutePath).pipe(Effect.orElseSucceed(() => null));
    if (!fileInfo || fileInfo.type !== "File") {
      return;
    }

    if (!keptThreadRelativePaths.has(relativePath)) {
      yield* fileSystem.remove(absolutePath, { force: true });
    }
  });

  const pruneThreadAttachments = Effect.fn("pruneThreadAttachments")(function* (
    threadId: string,
    keptThreadRelativePaths: Set<string>,
  ) {
    if (sideEffects.deletedThreadIds.has(threadId)) {
      return;
    }

    const threadSegment = toSafeThreadAttachmentSegment(threadId);
    if (!threadSegment) {
      yield* Effect.logWarning("skipping attachment prune for unsafe thread id", { threadId });
      return;
    }

    const entries = yield* readAttachmentRootEntries;
    yield* Effect.forEach(
      entries,
      (entry) => pruneThreadAttachmentEntry(threadSegment, keptThreadRelativePaths, entry),
      { concurrency: 1 },
    );
  });

  yield* Effect.forEach(sideEffects.forkedAttachments, copyForkedAttachment, {
    concurrency: 1,
  });

  yield* Effect.forEach(sideEffects.deletedThreadIds, deleteThreadAttachments, {
    concurrency: 1,
  });

  yield* Effect.forEach(
    sideEffects.prunedThreadRelativePaths.entries(),
    ([threadId, keptThreadRelativePaths]) =>
      pruneThreadAttachments(threadId, keptThreadRelativePaths),
    { concurrency: 1 },
  );
});

const makeOrchestrationProjectionPipeline = Effect.fn("makeOrchestrationProjectionPipeline")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* OrchestrationEventStore;
    const projectionStateRepository = yield* ProjectionStateRepository;
    const projectionProjectRepository = yield* ProjectionProjectRepository;
    const projectionThreadRepository = yield* ProjectionThreadRepository;
    const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
    const projectionThreadProposedPlanRepository = yield* ProjectionThreadProposedPlanRepository;
    const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
    const projectionThreadSessionRepository = yield* ProjectionThreadSessionRepository;
    const projectionTurnRepository = yield* ProjectionTurnRepository;
    const projectionPendingApprovalRepository = yield* ProjectionPendingApprovalRepository;
    const threadWorkObligationRepository = yield* ThreadWorkObligationRepository;

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;

    const applyProjectsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyProjectsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "project.created":
          yield* projectionProjectRepository.upsert({
            projectId: event.payload.projectId,
            title: event.payload.title,
            workspaceRoot: event.payload.workspaceRoot,
            defaultModelSelection: event.payload.defaultModelSelection,
            scripts: event.payload.scripts,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            deletedAt: null,
          });
          return;

        case "project.meta-updated": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.workspaceRoot !== undefined
              ? { workspaceRoot: event.payload.workspaceRoot }
              : {}),
            ...(event.payload.defaultModelSelection !== undefined
              ? { defaultModelSelection: event.payload.defaultModelSelection }
              : {}),
            ...(event.payload.scripts !== undefined ? { scripts: event.payload.scripts } : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "project.deleted": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        default:
          return;
      }
    });

    const refreshPendingApprovalSummary = Effect.fn("refreshPendingApprovalSummary")(function* (
      threadId: ThreadId,
    ) {
      yield* sql`
          UPDATE projection_threads
          SET pending_approval_count = COALESCE((
            SELECT COUNT(*)
            FROM projection_pending_approvals
            WHERE projection_pending_approvals.thread_id = ${threadId}
              AND projection_pending_approvals.status = 'pending'
          ), 0)
          WHERE thread_id = ${threadId}
        `.pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionPipeline.refreshPendingApprovalSummary:query"),
        ),
      );
    });

    const refreshPendingUserInputSummary = Effect.fn("refreshPendingUserInputSummary")(function* (
      threadId: ThreadId,
    ) {
      // Only the latest request-state row is needed. Never hydrate the full
      // activity payload history here: tool output can make that history
      // hundreds of megabytes on a long-running thread.
      yield* sql`
          UPDATE projection_threads
          SET pending_user_input_count = COALESCE((
            WITH latest_user_input_states AS (
              SELECT
                latest.kind
              FROM (
                SELECT
                  activity.kind,
                  ROW_NUMBER() OVER (
                    PARTITION BY json_extract(activity.payload_json, '$.requestId')
                    ORDER BY activity.created_at DESC, activity.activity_id DESC
                  ) AS row_number
                FROM projection_thread_activities AS activity
                WHERE activity.thread_id = ${threadId}
                  AND json_valid(activity.payload_json)
                  AND json_extract(activity.payload_json, '$.requestId') IS NOT NULL
                  AND (
                    activity.kind IN ('user-input.requested', 'user-input.resolved')
                    OR (
                      activity.kind = 'provider.user-input.respond.failed'
                      AND (
                        lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                          LIKE '%stale pending user-input request%'
                        OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                          LIKE '%unknown pending user-input request%'
                        OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                          LIKE '%unknown pending user input request%'
                        OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                          LIKE '%unknown pending codex user input request%'
                      )
                    )
                  )
              ) AS latest
              WHERE latest.row_number = 1
            )
            SELECT COUNT(*)
            FROM latest_user_input_states
            WHERE latest_user_input_states.kind = 'user-input.requested'
          ), 0)
          WHERE thread_id = ${threadId}
        `.pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionPipeline.refreshPendingUserInputSummary:query"),
        ),
      );
    });

    const refreshActionableProposedPlanSummary = Effect.fn("refreshActionableProposedPlanSummary")(
      function* (threadId: ThreadId) {
        // Only the latest turn's unimplemented plan is actionable. An older
        // leftover plan is history, not a wait — falling back to "any plan on
        // the thread" made almost every thread look blocked.
        yield* sql`
          UPDATE projection_threads
          SET has_actionable_proposed_plan = COALESCE((
            SELECT CASE
              WHEN projection_threads.latest_turn_id IS NOT NULL
                AND EXISTS (
                  SELECT 1
                  FROM projection_thread_proposed_plans AS latest_turn_plan_exists
                  WHERE latest_turn_plan_exists.thread_id = projection_threads.thread_id
                    AND latest_turn_plan_exists.turn_id = projection_threads.latest_turn_id
                )
                THEN CASE
                  WHEN (
                    SELECT latest_turn_plan.implemented_at
                    FROM projection_thread_proposed_plans AS latest_turn_plan
                    WHERE latest_turn_plan.thread_id = projection_threads.thread_id
                      AND latest_turn_plan.turn_id = projection_threads.latest_turn_id
                    ORDER BY latest_turn_plan.updated_at DESC, latest_turn_plan.plan_id DESC
                    LIMIT 1
                  ) IS NULL
                    THEN 1
                    ELSE 0
                  END
              ELSE 0
            END
          ), 0)
          WHERE thread_id = ${threadId}
        `.pipe(
          Effect.mapError(
            toPersistenceSqlError("ProjectionPipeline.refreshActionableProposedPlanSummary:query"),
          ),
        );
      },
    );

    // The obligation repository refreshes these columns on every mutation, so
    // this is the safety net for shell reads that follow event application:
    // it re-derives the same denormalized pending-work columns in the same
    // transaction as the rest of the shell summary.
    const refreshPendingWorkSummary = Effect.fn("refreshPendingWorkSummary")(function* (
      threadId: ThreadId,
    ) {
      yield* refreshProjectionThreadPendingWork(sql, threadId).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionPipeline.refreshPendingWorkSummary:query"),
        ),
      );
    });

    const refreshThreadShellSummary = Effect.fn("refreshThreadShellSummary")(function* (
      threadId: ThreadId,
    ) {
      yield* sql`
          UPDATE projection_threads
          SET latest_user_message_at = (
            SELECT MAX(message.created_at)
            FROM projection_thread_messages AS message
            WHERE message.thread_id = ${threadId}
              AND message.role = 'user'
          )
          WHERE thread_id = ${threadId}
        `.pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionPipeline.refreshThreadShellSummary:messages"),
        ),
      );
      yield* refreshPendingApprovalSummary(threadId);
      yield* refreshPendingUserInputSummary(threadId);
      yield* refreshActionableProposedPlanSummary(threadId);
      yield* refreshPendingWorkSummary(threadId);
    });

    const applyThreadsProjection = Effect.fn("applyThreadsProjection")(function* (
      event: OrchestrationEvent,
      attachmentSideEffects: AttachmentSideEffects,
      deferThreadShellSummary: boolean,
    ) {
      const refreshThreadShellSummaryForEvent = (threadId: ThreadId) =>
        deferThreadShellSummary ? Effect.void : refreshThreadShellSummary(threadId);

      switch (event.type) {
        case "thread.created":
          yield* projectionThreadRepository.upsert({
            threadId: event.payload.threadId,
            projectId: event.payload.projectId,
            title: event.payload.title,
            createdByThreadId: event.payload.createdByThreadId ?? null,
            browserProfileThreadId: event.payload.browserProfileThreadId ?? null,
            isSideChat: false,
            sideChatParentThreadId: null,
            modelSelection: event.payload.modelSelection,
            runtimeMode: event.payload.runtimeMode,
            interactionMode: event.payload.interactionMode,
            branch: event.payload.branch,
            worktreePath: event.payload.worktreePath,
            latestTurnId: null,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            latestUserMessageAt: null,
            pendingApprovalCount: 0,
            pendingUserInputCount: 0,
            hasActionableProposedPlan: 0,
            deletedAt: null,
          });
          return;

        case "thread.forked": {
          const source = yield* projectionThreadRepository.getById({
            threadId: event.payload.sourceThreadId,
          });
          if (Option.isNone(source)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...source.value,
            threadId: event.payload.threadId,
            projectId: event.payload.projectId,
            title: event.payload.title,
            createdByThreadId: event.payload.createdByThreadId ?? null,
            browserProfileThreadId: event.payload.browserProfileThreadId ?? null,
            isSideChat: event.payload.isSideChat === true,
            sideChatParentThreadId:
              event.payload.isSideChat === true
                ? (event.payload.sideChatParentThreadId ?? event.payload.sourceThreadId)
                : null,
            modelSelection: event.payload.modelSelection,
            runtimeMode: event.payload.runtimeMode,
            interactionMode: event.payload.interactionMode,
            branch: event.payload.branch,
            worktreePath: event.payload.worktreePath,
            latestTurnId:
              event.payload.isSideChat === true || source.value.latestTurnId === null
                ? null
                : forkedProjectionTurnId(event.payload.threadId, source.value.latestTurnId),
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pendingApprovalCount: 0,
            pendingUserInputCount: 0,
            hasActionableProposedPlan: 0,
            deletedAt: null,
          });
          yield* refreshThreadShellSummaryForEvent(event.payload.threadId);
          return;
        }

        case "thread.archived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: event.payload.archivedAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unarchived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.settled": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            settledOverride: "settled",
            settledAt: event.payload.settledAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unsettled": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            settledOverride: event.payload.reason === "user" ? "active" : null,
            settledAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.snoozed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            snoozedUntil: event.payload.snoozedUntil,
            snoozedAt: event.payload.snoozedAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unsnoozed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            snoozedUntil: null,
            snoozedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.meta-updated": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.isSideChat !== undefined
              ? { isSideChat: event.payload.isSideChat }
              : {}),
            ...(event.payload.isSideChat === false
              ? { isSideChat: false, sideChatParentThreadId: null, deletedAt: null }
              : {}),
            ...(event.payload.modelSelection !== undefined
              ? { modelSelection: event.payload.modelSelection }
              : {}),
            ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
            ...(event.payload.worktreePath !== undefined
              ? { worktreePath: event.payload.worktreePath }
              : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.runtime-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            runtimeMode: event.payload.runtimeMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.interaction-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            interactionMode: event.payload.interactionMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.deleted": {
          attachmentSideEffects.deletedThreadIds.add(event.payload.threadId);
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        case "thread.message-sent": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            // Voice-transcript rows must not count as user activity: this
            // timestamp gates the agent continuation, boot recovery, and
            // settle/snooze, all of which expect a message that started (or
            // will start) provider work — a spoken exchange never does.
            latestUserMessageAt:
              event.payload.role === "user" &&
              event.payload.voiceTranscript !== true &&
              (existingRow.value.latestUserMessageAt === null ||
                event.payload.createdAt > existingRow.value.latestUserMessageAt)
                ? event.payload.createdAt
                : existingRow.value.latestUserMessageAt,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.proposed-plan-upserted": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            updatedAt: event.occurredAt,
          });
          if (!deferThreadShellSummary) {
            yield* refreshActionableProposedPlanSummary(event.payload.threadId);
          }
          return;
        }

        case "thread.activity-appended": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            updatedAt: event.occurredAt,
          });
          if (deferThreadShellSummary) {
            return;
          }
          if (
            event.payload.activity.kind === "approval.requested" ||
            event.payload.activity.kind === "approval.resolved" ||
            event.payload.activity.kind === "provider.approval.respond.failed"
          ) {
            yield* refreshPendingApprovalSummary(event.payload.threadId);
          }
          if (
            event.payload.activity.kind === "user-input.requested" ||
            event.payload.activity.kind === "user-input.resolved" ||
            event.payload.activity.kind === "provider.user-input.respond.failed"
          ) {
            yield* refreshPendingUserInputSummary(event.payload.threadId);
          }
          return;
        }

        case "thread.approval-response-requested": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            updatedAt: event.occurredAt,
          });
          if (!deferThreadShellSummary) {
            yield* refreshPendingApprovalSummary(event.payload.threadId);
          }
          return;
        }

        case "thread.user-input-response-requested": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.session-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId: event.payload.session.activeTurnId ?? existingRow.value.latestTurnId,
            updatedAt: event.occurredAt,
          });
          if (!deferThreadShellSummary) {
            yield* refreshActionableProposedPlanSummary(event.payload.threadId);
          }
          return;
        }

        case "thread.turn-diff-completed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          // Checkpoint capture is asynchronous and can arrive after a newer
          // provider turn has already completed. Never let that late diff move
          // the thread's latest-turn pointer backward; doing so makes clients
          // inspect an older reply and display a false auto-resume state.
          const keepsCurrentLatestTurn =
            existingRow.value.latestTurnId !== null &&
            existingRow.value.latestTurnId !== event.payload.turnId;
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId: keepsCurrentLatestTurn
              ? existingRow.value.latestTurnId
              : event.payload.turnId,
            updatedAt: event.occurredAt,
          });
          if (!deferThreadShellSummary) {
            yield* refreshActionableProposedPlanSummary(event.payload.threadId);
          }
          return;
        }

        case "thread.reverted": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }

          const retainedTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          let latestTurnId: ProjectionTurn["turnId"] = null;
          let latestCheckpointTurnCount = -1;
          for (let index = 0; index < retainedTurns.length; index += 1) {
            const turn = retainedTurns[index];
            if (
              !turn ||
              turn.turnId === null ||
              turn.checkpointTurnCount === null ||
              turn.checkpointTurnCount > event.payload.turnCount
            ) {
              continue;
            }
            if (turn.checkpointTurnCount > latestCheckpointTurnCount) {
              latestCheckpointTurnCount = turn.checkpointTurnCount;
              latestTurnId = turn.turnId;
            }
          }

          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId,
            updatedAt: event.occurredAt,
          });
          yield* refreshThreadShellSummaryForEvent(event.payload.threadId);
          return;
        }

        default:
          return;
      }
    });

    const applyThreadMessagesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadMessagesProjection",
    )(function* (event, attachmentSideEffects) {
      switch (event.type) {
        case "thread.forked": {
          if (event.payload.isSideChat === true) return;
          const sourceRows = yield* projectionThreadMessageRepository.listByThreadId({
            threadId: event.payload.sourceThreadId,
          });
          yield* Effect.forEach(
            sourceRows,
            (message) => {
              const attachments = message.attachments?.map((attachment) => {
                const target = forkedProjectionAttachment(event.payload.threadId, attachment);
                attachmentSideEffects.forkedAttachments.push({ source: attachment, target });
                return target;
              });
              return projectionThreadMessageRepository.upsert({
                ...message,
                messageId: forkedProjectionMessageId(event.payload.threadId, message.messageId),
                threadId: event.payload.threadId,
                turnId:
                  message.turnId === null
                    ? null
                    : forkedProjectionTurnId(event.payload.threadId, message.turnId),
                isStreaming: false,
                ...(attachments !== undefined ? { attachments } : {}),
              });
            },
            { concurrency: 1 },
          );
          return;
        }

        case "thread.message-sent": {
          const existingMessage = yield* projectionThreadMessageRepository.getByMessageId({
            messageId: event.payload.messageId,
          });
          const previousMessage = Option.getOrUndefined(existingMessage);
          const nextText = Option.match(existingMessage, {
            onNone: () => event.payload.text,
            onSome: (message) => {
              if (event.payload.streaming) {
                return appendAgentStreamText(message.text, event.payload.text);
              }
              if (event.payload.text.length === 0) {
                return message.text;
              }
              return event.payload.text;
            },
          });
          const nextAttachments =
            event.payload.attachments !== undefined
              ? yield* materializeAttachmentsForProjection({
                  attachments: event.payload.attachments,
                })
              : previousMessage?.attachments;
          yield* projectionThreadMessageRepository.upsert({
            messageId: event.payload.messageId,
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            role: event.payload.role,
            text: nextText,
            ...(event.payload.inputOrigin !== undefined
              ? { inputOrigin: event.payload.inputOrigin }
              : previousMessage?.inputOrigin !== undefined
                ? { inputOrigin: previousMessage.inputOrigin }
                : {}),
            ...(event.payload.delegationId !== undefined
              ? { delegationId: event.payload.delegationId }
              : previousMessage?.delegationId !== undefined
                ? { delegationId: previousMessage.delegationId }
                : {}),
            ...(event.payload.voiceTranscript === true || previousMessage?.voiceTranscript === true
              ? { voiceTranscript: true }
              : {}),
            ...(nextAttachments !== undefined ? { attachments: [...nextAttachments] } : {}),
            isStreaming: event.payload.streaming,
            createdAt: previousMessage?.createdAt ?? event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.reverted": {
          const existingRows = yield* projectionThreadMessageRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionMessagesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionThreadMessageRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadMessageRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          attachmentSideEffects.prunedThreadRelativePaths.set(
            event.payload.threadId,
            collectThreadAttachmentRelativePaths(event.payload.threadId, keptRows),
          );
          return;
        }

        default:
          return;
      }
    });

    const applyThreadProposedPlansProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadProposedPlansProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.forked": {
          if (event.payload.isSideChat === true) return;
          const sourceRows = yield* projectionThreadProposedPlanRepository.listByThreadId({
            threadId: event.payload.sourceThreadId,
          });
          yield* Effect.forEach(
            sourceRows,
            (plan) =>
              projectionThreadProposedPlanRepository.upsert({
                ...plan,
                threadId: event.payload.threadId,
                turnId:
                  plan.turnId === null
                    ? null
                    : forkedProjectionTurnId(event.payload.threadId, plan.turnId),
              }),
            { concurrency: 1 },
          );
          return;
        }

        case "thread.proposed-plan-upserted":
          yield* projectionThreadProposedPlanRepository.upsert({
            planId: event.payload.proposedPlan.id,
            threadId: event.payload.threadId,
            turnId: event.payload.proposedPlan.turnId,
            planMarkdown: event.payload.proposedPlan.planMarkdown,
            implementedAt: event.payload.proposedPlan.implementedAt,
            implementationThreadId: event.payload.proposedPlan.implementationThreadId,
            createdAt: event.payload.proposedPlan.createdAt,
            updatedAt: event.payload.proposedPlan.updatedAt,
          });
          return;

        case "thread.reverted": {
          const existingRows = yield* projectionThreadProposedPlanRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionProposedPlansAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionThreadProposedPlanRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadProposedPlanRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyThreadActivitiesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadActivitiesProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.forked": {
          if (event.payload.isSideChat === true) return;
          const sourceRows = yield* projectionThreadActivityRepository.listByThreadId({
            threadId: event.payload.sourceThreadId,
          });
          yield* Effect.forEach(
            sourceRows,
            (activity) =>
              projectionThreadActivityRepository.upsert({
                ...activity,
                activityId: forkedProjectionActivityId(event.payload.threadId, activity.activityId),
                threadId: event.payload.threadId,
                turnId:
                  activity.turnId === null
                    ? null
                    : forkedProjectionTurnId(event.payload.threadId, activity.turnId),
              }),
            { concurrency: 1 },
          );
          return;
        }

        case "thread.activity-appended":
          yield* projectionThreadActivityRepository.upsert({
            activityId: event.payload.activity.id,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            tone: event.payload.activity.tone,
            kind: event.payload.activity.kind,
            summary: event.payload.activity.summary,
            payload: event.payload.activity.payload,
            ...(event.payload.activity.sequence !== undefined
              ? { sequence: event.payload.activity.sequence }
              : {}),
            createdAt: event.payload.activity.createdAt,
          });
          return;

        case "thread.reverted": {
          const existingRows = yield* projectionThreadActivityRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionActivitiesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }
          yield* projectionThreadActivityRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadActivityRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyThreadSessionsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadSessionsProjection",
    )(function* (event, _attachmentSideEffects) {
      if (event.type === "thread.session-stop-requested") {
        const existing = yield* projectionThreadSessionRepository.getByThreadId({
          threadId: event.payload.threadId,
        });
        if (Option.isNone(existing)) {
          return;
        }
        yield* projectionThreadSessionRepository.upsert({
          ...existing.value,
          status: "stopped",
          activeTurnId: null,
          lastError: null,
          failureKind: null,
          updatedAt: event.payload.createdAt,
        });
        return;
      }
      if (event.type !== "thread.session-set") {
        return;
      }
      yield* projectionThreadSessionRepository.upsert({
        threadId: event.payload.threadId,
        status: event.payload.session.status,
        providerName: event.payload.session.providerName,
        providerInstanceId: event.payload.session.providerInstanceId ?? null,
        runtimeMode: event.payload.session.runtimeMode,
        activeTurnId: event.payload.session.activeTurnId,
        lastError: event.payload.session.lastError,
        failureKind: event.payload.session.failureKind ?? null,
        updatedAt: event.payload.session.updatedAt,
      });
    });

    /**
     * A synthetic resume turn completing is itself the durable receipt that
     * its supervising obligation succeeded. Normally the scheduler observes
     * the same turn and performs this transition, but the provider lifecycle
     * and the supervisor fiber are independent streams: production has seen a
     * completed AGENT_STOP turn while its old startup-resume row remained
     * `executing`, leaving the shell stuck on "Auto-resuming thread…".
     *
     * Reconcile the exact owner from the synthetic source message. Requiring a
     * completed turn with finalized assistant output preserves the retry path
     * for empty upstream completions, while the compare-and-set makes this
     * safe to race with the scheduler's normal completion.
     */
    const completeResumeOwnerForTurn = Effect.fn("completeResumeOwnerForTurn")(function* (input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly occurredAt: string;
    }) {
      const turn = yield* projectionTurnRepository.getByTurnId({
        threadId: input.threadId,
        turnId: input.turnId,
      });
      if (
        Option.isNone(turn) ||
        turn.value.state !== "completed" ||
        turn.value.pendingMessageId === null
      ) {
        return;
      }

      const startupSourceTurnId = startupResumeSourceTurnId({
        threadId: input.threadId,
        messageId: turn.value.pendingMessageId,
      });
      const continuationSourceTurnId = agentContinuationSourceTurnId({
        threadId: input.threadId,
        messageId: turn.value.pendingMessageId,
      });
      const owner =
        startupSourceTurnId !== null
          ? { sourceTurnId: startupSourceTurnId, kind: "startup-resume" as const }
          : continuationSourceTurnId !== null
            ? {
                sourceTurnId: continuationSourceTurnId,
                kind: "agent-continuation" as const,
              }
            : null;
      if (owner === null) return;

      const messages = yield* projectionThreadMessageRepository.listByThreadId({
        threadId: input.threadId,
      });
      const producedOutput = messages.some(
        (message) =>
          message.role === "assistant" &&
          message.turnId === input.turnId &&
          !message.isStreaming &&
          message.text.trim().length > 0,
      );
      if (!producedOutput) return;

      const obligation = yield* threadWorkObligationRepository.getByKey({
        threadId: input.threadId,
        ...owner,
      });
      if (
        Option.isNone(obligation) ||
        obligation.value.state === "completed" ||
        obligation.value.state === "cancelled"
      ) {
        return;
      }
      yield* threadWorkObligationRepository.transition({
        obligationId: obligation.value.obligationId,
        expectedState: obligation.value.state,
        expectedAttempt: obligation.value.attempt,
        state: "completed",
        nextAttemptAt: null,
        claimedAt: null,
        leaseExpiresAt: null,
        blockedReason: null,
        updatedAt: input.occurredAt,
      });
    });

    const applyThreadTurnsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadTurnsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.forked": {
          if (event.payload.isSideChat === true) return;
          const sourceRows = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.sourceThreadId,
          });
          yield* Effect.forEach(
            sourceRows.filter((turn) => turn.turnId !== null),
            (turn) => {
              if (turn.turnId === null) return Effect.void;
              return projectionTurnRepository.upsertByTurnId({
                ...turn,
                threadId: event.payload.threadId,
                turnId: forkedProjectionTurnId(event.payload.threadId, turn.turnId),
                pendingMessageId:
                  turn.pendingMessageId === null
                    ? null
                    : forkedProjectionMessageId(event.payload.threadId, turn.pendingMessageId),
                assistantMessageId:
                  turn.assistantMessageId === null
                    ? null
                    : forkedProjectionMessageId(event.payload.threadId, turn.assistantMessageId),
                state:
                  turn.state === "running" || turn.state === "pending" ? "incomplete" : turn.state,
              });
            },
            { concurrency: 1 },
          );
          return;
        }

        case "thread.turn-start-requested": {
          yield* projectionTurnRepository.upsertPendingTurnStart({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            sourceProposedPlanThreadId: event.payload.sourceProposedPlan?.threadId ?? null,
            sourceProposedPlanId: event.payload.sourceProposedPlan?.planId ?? null,
            requestedAt: event.payload.createdAt,
          });
          return;
        }

        case "thread.activity-appended": {
          const activity = event.payload.activity;
          if (activity.kind !== "message.delivered") return;
          const payload = activity.payload;
          const rawMessageId =
            typeof payload === "object" &&
            payload !== null &&
            "messageId" in payload &&
            typeof payload.messageId === "string"
              ? payload.messageId
              : null;
          if (rawMessageId === null) return;

          const messageId = MessageId.make(rawMessageId);
          const pending = yield* projectionTurnRepository.getPendingTurnStart({
            threadId: event.payload.threadId,
            messageId,
          });
          if (Option.isNone(pending)) return;

          const obligation = yield* threadWorkObligationRepository.getByKey({
            threadId: event.payload.threadId,
            sourceTurnId: activeTurnWorkSourceId(messageId),
            kind: "active-turn-recovery",
          });
          // The same receipt kind is emitted for ordinary turn/start delivery
          // and for a steer into an already-running turn. Only the latter can
          // consume the null-turn placeholder here: a normal start still needs
          // that row so the subsequent session-set(running) can bind it to the
          // concrete provider turn. Claude omits the host turn id, so the
          // pre-claim marker — not activity.turnId — is the cross-provider
          // discriminator.
          if (
            Option.isNone(obligation) ||
            obligation.value.state !== "completed" ||
            obligation.value.blockedReason !== ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON
          ) {
            return;
          }
          yield* threadWorkObligationRepository.transition({
            obligationId: obligation.value.obligationId,
            expectedState: "completed",
            expectedAttempt: obligation.value.attempt,
            expectedBlockedReason: ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON,
            state: "completed",
            nextAttemptAt: null,
            claimedAt: null,
            leaseExpiresAt: null,
            blockedReason: null,
            updatedAt: activity.createdAt,
          });
          return;
        }

        case "thread.session-stop-requested": {
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            existingTurns.filter((turn) => turn.turnId !== null && turn.state === "running"),
            (turn) =>
              turn.turnId === null
                ? Effect.void
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                    state: "incomplete",
                    completedAt: event.payload.createdAt,
                  }),
            { concurrency: 1 },
          );
          return;
        }

        case "thread.session-set": {
          const turnId = event.payload.session.activeTurnId;
          if (turnId === null || event.payload.session.status !== "running") {
            // Leaving the "running" session status is the turn-end signal:
            // settle still-running turns so their duration reflects the whole
            // turn rather than the last assistant message.
            const settledTurnState = settledTurnStateForSessionStatus(event.payload.session.status);
            if (settledTurnState === null) {
              return;
            }
            const existingTurns = yield* projectionTurnRepository.listByThreadId({
              threadId: event.payload.threadId,
            });
            yield* Effect.forEach(
              existingTurns.filter((turn) => turn.turnId !== null && turn.state === "running"),
              (turn) =>
                Effect.gen(function* () {
                  if (turn.turnId === null) return;
                  yield* projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                    state: settledTurnState,
                    // A running turn's completedAt can only hold a mid-turn
                    // placeholder checkpoint timestamp — the session leaving
                    // "running" is the authoritative turn end.
                    completedAt: event.payload.session.updatedAt,
                  });
                  yield* completeResumeOwnerForTurn({
                    threadId: event.payload.threadId,
                    turnId: turn.turnId,
                    occurredAt: event.occurredAt,
                  });
                }),
              { concurrency: 1 },
            );
            return;
          }

          // A new active turn supersedes any still-running turn on the same
          // thread — steering can open a new turn without the provider ever
          // completing the previous one.
          const otherRunningTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            otherRunningTurns.filter(
              (turn) => turn.turnId !== null && turn.turnId !== turnId && turn.state === "running",
            ),
            (turn) =>
              Effect.gen(function* () {
                if (turn.turnId === null) return;
                yield* projectionTurnRepository.upsertByTurnId({
                  ...turn,
                  turnId: turn.turnId,
                  state: "completed",
                  completedAt: event.payload.session.updatedAt,
                });
                yield* completeResumeOwnerForTurn({
                  threadId: event.payload.threadId,
                  turnId: turn.turnId,
                  occurredAt: event.occurredAt,
                });
              }),
            { concurrency: 1 },
          );

          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId,
          });
          // A repeated session event for a turn that is already bound must not
          // pop the next message in the queue. Only an unbound/new concrete
          // turn adopts the FIFO head; an already-bound turn merely cleans up
          // a duplicate placeholder for its own immutable source message.
          const pendingTurnStart = yield* Effect.gen(function* () {
            if (Option.isNone(existingTurn)) {
              return yield* projectionTurnRepository.getOldestPendingTurnStartByThreadId({
                threadId: event.payload.threadId,
              });
            }
            if (existingTurn.value.pendingMessageId !== null) {
              return yield* projectionTurnRepository.getPendingTurnStart({
                threadId: event.payload.threadId,
                messageId: existingTurn.value.pendingMessageId,
              });
            }

            const candidate = yield* projectionTurnRepository.getOldestPendingTurnStartByThreadId({
              threadId: event.payload.threadId,
            });
            if (Option.isNone(candidate)) return candidate;
            const turnBeganAt = existingTurn.value.startedAt ?? existingTurn.value.requestedAt;
            return candidate.value.requestedAt <= turnBeganAt ? candidate : Option.none();
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              // The provider session is the authoritative liveness signal.
              // Failover/reconnect can briefly project ready or stopped before
              // the same provider turn is adopted again; preserving that old
              // terminal state leaves an actively streaming turn marked as
              // completed and later produces a false Resume affordance.
              state: "running",
              pendingMessageId:
                existingTurn.value.pendingMessageId ??
                (Option.isSome(pendingTurnStart) ? pendingTurnStart.value.messageId : null),
              sourceProposedPlanThreadId:
                existingTurn.value.sourceProposedPlanThreadId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanThreadId
                  : null),
              sourceProposedPlanId:
                existingTurn.value.sourceProposedPlanId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanId
                  : null),
              startedAt:
                existingTurn.value.startedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
              requestedAt:
                existingTurn.value.requestedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
              completedAt: null,
            });
          } else {
            yield* projectionTurnRepository.upsertByTurnId({
              turnId,
              threadId: event.payload.threadId,
              pendingMessageId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.messageId
                : null,
              sourceProposedPlanThreadId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanThreadId
                : null,
              sourceProposedPlanId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanId
                : null,
              assistantMessageId: null,
              state: "running",
              requestedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              startedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              completedAt: null,
              checkpointTurnCount: null,
              checkpointRef: null,
              checkpointStatus: null,
              checkpointFiles: [],
            });
          }

          if (Option.isSome(pendingTurnStart)) {
            yield* projectionTurnRepository.deletePendingTurnStart({
              threadId: event.payload.threadId,
              messageId: pendingTurnStart.value.messageId,
            });
          }
          return;
        }

        case "thread.message-sent": {
          if (event.payload.turnId === null || event.payload.role !== "assistant") {
            return;
          }
          // A completed assistant message only settles the turn once the
          // session is no longer running it — providers may emit several
          // assistant messages per turn (commentary between tool calls), and
          // the turn must stay unsettled until the provider reports turn end
          // (projected as thread.session-set leaving the "running" status).
          const session = yield* projectionThreadSessionRepository.getByThreadId({
            threadId: event.payload.threadId,
          });
          const turnStillRunning =
            Option.isSome(session) &&
            session.value.status === "running" &&
            session.value.activeTurnId === event.payload.turnId;
          const settlesTurn = !event.payload.streaming && !turnStillRunning;
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.messageId,
              state: settlesTurn
                ? existingTurn.value.state === "interrupted"
                  ? "interrupted"
                  : existingTurn.value.state === "error"
                    ? "error"
                    : "completed"
                : existingTurn.value.state,
              completedAt: settlesTurn
                ? (existingTurn.value.completedAt ?? event.payload.updatedAt)
                : existingTurn.value.completedAt,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.messageId,
            state: settlesTurn ? "completed" : "running",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: settlesTurn ? event.payload.updatedAt : null,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "thread.turn-interrupt-requested": {
          // The client only attaches a turn id when the session row happens to
          // read `running` at click time. A thread wedged in any other status —
          // or one whose session update lost a race with the click — sent none,
          // and this case then returned without ever marking the turn
          // interrupted, leaving a permanently "running" turn row behind the
          // stopped session. Fall back to whatever turn the session still
          // claims so Stop terminalizes both halves of the state.
          const interruptedTurnId =
            event.payload.turnId ??
            (yield* projectionThreadSessionRepository
              .getByThreadId({ threadId: event.payload.threadId })
              .pipe(
                Effect.map((session) =>
                  Option.isSome(session) ? (session.value.activeTurnId ?? undefined) : undefined,
                ),
              ));
          if (interruptedTurnId === undefined) {
            // No provider turn exists, so Stop targets the queued starts
            // themselves. The work projector cancels every pending owner in
            // the same event; clear the matching visible queue as one unit.
            yield* projectionTurnRepository.deleteAllPendingTurnStartsByThreadId({
              threadId: event.payload.threadId,
            });
            return;
          }
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: interruptedTurnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: "interrupted",
              completedAt: existingTurn.value.completedAt ?? event.payload.createdAt,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: interruptedTurnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: null,
            state: "interrupted",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: event.payload.createdAt,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "thread.turn-diff-completed": {
          // Mid-turn diff updates produce placeholder checkpoints; record the
          // checkpoint, but don't settle a turn its session is still running.
          const session = yield* projectionThreadSessionRepository.getByThreadId({
            threadId: event.payload.threadId,
          });
          const turnStillRunning =
            Option.isSome(session) &&
            session.value.status === "running" &&
            session.value.activeTurnId === event.payload.turnId;
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          const nextState = event.payload.status === "error" ? "error" : "completed";
          yield* projectionTurnRepository.clearCheckpointTurnConflict({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            checkpointTurnCount: event.payload.checkpointTurnCount,
          });

          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              // The checkpoint resolves its assistant pointer from a snapshot
              // taken when diff capture *started*, so on a multi-segment turn
              // it can point at an earlier segment than the one message-sent
              // already recorded — and downstream consumers (agent gate,
              // resumable chip, boot recovery) would then judge the turn by
              // text that predates the final reply. Never regress the pointer.
              assistantMessageId:
                existingTurn.value.assistantMessageId ?? event.payload.assistantMessageId,
              state: turnStillRunning ? existingTurn.value.state : nextState,
              checkpointTurnCount: event.payload.checkpointTurnCount,
              checkpointRef: event.payload.checkpointRef,
              checkpointStatus: event.payload.status,
              checkpointFiles: event.payload.files,
              startedAt: existingTurn.value.startedAt ?? event.payload.completedAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.completedAt,
              // Same principle as the assistant pointer above: checkpoint
              // capture is asynchronous and stamps the timestamp it inherited
              // when capture *started* — for a placeholder replacement that is
              // a mid-turn time. The session-set that settled the turn is the
              // authoritative end; rewinding it here broke the Agent
              // continuation gate's freshness check and silently stalled agent
              // threads at their final output.
              completedAt: existingTurn.value.completedAt ?? event.payload.completedAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.assistantMessageId,
            state: turnStillRunning ? "running" : nextState,
            requestedAt: event.payload.completedAt,
            startedAt: event.payload.completedAt,
            completedAt: event.payload.completedAt,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            checkpointRef: event.payload.checkpointRef,
            checkpointStatus: event.payload.status,
            checkpointFiles: event.payload.files,
          });
          return;
        }

        case "thread.reverted": {
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptTurns = existingTurns.filter(
            (turn) =>
              turn.turnId !== null &&
              turn.checkpointTurnCount !== null &&
              turn.checkpointTurnCount <= event.payload.turnCount,
          );
          yield* projectionTurnRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            keptTurns,
            (turn) =>
              turn.turnId === null
                ? Effect.void
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                  }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyCheckpointsProjection: ProjectorDefinition["apply"] = () => Effect.void;

    const applyPendingApprovalsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyPendingApprovalsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.activity-appended": {
          const requestId =
            extractActivityRequestId(event.payload.activity.payload) ??
            event.metadata.requestId ??
            null;
          if (requestId === null) {
            return;
          }
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId,
          });
          if (event.payload.activity.kind === "approval.resolved") {
            const resolvedDecisionRaw =
              typeof event.payload.activity.payload === "object" &&
              event.payload.activity.payload !== null &&
              "decision" in event.payload.activity.payload
                ? (event.payload.activity.payload as { decision?: unknown }).decision
                : null;
            const resolvedDecision =
              resolvedDecisionRaw === "accept" ||
              resolvedDecisionRaw === "acceptForSession" ||
              resolvedDecisionRaw === "decline" ||
              resolvedDecisionRaw === "cancel"
                ? resolvedDecisionRaw
                : null;
            yield* projectionPendingApprovalRepository.upsert({
              requestId,
              threadId: Option.isSome(existingRow)
                ? existingRow.value.threadId
                : event.payload.threadId,
              turnId: Option.isSome(existingRow)
                ? existingRow.value.turnId
                : event.payload.activity.turnId,
              status: "resolved",
              decision: resolvedDecision,
              createdAt: Option.isSome(existingRow)
                ? existingRow.value.createdAt
                : event.payload.activity.createdAt,
              resolvedAt: event.payload.activity.createdAt,
            });
            return;
          }
          if (event.payload.activity.kind === "provider.approval.respond.failed") {
            const payload =
              typeof event.payload.activity.payload === "object" &&
              event.payload.activity.payload !== null
                ? (event.payload.activity.payload as Record<string, unknown>)
                : null;
            const detail =
              typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
            if (isStalePendingApprovalFailureDetail(detail)) {
              if (Option.isNone(existingRow)) {
                return;
              }
              if (existingRow.value.status === "resolved") {
                return;
              }
              yield* projectionPendingApprovalRepository.upsert({
                requestId,
                threadId: existingRow.value.threadId,
                turnId: existingRow.value.turnId,
                status: "resolved",
                decision: null,
                createdAt: existingRow.value.createdAt,
                resolvedAt: event.payload.activity.createdAt,
              });
              return;
            }
            return;
          }
          // Only approval-requested activities should create pending-approval
          // rows.  Other activity kinds that happen to carry a requestId
          // (e.g. user-input.requested / user-input.resolved) must not
          // pollute this projection — they have their own accounting via
          // derivePendingUserInputCountFromActivities.
          if (event.payload.activity.kind !== "approval.requested") {
            return;
          }
          if (Option.isSome(existingRow) && existingRow.value.status === "resolved") {
            return;
          }
          yield* projectionPendingApprovalRepository.upsert({
            requestId,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            status: "pending",
            decision: null,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.activity.createdAt,
            resolvedAt: null,
          });
          return;
        }

        case "thread.approval-response-requested": {
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId: event.payload.requestId,
          });
          yield* projectionPendingApprovalRepository.upsert({
            requestId: event.payload.requestId,
            threadId: Option.isSome(existingRow)
              ? existingRow.value.threadId
              : event.payload.threadId,
            turnId: Option.isSome(existingRow) ? existingRow.value.turnId : null,
            status: "resolved",
            decision: event.payload.decision,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.createdAt,
            resolvedAt: event.payload.createdAt,
          });
          return;
        }

        default:
          return;
      }
    });

    /**
     * The Agent continuation gate, evaluated only from projected state so
     * every trigger — the turn-settling session-set, or an assistant segment
     * that finalizes after it — reaches the same verdict. The turn is judged
     * by its NEWEST non-streaming assistant message, never by the turn's
     * assistant pointer: a late checkpoint used to rewind that pointer to a
     * mid-turn segment, and the gate then continued straight over a final
     * reply whose text said AGENT_STOP.
     */
    const maybeEnqueueAgentContinuation = Effect.fn("maybeEnqueueAgentContinuation")(
      function* (input: { readonly threadId: ThreadId; readonly occurredAt: string }) {
        const thread = yield* projectionThreadRepository.getById({ threadId: input.threadId });
        if (
          Option.isNone(thread) ||
          thread.value.interactionMode !== "agent" ||
          thread.value.settledOverride === "settled" ||
          thread.value.deletedAt !== null ||
          thread.value.pendingApprovalCount > 0 ||
          thread.value.pendingUserInputCount > 0 ||
          thread.value.latestTurnId === null
        ) {
          return;
        }
        const session = yield* projectionThreadSessionRepository.getByThreadId({
          threadId: input.threadId,
        });
        if (
          Option.isNone(session) ||
          session.value.status !== "ready" ||
          session.value.activeTurnId !== null
        ) {
          return;
        }
        const turn = yield* projectionTurnRepository.getByTurnId({
          threadId: input.threadId,
          turnId: thread.value.latestTurnId,
        });
        if (
          Option.isNone(turn) ||
          turn.value.state !== "completed" ||
          turn.value.completedAt === null ||
          // Only a session row OLDER than the completion is disqualifying —
          // it means the ready state predates this turn ending, so the gate is
          // reading a stale row and must wait for the settling session-set.
          // The previous strict equality also rejected every session-set that
          // arrived AFTER the settle (status refreshes, reconnects) and every
          // async checkpoint that touched the turn row in the settle→finalize
          // window, which permanently stalled agent threads: the gate has no
          // trigger after the assistant finalize, so one interleaved event
          // meant no continuation, ever.
          session.value.updatedAt < turn.value.completedAt ||
          (thread.value.latestUserMessageAt !== null &&
            thread.value.latestUserMessageAt > turn.value.completedAt)
        ) {
          return;
        }

        const messages = yield* projectionThreadMessageRepository.listByThreadId({
          threadId: input.threadId,
        });
        const assistantMessage = messages.findLast(
          (message) => message.role === "assistant" && message.turnId === turn.value.turnId,
        );
        // No reply text yet, or the final segment is still streaming: judging
        // now would use an unfinished reply. The finalizing message-sent
        // re-runs this gate, so deferring never drops a continuation.
        if (assistantMessage === undefined || assistantMessage.isStreaming) return;

        if (isProviderAuthenticationFailure(assistantMessage.text)) return;
        if (!shouldAgentContinueAfterReply(assistantMessage.text)) return;

        const sourceMessageIndex =
          turn.value.pendingMessageId === null
            ? -1
            : messages.findIndex((message) => message.messageId === turn.value.pendingMessageId);
        const sourceMessage = sourceMessageIndex < 0 ? undefined : messages[sourceMessageIndex];
        if (turn.value.pendingMessageId !== null) {
          if (
            sourceMessage === undefined ||
            sourceMessage.role !== "user" ||
            sourceMessage.text.startsWith("Settings updated:")
          ) {
            return;
          }
        }
        // A later queued turn may arrive after this turn's source but before
        // this turn writes its assistant response. It is therefore invisible
        // to the usual "messages after the assistant" check below. Apply the
        // same priority rule from the immutable source boundary: a real user
        // turn or browser cleanup owns the next work slot, while ordinary
        // agent-loop messages remain eligible for normal continuation.
        if (
          sourceMessageIndex >= 0 &&
          messages
            .slice(sourceMessageIndex + 1)
            .some(
              (message) =>
                message.role === "user" &&
                (message.inputOrigin !== "agent-loop" ||
                  isBrowserTabCleanupMessageId(String(message.messageId))),
            )
        ) {
          return;
        }
        // A real user message anywhere after the judged reply always outranks
        // synthetic continuation — including on turn rows minted straight from
        // an assistant message, which have no pending source pointer and used
        // to skip this check entirely.
        const assistantIndex = messages.findIndex(
          (message) => message.messageId === assistantMessage.messageId,
        );
        // A cleanup turn is housekeeping on behalf of the latest substantive
        // turn, not a fresh authorization to keep an Agent loop alive. Judge
        // both replies: the cleanup reply itself must be continuable (checked
        // above), and the newest finalized assistant reply that did not come
        // from a cleanup turn must also be continuable. Filtering by the turn's
        // immutable pending source handles interleavings such as
        // A -> cleanup C, queued B -> cleanup D: C's ordinary housekeeping
        // response must not hide B's later AGENT_STOP when D completes.
        if (
          sourceMessage !== undefined &&
          isBrowserTabCleanupMessageId(String(sourceMessage.messageId))
        ) {
          const threadTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: input.threadId,
          });
          const cleanupTurnIds = new Set(
            threadTurns.flatMap((candidateTurn) =>
              candidateTurn.turnId !== null &&
              candidateTurn.pendingMessageId !== null &&
              isBrowserTabCleanupMessageId(String(candidateTurn.pendingMessageId))
                ? [String(candidateTurn.turnId)]
                : [],
            ),
          );
          const substantiveAssistantMessage = messages
            .slice(0, assistantIndex)
            .findLast(
              (message) =>
                message.role === "assistant" &&
                !message.isStreaming &&
                (message.turnId === null || !cleanupTurnIds.has(String(message.turnId))),
            );
          if (
            substantiveAssistantMessage === undefined ||
            isProviderAuthenticationFailure(substantiveAssistantMessage.text) ||
            !shouldAgentContinueAfterReply(substantiveAssistantMessage.text)
          ) {
            return;
          }
        }
        if (
          messages
            .slice(assistantIndex + 1)
            .some(
              (message) =>
                message.role === "user" &&
                (message.inputOrigin !== "agent-loop" ||
                  isBrowserTabCleanupMessageId(String(message.messageId))),
            )
        ) {
          return;
        }

        const kind = "agent-continuation" as const;
        const providerInstanceId =
          session.value.providerInstanceId ?? thread.value.modelSelection.instanceId;
        yield* threadWorkObligationRepository.insert({
          obligationId: threadWorkObligationId({
            threadId: input.threadId,
            sourceTurnId: turn.value.turnId,
            kind,
          }),
          threadId: input.threadId,
          sourceTurnId: turn.value.turnId,
          kind,
          state: "pending",
          providerInstanceId,
          attempt: 0,
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: null,
          createdAt: input.occurredAt,
          updatedAt: input.occurredAt,
        });
      },
    );

    const applyThreadWorkProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadWorkProjection",
    )(function* (event, _attachmentSideEffects) {
      if (
        event.type === "thread.deleted" ||
        event.type === "thread.settled" ||
        event.type === "thread.session-stop-requested" ||
        event.type === "thread.turn-interrupt-requested"
      ) {
        const interruptionTargetsRunningTurn =
          event.type === "thread.turn-interrupt-requested"
            ? event.payload.turnId !== undefined ||
              (yield* projectionThreadSessionRepository
                .getByThreadId({ threadId: event.payload.threadId })
                .pipe(
                  Effect.map(
                    (session) =>
                      Option.isSome(session) &&
                      session.value.status === "running" &&
                      session.value.activeTurnId !== null,
                  ),
                ))
            : false;
        yield* threadWorkObligationRepository.cancelByThread({
          threadId: event.payload.threadId,
          updatedAt: event.occurredAt,
          blockedReason: event.type,
          // Interrupting a running turn preserves later user messages parked
          // behind it. When no provider turn exists, however, Stop refers to
          // the pending delivery itself and must cancel it; otherwise the
          // scheduler immediately starts the work again behind the user's back.
          mode:
            event.type === "thread.deleted" || event.type === "thread.settled"
              ? "thread-terminal"
              : event.type === "thread.turn-interrupt-requested" && !interruptionTargetsRunningTurn
                ? "pending-start-interrupt"
                : "turn-interrupt",
        });
        return;
      }

      if (event.type === "thread.turn-start-requested") {
        const sourceMessage = yield* projectionThreadMessageRepository.getByMessageId({
          messageId: event.payload.messageId,
        });
        if (
          Option.isSome(sourceMessage) &&
          sourceMessage.value.role === "user" &&
          // Only continuation auto-resume prompts own their launch elsewhere.
          // Other agent-loop messages — scheduled VM-agent task prompts — need
          // this obligation or nothing ever starts their turn.
          !isAgentAutoResumeMessageId(event.payload.messageId)
        ) {
          const startupSourceTurnId = startupResumeSourceTurnId({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
          });
          const sourceTurnId =
            startupSourceTurnId ?? activeTurnWorkSourceId(event.payload.messageId);
          const kind =
            startupSourceTurnId === null
              ? ("active-turn-recovery" as const)
              : ("startup-resume" as const);
          const existing = yield* threadWorkObligationRepository.getByKey({
            threadId: event.payload.threadId,
            sourceTurnId,
            kind,
          });
          // Reapplying the same event must not cancel work that it already
          // created. The deterministic row is the projector's replay receipt.
          if (Option.isSome(existing)) {
            // …but a *cancelled* row is no receipt of work done. A fresh
            // turn-start for the same message is a retry — the task scheduler
            // re-dispatches under new command ids with the message id reused —
            // and skipping it here left nothing at all to drive the turn.
            // Revive the row instead; delivery re-checks supersession on
            // claim, so a genuinely overtaken turn is still cancelled there.
            if (
              existing.value.state === "cancelled" &&
              isVmAgentTaskPromptMessageId(event.payload.messageId) &&
              existing.value.blockedReason === "turn-start was superseded"
            ) {
              yield* threadWorkObligationRepository.transition({
                obligationId: existing.value.obligationId,
                expectedState: "cancelled",
                expectedAttempt: existing.value.attempt,
                state: "pending",
                nextAttemptAt: null,
                claimedAt: null,
                leaseExpiresAt: null,
                blockedReason: null,
                updatedAt: event.occurredAt,
              });
            }
            return;
          }

          // A newer user message supersedes queued *synthetic* work — agent
          // continuations, startup resumes, retries — but never earlier user
          // messages: those deliver FIFO once the thread frees up, exactly as
          // the "Sent" indicator promised. Cancelling them here meant every
          // follow-up send silently destroyed the one before it.
          yield* threadWorkObligationRepository.cancelByThread({
            threadId: event.payload.threadId,
            updatedAt: event.occurredAt,
            blockedReason: "superseded by user turn",
            mode: "user-supersede",
          });

          const thread = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (
            Option.isNone(thread) ||
            thread.value.settledOverride === "settled" ||
            thread.value.deletedAt !== null
          ) {
            return;
          }
          const session = yield* projectionThreadSessionRepository.getByThreadId({
            threadId: event.payload.threadId,
          });
          const providerInstanceId =
            event.payload.modelSelection?.instanceId ??
            (Option.isSome(session) && session.value.providerInstanceId !== null
              ? session.value.providerInstanceId
              : thread.value.modelSelection.instanceId);
          yield* threadWorkObligationRepository.insert({
            obligationId: threadWorkObligationId({
              threadId: event.payload.threadId,
              sourceTurnId,
              kind,
            }),
            threadId: event.payload.threadId,
            sourceTurnId,
            kind,
            state: "pending",
            providerInstanceId,
            attempt: 0,
            nextAttemptAt: null,
            claimedAt: null,
            leaseExpiresAt: null,
            blockedReason: null,
            createdAt: event.occurredAt,
            updatedAt: event.occurredAt,
          });

          // This projector trails the turn projector, so future C may already
          // have a visible row while B's owner is being created. Repair only
          // rows that sort before the current event, and do it after the
          // current owner exists. That makes a user's next send clear a legacy
          // false queue entry without deleting B/C during normal batch replay.
          yield* sql`
              DELETE FROM projection_turns AS pending
              WHERE pending.thread_id = ${event.payload.threadId}
                AND pending.turn_id IS NULL
                AND pending.state = 'pending'
                AND pending.pending_message_id IS NOT NULL
                AND pending.checkpoint_turn_count IS NULL
                AND (
                  pending.requested_at < ${event.payload.createdAt}
                  OR (
                    pending.requested_at = ${event.payload.createdAt}
                    AND pending.pending_message_id < ${event.payload.messageId}
                  )
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM thread_work_obligations AS work
                  WHERE work.thread_id = pending.thread_id
                    AND (
                      work.state NOT IN ('completed', 'cancelled')
                      OR (
                        work.state = 'completed'
                        AND work.blocked_reason IS ${ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON}
                      )
                    )
                    AND (
                      (
                        work.kind = 'active-turn-recovery'
                        AND work.source_turn_id = 'turn-start:' || pending.pending_message_id
                      )
                      OR (
                        work.kind = 'startup-resume'
                        AND pending.pending_message_id =
                          'startup-auto-resume-message:' || work.thread_id || ':' || work.source_turn_id
                      )
                      OR (
                        work.kind = 'agent-continuation'
                        AND pending.pending_message_id =
                          'agent-auto-resume-message:' || work.thread_id || ':' || work.source_turn_id
                      )
                    )
                )
            `.pipe(
            Effect.mapError(
              toPersistenceSqlError("ProjectionPipeline.repairPendingTurnStarts:query"),
            ),
          );
        }
        return;
      }

      if (
        event.type === "thread.message-sent" &&
        event.payload.role === "assistant" &&
        event.payload.turnId !== null &&
        !event.payload.streaming
      ) {
        yield* completeResumeOwnerForTurn({
          threadId: event.payload.threadId,
          turnId: event.payload.turnId,
          occurredAt: event.occurredAt,
        });
        const projectedAssistant = yield* projectionThreadMessageRepository.getByMessageId({
          messageId: event.payload.messageId,
        });
        const assistantText = Option.isSome(projectedAssistant)
          ? projectedAssistant.value.text
          : event.payload.text;
        if (!isProviderAuthenticationFailure(assistantText)) {
          // The deferral landing point for the continuation gate: on the
          // common path the turn-settling session-set is dispatched *before*
          // the final assistant segment finalizes, so the gate declined to
          // judge a still-streaming reply. This finalize is the moment the
          // full text exists — re-run the gate against it.
          yield* maybeEnqueueAgentContinuation({
            threadId: event.payload.threadId,
            occurredAt: event.occurredAt,
          });
          return;
        }
        const thread = yield* projectionThreadRepository.getById({
          threadId: event.payload.threadId,
        });
        if (
          Option.isNone(thread) ||
          thread.value.interactionMode !== "agent" ||
          thread.value.settledOverride === "settled" ||
          thread.value.deletedAt !== null
        ) {
          return;
        }
        const session = yield* projectionThreadSessionRepository.getByThreadId({
          threadId: event.payload.threadId,
        });
        const providerInstanceId =
          Option.isSome(session) && session.value.providerInstanceId !== null
            ? session.value.providerInstanceId
            : thread.value.modelSelection.instanceId;
        const existing = yield* threadWorkObligationRepository.getByKey({
          threadId: event.payload.threadId,
          sourceTurnId: event.payload.turnId,
          kind: "authentication-resume",
        });
        if (Option.isSome(existing)) return;

        // Authentication loss supersedes every prior execution owner for the
        // thread. Do this in the projector transaction before inserting the
        // blocked replacement so an offline restart cannot run the original
        // user turn and the auth resume as two separate turns. This sweep
        // deliberately does NOT exempt active-turn-recovery: the auth resume
        // redelivers the failing turn's message itself, so leaving that
        // delivery row alive would run the turn twice.
        yield* threadWorkObligationRepository.cancelByThread({
          threadId: event.payload.threadId,
          updatedAt: event.occurredAt,
          blockedReason: "replaced by authentication-resume",
          mode: "thread-terminal",
        });
        const inserted = yield* threadWorkObligationRepository.insert({
          obligationId: threadWorkObligationId({
            threadId: event.payload.threadId,
            sourceTurnId: event.payload.turnId,
            kind: "authentication-resume",
          }),
          threadId: event.payload.threadId,
          sourceTurnId: event.payload.turnId,
          kind: "authentication-resume",
          state: "blocked-authentication",
          providerInstanceId,
          attempt: 0,
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: "provider authentication required",
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt,
        });
        if (inserted) {
          yield* increment(threadWorkAuthenticationTransitionsTotal, {
            provider: providerInstanceId,
            transition: "paused",
          });
        }
        return;
      }

      if (
        event.type !== "thread.session-set" ||
        event.payload.session.status !== "ready" ||
        event.payload.session.activeTurnId !== null
      ) {
        return;
      }

      yield* maybeEnqueueAgentContinuation({
        threadId: event.payload.threadId,
        occurredAt: event.occurredAt,
      });
    });

    const projectors: ReadonlyArray<ProjectorDefinition> = [
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.projects,
        apply: applyProjectsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
        apply: applyThreadSessionsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
        apply: applyThreadTurnsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
        apply: applyThreadMessagesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
        apply: applyThreadProposedPlansProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
        apply: applyThreadActivitiesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
        apply: applyCheckpointsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.pendingApprovals,
        apply: applyPendingApprovalsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threads,
        apply: (event, attachmentSideEffects) =>
          applyThreadsProjection(event, attachmentSideEffects, false),
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadWork,
        apply: applyThreadWorkProjection,
      },
    ];

    const runProjectorsForEvent = Effect.fn("runProjectorsForEvent")(function* (
      selectedProjectors: ReadonlyArray<ProjectorDefinition>,
      event: OrchestrationEvent,
    ) {
      const attachmentSideEffects: AttachmentSideEffects = {
        deletedThreadIds: new Set<string>(),
        prunedThreadRelativePaths: new Map<string, Set<string>>(),
        forkedAttachments: [],
      };

      yield* sql.withTransaction(
        Effect.forEach(
          selectedProjectors,
          (projector) =>
            projector.apply(event, attachmentSideEffects).pipe(
              Effect.flatMap(() =>
                projectionStateRepository.upsert({
                  projector: projector.name,
                  lastAppliedSequence: event.sequence,
                  updatedAt: event.occurredAt,
                }),
              ),
            ),
          { concurrency: 1, discard: true },
        ),
      );

      yield* runAttachmentSideEffects(attachmentSideEffects).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to apply projected attachment side-effects", {
            projectors: selectedProjectors.map((projector) => projector.name),
            sequence: event.sequence,
            eventType: event.type,
            cause,
          }),
        ),
      );
    });

    const refreshThreadShellSummaries = Effect.fn("refreshThreadShellSummaries")(function* (
      threadIds: ReadonlySet<string>,
    ) {
      yield* Effect.forEach(
        threadIds,
        (threadId) => refreshThreadShellSummary(ThreadId.make(threadId)),
        { concurrency: 1 },
      );
    });

    /**
     * Settle work the previous process was in the middle of when it died.
     *
     * This runs inside `bootstrap`, which the engine awaits once before it
     * starts its command worker — so no provider session or turn can be live
     * here, and anything still marked in-flight is by definition orphaned.
     *
     * A graceful quit projects `thread.session-set(stopped)`, which settles the
     * running turn to "incomplete" on the way down. A hard kill (crash, deploy,
     * SIGKILL) projects nothing, so the turn stays "running" forever: the UI
     * counts "Working for ..." indefinitely, and — because the recovery scan
     * below only considers turns in ('completed','incomplete','error') — no
     * resume obligation is ever enqueued. Observed 2026-08-05: a turn sat
     * "running" for 95 minutes after a restart and only settled when the user
     * sent a new message.
     *
     * Assistant messages are reconciled too: a stream interrupted mid-flight
     * stays `is_streaming = 1`, and the recovery scan inner-joins on
     * `is_streaming = 0`, so an orphaned stream would hide its turn from
     * recovery just as effectively.
     */
    const reconcileOrphanedInFlightWork = Effect.gen(function* () {
      const fallbackNow = DateTime.formatIso(yield* DateTime.now);
      const settledAt = yield* sql<{
        readonly now: string;
      }>`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS "now"`.pipe(
        Effect.map((rows) => rows[0]?.now ?? fallbackNow),
      );

      yield* sql`
        UPDATE projection_thread_messages
        SET is_streaming = 0
        WHERE is_streaming = 1
      `;
      yield* sql`
        UPDATE projection_turns
        SET state = 'incomplete',
            completed_at = COALESCE(completed_at, ${settledAt})
        WHERE state = 'running'
      `;
      yield* sql`
        UPDATE projection_thread_sessions
        SET status = 'stopped',
            active_turn_id = NULL,
            updated_at = ${settledAt}
        WHERE status IN ('running', 'starting')
      `;

      // A session left in `error` belongs to the process that just died. The
      // continuation gate treats `error` as terminal so a genuinely failing
      // provider is never hammered — but after a restart there is no live CLI
      // left to fail: resuming spawns a fresh one, exactly as it does for a
      // `stopped` session. Leaving the row `error` meant any turn our own
      // shutdown killed ("Claude runtime stream failed") could never
      // auto-resume. Observed 2026-08-15 across four in-place updates: the
      // continuation was enqueued as the turn settled and then cancelled about
      // a second after boot with "source turn is no longer continuable",
      // stranding the thread until the user typed.
      //
      // Authentication failures keep their `error` status. Those are not stale
      // — they need the user to log in — and the recovery scan below routes
      // them to a blocked-authentication obligation instead of a resume.
      const staleErroredSessions = yield* sql<{
        readonly threadId: string;
        readonly lastError: string | null;
      }>`
        SELECT thread_id AS "threadId", last_error AS "lastError"
        FROM projection_thread_sessions
        WHERE status = 'error'
      `;
      for (const session of staleErroredSessions) {
        if (isProviderAuthenticationFailure(session.lastError ?? "")) continue;
        // `last_error` is deliberately preserved: it still explains what went
        // wrong, and the recovery scan reads it to classify the thread.
        yield* sql`
          UPDATE projection_thread_sessions
          SET status = 'stopped',
              active_turn_id = NULL,
              updated_at = ${settledAt}
          WHERE thread_id = ${session.threadId}
        `;
      }

      // Inactive threads cannot own runnable work. Older builds could leave a
      // nonterminal owner behind when delete/archive/settle raced shutdown;
      // cancel it before queue reconstruction so it cannot preserve or replay
      // a stale visible placeholder on this boot.
      const retiredInactiveOwners = yield* sql<{ readonly threadId: string }>`
        UPDATE thread_work_obligations AS work
        SET state = 'cancelled',
            next_attempt_at = NULL,
            claimed_at = NULL,
            lease_expires_at = NULL,
            blocked_reason = 'thread is inactive after restart',
            updated_at = ${settledAt}
        WHERE work.state NOT IN ('completed', 'cancelled')
          AND EXISTS (
            SELECT 1
            FROM projection_threads AS thread
            WHERE thread.thread_id = work.thread_id
              AND (
                thread.deleted_at IS NOT NULL
                OR thread.archived_at IS NOT NULL
                OR COALESCE(thread.settled_override, '') = 'settled'
              )
          )
        RETURNING thread_id AS "threadId"
      `;

      // A mid-turn message is projected as a pending turn before the provider
      // reactor knows whether it can steer the live turn. On acceptance the
      // provider emits `message.delivered` for the exact immutable message id;
      // Claude intentionally omits a host turn id, so the receipt itself is the
      // cross-provider durable truth.
      //
      // Repair both sides before the generic pending-work backfill runs:
      //   1. a durable exact receipt proves delivery, so retire only that
      //      message's placeholder and never replay it;
      //   2. a pre-claimed row carrying an unconfirmed/unknown marker but no
      //      receipt never crossed the provider's durable acceptance boundary.
      //      Re-arm it so the parked path can deliver it after restart. Older
      //      builds converted the first marker to the second, so recognizing
      //      both heals messages they already stranded.
      const completedDeliveredSteerOwners = yield* sql<{ readonly threadId: string }>`
        UPDATE thread_work_obligations AS work
        SET state = 'completed',
            next_attempt_at = NULL,
            claimed_at = NULL,
            lease_expires_at = NULL,
            blocked_reason = NULL,
            updated_at = ${settledAt}
        WHERE work.kind = 'active-turn-recovery'
          AND work.state != 'cancelled'
          AND (
            work.state != 'completed'
            OR work.blocked_reason IN (
              ${ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON},
              ${ACTIVE_TURN_STEER_DELIVERY_UNKNOWN_REASON}
            )
          )
          AND EXISTS (
            SELECT 1
            FROM orchestration_events AS delivered
            WHERE delivered.aggregate_kind = 'thread'
              AND delivered.stream_id = work.thread_id
              AND delivered.event_type = 'thread.activity-appended'
              AND json_extract(delivered.payload_json, '$.activity.kind') = 'message.delivered'
              AND json_extract(delivered.payload_json, '$.activity.payload.messageId') =
                substr(work.source_turn_id, length('turn-start:') + 1)
              AND delivered.sequence >= COALESCE(
                (
                  SELECT start.sequence
                  FROM orchestration_events AS start
                  WHERE start.aggregate_kind = 'thread'
                    AND start.stream_id = work.thread_id
                    AND start.event_type = 'thread.turn-start-requested'
                    AND json_extract(start.payload_json, '$.messageId') =
                      substr(work.source_turn_id, length('turn-start:') + 1)
                  ORDER BY start.sequence DESC
                  LIMIT 1
                ),
                0
              )
          )
        RETURNING thread_id AS "threadId"
      `;
      const recoveredUnconfirmedSteerOwners = yield* sql<{ readonly threadId: string }>`
        UPDATE thread_work_obligations AS work
        SET state = 'pending',
            next_attempt_at = NULL,
            claimed_at = NULL,
            lease_expires_at = NULL,
            blocked_reason = NULL,
            updated_at = ${settledAt}
        WHERE work.kind = 'active-turn-recovery'
          AND work.state = 'completed'
          AND work.blocked_reason IN (
            ${ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON},
            ${ACTIVE_TURN_STEER_DELIVERY_UNKNOWN_REASON}
          )
          AND NOT EXISTS (
            SELECT 1
            FROM orchestration_events AS delivered
            WHERE delivered.aggregate_kind = 'thread'
              AND delivered.stream_id = work.thread_id
              AND delivered.event_type = 'thread.activity-appended'
              AND json_extract(delivered.payload_json, '$.activity.kind') = 'message.delivered'
              AND json_extract(delivered.payload_json, '$.activity.payload.messageId') =
                substr(work.source_turn_id, length('turn-start:') + 1)
              AND delivered.sequence >= COALESCE(
                (
                  SELECT start.sequence
                  FROM orchestration_events AS start
                  WHERE start.aggregate_kind = 'thread'
                    AND start.stream_id = work.thread_id
                    AND start.event_type = 'thread.turn-start-requested'
                    AND json_extract(start.payload_json, '$.messageId') =
                      substr(work.source_turn_id, length('turn-start:') + 1)
                  ORDER BY start.sequence DESC
                  LIMIT 1
                ),
                0
              )
          )
        RETURNING thread_id AS "threadId"
      `;
      // Heal placeholders left by older builds whose owner already reached a
      // durable terminal verdict. Map every owner kind to its exact synthetic
      // or user message and never disturb a sibling queued message.
      const retiredTerminalOwnerPlaceholders = yield* sql<{ readonly threadId: string }>`
        DELETE FROM projection_turns AS pending
        WHERE pending.turn_id IS NULL
          AND pending.state = 'pending'
          AND pending.pending_message_id IS NOT NULL
          AND pending.checkpoint_turn_count IS NULL
          AND EXISTS (
            SELECT 1
            FROM thread_work_obligations AS work
            WHERE work.thread_id = pending.thread_id
              AND work.state IN ('completed', 'cancelled')
              AND NOT (
                work.state = 'completed'
                AND work.blocked_reason IS ${ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON}
              )
              AND (
                (
                  work.kind = 'active-turn-recovery'
                  AND work.source_turn_id = 'turn-start:' || pending.pending_message_id
                )
                OR (
                  work.kind = 'startup-resume'
                  AND pending.pending_message_id =
                    'startup-auto-resume-message:' || work.thread_id || ':' || work.source_turn_id
                )
                OR (
                  work.kind = 'agent-continuation'
                  AND pending.pending_message_id =
                    'agent-auto-resume-message:' || work.thread_id || ':' || work.source_turn_id
                )
              )
          )
        RETURNING thread_id AS "threadId"
      `;

      // Older single-slot projection builds could drop B's visible row when C
      // was queued even though B's durable owner survived. Reconstruct only
      // nonterminal user-delivery owners from their latest exact start event;
      // receipt-backed and already-adopted messages are never replayed.
      const reconstructedPendingStarts = yield* sql<{ readonly threadId: string }>`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        SELECT
          work.thread_id,
          NULL,
          substr(work.source_turn_id, length('turn-start:') + 1),
          json_extract(start.payload_json, '$.sourceProposedPlan.threadId'),
          json_extract(start.payload_json, '$.sourceProposedPlan.planId'),
          NULL,
          'pending',
          COALESCE(json_extract(start.payload_json, '$.createdAt'), start.occurred_at),
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          '[]'
        FROM thread_work_obligations AS work
        INNER JOIN orchestration_events AS start
          ON start.sequence = (
            SELECT MAX(candidate.sequence)
            FROM orchestration_events AS candidate
            WHERE candidate.aggregate_kind = 'thread'
              AND candidate.stream_id = work.thread_id
              AND candidate.event_type = 'thread.turn-start-requested'
              AND json_extract(candidate.payload_json, '$.messageId') =
                substr(work.source_turn_id, length('turn-start:') + 1)
          )
        INNER JOIN projection_threads AS thread
          ON thread.thread_id = work.thread_id
        INNER JOIN projection_thread_messages AS message
          ON message.thread_id = work.thread_id
          AND message.message_id = substr(work.source_turn_id, length('turn-start:') + 1)
          AND message.role = 'user'
        WHERE work.kind = 'active-turn-recovery'
          AND work.state NOT IN ('completed', 'cancelled')
          AND thread.deleted_at IS NULL
          AND thread.archived_at IS NULL
          AND COALESCE(thread.settled_override, '') != 'settled'
          AND NOT EXISTS (
            SELECT 1
            FROM projection_turns AS existing
            WHERE existing.thread_id = work.thread_id
              AND existing.pending_message_id =
                substr(work.source_turn_id, length('turn-start:') + 1)
          )
        RETURNING thread_id AS "threadId"
      `;
      yield* Effect.forEach(
        new Set(
          [
            ...completedDeliveredSteerOwners,
            ...recoveredUnconfirmedSteerOwners,
            ...retiredTerminalOwnerPlaceholders,
            ...reconstructedPendingStarts,
            ...retiredInactiveOwners,
          ].map((row) => row.threadId),
        ),
        (threadId) => refreshPendingWorkSummary(ThreadId.make(threadId)),
        { concurrency: 1, discard: true },
      );

      // A synthetic resume turn can reach a durable terminal projection while
      // the supervisor that launched it is being torn down. If the process
      // exits in that window, projector events are already caught up at the
      // next boot, so the exact startup/continuation owner would otherwise be
      // recovered and run again. Treat the completed turn plus finalized
      // assistant output as the missing supervisor receipt. Matching the
      // synthetic message id to the owner's exact source turn prevents a
      // different completed turn from retiring live work.
      const retiredResumeOwners = yield* sql<{ readonly threadId: string }>`
        UPDATE thread_work_obligations
        SET state = 'completed',
            next_attempt_at = NULL,
            claimed_at = NULL,
            lease_expires_at = NULL,
            blocked_reason = NULL,
            updated_at = ${settledAt}
        WHERE kind IN ('startup-resume', 'agent-continuation')
          AND state NOT IN ('completed', 'cancelled')
          AND EXISTS (
            SELECT 1
            FROM projection_turns AS resumed
            WHERE resumed.thread_id = thread_work_obligations.thread_id
              AND resumed.state = 'completed'
              AND resumed.pending_message_id =
                CASE thread_work_obligations.kind
                  WHEN 'startup-resume'
                    THEN 'startup-auto-resume-message:'
                  ELSE 'agent-auto-resume-message:'
                END
                || thread_work_obligations.thread_id
                || ':'
                || thread_work_obligations.source_turn_id
              AND EXISTS (
                SELECT 1
                FROM projection_thread_messages AS output
                WHERE output.thread_id = resumed.thread_id
                  AND output.turn_id = resumed.turn_id
                  AND output.role = 'assistant'
                  AND output.is_streaming = 0
                  AND length(
                    trim(
                      output.text,
                      ' ' || char(9) || char(10) || char(11) || char(12) || char(13)
                    )
                  ) > 0
              )
          )
        RETURNING thread_id AS "threadId"
      `;
      // By this point every valid queued row has one exact nonterminal owner.
      // Retire legacy rows whose owner was completed/cancelled (including the
      // resume owners settled immediately above), pruned, or never existed.
      // New writes create the row and owner in one projector transaction, so a
      // missing owner is ambiguous historical state and must not be replayed.
      const retiredOrphanPendingStarts = yield* sql<{ readonly threadId: string }>`
        DELETE FROM projection_turns AS pending
        WHERE pending.turn_id IS NULL
          AND pending.state = 'pending'
          AND pending.pending_message_id IS NOT NULL
          AND pending.checkpoint_turn_count IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM thread_work_obligations AS work
            WHERE work.thread_id = pending.thread_id
              AND work.state NOT IN ('completed', 'cancelled')
              AND (
                (
                  work.kind = 'active-turn-recovery'
                  AND work.source_turn_id = 'turn-start:' || pending.pending_message_id
                )
                OR (
                  work.kind = 'startup-resume'
                  AND pending.pending_message_id =
                    'startup-auto-resume-message:' || work.thread_id || ':' || work.source_turn_id
                )
                OR (
                  work.kind = 'agent-continuation'
                  AND pending.pending_message_id =
                    'agent-auto-resume-message:' || work.thread_id || ':' || work.source_turn_id
                )
              )
          )
        RETURNING thread_id AS "threadId"
      `;
      yield* Effect.forEach(
        new Set([...retiredResumeOwners, ...retiredOrphanPendingStarts].map((row) => row.threadId)),
        (threadId) => refreshPendingWorkSummary(ThreadId.make(threadId)),
        { concurrency: 1, discard: true },
      );

      // Cancelled and completed obligations are durable terminal verdicts.
      // Transient work remains sleeping or carries an expiring claim, and the
      // scheduler recovers those states explicitly. Reviving terminal rows at
      // boot made AGENT_STOP, Stop, supersession, and successful completion all
      // capable of silently dispatching the same resume prompt again.

      // The recovery scan already ran inside `bootstrap`, before these rows
      // settled, so it could not see them. Re-run it now that they have.
      // Obligation inserts are ON CONFLICT DO NOTHING, so this is idempotent.
      yield* backfillCurrentThreadWork;
    }).pipe(
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(
          toPersistenceSqlError("ProjectionPipeline.reconcileOrphanedInFlightWork:query")(sqlError),
        ),
      ),
    );

    const backfillCurrentThreadWork = Effect.gen(function* () {
      let afterThreadId = "";
      while (true) {
        const rows = yield* sql<{
          readonly threadId: string;
          readonly turnId: string;
          readonly turnState: string;
          readonly completedAt: string | null;
          readonly assistantText: string | null;
          readonly assistantUpdatedAt: string | null;
          readonly sourceMessageId: string | null;
          readonly sourceMessageText: string | null;
          readonly latestUserMessageAt: string | null;
          readonly sessionStatus: string | null;
          readonly sessionUpdatedAt: string | null;
          readonly sessionLastError: string | null;
          readonly providerInstanceId: string | null;
          readonly interactionMode: string;
          readonly turnRuntimeErrors: number;
        }>`
          SELECT
            threads.thread_id AS "threadId",
            turns.turn_id AS "turnId",
            turns.state AS "turnState",
            turns.completed_at AS "completedAt",
            (
              SELECT COUNT(*)
              FROM projection_thread_activities failure
              WHERE failure.turn_id = turns.turn_id
                AND failure.kind = 'runtime.error'
            ) AS "turnRuntimeErrors",
            assistant.text AS "assistantText",
            assistant.updated_at AS "assistantUpdatedAt",
            source.message_id AS "sourceMessageId",
            source.text AS "sourceMessageText",
            threads.latest_user_message_at AS "latestUserMessageAt",
            sessions.status AS "sessionStatus",
            sessions.updated_at AS "sessionUpdatedAt",
            sessions.last_error AS "sessionLastError",
            COALESCE(
              sessions.provider_instance_id,
              json_extract(threads.model_selection_json, '$.instanceId')
            ) AS "providerInstanceId",
            threads.interaction_mode AS "interactionMode"
          FROM projection_threads AS threads
          INNER JOIN projection_turns AS turns
            ON turns.thread_id = threads.thread_id
            AND turns.turn_id = threads.latest_turn_id
          -- LEFT, not INNER: a turn hard-killed before any assistant text
          -- exists (during CLI spawn, a long tool call, before first token)
          -- has no assistant row at all. The INNER JOIN silently dropped
          -- exactly those threads from recovery, so the deadest turns were
          -- the ones that never resumed.
          LEFT JOIN projection_thread_messages AS assistant
            ON assistant.message_id = turns.assistant_message_id
            AND assistant.role = 'assistant'
            AND assistant.is_streaming = 0
          LEFT JOIN projection_thread_messages AS source
            ON source.message_id = turns.pending_message_id
          LEFT JOIN projection_thread_sessions AS sessions
            ON sessions.thread_id = threads.thread_id
          WHERE threads.thread_id > ${afterThreadId}
            AND threads.deleted_at IS NULL
            AND threads.archived_at IS NULL
            AND COALESCE(threads.settled_override, '') != 'settled'
            AND threads.pending_approval_count = 0
            AND threads.pending_user_input_count = 0
            AND turns.turn_id IS NOT NULL
            AND turns.state IN ('completed', 'incomplete', 'error')
          ORDER BY threads.thread_id ASC
          LIMIT 128
        `;
        if (rows.length === 0) break;

        for (const row of rows) {
          if (row.providerInstanceId === null) continue;
          // Null for a turn that died before producing any output; recovery
          // then has no settle time to compare against, and the turn is
          // treated as resumable (a newer user message still supersedes it at
          // the recovery-verdict stage).
          const settledAt = row.completedAt ?? row.assistantUpdatedAt;
          const authenticationFailure =
            isProviderAuthenticationFailure(row.assistantText ?? "") ||
            isProviderAuthenticationFailure(row.sessionLastError ?? "");
          const isAuthenticationPause =
            authenticationFailure &&
            (row.sessionStatus === "error" ||
              row.turnState === "incomplete" ||
              row.turnState === "error");
          const isAgentContinuation =
            row.interactionMode === "agent" &&
            !authenticationFailure &&
            row.turnState === "completed" &&
            row.completedAt !== null &&
            row.sessionStatus === "ready" &&
            row.sessionUpdatedAt === row.completedAt &&
            (row.latestUserMessageAt === null || row.latestUserMessageAt <= row.completedAt) &&
            // Cleanup continuation is decided transactionally while the live
            // projection still has the substantive predecessor available.
            // Boot recovery intentionally fails closed here: synthesizing a
            // missing continuation from housekeeping alone can resurrect an
            // Agent loop whose substantive turn ended with AGENT_STOP.
            !isBrowserTabCleanupMessageId(row.sourceMessageId ?? "") &&
            !row.sourceMessageText?.startsWith("Settings updated:") &&
            row.assistantText !== null &&
            shouldAgentContinueAfterReply(row.assistantText);
          // A turn the process died inside of — a crash, a deploy, a kill —
          // lands as "incomplete"/"error" without an auth failure. It matches
          // neither branch above (continuation requires "completed"), so
          // before this branch existed the thread simply stayed dead until the
          // user typed again, even though `--auto-resume` was requested and a
          // startup-resume handler was already registered. A deliberate user
          // interrupt settles as "interrupted" and is excluded by the query,
          // so it is never resumed here.
          // A turn killed before it produced a single assistant token settles
          // as "completed" — the shutdown path closes it out — while the
          // failure is recorded beside it as a `runtime.error` activity and a
          // session `last_error`. That combination matched no branch: the
          // continuation branch requires assistant text to continue *from*,
          // and the startup-resume branch required "incomplete"/"error". The
          // LEFT JOIN above was widened for exactly this shape (see its
          // comment) so the row survives the query, but both predicates still
          // rejected it, so the deadest turns still never resumed. Observed
          // 2026-08-15 on thread ed9e1e19: an in-place app update killed the
          // CLI 68s into a turn, the turn settled "completed" with zero
          // assistant messages, and the thread sat on an unanswered user
          // message with no obligation of any kind ever created.
          const diedBeforeProducingOutput =
            row.turnState === "completed" &&
            row.assistantText === null &&
            row.turnRuntimeErrors > 0;
          const isStartupResume =
            !authenticationFailure &&
            !isAgentContinuation &&
            (row.turnState === "incomplete" ||
              row.turnState === "error" ||
              diedBeforeProducingOutput) &&
            // An assistant that signed off with AGENT_STOP deliberately ended
            // its loop; resuming it here contradicts the stop contract the
            // user saw (observed 2026-08-05: a restart resumed a signed-off
            // thread with no user input).
            !(row.assistantText !== null && emittedAgentStop(row.assistantText)) &&
            // A newer user message supersedes the dead turn; that send carries
            // its own recovery obligation.
            (row.latestUserMessageAt === null ||
              settledAt === null ||
              row.latestUserMessageAt <= settledAt);
          if (!isAuthenticationPause && !isAgentContinuation && !isStartupResume) continue;

          const kind = isAuthenticationPause
            ? ("authentication-resume" as const)
            : isStartupResume
              ? ("startup-resume" as const)
              : ("agent-continuation" as const);
          const threadId = ThreadId.make(row.threadId);
          const sourceTurnId = TurnId.make(row.turnId);
          const recordedAt =
            settledAt ??
            row.sessionUpdatedAt ??
            row.latestUserMessageAt ??
            "1970-01-01T00:00:00.000Z";
          // One bad row (e.g. the blocked-authentication insert violating the
          // one-active-per-thread index because a sleeping row survived the
          // restart) must not abort the scan: every thread after it in
          // thread-id order would silently get no recovery at all.
          yield* threadWorkObligationRepository
            .insert({
              obligationId: threadWorkObligationId({ threadId, sourceTurnId, kind }),
              threadId,
              sourceTurnId,
              kind,
              state: isAuthenticationPause ? "blocked-authentication" : "pending",
              providerInstanceId: ProviderInstanceId.make(row.providerInstanceId),
              attempt: 0,
              nextAttemptAt: null,
              claimedAt: null,
              leaseExpiresAt: null,
              blockedReason: isAuthenticationPause ? "provider authentication required" : null,
              createdAt: recordedAt,
              updatedAt: recordedAt,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("boot recovery scan could not enqueue thread work", {
                  threadId: row.threadId,
                  sourceTurnId: row.turnId,
                  kind,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
        }

        afterThreadId = rows.at(-1)!.threadId;
        if (rows.length < 128) break;
      }

      yield* backfillKilledBackgroundTaskResumes;
    });

    /**
     * Recover threads whose last turn ended waiting on a background task.
     *
     * These are invisible to the scan above, which only looks at agent-mode
     * threads whose turn ended `incomplete` or `error`. A turn that backgrounds
     * a task and signs off to wait ends perfectly normally, in any interaction
     * mode — the wake it is waiting for comes from the provider harness
     * re-invoking the agent when the task exits, and that owner dies with the
     * process. Nothing else in the system ever fires for it, so the thread sits
     * on "I'll report back when they land" across every later restart.
     */
    const backfillKilledBackgroundTaskResumes = Effect.gen(function* () {
      const bootedAt = yield* DateTime.now;
      const bootedAtEpochMs = DateTime.toEpochMillis(bootedAt);
      const oldestCompletedAt = DateTime.formatIso(
        DateTime.subtract(bootedAt, { milliseconds: KILLED_BACKGROUND_TASK_RESUME_MAX_AGE_MS }),
      );

      let afterThreadId = "";
      while (true) {
        const rows = yield* sql<{
          readonly threadId: string;
          readonly turnId: string;
          readonly completedAt: string;
          readonly assistantText: string | null;
          readonly providerInstanceId: string | null;
        }>`
          SELECT
            threads.thread_id AS "threadId",
            turns.turn_id AS "turnId",
            turns.completed_at AS "completedAt",
            assistant.text AS "assistantText",
            COALESCE(
              sessions.provider_instance_id,
              json_extract(threads.model_selection_json, '$.instanceId')
            ) AS "providerInstanceId"
          FROM projection_threads AS threads
          INNER JOIN projection_turns AS turns
            ON turns.thread_id = threads.thread_id
            AND turns.turn_id = threads.latest_turn_id
          LEFT JOIN projection_thread_messages AS assistant
            ON assistant.message_id = turns.assistant_message_id
            AND assistant.role = 'assistant'
            AND assistant.is_streaming = 0
          LEFT JOIN projection_thread_sessions AS sessions
            ON sessions.thread_id = threads.thread_id
          WHERE threads.thread_id > ${afterThreadId}
            AND threads.deleted_at IS NULL
            AND threads.archived_at IS NULL
            AND COALESCE(threads.settled_override, '') != 'settled'
            AND threads.pending_approval_count = 0
            AND threads.pending_user_input_count = 0
            AND turns.state = 'completed'
            AND turns.completed_at IS NOT NULL
            AND turns.completed_at >= ${oldestCompletedAt}
            -- A newer user message supersedes the wait; that send carries its
            -- own delivery obligation.
            AND (
              threads.latest_user_message_at IS NULL
              OR threads.latest_user_message_at <= turns.completed_at
            )
            -- Cheap narrowing on (thread_id, kind, created_at) so the scan only
            -- reads activities for threads that ever backgrounded work before
            -- their last turn settled.
            AND EXISTS (
              SELECT 1
              FROM projection_thread_activities AS started
              WHERE started.thread_id = threads.thread_id
                AND started.kind = 'task.started'
                AND started.created_at <= turns.completed_at
            )
          ORDER BY threads.thread_id ASC
          LIMIT 128
        `;
        if (rows.length === 0) break;

        for (const row of rows) {
          if (row.providerInstanceId === null) continue;
          // The stop contract wins over any recovery: an assistant that signed
          // off with AGENT_STOP ended its loop on purpose, task or no task.
          if (row.assistantText !== null && emittedAgentStop(row.assistantText)) continue;

          // Only the task rows, only recent ones, newest first: a long-lived
          // thread can hold tens of thousands of activities (86k on the thread
          // this was reported from), and reading them all per candidate would
          // put that on the boot path. Taking the newest rows can only drop a
          // `task.started` whose pair is still present, which makes the task
          // invisible rather than falsely stranded.
          const taskRows = yield* sql<{
            readonly kind: string;
            readonly createdAt: string;
            readonly taskId: string | null;
            readonly taskType: string | null;
            readonly status: string | null;
          }>`
            SELECT
              kind,
              created_at AS "createdAt",
              json_extract(payload_json, '$.taskId') AS "taskId",
              json_extract(payload_json, '$.taskType') AS "taskType",
              json_extract(payload_json, '$.status') AS "status"
            FROM projection_thread_activities
            WHERE thread_id = ${row.threadId}
              AND kind IN ('task.started', 'task.completed')
              AND created_at >= ${oldestCompletedAt}
              AND json_valid(payload_json)
            ORDER BY created_at DESC, activity_id DESC
            LIMIT 500
          `;
          if (
            !threadLostBackgroundTaskAtRestart({
              activities: taskRows
                .map((taskRow) => ({
                  kind: taskRow.kind,
                  createdAt: taskRow.createdAt,
                  payload: {
                    ...(taskRow.taskId === null ? {} : { taskId: taskRow.taskId }),
                    ...(taskRow.taskType === null ? {} : { taskType: taskRow.taskType }),
                    ...(taskRow.status === null ? {} : { status: taskRow.status }),
                  },
                }))
                .toReversed(),
              turnCompletedAt: row.completedAt,
              bootedAtEpochMs,
            })
          ) {
            continue;
          }

          const threadId = ThreadId.make(row.threadId);
          const sourceTurnId = TurnId.make(row.turnId);
          const kind = "startup-resume" as const;
          // Keyed on the settled turn, so a thread recovered once is not
          // recovered again on the next boot: the obligation row survives as
          // completed and the insert is a no-op.
          yield* threadWorkObligationRepository
            .insert({
              obligationId: threadWorkObligationId({ threadId, sourceTurnId, kind }),
              threadId,
              sourceTurnId,
              kind,
              state: "pending",
              providerInstanceId: ProviderInstanceId.make(row.providerInstanceId),
              attempt: 0,
              nextAttemptAt: null,
              claimedAt: null,
              leaseExpiresAt: null,
              blockedReason: null,
              createdAt: row.completedAt,
              updatedAt: row.completedAt,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("boot recovery scan could not enqueue killed-task resume", {
                  threadId: row.threadId,
                  sourceTurnId: row.turnId,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
        }

        afterThreadId = rows.at(-1)!.threadId;
        if (rows.length < 128) break;
      }
    });

    const bootstrapProjectors = Effect.gen(function* () {
      const bootstrapDefinitions = projectors.map((projector) =>
        projector.name === ORCHESTRATION_PROJECTOR_NAMES.threads
          ? {
              ...projector,
              apply: (event: OrchestrationEvent, attachmentSideEffects: AttachmentSideEffects) =>
                applyThreadsProjection(event, attachmentSideEffects, true),
            }
          : projector,
      );
      const stateRows = yield* projectionStateRepository.listAll();
      const lastAppliedByProjector = new Map(
        stateRows.map((row) => [row.projector, row.lastAppliedSequence]),
      );
      const firstUnappliedSequence = Math.min(
        ...bootstrapDefinitions.map((projector) => lastAppliedByProjector.get(projector.name) ?? 0),
      );
      const shellSummaryThreadIds = new Set<string>();

      yield* Stream.runForEach(
        eventStore.readFromSequence(firstUnappliedSequence, Number.MAX_SAFE_INTEGER),
        (event) => {
          const selectedProjectors = bootstrapDefinitions.filter(
            (projector) => (lastAppliedByProjector.get(projector.name) ?? 0) < event.sequence,
          );
          if (selectedProjectors.length === 0) return Effect.void;

          if (
            event.aggregateKind === "thread" &&
            selectedProjectors.some(
              (projector) => projector.name === ORCHESTRATION_PROJECTOR_NAMES.threads,
            )
          ) {
            shellSummaryThreadIds.add(event.aggregateId);
          }

          return runProjectorsForEvent(selectedProjectors, event).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                for (const projector of selectedProjectors) {
                  lastAppliedByProjector.set(projector.name, event.sequence);
                }
              }),
            ),
          );
        },
      );

      // Replay defers summary derivation because several projector tables must
      // reach the same sequence first. Only threads touched by this replay can
      // have changed; refreshing every historical thread made an already
      // caught-up startup perform five writes per thread for no state change.
      yield* refreshThreadShellSummaries(shellSummaryThreadIds);
    });

    const projectEvent: OrchestrationProjectionPipelineShape["projectEvent"] = (event) =>
      runProjectorsForEvent(projectors, event).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ServerConfig, serverConfig),
        Effect.asVoid,
        Effect.catchTag("SqlError", (sqlError) =>
          Effect.fail(toPersistenceSqlError("ProjectionPipeline.projectEvent:query")(sqlError)),
        ),
      );

    const bootstrap: OrchestrationProjectionPipelineShape["bootstrap"] = bootstrapProjectors.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
      Effect.andThen(backfillCurrentThreadWork),
      Effect.asVoid,
      Effect.tap(() =>
        Effect.logDebug("orchestration projection pipeline bootstrapped").pipe(
          Effect.annotateLogs({ projectors: projectors.length }),
        ),
      ),
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(toPersistenceSqlError("ProjectionPipeline.bootstrap:query")(sqlError)),
      ),
    );

    return {
      bootstrap,
      reconcileOrphanedInFlightWork,
      projectEvent,
    } satisfies OrchestrationProjectionPipelineShape;
  },
);

export const OrchestrationProjectionPipelineLive = Layer.effect(
  OrchestrationProjectionPipeline,
  makeOrchestrationProjectionPipeline(),
).pipe(
  Layer.provideMerge(ProjectionProjectRepositoryLive),
  Layer.provideMerge(ProjectionThreadRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(ProjectionThreadProposedPlanRepositoryLive),
  Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
  Layer.provideMerge(ProjectionThreadSessionRepositoryLive),
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provideMerge(ProjectionPendingApprovalRepositoryLive),
  Layer.provideMerge(ProjectionStateRepositoryLive),
  Layer.provideMerge(ThreadWorkObligationRepositoryLive),
);
