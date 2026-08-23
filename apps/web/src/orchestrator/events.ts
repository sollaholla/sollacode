import { isOrchestratorThreadId, type OrchestratorSpokenEvents } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

/**
 * Orchestrator event detection.
 *
 * The app renders thread status but never emits "this finished" — every surface
 * reads the current shell row and draws it. Proactive speech needs the opposite:
 * the *transition*. This module folds shell rows into a minimal snapshot and
 * diffs consecutive snapshots into the handful of transitions worth interrupting
 * the user for.
 *
 * Kept pure (no React, no atoms, no clock) so the interesting cases — a thread
 * merely re-rendering, a thread appearing for the first time, a thread that was
 * already blocked staying blocked — are cheap to pin down in tests.
 */

export type OrchestratorEventKind =
  | "thread-finished"
  | "task-completed"
  | "approval-needed"
  | "input-needed"
  | "thread-failed"
  | "auto-resume-stuck";

export type ThreadWaitingOn = "approval" | "user-input" | "proposed-plan" | "nothing";

export interface ThreadSnapshot {
  readonly threadKey: string;
  readonly threadId: string;
  readonly environmentId: string;
  readonly title: string;
  readonly isWorking: boolean;
  readonly waitingOn: ThreadWaitingOn;
  readonly hasError: boolean;
  /**
   * The provider's own words for why the thread failed, verbatim.
   *
   * Without it a failure could only ever be reported as "it failed", which is
   * the one thing the user already knows. Null when nothing failed, or when the
   * failure carried no message.
   */
  readonly lastError: string | null;
  /**
   * Coarse classification behind {@link lastError} — an auth failure and a
   * usage limit need different answers, and the message alone does not always
   * make which one obvious. Open string: a newer server may classify failures
   * this client has never heard of.
   */
  readonly failureKind: string | null;
  /**
   * When the provider last wrote to the failed session — in practice, when the
   * failure was recorded. Lets "that one has been broken since this morning" be
   * answered without reading the thread, which is the only thing that could
   * distinguish a fresh break from one already reported on.
   */
  readonly errorAt: string | null;
  /**
   * Whether the user has marked this thread finished.
   *
   * Read from the shell rather than inferred: the orchestrator could settle a
   * thread and then not see the flag it had just set, and a settled thread with
   * a stale provider error still reported "error" — which is what the sidebar
   * and the spoken status disagreed about.
   */
  readonly settled: boolean;
  /** True when the host is unreachable, so its state is stale rather than settled. */
  readonly environmentUnreachable: boolean;
  /** Model the thread runs on, so the orchestrator can answer "which model?". */
  readonly model: string;
  /** Provider instance behind that model, e.g. "codex" or "claudeAgent". */
  readonly provider: string;
  /** Access permissions: approval-required | auto-accept-edits | auto | full-access. */
  readonly accessMode: string;
  /** default | plan | agent. */
  readonly interactionMode: string;
  /** Thinking effort, or "default" when the provider was left on its own. */
  readonly effort: string;
  /** Project the thread belongs to. Empty when the project is not loaded yet. */
  /**
   * Whether this thread is a side chat rather than a thread of its own.
   *
   * Carried because the orchestrator is otherwise blind to it: side chats are
   * deliberately kept out of the sidebar, so they reach the user only as a tab
   * beside another conversation, and answering "what is that thread doing"
   * without saying it is a side chat describes something the user cannot find
   * where they would look for it.
   */
  readonly isSideChat: boolean;
  /** The conversation this side chat was forked from; null for a normal thread. */
  readonly sideChatParentThreadId: string | null;
  /**
   * Name of the named background agent whose chat this thread is — "Scout",
   * "Pawstalgia" — or null for an ordinary conversation. Interaction mode
   * cannot answer this: a background agent's chat often runs in default mode
   * while a throwaway chat runs in agent mode, and the orchestrator kept
   * describing the user's actual agents as plain threads.
   */
  readonly backgroundAgentName: string | null;
  readonly projectId: string;
  /**
   * Project title. Titles alone are not enough to route by — several threads
   * routinely share one project (three "Vera Medical" threads), and just as
   * often the user names the project instead of the thread.
   */
  readonly projectName: string;
  /** Basename of the project's workspace root, e.g. "t3-fork". */
  readonly workspaceName: string;
  /** Raw latest-turn state, so a finish can be told apart from a giving-up. */
  readonly latestTurnState: string | undefined;
}

