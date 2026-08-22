/**
 * What the orchestrator is waiting for, and whether a result is worth reopening
 * the microphone for.
 *
 * The orchestrator routinely says "I'll let you know when that finishes". If the
 * silence timeout closed the session in the meantime, nothing was ever going to
 * keep that promise: completions are only spoken while a session is live, and
 * the world diff advances its baseline whether or not one is. The user is left
 * waiting on an answer that already arrived.
 *
 * Reopening a microphone on the app's own initiative is not a small thing, so
 * the rules here are deliberately narrow and all of them are checked:
 *
 *  - only work the orchestrator itself dispatched and said it would report on;
 *  - only when the *timeout* closed the session — a session the user stopped by
 *    hand stays stopped;
 *  - only within {@link AWAITED_WORK_TTL_MS} of the ask, because being told
 *    about a request from three hours ago is worse than not being told;
 *  - only a bounded number of times, so a thread that flaps between states
 *    cannot turn the microphone into a strobe.
 */

/** One outstanding "tell me when this is done". */
export interface AwaitedWork {
  readonly threadKey: string;
  readonly threadTitle: string;
  /** What the orchestrator was asked to get done, for the wake-up line. */
  readonly request: string;
  /** Epoch ms. Compared against the event, not against wall-clock "now". */
  readonly askedAt: number;
}

/**
 * How long a promise to report back stays live. Half an hour is long enough to
 * cover a slow build and short enough that the microphone opening is still
 * obviously connected to something the user asked for.
 */
export const AWAITED_WORK_TTL_MS = 30 * 60 * 1_000;

/**
 * Most outstanding items tracked at once. Dispatching more than this without
 * hearing anything back means the orchestrator is being used as a queue, and
 * the oldest entries are the least likely to still be wanted out loud.
 */
export const MAX_AWAITED_WORK = 12;

/**
 * Consecutive automatic wake-ups allowed without the user saying anything in
 * between. Reset by any real interaction; see {@link resetWakeBudget}.
 */
export const MAX_CONSECUTIVE_WAKES = 3;

/** Reasons a session ended, because only one of them may reopen the mic. */
export type SessionEndReason = "user" | "idle-timeout" | "error" | "never-started";

export interface AwaitedWorkState {
  readonly items: ReadonlyArray<AwaitedWork>;
  readonly consecutiveWakes: number;
  readonly endedBy: SessionEndReason;
}

export const initialAwaitedWorkState: AwaitedWorkState = {
  items: [],
  consecutiveWakes: 0,
  endedBy: "never-started",
};

/**
 * Records that the orchestrator dispatched work and owes the user an answer.
 *
 * Re-dispatching to the same thread replaces the entry rather than stacking:
 * the newest ask is the one the user is waiting on, and two wake-ups for one
 * thread is one too many.
 */
export function rememberAwaitedWork(state: AwaitedWorkState, work: AwaitedWork): AwaitedWorkState {
  const withoutThread = state.items.filter((item) => item.threadKey !== work.threadKey);
  return {
    ...state,
    items: [...withoutThread, work].slice(-MAX_AWAITED_WORK),
  };
}

export function forgetAwaitedWork(state: AwaitedWorkState, threadKey: string): AwaitedWorkState {
  return { ...state, items: state.items.filter((item) => item.threadKey !== threadKey) };
}

/** The user said something, so the app has not been talking to itself. */
export function resetWakeBudget(state: AwaitedWorkState): AwaitedWorkState {
  return { ...state, consecutiveWakes: 0 };
}

export function noteSessionEnded(
  state: AwaitedWorkState,
  reason: SessionEndReason,
): AwaitedWorkState {
  return { ...state, endedBy: reason };
}

export function findAwaitedWork(
  state: AwaitedWorkState,
  threadKey: string,
): AwaitedWork | undefined {
  return state.items.find((item) => item.threadKey === threadKey);
}

export type WakeDecision =
  | { readonly wake: true; readonly work: AwaitedWork; readonly reason: "awaited-work-finished" }
  | { readonly wake: false; readonly reason: WakeRefusal };

export type WakeRefusal =
  | "setting-disabled"
  | "orchestrator-disabled"
  | "session-live"
  | "not-closed-by-timeout"
  | "not-awaited"
  | "expired"
  | "wake-budget-spent";

/**
 * Whether a completed thread justifies reopening the microphone.
 *
 * Every refusal is named rather than folded into one boolean, so the reason a
 * wake-up did not happen is visible in the tool log instead of being guessed at.
 */
export function decideWake(input: {
  readonly state: AwaitedWorkState;
  readonly threadKey: string;
  readonly now: number;
  readonly settingEnabled: boolean;
  readonly orchestratorEnabled: boolean;
  readonly sessionLive: boolean;
}): WakeDecision {
  if (!input.settingEnabled) return { wake: false, reason: "setting-disabled" };
  if (!input.orchestratorEnabled) return { wake: false, reason: "orchestrator-disabled" };
  // A live session announces through its own path; waking is only for silence.
  if (input.sessionLive) return { wake: false, reason: "session-live" };
  if (input.state.endedBy !== "idle-timeout") {
    return { wake: false, reason: "not-closed-by-timeout" };
  }
  if (input.state.consecutiveWakes >= MAX_CONSECUTIVE_WAKES) {
    return { wake: false, reason: "wake-budget-spent" };
  }

  const work = findAwaitedWork(input.state, input.threadKey);
  if (work === undefined) return { wake: false, reason: "not-awaited" };
  if (input.now - work.askedAt > AWAITED_WORK_TTL_MS) return { wake: false, reason: "expired" };

  return { wake: true, work, reason: "awaited-work-finished" };
}

/** Bookkeeping after a wake actually happens. */
export function noteWoke(state: AwaitedWorkState, threadKey: string): AwaitedWorkState {
  return {
    ...forgetAwaitedWork(state, threadKey),
    consecutiveWakes: state.consecutiveWakes + 1,
    endedBy: "never-started",
  };
}

/**
 * The opening line of a woken session.
 *
 * It has to close the loop the user was left hanging on, so it names what they
 * asked for and says outright that the microphone reopened by itself — an app
 * that starts talking unprompted should say why in its first breath.
 */
export function buildWakeAnnouncement(input: {
  readonly work: AwaitedWork;
  readonly completion: string;
}): string {
  return [
    `Voice reopened by itself because "${input.work.threadTitle}" finished the work you asked about, and the session had closed on silence before it did.`,
    `The user asked you to: ${input.work.request}`,
    "Open by saying, briefly, that you are back because that finished — then give them the answer.",
    input.completion,
  ].join(" ");
}
