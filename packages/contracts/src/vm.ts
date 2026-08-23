import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Reserved project that owns every agent's dedicated chat thread. Like the
 * orchestrator's reserved project, it is hidden from the normal project/thread
 * lists — agents surface only in their own sidebar section.
 */
export const AGENTS_PROJECT_ID = ProjectId.make("solla-agents");
export const AGENTS_PROJECT_NAME = "Agents";
export const isAgentsProjectId = (projectId: string): boolean => projectId === AGENTS_PROJECT_ID;

/**
 * Reserved id prefix for Agent Builder chats.
 *
 * A builder chat is an ordinary thread in the hidden agents project whose id
 * carries this prefix. The prefix is what grants the thread the agent_builder
 * tool — identity in the id, like delegation-worker threads — so no schema or
 * table changes are needed to mark one.
 */
export const AGENT_BUILDER_THREAD_PREFIX = "agent-builder:";
export const isAgentBuilderThreadId = (threadId: string): boolean =>
  threadId.startsWith(AGENT_BUILDER_THREAD_PREFIX);

/**
 * The singleton Agent Builder chat.
 *
 * One persistent thread — like the orchestrator — that the Agents section's
 * build button opens. It carries the builder prefix, so the capability grant
 * needs no extra rule, and its fixed id is what the decider's delete/archive
 * guards protect (a soft-deleted row would burn the reserved id forever).
 */
export const AGENT_BUILDER_THREAD_ID = ThreadId.make("agent-builder:primary");
export const AGENT_BUILDER_THREAD_TITLE = "Agent Builder";

/**
 * The Agent Stack: named autonomous agents that each own a persistent local
 * virtual machine (full desktop + browser) they control with full permissions.
 *
 * Agents are a first-class feature, deliberately NOT modeled as threads. An
 * agent's identity is its unique {@link VmAgentName}; a normalized
 * {@link VmAgentHandle} is what `@mentions` in chat resolve against.
 */

/** Branded stable id. Server-allocated, opaque to clients. */
export const VmAgentId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("VmAgentId"),
);
export type VmAgentId = typeof VmAgentId.Type;

/** Branded id of the underlying VM in the hypervisor. */
export const VmId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(Schema.brand("VmId"));
export type VmId = typeof VmId.Type;

/**
 * Display name. Unique (case-insensitively) across agents. This is the agent's
 * identity the user types and reads.
 */
export const VmAgentName = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type VmAgentName = typeof VmAgentName.Type;

/**
 * Mention handle: a normalized, lowercase, `@`-friendly form of the name used
 * to route `@handle` deliveries in chat threads. Letters, digits, hyphen only.
 */
export const VmAgentHandle = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
);
export type VmAgentHandle = typeof VmAgentHandle.Type;

/** Derive the mention handle from a display name. Shared by client and server. */
export const toVmAgentHandle = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

export const VmAgentStatus = Schema.Literals([
  "provisioning",
  "stopped",
  "starting",
  "running",
  "stopping",
  "failed",
]);
export type VmAgentStatus = typeof VmAgentStatus.Type;

/**
 * Historical takeover flag from the VM era, retained for row compatibility.
 * Always "agent" for new rows; nothing flips it any more.
 */
export const VmControlMode = Schema.Literals(["agent", "user"]);
export type VmControlMode = typeof VmControlMode.Type;