/**
 * Providers disagree on the option id: Claude calls it `effort`, Codex
 * `reasoningEffort`. Both are read, matching how the composer and the server
 * reactor resolve it.
 */
export function readEffort(
  options: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined,
): string {
  const match = options?.find(
    (option) => option.id === "effort" || option.id === "reasoningEffort",
  );
  return match === undefined ? "default" : String(match.value);
}

export interface OrchestratorEvent {
  readonly kind: OrchestratorEventKind;
  readonly threadKey: string;
  readonly threadId: string;
  readonly environmentId: string;
  readonly title: string;
  readonly projectName: string;
  /**
   * How the work actually ended. "finished" used to cover all three, so an
   * interrupted turn and a turn that ran out of context were both announced as
   * plain success.
   */
  readonly outcome: TurnOutcome;
}

export type TurnOutcome = "completed" | "partial" | "failed" | "unknown";

/**
 * `OrchestrationLatestTurnState` is completed | error | incomplete |
 * interrupted | running. Only the first is an unqualified success.
 */
function outcomeForTurnState(state: string | undefined): TurnOutcome {
  switch (state) {
    case "completed":
      return "completed";
    case "incomplete":
    case "interrupted":
      return "partial";
    case "error":
      return "failed";
    default:
      return "unknown";
  }
}

export type OrchestratorWorld = ReadonlyMap<string, ThreadSnapshot>;

// `OrchestrationLatestTurnState` is completed | error | incomplete | interrupted
// | running. Only `running` means work is actually in flight.
const WORKING_TURN_STATES = new Set(["running"]);
const ERROR_TURN_STATES = new Set(["error"]);
// A thread only *finished* if a turn actually settled. A freshly forked side
// chat projects `stopped → starting → ready → running` inside one second, and
// the turnless `ready` gap read as working→idle — announcing "finished" for a
// thread created moments ago (observed 2026-08-23: the voice orchestrator
// re-narrated one side-chat creation four times back to back).
const SETTLED_TURN_STATES = new Set(["completed", "incomplete", "interrupted", "error"]);

export function threadSnapshotKey(shell: {
  readonly environmentId: string;
  readonly id: string;
}): string {
  return `${shell.environmentId}:${shell.id}`;
}

/**
 * What a thread is blocked on, if anything.
 *
 * `isWorking` is a parameter because waiting and working are mutually
 * exclusive for one of these and not the others. An approval prompt or an input
 * request is raised *by* a turn that is still in flight — the turn stays
 * running while it waits — so those are real even while the thread is working.
 *
 * A proposed plan is not. Having a plan in history is not a wait. The record
 * stays on the thread after the user leaves Plan mode, after later turns, and
 * after they start building. waitingOn is "proposed-plan" only when the thread
 * is actually stopped for approval — the same gate as the sidebar's "Plan
 * Ready" row: plan mode, settled latest turn, unimplemented plan on that turn.
 */
function isStoppedForProposedPlan(shell: EnvironmentThreadShell, isWorking: boolean): boolean {
  if (isWorking) return false;
  if (shell.interactionMode !== "plan") return false;
  if (!shell.hasActionableProposedPlan) return false;
  const latestTurn = shell.latestTurn;
  if (!latestTurn?.startedAt || !latestTurn.completedAt) return false;
  if (shell.session?.status === "running") return false;
  return true;
}

