import type { RemoteControlHostStatus, RemoteControlHostStatusReason } from "@t3tools/contracts";
import {
  REMOTE_CONTROL_ACCESSIBILITY_PERMISSION_HELP,
  REMOTE_CONTROL_SCREEN_PERMISSION_HELP,
} from "@t3tools/contracts";

/**
 * Recovery policy for a host that has stopped cooperating.
 *
 * The condition this exists for is a Windows UAC prompt: it moves input and
 * capture to a desktop no other process may touch, for as long as it takes
 * someone to answer it. That is measured in seconds to minutes, is completely
 * normal, and ends by itself — so the session has to sit through it rather than
 * treat the first failed frame as the end of the world.
 */
export const REMOTE_CONTROL_RECOVERY_BASE_DELAY_MS = 750;
export const REMOTE_CONTROL_RECOVERY_MAX_DELAY_MS = 5_000;
/**
 * How long a host may stay unreachable before the session really is ended.
 *
 * Long enough to outlast someone walking to the machine to answer a prompt,
 * short enough that a genuinely dead host does not leave a controller staring
 * at a frozen frame indefinitely.
 */
export const REMOTE_CONTROL_RECOVERY_GIVE_UP_MS = 180_000;

export type RemoteControlFailureKind = "transient" | "fatal";

export interface RemoteControlFailure {
  /**
   * `transient` means retrying is the correct response and the session must
   * stay open. `fatal` means a human has to change something first, so
   * retrying would only hide the reason.
   */
  readonly kind: RemoteControlFailureKind;
  readonly reason?: RemoteControlHostStatusReason;
  readonly message: string;
}

function messageOf(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message.trim();
  if (typeof cause === "string" && cause.trim()) return cause.trim();
  return fallback;
}

/**
 * Only an OS permission the user has withheld is fatal.
 *
 * Everything else a capture pipeline can report — a lost duplication surface, a
 * display that vanished, an encoder that stopped, a publish that failed — is
 * either a desktop switch or a hiccup, and every one of them resolves on a
 * retry. Guessing "fatal" for those is what turned a UAC prompt into a dead
 * session.
 */
export function classifyCaptureFailure(cause: unknown): RemoteControlFailure {
  const message = messageOf(cause, "Solla Code could not capture this screen.");
  if (
    message.includes(REMOTE_CONTROL_SCREEN_PERMISSION_HELP) ||
    message.includes(REMOTE_CONTROL_ACCESSIBILITY_PERMISSION_HELP)
  ) {
    return { kind: "fatal", message };
  }
  return { kind: "transient", reason: "capture-interrupted", message };
}

export function classifyInputFailure(cause: unknown): RemoteControlFailure {
  const message = messageOf(cause, "Solla Code could not apply input from the controlling device.");
  if (message.includes(REMOTE_CONTROL_ACCESSIBILITY_PERMISSION_HELP)) {
    return { kind: "fatal", message };
  }
  // The input helper restarts itself, and a rejected event is not evidence that
  // the screen stopped working — so this never ends a session on its own.
  return { kind: "transient", message };
}

/** Exponential backoff, capped, so a long outage settles into a slow poll. */
export function recoveryDelayMs(attempt: number): number {
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const delay = REMOTE_CONTROL_RECOVERY_BASE_DELAY_MS * 2 ** Math.min(safeAttempt, 10);
  return Math.min(delay, REMOTE_CONTROL_RECOVERY_MAX_DELAY_MS);
}

const REASON_TEXT: Record<RemoteControlHostStatusReason, string> = {
  "secure-desktop":
    "Windows is showing a security prompt on the remote computer — User Account Control, the lock screen, or Ctrl+Alt+Del. Windows hides that screen from every other program, so it has to be answered there. This session resumes on its own once it closes.",
  "elevated-window":
    "The window in front on the remote computer is running as administrator, so Windows is ignoring remote input. Switch to an ordinary window there, or run Solla Code as administrator to control elevated apps.",
  "secure-input":
    "The remote Mac has secure input turned on, which a password field or authorization prompt does. Keystrokes are blocked until it closes.",
  "capture-interrupted":
    "The remote screen stopped being capturable and is being reconnected. This usually means a security prompt or a display change on that computer.",
};

/** Viewer-facing text for a status, or null when nothing is wrong. */
export function describeHostStatus(status: RemoteControlHostStatus): string | null {
  if (status.state === "ok") return null;
  if (status.reason) return REASON_TEXT[status.reason];
  return status.detail ?? "The remote computer is temporarily unavailable.";
}

/**
 * Whether two statuses say the same thing, used to keep the host from
 * re-reporting an unchanged condition on every dropped event.
 */
export function isSameHostStatus(
  left: RemoteControlHostStatus | null,
  right: RemoteControlHostStatus,
): boolean {
  if (!left) return false;
  return left.state === right.state && left.reason === right.reason;
}
