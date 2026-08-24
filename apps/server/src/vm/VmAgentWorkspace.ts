import {
  type VmAgentArtifact,
  type VmAgentArtifactDefinition,
  VmAgentArtifactId,
  type VmAgentAttentionSnapshot,
  type VmAgentBlocker,
  VmAgentBlockerId,
  type VmAgentId,
  type VmAgentNotification,
  VmAgentNotificationId,
  type VmAgentNotificationKind,
  type VmAgentNotificationPreferences,
  type VmAgentTask,
  VmAgentTaskApprovalRequiredError,
  VmAgentTaskId,
  VmAgentTaskNotFoundError,
  type VmAgentTaskNotificationPolicy,
  type VmAgentTaskSchedule,
  type VmAgentTaskStatus,
  type VmAgentWorkspaceError,
  VmAgentWorkspaceOperationError,
  type VmAgentWorkspaceSnapshot,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { VmAgentStore } from "../persistence/Services/VmAgents.ts";
import { VmAgentWorkspaceStore } from "../persistence/Services/VmAgentWorkspaces.ts";
import { ARCHIVED_NOTIFICATION_RETENTION_HOURS } from "../persistence/Layers/VmAgentWorkspaces.ts";

type WorkspaceListener = (snapshot: VmAgentWorkspaceSnapshot) => Effect.Effect<void>;
type AttentionListener = (snapshot: VmAgentAttentionSnapshot) => Effect.Effect<void>;

export interface CreateWorkspaceTaskInput {
  readonly vmAgentId: VmAgentId;
  readonly title: string;
  readonly prompt: string;
  readonly completionCriteria: ReadonlyArray<string>;
  readonly status?: VmAgentTaskStatus | undefined;
  readonly schedule: VmAgentTaskSchedule | null;
  readonly notificationPolicy?: VmAgentTaskNotificationPolicy | undefined;
  readonly createdBy: "user" | "agent";
  /** Agents can activate a one-off task, but recurring work always requires approval. */
  readonly activate?: boolean | undefined;
}

export interface UpdateWorkspaceTaskInput {
  readonly vmAgentId: VmAgentId;
  readonly taskId: VmAgentTaskId;
  readonly title?: string | undefined;
  readonly prompt?: string | undefined;
  readonly completionCriteria?: ReadonlyArray<string> | undefined;
  readonly status?: VmAgentTaskStatus | undefined;
  readonly schedule?: VmAgentTaskSchedule | null | undefined;
  readonly approvalState?: VmAgentTask["approvalState"] | undefined;
  readonly notificationPolicy?: VmAgentTaskNotificationPolicy | undefined;
}

export interface VmAgentWorkspaceShape {
  readonly ensure: (vmAgentId: VmAgentId) => Effect.Effect<void, VmAgentWorkspaceError>;
  readonly snapshot: (
    vmAgentId: VmAgentId,
  ) => Effect.Effect<VmAgentWorkspaceSnapshot, VmAgentWorkspaceError>;
  readonly subscribe: (
    vmAgentId: VmAgentId,
    listener: WorkspaceListener,
  ) => Effect.Effect<() => void, VmAgentWorkspaceError>;
  readonly subscribeAttention: (
    listener: AttentionListener,
  ) => Effect.Effect<() => void, VmAgentWorkspaceError>;
  readonly createTask: (
    input: CreateWorkspaceTaskInput,
  ) => Effect.Effect<VmAgentTask, VmAgentWorkspaceError>;
  readonly updateTask: (
    input: UpdateWorkspaceTaskInput,
  ) => Effect.Effect<VmAgentTask, VmAgentWorkspaceError>;
  readonly deleteTask: (
    vmAgentId: VmAgentId,
    taskId: VmAgentTaskId,
  ) => Effect.Effect<void, VmAgentWorkspaceError>;
  readonly runTaskNow: (
    vmAgentId: VmAgentId,
    taskId: VmAgentTaskId,
  ) => Effect.Effect<VmAgentTask, VmAgentWorkspaceError>;
  readonly notify: (input: {
    readonly vmAgentId: VmAgentId;
    readonly notificationId?: VmAgentNotificationId;
    readonly taskId?: VmAgentTaskId | null;
    readonly runId?: VmAgentNotification["runId"];
    readonly kind: VmAgentNotificationKind;
    readonly title: string;
    readonly body: string;
    readonly dedupeKey?: string;
  }) => Effect.Effect<boolean, VmAgentWorkspaceError>;
  readonly markNotificationRead: (
    vmAgentId: VmAgentId,
    notificationId: VmAgentNotificationId,
  ) => Effect.Effect<void, VmAgentWorkspaceError>;
  readonly updateNotification: (input: {
    readonly vmAgentId: VmAgentId;
    readonly notificationId: VmAgentNotificationId;
    readonly read?: boolean | undefined;
    readonly archived?: boolean | undefined;
  }) => Effect.Effect<void, VmAgentWorkspaceError>;
  readonly updateNotificationPreferences: (
    input: Omit<VmAgentNotificationPreferences, "updatedAt">,
  ) => Effect.Effect<VmAgentNotificationPreferences, VmAgentWorkspaceError>;
  readonly upsertArtifact: (input: {
    readonly vmAgentId: VmAgentId;
    readonly title: string;
    readonly definition: VmAgentArtifactDefinition;
  }) => Effect.Effect<VmAgentArtifact, VmAgentWorkspaceError>;
  /**
   * Raise (or refresh, keyed on title) a standing "waiting on you" request —
   * work blocked on something only the user can do. Persists until resolved.
   */
  readonly raiseBlocker: (input: {
    readonly vmAgentId: VmAgentId;
    readonly title: string;
    readonly detail: string;
    readonly url?: string | null;
  }) => Effect.Effect<VmAgentBlocker, VmAgentWorkspaceError>;
  /** None when the blocker is unknown or already resolved. */
  readonly resolveBlocker: (input: {
    readonly vmAgentId: VmAgentId;
    readonly blockerId: VmAgentBlockerId;
    readonly resolvedBy: "user" | "agent" | "dismissed";
  }) => Effect.Effect<Option.Option<VmAgentBlocker>, VmAgentWorkspaceError>;
  /** Publish a fresh snapshot after scheduler-owned persistence changes. */
  readonly refresh: (vmAgentId: VmAgentId) => Effect.Effect<void>;
}

export class VmAgentWorkspace extends Context.Service<VmAgentWorkspace, VmAgentWorkspaceShape>()(
  "t3/vm/VmAgentWorkspace",
) {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const operationError = (operation: string) => (error: unknown) =>
  new VmAgentWorkspaceOperationError({
    operation,
    detail: error instanceof Error ? error.message : String(error),
  });

const nextRunAt = (
  status: VmAgentTaskStatus,
  approvalState: "pending" | "approved" | "rejected",
  schedule: VmAgentTaskSchedule | null,
  now: string,
): string | null => {
  if (status !== "active" || approvalState !== "approved" || schedule === null) return null;
  if (schedule.kind === "once") {
    // Normalize to UTC ISO: the due check is a lexicographic SQL comparison
    // against a Z-suffixed now, so an offset form like "12:00:00-04:00"
    // compares by its LOCAL digits and fires hours off (a real agent-written
    // noon-ET task fired at 08:00 ET this way). An unparseable value schedules
    // nothing rather than something wrong.
    try {
      return DateTime.formatIso(DateTime.makeUnsafe(schedule.runAt));
    } catch {
      return null;
    }
  }
  return DateTime.formatIso(
    DateTime.add(DateTime.makeUnsafe(now), { minutes: schedule.everyMinutes }),
  );
};

export const make = Effect.gen(function* () {
  const agents = yield* VmAgentStore;
  const store = yield* VmAgentWorkspaceStore;
  const listeners = new Map<string, Set<WorkspaceListener>>();
  const attentionListeners = new Set<AttentionListener>();

  const requireAgent = Effect.fn("VmAgentWorkspace.requireAgent")(function* (vmAgentId: VmAgentId) {
    const agent = yield* agents
      .getById(vmAgentId)
      .pipe(Effect.mapError(operationError("resolving agent")));
    if (Option.isNone(agent)) {
      return yield* new VmAgentWorkspaceOperationError({
        operation: "resolving agent",
        detail: `Unknown agent: ${vmAgentId}`,
      });
    }
    return agent.value;
  });

  const ensure: VmAgentWorkspaceShape["ensure"] = Effect.fn("VmAgentWorkspace.ensure")(
    function* (vmAgentId) {
      yield* requireAgent(vmAgentId);
      const now = yield* nowIso;
      yield* store
        .ensureDefaults({
          vmAgentId,
          artifactId: VmAgentArtifactId.make(`schedule:${vmAgentId}`),
          now,
        })
        .pipe(Effect.mapError(operationError("initializing agent workspace")));
    },
  );

  const snapshot: VmAgentWorkspaceShape["snapshot"] = Effect.fn("VmAgentWorkspace.snapshot")(
    function* (vmAgentId) {
      yield* ensure(vmAgentId);
      // Expiry is age-based, so unlike run-count pruning it cannot ride on run
      // completion alone: an idle agent's archive must still drain. Reading the
      // workspace is the only moment the archive is observable, so the sweep
      // rides on it, the same way ensure() does.
      const cutoff = DateTime.formatIso(
        DateTime.subtract(yield* DateTime.now, {
          hours: ARCHIVED_NOTIFICATION_RETENTION_HOURS,
        }),
      );
      yield* store
        .purgeExpiredArchivedNotifications({ vmAgentId, cutoff })
        .pipe(Effect.mapError(operationError("expiring archived notifications")));
      return yield* store
        .snapshot(vmAgentId)
        .pipe(Effect.mapError(operationError("reading agent workspace")));
    },
  );

  const publish = Effect.fn("VmAgentWorkspace.publish")(function* (vmAgentId: VmAgentId) {
    const agentListeners = listeners.get(vmAgentId);
    if (!agentListeners || agentListeners.size === 0) return;
    const next = yield* snapshot(vmAgentId).pipe(Effect.orElseSucceed(() => null));
    if (next === null) return;
    for (const listener of agentListeners) {
      yield* listener(next).pipe(Effect.ignoreCause({ log: true }));
    }
  });

  const publishAttention = Effect.fn("VmAgentWorkspace.publishAttention")(function* () {
    if (attentionListeners.size === 0) return;
    const next = yield* store.attentionSnapshot().pipe(Effect.orElseSucceed(() => null));
    if (next === null) return;
    for (const listener of attentionListeners) {
      yield* listener(next).pipe(Effect.ignoreCause({ log: true }));
    }
  });

  const refresh: VmAgentWorkspaceShape["refresh"] = (vmAgentId) =>
    publish(vmAgentId).pipe(Effect.ignoreCause({ log: true }));

  const subscribe: VmAgentWorkspaceShape["subscribe"] = (vmAgentId, listener) => {
    let unsubscribe: (() => void) | null = null;
    return Effect.gen(function* () {
      yield* ensure(vmAgentId);
      let agentListeners = listeners.get(vmAgentId);
      if (!agentListeners) {
        agentListeners = new Set();
        listeners.set(vmAgentId, agentListeners);
      }
      agentListeners.add(listener);
      unsubscribe = () => {
        agentListeners?.delete(listener);
        if (agentListeners?.size === 0) listeners.delete(vmAgentId);
      };
      const initial = yield* snapshot(vmAgentId);
      yield* listener(initial);
      return unsubscribe as () => void;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => unsubscribe?.()).pipe(Effect.flatMap(() => Effect.failCause(cause))),
      ),
    );
  };

  const subscribeAttention: VmAgentWorkspaceShape["subscribeAttention"] = (listener) => {
    let subscribed = false;
    return Effect.gen(function* () {
      attentionListeners.add(listener);
      subscribed = true;
      yield* listener(
        yield* store
          .attentionSnapshot()
          .pipe(Effect.mapError(operationError("reading agent attention"))),
      );
      return () => {
        attentionListeners.delete(listener);
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          if (subscribed) attentionListeners.delete(listener);
        }).pipe(Effect.flatMap(() => Effect.failCause(cause))),
      ),
    );
  };

  const createTask: VmAgentWorkspaceShape["createTask"] = Effect.fn("VmAgentWorkspace.createTask")(
    function* (input) {
      yield* ensure(input.vmAgentId);
      const now = yield* nowIso;
      const artifact = (yield* store
        .snapshot(input.vmAgentId)
        .pipe(Effect.mapError(operationError("reading agent artifact")))).artifact;
      const agentMayActivate =
        input.createdBy === "agent" &&
        input.activate === true &&
        input.schedule?.kind !== "interval";
      const approvalState =
        input.createdBy === "user" || agentMayActivate
          ? ("approved" as const)
          : ("pending" as const);
      const status =
        input.createdBy === "agent" && !agentMayActivate
          ? ("draft" as const)
          : (input.status ?? "active");
      const task = yield* store
        .createTask({
          taskId: VmAgentTaskId.make(NodeCrypto.randomUUID()),
          vmAgentId: input.vmAgentId,
          title: input.title,
          prompt: input.prompt,
          completionCriteria: input.completionCriteria,
          status,
          schedule: input.schedule,
          nextRunAt: nextRunAt(status, approvalState, input.schedule, now),
          createdBy: input.createdBy,
          approvalState,
          notificationPolicy: input.notificationPolicy ?? "always",
          artifactId: artifact?.artifactId ?? null,
          createdAt: now,
        })
        .pipe(Effect.mapError(operationError("creating agent task")));
      yield* publish(input.vmAgentId);
      return task;
    },
  );

  const requireTask = Effect.fn("VmAgentWorkspace.requireTask")(function* (
    vmAgentId: VmAgentId,
    taskId: VmAgentTaskId,
  ) {
    const task = yield* store
      .getTask(vmAgentId, taskId)
      .pipe(Effect.mapError(operationError("reading agent task")));
    if (Option.isNone(task)) return yield* new VmAgentTaskNotFoundError({ taskId });
    return task.value;
  });

  const updateTask: VmAgentWorkspaceShape["updateTask"] = Effect.fn("VmAgentWorkspace.updateTask")(
    function* (input) {
      const current = yield* requireTask(input.vmAgentId, input.taskId);
      const now = yield* nowIso;
      const status = input.status ?? current.status;
      const schedule = input.schedule === undefined ? current.schedule : input.schedule;
      const approvalState = input.approvalState ?? current.approvalState;
      const updated = yield* store
        .updateTask({
          taskId: current.taskId,
          vmAgentId: current.vmAgentId,
          title: input.title ?? current.title,
          prompt: input.prompt ?? current.prompt,
          completionCriteria: input.completionCriteria ?? current.completionCriteria,
          status,
          schedule,
          nextRunAt: nextRunAt(status, approvalState, schedule, now),
          approvalState,
          notificationPolicy: input.notificationPolicy ?? current.notificationPolicy,
          updatedAt: now,
        })
        .pipe(Effect.mapError(operationError("updating agent task")));
      yield* publish(input.vmAgentId);
      return updated;
    },
  );

  const deleteTask: VmAgentWorkspaceShape["deleteTask"] = Effect.fn("VmAgentWorkspace.deleteTask")(
    function* (vmAgentId, taskId) {
      yield* requireTask(vmAgentId, taskId);
      yield* store
        .deleteTask(vmAgentId, taskId)
        .pipe(Effect.mapError(operationError("deleting agent task")));
      yield* publish(vmAgentId);
    },
  );

  const runTaskNow: VmAgentWorkspaceShape["runTaskNow"] = Effect.fn("VmAgentWorkspace.runTaskNow")(
    function* (vmAgentId, taskId) {
      const current = yield* requireTask(vmAgentId, taskId);
      if (current.approvalState !== "approved") {
        return yield* new VmAgentTaskApprovalRequiredError({ taskId });
      }
      const now = yield* nowIso;
      const updated = yield* store
        .runTaskNow({ vmAgentId, taskId, now })
        .pipe(Effect.mapError(operationError("queueing agent task")));
      yield* publish(vmAgentId);
      return updated;
    },
  );

  const notify: VmAgentWorkspaceShape["notify"] = Effect.fn("VmAgentWorkspace.notify")(
    function* (input) {
      yield* ensure(input.vmAgentId);
      const now = yield* nowIso;
      const current = yield* store
        .snapshot(input.vmAgentId)
        .pipe(Effect.mapError(operationError("checking notification preferences")));
      const preferences = current.notificationPreferences;
      const permitted =
        preferences.enabled &&
        (input.kind === "agent-message"
          ? preferences.agentMessages
          : input.kind === "task-completed"
            ? preferences.taskCompletions
            : preferences.taskFailures);
      if (!permitted) return false;
      if (input.kind === "agent-message") {
        const oneHourAgo = DateTime.toEpochMillis(DateTime.makeUnsafe(now)) - 60 * 60 * 1_000;
        const recentAgentMessages = current.notifications.filter(
          (notification) =>
            notification.kind === "agent-message" &&
            DateTime.toEpochMillis(DateTime.makeUnsafe(notification.createdAt)) >= oneHourAgo,
        ).length;
        if (recentAgentMessages >= 10) {
          return yield* new VmAgentWorkspaceOperationError({
            operation: "creating agent notification",
            detail: "Notification rate limit reached (10 agent messages per hour).",
          });
        }
      }
      const notificationId =
        input.notificationId ?? VmAgentNotificationId.make(NodeCrypto.randomUUID());
      yield* store
        .createNotification({
          notificationId,
          vmAgentId: input.vmAgentId,
          taskId: input.taskId ?? null,
          runId: input.runId ?? null,
          kind: input.kind,
          title: input.title,
          body: input.body,
          deepLink: `/agents/${input.vmAgentId}`,
          dedupeKey: input.dedupeKey ?? `agent-message:${notificationId}`,
          createdAt: now,
        })
        .pipe(Effect.mapError(operationError("creating agent notification")));
      yield* publish(input.vmAgentId);
      yield* publishAttention();
      return true;
    },
  );

  const markNotificationRead: VmAgentWorkspaceShape["markNotificationRead"] = Effect.fn(
    "VmAgentWorkspace.markNotificationRead",
  )(function* (vmAgentId, notificationId) {
    yield* ensure(vmAgentId);
    yield* store
      .markNotificationRead({ vmAgentId, notificationId, readAt: yield* nowIso })
      .pipe(Effect.mapError(operationError("marking agent notification read")));
    yield* publish(vmAgentId);
    yield* publishAttention();
  });

  const updateNotification: VmAgentWorkspaceShape["updateNotification"] = Effect.fn(
    "VmAgentWorkspace.updateNotification",
  )(function* (input) {
    yield* ensure(input.vmAgentId);
    const now = yield* nowIso;
    yield* store
      .updateNotification({
        vmAgentId: input.vmAgentId,
        notificationId: input.notificationId,
        ...(input.read === undefined ? {} : { readAt: input.read ? now : null }),
        ...(input.archived === undefined ? {} : { archivedAt: input.archived ? now : null }),
      })
      .pipe(Effect.mapError(operationError("updating agent notification")));
    yield* publish(input.vmAgentId);
    yield* publishAttention();
  });

  const updateNotificationPreferences: VmAgentWorkspaceShape["updateNotificationPreferences"] =
    Effect.fn("VmAgentWorkspace.updateNotificationPreferences")(function* (input) {
      yield* ensure(input.vmAgentId);
      const preferences = yield* store
        .updateNotificationPreferences({ ...input, updatedAt: yield* nowIso })
        .pipe(Effect.mapError(operationError("updating agent notification preferences")));
      yield* publish(input.vmAgentId);
      return preferences;
    });

  const upsertArtifact: VmAgentWorkspaceShape["upsertArtifact"] = Effect.fn(
    "VmAgentWorkspace.upsertArtifact",
  )(function* (input) {
    yield* ensure(input.vmAgentId);
    const artifact = yield* store
      .upsertArtifact({
        artifactId: VmAgentArtifactId.make(NodeCrypto.randomUUID()),
        vmAgentId: input.vmAgentId,
        title: input.title,
        definition: input.definition,
        updatedAt: yield* nowIso,
      })
      .pipe(Effect.mapError(operationError("updating agent artifact")));
    yield* publish(input.vmAgentId);
    return artifact;
  });

  const raiseBlocker: VmAgentWorkspaceShape["raiseBlocker"] = Effect.fn(
    "VmAgentWorkspace.raiseBlocker",
  )(function* (input) {
    yield* ensure(input.vmAgentId);
    const now = yield* nowIso;
    const blocker = yield* store
      .raiseBlocker({
        blockerId: VmAgentBlockerId.make(NodeCrypto.randomUUID()),
        vmAgentId: input.vmAgentId,
        title: input.title,
        detail: input.detail,
        url: input.url ?? null,
        now,
      })
      .pipe(Effect.mapError(operationError("raising a blocker")));
    // A blocker is a standing request for the user, so it also knocks: reuses
    // the task-blocked notification kind (preference-gated like every other),
    // deduped on the blocker id so re-reports refresh silently.
    yield* notify({
      vmAgentId: input.vmAgentId,
      kind: "task-blocked",
      title: `Waiting on you: ${input.title}`,
      body: input.detail,
      dedupeKey: `blocker:${blocker.blockerId}`,
    }).pipe(Effect.orElseSucceed(() => false));
    yield* publish(input.vmAgentId);
    yield* publishAttention();
    return blocker;
  });

  const resolveBlocker: VmAgentWorkspaceShape["resolveBlocker"] = Effect.fn(
    "VmAgentWorkspace.resolveBlocker",
  )(function* (input) {
    yield* ensure(input.vmAgentId);
    const resolved = yield* store
      .resolveBlocker({
        vmAgentId: input.vmAgentId,
        blockerId: input.blockerId,
        resolvedBy: input.resolvedBy,
        now: yield* nowIso,
      })
      .pipe(Effect.mapError(operationError("resolving a blocker")));
    // The alert that announced this request has served its purpose the moment
    // the request stops standing. Leaving it unread left the agent showing a
    // notification badge for something the user had just dealt with, and the
    // only way to clear it was to open and read a message about work already
    // done. Keyed on the dedupe key `raiseBlocker` writes, so it clears the
    // re-reported copies too. Best-effort: the blocker is genuinely resolved
    // whether or not its alert could be tidied up.
    if (Option.isSome(resolved)) {
      yield* store
        .markNotificationsReadByDedupeKey({
          vmAgentId: input.vmAgentId,
          dedupeKey: `blocker:${input.blockerId}`,
          readAt: yield* nowIso,
        })
        .pipe(Effect.ignoreCause({ log: true }));
    }
    yield* publish(input.vmAgentId);
    yield* publishAttention();
    return resolved;
  });

  return {
    ensure,
    snapshot,
    subscribe,
    subscribeAttention,
    createTask,
    updateTask,
    deleteTask,
    runTaskNow,
    notify,
    markNotificationRead,
    updateNotification,
    updateNotificationPreferences,
    upsertArtifact,
    raiseBlocker,
    resolveBlocker,
    refresh,
  } satisfies VmAgentWorkspaceShape;
});

export const VmAgentWorkspaceLive = Layer.effect(VmAgentWorkspace, make);