export const VmAgent = Schema.Struct({
  vmAgentId: VmAgentId,
  name: VmAgentName,
  handle: VmAgentHandle,
  purpose: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  vmId: VmId,
  /** The agent's dedicated single chat thread (null only if creation failed). */
  threadId: Schema.NullOr(ThreadId),
  status: VmAgentStatus,
  controlMode: VmControlMode,
  /** vmnet-assigned guest IP once the VM is up; null while down/booting. */
  guestIp: Schema.NullOr(TrimmedNonEmptyString),
  /** Last failure message when `status === "failed"`. */
  lastError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type VmAgent = typeof VmAgent.Type;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const VmAgentCreateInput = Schema.Struct({
  name: VmAgentName,
  purpose: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
});
export type VmAgentCreateInput = Schema.Codec.Encoded<typeof VmAgentCreateInput>;

export const VmAgentRef = Schema.Struct({
  vmAgentId: VmAgentId,
});
export type VmAgentRef = Schema.Codec.Encoded<typeof VmAgentRef>;

export const VmAgentListResult = Schema.Struct({
  agents: Schema.Array(VmAgent),
});
export type VmAgentListResult = typeof VmAgentListResult.Type;

// ---------------------------------------------------------------------------
// Registry stream (list view stays live without polling)
// ---------------------------------------------------------------------------

const VmAgentSnapshotEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  agents: Schema.Array(VmAgent),
});

const VmAgentUpsertEvent = Schema.Struct({
  type: Schema.Literal("upsert"),
  agent: VmAgent,
});

const VmAgentRemoveEvent = Schema.Struct({
  type: Schema.Literal("remove"),
  vmAgentId: VmAgentId,
});

export const VmAgentResyncRequiredEvent = Schema.Struct({
  type: Schema.Literal("resync-required"),
  reason: Schema.Literal("slow-consumer"),
});
export type VmAgentResyncRequiredEvent = typeof VmAgentResyncRequiredEvent.Type;

export const VmAgentStreamEvent = Schema.Union([
  VmAgentSnapshotEvent,
  VmAgentUpsertEvent,
  VmAgentRemoveEvent,
]);
export type VmAgentStreamEvent = typeof VmAgentStreamEvent.Type;

export const VmAgentStreamItem = Schema.Union([VmAgentStreamEvent, VmAgentResyncRequiredEvent]);
export type VmAgentStreamItem = typeof VmAgentStreamItem.Type;

// ---------------------------------------------------------------------------
// Durable agent workspaces
// ---------------------------------------------------------------------------

export const VmAgentTaskId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("VmAgentTaskId"),
);
export type VmAgentTaskId = typeof VmAgentTaskId.Type;

export const VmAgentTaskRunId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("VmAgentTaskRunId"),
);
export type VmAgentTaskRunId = typeof VmAgentTaskRunId.Type;

export const VmAgentArtifactId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("VmAgentArtifactId"),
);
export type VmAgentArtifactId = typeof VmAgentArtifactId.Type;

export const VmAgentNotificationId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("VmAgentNotificationId"),
);
export type VmAgentNotificationId = typeof VmAgentNotificationId.Type;

export const VmAgentBlockerId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("VmAgentBlockerId"),
);
export type VmAgentBlockerId = typeof VmAgentBlockerId.Type;

export const VmAgentTaskStatus = Schema.Literals(["draft", "active", "paused", "completed"]);
export type VmAgentTaskStatus = typeof VmAgentTaskStatus.Type;

export const VmAgentTaskApprovalState = Schema.Literals(["pending", "approved", "rejected"]);
export type VmAgentTaskApprovalState = typeof VmAgentTaskApprovalState.Type;

export const VmAgentTaskCreatedBy = Schema.Literals(["user", "agent"]);
export type VmAgentTaskCreatedBy = typeof VmAgentTaskCreatedBy.Type;

export const VmAgentTaskNotificationPolicy = Schema.Literals(["always", "failure", "never"]);
export type VmAgentTaskNotificationPolicy = typeof VmAgentTaskNotificationPolicy.Type;

export const VmAgentTaskSchedule = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("once"),
    runAt: IsoDateTime,
  }),
  Schema.Struct({
    kind: Schema.Literal("interval"),
    everyMinutes: PositiveInt.check(Schema.isLessThanOrEqualTo(525_600)),
  }),
]);
export type VmAgentTaskSchedule = typeof VmAgentTaskSchedule.Type;

export const VmAgentTaskCompletionCriteria = Schema.Array(
  TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
).check(Schema.isMaxLength(50));
export type VmAgentTaskCompletionCriteria = typeof VmAgentTaskCompletionCriteria.Type;