function resolveWaitingOn(shell: EnvironmentThreadShell, isWorking: boolean): ThreadWaitingOn {
  if (shell.hasPendingApprovals) return "approval";
  if (shell.hasPendingUserInput) return "user-input";
  if (isStoppedForProposedPlan(shell, isWorking)) return "proposed-plan";
  return "nothing";
}

export interface ProjectLookupEntry {
  readonly title: string;
  readonly workspaceRoot: string;
}

/** Trailing path segment of a workspace root, however it is separated. */
export function workspaceBasename(workspaceRoot: string): string {
  const segments = workspaceRoot.split(/[/\\]+/).filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? "";
}

/**
 * Folds the live shell rows into the snapshot the diff operates on.
 *
 * Archived threads and the orchestrator itself are dropped: the orchestrator
 * announcing its own turns would talk over the user mid-sentence.
 */
export function buildWorld(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  unreachableEnvironmentIds: ReadonlySet<string> = new Set(),
  projects: ReadonlyMap<string, ProjectLookupEntry> = new Map(),
  /** Named background agents' chat threads, keyed `environmentId:threadId`. */
  backgroundAgentNames: ReadonlyMap<string, string> = new Map(),
): OrchestratorWorld {
  const world = new Map<string, ThreadSnapshot>();

  for (const shell of shells) {
    if (shell.archivedAt !== null) continue;
    if (isOrchestratorThreadId(shell.id)) continue;

    const turnState = shell.latestTurn?.state;
    const project = projects.get(`${shell.environmentId}:${shell.projectId}`);
    // Session first, turn only as a fallback — the same precedence as
    // `resolveSidebarV2Status`, and for the same reason it records: turns only
    // settle when their session leaves `running`, so a turn row can be left on
    // `running` long after all work stopped. Reading the turn alone had the
    // orchestrator describing an idle thread as still processing while the
    // sidebar, which got this fix first, showed it ready. The turn fallback
    // stays because the opposite lag is real too: a turn can start before the
    // session projection flips, and a session row can be absent entirely.
    const sessionStatus = shell.session?.status;
    const isWorking =
      sessionStatus === "running" || sessionStatus === "starting"
        ? true
        : sessionStatus === "stopped" ||
            sessionStatus === "interrupted" ||
            sessionStatus === "error"
          ? false
          : turnState !== undefined && WORKING_TURN_STATES.has(turnState);
    world.set(threadSnapshotKey(shell), {
      threadKey: threadSnapshotKey(shell),
      threadId: shell.id,
      environmentId: shell.environmentId,
      title: shell.title,
      isWorking,
      waitingOn: resolveWaitingOn(shell, isWorking),
      hasError:
        shell.session?.status === "error" ||
        (turnState !== undefined && ERROR_TURN_STATES.has(turnState)),
      // Carried whenever the provider recorded one, not only while the session
      // still reads as errored: a thread that failed and then went idle is
      // exactly the one the user asks about afterwards.
      lastError: shell.session?.lastError ?? null,
      failureKind: shell.session?.failureKind ?? null,
      // Only meaningful alongside an error; a session's updatedAt on a healthy
      // thread is just "when anything last happened" and would read as an age
      // for a failure that never occurred.
      errorAt: shell.session?.lastError ? (shell.session.updatedAt ?? null) : null,
      settled: shell.settledOverride === "settled",
      environmentUnreachable: unreachableEnvironmentIds.has(shell.environmentId),
      model: shell.modelSelection?.model ?? "unknown",
      provider: shell.modelSelection?.instanceId ?? "unknown",
      accessMode: shell.runtimeMode ?? "unknown",
      interactionMode: shell.interactionMode ?? "unknown",
      effort: readEffort(shell.modelSelection?.options),
      latestTurnState: turnState,
      isSideChat: shell.isSideChat === true,
      sideChatParentThreadId: shell.sideChatParentThreadId ?? null,
      backgroundAgentName: backgroundAgentNames.get(threadSnapshotKey(shell)) ?? null,
      projectId: shell.projectId,
      projectName: project?.title ?? "",
      workspaceName: project === undefined ? "" : workspaceBasename(project.workspaceRoot),
    });
  }

  return world;
}

