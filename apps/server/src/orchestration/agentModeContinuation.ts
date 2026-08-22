import {
  CommandId,
  MessageId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  isProviderAuthenticationFailure,
  shouldAgentContinueAfterReply,
} from "@t3tools/shared/agentMode";
import { SETTINGS_UPDATE_MESSAGE_PREFIX } from "@t3tools/shared/settingsPrompt";
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

/**
 * A backgrounded task keeps running after the turn that launched it ends —
 * that is the whole point of backgrounding one. The agent therefore signs off
 * *in order to wait*, and its reply carries no AGENT_STOP, so the continuation
 * gate above reads "keep going" and dispatches a resume immediately. The agent
 * wakes with the task still mid-flight, finds nothing to act on, and burns a
 * continuation on a wait it was already doing correctly.
 *
 * The harness already re-invokes the agent when a tracked task exits, so the
 * fix is to let *that* be the wake signal and have the continuation defer while
 * any task is still outstanding. It must only defer, never cancel: a provider
 * that drops a terminal `task.completed` would otherwise strand the thread
 * forever, so the caller pairs this with a bounded grace window.
 */
const PLAN_TASK_TYPE = "plan";

interface TaskActivityPayload {
  readonly taskId?: unknown;
  readonly taskType?: unknown;
}

function taskActivityFields(activity: Pick<OrchestrationThreadActivity, "payload">): {
  readonly taskId: string;
  readonly taskType: string | null;
} | null {
  const payload = activity.payload as TaskActivityPayload | undefined;
  const taskId = typeof payload?.taskId === "string" ? payload.taskId : null;
  if (taskId === null || taskId.length === 0) return null;
  return {
    taskId,
    taskType: typeof payload?.taskType === "string" ? payload.taskType : null,
  };
}

export interface OutstandingBackgroundTask {
  readonly taskId: string;
  /** When the task was announced, used to bound how long the gate may wait. */
  readonly startedAt: string;
  /** Newest `task.started`/`task.progress` timestamp seen for this task. */
  readonly lastActivityAt: string;
}

/**
 * Folds the append-only `task.*` stream into the set of tasks that were started
 * and never reported terminal. Plan tasks are excluded: they are a UI-side plan
 * refresh that runs outside the turn stream and nothing waits on them.
 */
export function outstandingBackgroundTasks(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OutstandingBackgroundTask> {
  const running = new Map<string, OutstandingBackgroundTask>();
  for (const activity of activities) {
    const fields = taskActivityFields(activity);
    if (fields === null) continue;
    switch (activity.kind) {
      case "task.started": {
        if (fields.taskType === PLAN_TASK_TYPE) break;
        running.set(fields.taskId, {
          taskId: fields.taskId,
          startedAt: activity.createdAt,
          lastActivityAt: activity.createdAt,
        });
        break;
      }
      case "task.progress": {
        const existing = running.get(fields.taskId);
        if (existing !== undefined) {
          running.set(fields.taskId, { ...existing, lastActivityAt: activity.createdAt });
        }
        break;
      }
      case "task.completed": {
        running.delete(fields.taskId);
        break;
      }
      default:
        break;
    }
  }
  return [...running.values()];
}

/**
 * How long the continuation may defer to an outstanding task before giving up
 * and resuming anyway. Long enough for a real build, test run, or sub-agent;
 * short enough that a provider which never emits `task.completed` costs one
 * delay rather than a dead thread. Measured from the task's newest activity, so
 * a task that keeps reporting progress keeps extending the window.
 */
export const BACKGROUND_TASK_CONTINUATION_GRACE_MS = 15 * 60_000;

/**
 * Whether an agent continuation should wait rather than dispatch, because the
 * turn ended with work still running that the agent is expecting a result from.
 * Returns null when there is nothing to wait for or the grace window has
 * expired — in both cases the continuation proceeds exactly as it does today.
 */
export function agentContinuationShouldAwaitBackgroundTask(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly nowEpochMs: number;
  readonly graceMs?: number;
  /**
   * When this server process started. Tasks announced before it belong to a
   * dead process and are skipped outright.
   *
   * Waiting is only justified because the harness re-invokes the agent when a
   * task it owns exits. A task from a previous process has no live owner, so
   * that wake signal can never fire for it: the only thing that ends the wait
   * is the orphan sweep writing a late `task.completed` ("Task stopped"), which
   * is lazy — observed 2026-08-07 landing 4h47m after the restart that stranded
   * it. Without this bound a restart costs every affected thread the full grace
   * window of "Agent auto-resuming" before it moves.
   */
  readonly processStartedAtEpochMs?: number;
}): OutstandingBackgroundTask | null {
  const graceMs = input.graceMs ?? BACKGROUND_TASK_CONTINUATION_GRACE_MS;
  let newest: { readonly task: OutstandingBackgroundTask; readonly at: number } | null = null;
  for (const task of outstandingBackgroundTasks(input.activities)) {
    const at = Date.parse(task.lastActivityAt);
    // An unparseable timestamp cannot be aged out, so it must not gate the
    // continuation: treating it as fresh would wait forever.
    if (!Number.isFinite(at)) continue;
    if (input.nowEpochMs - at >= graceMs) continue;
    if (input.processStartedAtEpochMs !== undefined) {
      const startedAt = Date.parse(task.startedAt);
      // An unparseable start cannot be proven to predate this process, so it
      // keeps the grace window rather than being discarded as orphaned.
      if (Number.isFinite(startedAt) && startedAt < input.processStartedAtEpochMs) continue;
    }
    if (newest === null || at > newest.at) newest = { task, at };
  }
  return newest?.task ?? null;
}