export const VmAgentTask = Schema.Struct({
  taskId: VmAgentTaskId,
  vmAgentId: VmAgentId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(50_000)),
  completionCriteria: VmAgentTaskCompletionCriteria,
  status: VmAgentTaskStatus,
  schedule: Schema.NullOr(VmAgentTaskSchedule),
  nextRunAt: Schema.NullOr(IsoDateTime),
  createdBy: VmAgentTaskCreatedBy,
  approvalState: VmAgentTaskApprovalState,
  notificationPolicy: VmAgentTaskNotificationPolicy,
  artifactId: Schema.NullOr(VmAgentArtifactId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type VmAgentTask = typeof VmAgentTask.Type;

export const VmAgentTaskRunStatus = Schema.Literals([
  "queued",
  "booting",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type VmAgentTaskRunStatus = typeof VmAgentTaskRunStatus.Type;

export const VmAgentTaskRun = Schema.Struct({
  runId: VmAgentTaskRunId,
  taskId: VmAgentTaskId,
  vmAgentId: VmAgentId,
  status: VmAgentTaskRunStatus,
  messageId: Schema.NullOr(MessageId),
  turnId: Schema.NullOr(TurnId),
  scheduledFor: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  resultSummary: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_000))),
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_000))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type VmAgentTaskRun = typeof VmAgentTaskRun.Type;

const VmArtifactText = TrimmedNonEmptyString.check(Schema.isMaxLength(2_000));

export const VmAgentArtifactDefinition = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("schedule"),
    description: Schema.optional(VmArtifactText),
  }),
  Schema.Struct({
    kind: Schema.Literal("metrics"),
    metrics: Schema.Array(
      Schema.Struct({
        label: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
        value: Schema.String.check(Schema.isMaxLength(500)),
      }),
    ).check(Schema.isMaxLength(100)),
  }),
  Schema.Struct({
    kind: Schema.Literal("checklist"),
    items: Schema.Array(
      Schema.Struct({
        label: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
        checked: Schema.Boolean,
      }),
    ).check(Schema.isMaxLength(200)),
  }),
  Schema.Struct({
    kind: Schema.Literal("table"),
    columns: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(120))).check(
      Schema.isMaxLength(20),
    ),
    rows: Schema.Array(
      Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(Schema.isMaxLength(20)),
    ).check(Schema.isMaxLength(100)),
  }),
  Schema.Struct({
    kind: Schema.Literal("timeline"),
    items: Schema.Array(
      Schema.Struct({
        at: Schema.optional(IsoDateTime),
        title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
        detail: Schema.optional(Schema.String.check(Schema.isMaxLength(1_000))),
      }),
    ).check(Schema.isMaxLength(200)),
  }),
  Schema.Struct({
    kind: Schema.Literal("cards"),
    cards: Schema.Array(
      Schema.Struct({
        title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
        body: Schema.String.check(Schema.isMaxLength(2_000)),
      }),
    ).check(Schema.isMaxLength(100)),
  }),
]);
export type VmAgentArtifactDefinition = typeof VmAgentArtifactDefinition.Type;