const EVENT_SETTING_KEYS: Record<OrchestratorEventKind, keyof OrchestratorSpokenEvents> = {
  "thread-finished": "threadFinished",
  "task-completed": "taskCompleted",
  "approval-needed": "approvalNeeded",
  "input-needed": "inputNeeded",
  "thread-failed": "threadFailed",
  "auto-resume-stuck": "autoResumeStuck",
};

export function isEventEnabled(
  kind: OrchestratorEventKind,
  spokenEvents: OrchestratorSpokenEvents,
): boolean {
  return spokenEvents[EVENT_SETTING_KEYS[kind]] === true;
}

/**
 * Diffs two worlds into speech-worthy transitions.
 *
 * Threads absent from `previous` produce nothing. That is what makes the first
 * snapshot after launch silent instead of announcing every thread that happens
 * to be blocked — otherwise opening the app would trigger a monologue.
 */
export function diffWorlds(
  previous: OrchestratorWorld,
  next: OrchestratorWorld,
  spokenEvents: OrchestratorSpokenEvents,
): ReadonlyArray<OrchestratorEvent> {
  const events: Array<OrchestratorEvent> = [];

  for (const [key, current] of next) {
    const before = previous.get(key);
    if (before === undefined) continue;

    // A host going offline freezes its rows mid-flight. Treating that as
    // "finished" would announce completions that never happened.
    if (current.environmentUnreachable || before.environmentUnreachable) continue;

    const base = {
      threadKey: current.threadKey,
      threadId: current.threadId,
      environmentId: current.environmentId,
      title: current.title,
      projectName: current.projectName,
      outcome: outcomeForTurnState(current.latestTurnState),
    };

    if (!before.hasError && current.hasError) {
      events.push({ ...base, kind: "thread-failed", outcome: "failed" });
    } else if (
      before.isWorking &&
      !current.isWorking &&
      current.latestTurnState !== undefined &&
      SETTLED_TURN_STATES.has(current.latestTurnState)
    ) {
      events.push({ ...base, kind: "thread-finished" });
    }

    if (before.waitingOn !== "approval" && current.waitingOn === "approval") {
      events.push({ ...base, kind: "approval-needed" });
    }

    if (before.waitingOn !== "user-input" && current.waitingOn === "user-input") {
      events.push({ ...base, kind: "input-needed" });
    }
  }

  return events.filter((event) => isEventEnabled(event.kind, spokenEvents));
}

/**
 * How long a repeat of the same event on the same thread stays unspeakable.
 *
 * A provider at its usage cap fails a turn in seconds and the thread retries,
 * so the same finished/failed transition can recur several times a minute.
 * Announcing each one had the orchestrator saying the same sentence in
 * different words until the user could not get a word in. One announcement a
 * minute per thread and kind still reports every real state change — a genuine
 * re-run that finishes again later is past the window.
 */
export const EVENT_REANNOUNCE_WINDOW_MS = 60_000;

/**
 * Rate limit for spoken announcements, keyed on thread and event kind.
 *
 * Pure decision over a caller-owned map so the flap scenarios are testable:
 * call {@link shouldAnnounceEvent}, and on a true result the map has already
 * recorded the announcement time.
 */
export function shouldAnnounceEvent(
  announcedAt: Map<string, number>,
  event: Pick<OrchestratorEvent, "threadKey" | "kind">,
  now: number,
): boolean {
  const key = `${event.threadKey}:${event.kind}`;
  const last = announcedAt.get(key);
  if (last !== undefined && now - last < EVENT_REANNOUNCE_WINDOW_MS) return false;
  announcedAt.set(key, now);
  return true;
}