/**
 * A turn that carries one of these did something the thread can be resumed
 * *from*. Everything else a turn emits — usage counters, context-window
 * updates, checkpoints, the control activities below — is bookkeeping.
 */
const WORK_ACTIVITY_KIND_PREFIXES = ["tool.", "task."] as const;

const CONTROL_ACTIVITY_KINDS = new Set(["provider.handoff.completed", "thread.settings.applied"]);

/**
 * Was applying a control change the *whole* turn?
 *
 * Switching provider or model while a thread is idle produces a turn whose
 * only content is the agent acknowledging the change. Continuing from that
 * would have the agent invent work off a bookkeeping reply, so the loop skips
 * it. The control activity alone cannot decide that, though:
 *
 *   - `provider.handoff.completed` is stamped with the id of the turn the
 *     handoff *starts*, and that turn normally carries the user's own prompt
 *     (the handoff's `immediateRequirement`);
 *   - a "Settings updated: …" message explicitly asks the agent to *continue
 *     the current task*, and the turns after it inherit that user message
 *     until the user types something new.
 *
 * Keying on the control marker alone therefore retired the agent loop after
 * every provider switch and every settings change. Observed 2026-08-15 on
 * thread dba3af80: a nine-minute turn with 146 tool activities had its
 * continuation cancelled 117ms after it settled, and the thread sat idle.
 * Across that ledger the two populations separate cleanly — 94 turns that ran
 * work carried 8 or more tool/task activities, and all 22 genuine
 * control-only turns carried none — so the presence of work is the signal.
 */
export function isControlOnlyAgentTurn(input: {
  readonly activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "turnId">>;
  readonly sourceTurnId: string;
  readonly sourceUserMessageText?: string | undefined;
}): boolean {
  let carriesControlMarker =
    input.sourceUserMessageText?.startsWith(SETTINGS_UPDATE_MESSAGE_PREFIX) === true;
  for (const activity of input.activities) {
    if (activity.turnId !== input.sourceTurnId) continue;
    // Any real work rules the turn out immediately, whatever else it carries.
    if (WORK_ACTIVITY_KIND_PREFIXES.some((prefix) => activity.kind.startsWith(prefix))) {
      return false;
    }
    if (CONTROL_ACTIVITY_KINDS.has(activity.kind)) carriesControlMarker = true;
  }
  return carriesControlMarker;
}