export const VmAgentArtifact = Schema.Struct({
  artifactId: VmAgentArtifactId,
  vmAgentId: VmAgentId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  definition: VmAgentArtifactDefinition,
  revision: PositiveInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type VmAgentArtifact = typeof VmAgentArtifact.Type;

export const VmAgentNotificationKind = Schema.Literals([
  "task-completed",
  "task-failed",
  "task-blocked",
  "agent-message",
]);
export type VmAgentNotificationKind = typeof VmAgentNotificationKind.Type;

export const VmAgentNotification = Schema.Struct({
  notificationId: VmAgentNotificationId,
  vmAgentId: VmAgentId,
  taskId: Schema.NullOr(VmAgentTaskId),
  runId: Schema.NullOr(VmAgentTaskRunId),
  kind: VmAgentNotificationKind,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  body: Schema.String.check(Schema.isMaxLength(4_000)),
  deepLink: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  readAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
});
export type VmAgentNotification = typeof VmAgentNotification.Type;

export const VmAgentNotificationPreferences = Schema.Struct({
  vmAgentId: VmAgentId,
  enabled: Schema.Boolean,
  taskCompletions: Schema.Boolean,
  taskFailures: Schema.Boolean,
  agentMessages: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type VmAgentNotificationPreferences = typeof VmAgentNotificationPreferences.Type;

/**
 * A standing "waiting on you" request the agent raised because its work is
 * blocked on something only the user can do — a login, a CAPTCHA, a
 * permission grant, a purchase decision. Unlike prose in the chat (which
 * scrolls away when the turn ends), a blocker persists until one side
 * resolves it: the user from the workspace UI, or the agent once a later run
 * finds the path clear.
 */
export const VmAgentBlocker = Schema.Struct({
  blockerId: VmAgentBlockerId,
  vmAgentId: VmAgentId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  detail: Schema.String.check(Schema.isMaxLength(4_000)),
  /** Where the user should go to unblock, when there is a single place. */
  url: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
  resolvedBy: Schema.NullOr(Schema.Literals(["user", "agent", "dismissed"])),
});
export type VmAgentBlocker = typeof VmAgentBlocker.Type;

export const VmAgentWorkspaceSnapshot = Schema.Struct({
  type: Schema.Literal("snapshot"),
  vmAgentId: VmAgentId,
  tasks: Schema.Array(VmAgentTask),
  runs: Schema.Array(VmAgentTaskRun),
  artifact: Schema.NullOr(VmAgentArtifact),
  notifications: Schema.Array(VmAgentNotification),
  notificationPreferences: VmAgentNotificationPreferences,
  blockers: Schema.Array(VmAgentBlocker),
});
export type VmAgentWorkspaceSnapshot = typeof VmAgentWorkspaceSnapshot.Type;

export const VmAgentWorkspaceStreamItem = Schema.Union([
  VmAgentWorkspaceSnapshot,
  VmAgentResyncRequiredEvent,
]);
export type VmAgentWorkspaceStreamItem = typeof VmAgentWorkspaceStreamItem.Type;

// ---------------------------------------------------------------------------
// Bounded agent-to-agent collaboration
// ---------------------------------------------------------------------------

export const VM_AGENT_DELEGATION_MAX_CHILD_DELEGATIONS = 3;
export const VM_AGENT_DELEGATION_MAX_DEPTH = 1;
export const VM_AGENT_DELEGATION_MAX_FOLLOWUPS = 5;
export const VM_AGENT_DELEGATION_MAX_MESSAGES = 200;
export const VM_AGENT_DELEGATION_MAX_WALL_CLOCK_MINUTES = 30;

export const VmAgentDelegationId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("VmAgentDelegationId"),
);
export type VmAgentDelegationId = typeof VmAgentDelegationId.Type;

export const VmAgentDelegationMessageId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("VmAgentDelegationMessageId"),
);
export type VmAgentDelegationMessageId = typeof VmAgentDelegationMessageId.Type;

export const VmAgentDelegationStatus = Schema.Literals([
  "pending-approval",
  "queued",
  "running",
  "waiting-input",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
export type VmAgentDelegationStatus = typeof VmAgentDelegationStatus.Type;

export const VmAgentCollaborationAvailability = Schema.Literals([
  "available",
  "busy",
  "offline",
  "failed",
  "user-control",
]);
export type VmAgentCollaborationAvailability = typeof VmAgentCollaborationAvailability.Type;

/** Extensible capability id. Unknown future ids remain visible to old clients. */
export const VmAgentCollaborationCapability = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type VmAgentCollaborationCapability = typeof VmAgentCollaborationCapability.Type;

export const VmAgentCollaborationAgentSummary = Schema.Struct({
  vmAgentId: VmAgentId,
  name: VmAgentName,
  handle: VmAgentHandle,
  purpose: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  status: VmAgentStatus,
  controlMode: VmControlMode,
  availability: VmAgentCollaborationAvailability,
  capabilities: Schema.Array(VmAgentCollaborationCapability),
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  model: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  activeDelegations: NonNegativeInt,
  canReceiveDelegation: Schema.Boolean,
});
export type VmAgentCollaborationAgentSummary = typeof VmAgentCollaborationAgentSummary.Type;

export const VmAgentDelegationLimits = Schema.Struct({
  maxDepth: PositiveInt,
  maxChildDelegations: PositiveInt,
  maxFollowups: PositiveInt,
  maxMessages: PositiveInt,
  maxWallClockMinutes: PositiveInt,
});
export type VmAgentDelegationLimits = typeof VmAgentDelegationLimits.Type;

export const DEFAULT_VM_AGENT_DELEGATION_LIMITS: VmAgentDelegationLimits = {
  maxDepth: VM_AGENT_DELEGATION_MAX_DEPTH,
  maxChildDelegations: VM_AGENT_DELEGATION_MAX_CHILD_DELEGATIONS,
  maxFollowups: VM_AGENT_DELEGATION_MAX_FOLLOWUPS,
  maxMessages: VM_AGENT_DELEGATION_MAX_MESSAGES,
  maxWallClockMinutes: VM_AGENT_DELEGATION_MAX_WALL_CLOCK_MINUTES,
};

export const VmAgentDelegationTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("agent"),
    vmAgentId: VmAgentId,
  }),
  Schema.Struct({
    kind: Schema.Literal("ephemeral"),
    label: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  }),
]);
export type VmAgentDelegationTarget = typeof VmAgentDelegationTarget.Type;

export const VmAgentDelegationResult = Schema.Struct({
  summary: Schema.String.check(Schema.isMaxLength(20_000)),
  completedBy: Schema.Literals(["target-agent", "ephemeral-worker"]),
  completedAt: IsoDateTime,
});
export type VmAgentDelegationResult = typeof VmAgentDelegationResult.Type;

export const VmAgentIdentitySnapshot = Schema.Struct({
  vmAgentId: VmAgentId,
  name: VmAgentName,
  handle: VmAgentHandle,
  purpose: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
});
export type VmAgentIdentitySnapshot = typeof VmAgentIdentitySnapshot.Type;

export const VmAgentDelegation = Schema.Struct({
  delegationId: VmAgentDelegationId,
  rootVmAgentId: VmAgentId,
  sourceVmAgentId: VmAgentId,
  rootDelegationId: Schema.NullOr(VmAgentDelegationId),
  parentDelegationId: Schema.NullOr(VmAgentDelegationId),
  depth: PositiveInt,
  target: VmAgentDelegationTarget,
  targetVmAgentId: Schema.NullOr(VmAgentId),
  workerThreadId: Schema.NullOr(ThreadId),
  rootAgentSnapshot: VmAgentIdentitySnapshot,
  sourceAgentSnapshot: VmAgentIdentitySnapshot,
  targetAgentSnapshot: Schema.NullOr(VmAgentIdentitySnapshot),
  taskId: VmAgentTaskId,
  runId: Schema.NullOr(VmAgentTaskRunId),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(50_000)),
  completionCriteria: VmAgentTaskCompletionCriteria,
  requestedCapabilities: Schema.Array(VmAgentCollaborationCapability).check(Schema.isMaxLength(32)),
  status: VmAgentDelegationStatus,
  followupCount: NonNegativeInt,
  messageCount: NonNegativeInt,
  effectiveLimits: VmAgentDelegationLimits,
  revision: PositiveInt,
  createdAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  expiresAt: IsoDateTime,
  updatedAt: IsoDateTime,
  result: Schema.NullOr(VmAgentDelegationResult),
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_000))),
});
export type VmAgentDelegation = typeof VmAgentDelegation.Type;

export const VmAgentDelegationMessageSender = Schema.Literals([
  "source-agent",
  "target-agent",
  "user",
  "system",
]);
export type VmAgentDelegationMessageSender = typeof VmAgentDelegationMessageSender.Type;