/**
 * How stale interrupted work may be and still be picked up at boot.
 *
 * A restart should recover the session the user was in the middle of, not
 * resurrect every thread that ever ended holding a task. Six hours covers an
 * overnight-adjacent working session and a long test run, while a thread left
 * this way for days stays put until the user says something.
 */
export const KILLED_BACKGROUND_TASK_RESUME_MAX_AGE_MS = 6 * 60 * 60_000;

/**
 * Did this thread's last turn end waiting on a background task that can no
 * longer report back?
 *
 * A turn that ends with a task still running is the agent deliberately signing
 * off *to wait* — the harness re-invokes it when the task exits, which is why
 * the continuation gate defers instead of dispatching. That contract has one
 * owner: the process running the task. Kill it and the wake can never fire, so
 * the thread sits at a reply like "I'll report back when they land" forever,
 * through every subsequent restart. Reported 2026-08-12 on a thread waiting for
 * Unity test runs; the boot scan never saw it, because that scan only looks at
 * agent-mode threads whose turn ended `incomplete`, and this one is an ordinary
 * completed turn.
 *
 * Two shapes count, matching the two ways a process goes away:
 *   - a task with no terminal record at all (the process was killed outright);
 *   - a task whose terminal record is non-`completed` and landed at or after
 *     the turn settled (a graceful shutdown, where the provider reports its
 *     tasks stopped on the way out).
 * A task that genuinely finished, or that was already terminal before the turn
 * ended, is not something the thread is waiting on.
 */
export function threadLostBackgroundTaskAtRestart(input: {
  // Structural on purpose: the boot scan reads projection rows, which carry the
  // same three fields under a different row type than the domain activity.
  readonly activities: ReadonlyArray<
    Pick<OrchestrationThreadActivity, "kind" | "payload"> & {
      readonly createdAt: string;
    }
  >;
  readonly turnCompletedAt: string;
  readonly bootedAtEpochMs: number;
  readonly maxAgeMs?: number;
}): boolean {
  const completedAtMs = Date.parse(input.turnCompletedAt);
  if (!Number.isFinite(completedAtMs)) return false;
  const maxAgeMs = input.maxAgeMs ?? KILLED_BACKGROUND_TASK_RESUME_MAX_AGE_MS;
  if (input.bootedAtEpochMs - completedAtMs > maxAgeMs) return false;

  // Terminal record per task, in activity order; the last one wins so a
  // provider that reports twice (a stop at shutdown, then a late sweep) is
  // folded rather than double-counted.
  const startedAt = new Map<string, number>();
  const terminal = new Map<string, { readonly at: number; readonly status: string | null }>();
  for (const activity of input.activities) {
    const fields = taskActivityFields(activity);
    if (fields === null || fields.taskType === PLAN_TASK_TYPE) continue;
    const at = Date.parse(activity.createdAt);
    if (!Number.isFinite(at)) continue;
    if (activity.kind === "task.started") {
      if (!startedAt.has(fields.taskId)) startedAt.set(fields.taskId, at);
      terminal.delete(fields.taskId);
      continue;
    }
    if (activity.kind === "task.completed") {
      const payload = activity.payload as { readonly status?: unknown } | undefined;
      terminal.set(fields.taskId, {
        at,
        status: typeof payload?.status === "string" ? payload.status : null,
      });
    }
  }

  for (const [taskId, taskStartedAt] of startedAt) {
    // Only tasks the turn was actually waiting on: one announced after the
    // turn settled belongs to whatever came next, not to this reply.
    if (taskStartedAt > completedAtMs) continue;
    const end = terminal.get(taskId);
    if (end === undefined) return true;
    if (end.status !== "completed" && end.at >= completedAtMs) return true;
  }
  return false;
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

/**
 * Cancellation reason for a startup resume whose thread already signed off
 * with AGENT_STOP. The boot re-arm sweep matches on this exact string to keep
 * such obligations retired across restarts — a signed-off thread must never
 * self-dispatch a RESUME_PROMPT (observed 2026-08-05: an unattended thread
 * resumed itself after an explicit AGENT_STOP with no user input).
 */
export const STARTUP_RESUME_SIGNED_OFF_REASON = "agent signed off with AGENT_STOP";

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