export const VmAgentDelegationMessageKind = Schema.Literals(["note", "question", "answer"]);
export type VmAgentDelegationMessageKind = typeof VmAgentDelegationMessageKind.Type;

export const VmAgentDelegationMessageDelivery = Schema.Literals(["pending", "delivered"]);
export type VmAgentDelegationMessageDelivery = typeof VmAgentDelegationMessageDelivery.Type;

export const VmAgentDelegationMessage = Schema.Struct({
  messageId: VmAgentDelegationMessageId,
  delegationId: VmAgentDelegationId,
  sequence: PositiveInt,
  sender: VmAgentDelegationMessageSender,
  senderVmAgentId: Schema.NullOr(VmAgentId),
  kind: VmAgentDelegationMessageKind,
  delivery: VmAgentDelegationMessageDelivery,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  createdAt: IsoDateTime,
});
export type VmAgentDelegationMessage = typeof VmAgentDelegationMessage.Type;

export const VmAgentDelegationSummary = Schema.Struct({
  delegation: VmAgentDelegation,
  rootAgent: Schema.NullOr(VmAgentCollaborationAgentSummary),
  sourceAgent: Schema.NullOr(VmAgentCollaborationAgentSummary),
  targetAgent: Schema.NullOr(VmAgentCollaborationAgentSummary),
  latestMessage: Schema.NullOr(VmAgentDelegationMessage),
});
export type VmAgentDelegationSummary = typeof VmAgentDelegationSummary.Type;

export const VmAgentDelegationDetail = Schema.Struct({
  delegation: VmAgentDelegation,
  rootAgent: Schema.NullOr(VmAgentCollaborationAgentSummary),
  sourceAgent: Schema.NullOr(VmAgentCollaborationAgentSummary),
  targetAgent: Schema.NullOr(VmAgentCollaborationAgentSummary),
  messages: Schema.Array(VmAgentDelegationMessage),
});
export type VmAgentDelegationDetail = typeof VmAgentDelegationDetail.Type;

export const VmAgentCollaborationSnapshot = Schema.Struct({
  type: Schema.Literal("snapshot"),
  agents: Schema.Array(VmAgentCollaborationAgentSummary),
  delegations: Schema.Array(VmAgentDelegationSummary),
});
export type VmAgentCollaborationSnapshot = typeof VmAgentCollaborationSnapshot.Type;

export const VmAgentCollaborationStreamItem = Schema.Union([
  VmAgentCollaborationSnapshot,
  VmAgentResyncRequiredEvent,
]);
export type VmAgentCollaborationStreamItem = typeof VmAgentCollaborationStreamItem.Type;

export const VmAgentDelegationCreateInput = Schema.Struct({
  target: VmAgentDelegationTarget,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(50_000)),
  completionCriteria: Schema.optional(VmAgentTaskCompletionCriteria),
  requestedCapabilities: Schema.optional(
    Schema.Array(VmAgentCollaborationCapability).check(Schema.isMaxLength(32)),
  ),
  /** Stable caller key makes retried delegate calls return the same work item. */
  idempotencyKey: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type VmAgentDelegationCreateInput = Schema.Codec.Encoded<
  typeof VmAgentDelegationCreateInput
>;

export const VmAgentDelegationRef = Schema.Struct({
  delegationId: VmAgentDelegationId,
});
export type VmAgentDelegationRef = Schema.Codec.Encoded<typeof VmAgentDelegationRef>;

export const VmAgentDelegationSendMessageInput = Schema.Struct({
  delegationId: VmAgentDelegationId,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  kind: Schema.optional(VmAgentDelegationMessageKind),
  waitForReply: Schema.optional(Schema.Boolean),
});
export type VmAgentDelegationSendMessageInput = Schema.Codec.Encoded<
  typeof VmAgentDelegationSendMessageInput
>;

export const VmAgentCollaborationReceipt = Schema.Struct({
  operation: Schema.Literals(["delegate", "send-message", "cancel"]),
  delegationId: VmAgentDelegationId,
  status: VmAgentDelegationStatus,
  revision: PositiveInt,
  acceptedAt: IsoDateTime,
});
export type VmAgentCollaborationReceipt = typeof VmAgentCollaborationReceipt.Type;

export class VmAgentDelegationNotFoundError extends Schema.TaggedErrorClass<VmAgentDelegationNotFoundError>()(
  "VmAgentDelegationNotFoundError",
  { delegationId: Schema.String },
) {
  override get message() {
    return `Unknown delegated work item: ${this.delegationId}`;
  }
}

export class VmAgentDelegationScopeError extends Schema.TaggedErrorClass<VmAgentDelegationScopeError>()(
  "VmAgentDelegationScopeError",
  { delegationId: Schema.String, vmAgentId: Schema.String },
) {
  override get message() {
    return `Agent ${this.vmAgentId} is not part of delegated work ${this.delegationId}`;
  }
}

export class VmAgentDelegationLimitError extends Schema.TaggedErrorClass<VmAgentDelegationLimitError>()(
  "VmAgentDelegationLimitError",
  {
    limit: Schema.Literals(["active-children", "followups", "messages", "depth", "wall-clock"]),
    maximum: NonNegativeInt,
  },
) {
  override get message() {
    return `Agent collaboration limit '${this.limit}' was reached (${this.maximum})`;
  }
}

export class VmAgentDelegationInvalidStateError extends Schema.TaggedErrorClass<VmAgentDelegationInvalidStateError>()(
  "VmAgentDelegationInvalidStateError",
  { delegationId: Schema.String, status: Schema.String, operation: Schema.String },
) {
  override get message() {
    return `Cannot ${this.operation} delegated work ${this.delegationId} while it is ${this.status}`;
  }
}

export class VmAgentCollaborationOperationError extends Schema.TaggedErrorClass<VmAgentCollaborationOperationError>()(
  "VmAgentCollaborationOperationError",
  { operation: Schema.String, detail: Schema.String },
) {
  override get message() {
    return `${this.operation} failed: ${this.detail}`;
  }
}

export const VmAgentTaskCreateInput = Schema.Struct({
  vmAgentId: VmAgentId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(50_000)),
  completionCriteria: VmAgentTaskCompletionCriteria,
  status: Schema.optional(VmAgentTaskStatus),
  schedule: Schema.NullOr(VmAgentTaskSchedule),
  notificationPolicy: Schema.optional(VmAgentTaskNotificationPolicy),
});
export type VmAgentTaskCreateInput = Schema.Codec.Encoded<typeof VmAgentTaskCreateInput>;

export const VmAgentTaskUpdateInput = Schema.Struct({
  vmAgentId: VmAgentId,
  taskId: VmAgentTaskId,
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  prompt: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(50_000))),
  completionCriteria: Schema.optional(VmAgentTaskCompletionCriteria),
  status: Schema.optional(VmAgentTaskStatus),
  schedule: Schema.optional(Schema.NullOr(VmAgentTaskSchedule)),
  approvalState: Schema.optional(VmAgentTaskApprovalState),
  notificationPolicy: Schema.optional(VmAgentTaskNotificationPolicy),
});
export type VmAgentTaskUpdateInput = Schema.Codec.Encoded<typeof VmAgentTaskUpdateInput>;

export const VmAgentTaskRef = Schema.Struct({
  vmAgentId: VmAgentId,
  taskId: VmAgentTaskId,
});
export type VmAgentTaskRef = Schema.Codec.Encoded<typeof VmAgentTaskRef>;

export const VmAgentTaskPromptGenerationInput = Schema.Struct({
  vmAgentId: VmAgentId,
  request: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
});
export type VmAgentTaskPromptGenerationInput = Schema.Codec.Encoded<
  typeof VmAgentTaskPromptGenerationInput
>;

export const VmAgentTaskPromptGenerationResult = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(50_000)),
  schedule: Schema.NullOr(VmAgentTaskSchedule),
  completionCriteria: VmAgentTaskCompletionCriteria,
  notificationPolicy: VmAgentTaskNotificationPolicy,
});
export type VmAgentTaskPromptGenerationResult = typeof VmAgentTaskPromptGenerationResult.Type;

export const VmAgentNotificationRef = Schema.Struct({
  vmAgentId: VmAgentId,
  notificationId: VmAgentNotificationId,
});
export type VmAgentNotificationRef = Schema.Codec.Encoded<typeof VmAgentNotificationRef>;

export const VmAgentBlockerRef = Schema.Struct({
  vmAgentId: VmAgentId,
  blockerId: VmAgentBlockerId,
});
export type VmAgentBlockerRef = Schema.Codec.Encoded<typeof VmAgentBlockerRef>;

export const VmAgentBlockerResolveInput = Schema.Struct({
  vmAgentId: VmAgentId,
  blockerId: VmAgentBlockerId,
  /**
   * Dismissal is the user waving the request away without asserting the
   * underlying thing happened: the card disappears and the agent sees
   * resolvedBy "dismissed" rather than a completed hand-off.
   */
  dismissed: Schema.optional(Schema.Boolean),
});
export type VmAgentBlockerResolveInput = Schema.Codec.Encoded<typeof VmAgentBlockerResolveInput>;

export const VmAgentNotificationPreferencesInput = Schema.Struct({
  vmAgentId: VmAgentId,
  enabled: Schema.Boolean,
  taskCompletions: Schema.Boolean,
  taskFailures: Schema.Boolean,
  agentMessages: Schema.Boolean,
});
export type VmAgentNotificationPreferencesInput = Schema.Codec.Encoded<
  typeof VmAgentNotificationPreferencesInput
>;

export class VmAgentTaskNotFoundError extends Schema.TaggedErrorClass<VmAgentTaskNotFoundError>()(
  "VmAgentTaskNotFoundError",
  { taskId: Schema.String },
) {
  override get message() {
    return `Unknown agent task: ${this.taskId}`;
  }
}

export class VmAgentTaskApprovalRequiredError extends Schema.TaggedErrorClass<VmAgentTaskApprovalRequiredError>()(
  "VmAgentTaskApprovalRequiredError",
  { taskId: Schema.String },
) {
  override get message() {
    return `Agent task ${this.taskId} requires user approval`;
  }
}

export class VmAgentWorkspaceOperationError extends Schema.TaggedErrorClass<VmAgentWorkspaceOperationError>()(
  "VmAgentWorkspaceOperationError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message() {
    return `${this.operation} failed: ${this.detail}`;
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class VmAgentNameConflictError extends Schema.TaggedErrorClass<VmAgentNameConflictError>()(
  "VmAgentNameConflictError",
  {
    name: Schema.String,
    handle: Schema.String,
  },
) {
  override get message() {
    return `An agent named "${this.name}" (@${this.handle}) already exists`;
  }
}

export class VmAgentNotFoundError extends Schema.TaggedErrorClass<VmAgentNotFoundError>()(
  "VmAgentNotFoundError",
  {
    vmAgentId: Schema.String,
  },
) {
  override get message() {
    return `Unknown agent: ${this.vmAgentId}`;
  }
}

export const VmAgentError = Schema.Union([VmAgentNameConflictError, VmAgentNotFoundError]);
export type VmAgentError = typeof VmAgentError.Type;

export const VmAgentWorkspaceError = Schema.Union([
  VmAgentNotFoundError,
  VmAgentTaskNotFoundError,
  VmAgentTaskApprovalRequiredError,
  VmAgentWorkspaceOperationError,
]);
export type VmAgentWorkspaceError = typeof VmAgentWorkspaceError.Type;

export const VmAgentCollaborationError = Schema.Union([
  VmAgentNotFoundError,
  VmAgentDelegationNotFoundError,
  VmAgentDelegationScopeError,
  VmAgentDelegationLimitError,
  VmAgentDelegationInvalidStateError,
  VmAgentCollaborationOperationError,
]);
export type VmAgentCollaborationError = typeof VmAgentCollaborationError.Type;
