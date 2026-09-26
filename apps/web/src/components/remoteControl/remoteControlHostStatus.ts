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

/**
 * How many times a permission failure is retried before the session ends.
 *
 * Replacing the application bundle invalidates macOS Screen Recording
 * authorization even though TCC still lists the app as allowed, so the first
 * frames after an update can fail with a permission error that the very next
 * attempt succeeds at. Ending the session on the first one turned a recoverable
 * hiccup into "go change a system setting and relaunch". A genuinely withheld
 * permission fails every attempt and still reports itself, just a few seconds
 * later.
 */
export const REMOTE_CONTROL_PERMISSION_RETRY_ATTEMPTS = 5;

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

/**
 * Viewer text per reason.
 *
 * Deliberately partial: a reason with no entry is accepted off the wire and
 * then says nothing. `secure-input` is the one such reason - macOS password
 * fields no longer produce any banner at the owner's request, and the literal
 * stays only so a host on an older build can still report it without failing
 * to decode.
 */
const REASON_TEXT: Partial<Record<RemoteControlHostStatusReason, string>> = {
  "secure-desktop":
    "Windows is showing a security prompt on the remote computer — User Account Control, the lock screen, or Ctrl+Alt+Del. Windows hides that screen from every other program, so it has to be answered there. This session resumes on its own once it closes.",
  "elevated-window":
    "The window in front on the remote computer is running as administrator. Keystrokes are still sent, but Windows ignores them for elevated windows. To control those, run Solla Code as administrator on that computer.",
  "capture-interrupted":
    "The remote screen stopped being capturable and is being reconnected. This usually means a security prompt or a display change on that computer.",
  "input-interrupted":
    "The remote computer is still being watched, but it is not accepting clicks or keystrokes right now. Retrying — if this persists, check that Solla Code has Accessibility permission on that computer.",
};

/**
 * What the owner can do about a UAC block, when anything.
 *
 * A `secure-desktop` block has two very different causes and the bare message
 * treated them alike. If UAC still draws on its own secure desktop, this
 * machine is one setting away from at least SHOWING the prompt remotely — worth
 * saying, because the plain text reads as "nothing can be done". If that
 * setting is already off, the block is the lock screen, Ctrl+Alt+Del, or UIPI,
 * and pointing at the setting would be a dead end.
 *
 * Deliberately not offered as a button: turning it off genuinely weakens UAC,
 * it needs administrator rights on that machine, and the elevation prompt it
 * raises lands on the very desktop this session cannot reach. It is a decision
 * to make at the computer, so the viewer explains rather than acts.
 */
export const SECURE_DESKTOP_PROMPT_HELP =
  "You can make this prompt visible over remote control: on that computer, set " +
  "PromptOnSecureDesktop to 0 under HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System " +
  "and sign out and back in. UAC then draws on the ordinary desktop instead of a hidden one. " +
  "It does weaken UAC, and Windows may still refuse clicks on the prompt itself.";

/** Viewer-facing text for a status, or null when nothing is wrong. */
export function describeHostStatus(status: RemoteControlHostStatus): string | null {
  if (status.state === "ok") return null;
  if (status.reason) {
    const text = REASON_TEXT[status.reason] ?? null;
    if (text === null) return null;
    // Only a secure-desktop block with the prompt still on the secure desktop
    // has a remedy. `undefined` means macOS or an older host: say nothing extra
    // rather than guess.
    return status.reason === "secure-desktop" && status.secureDesktopPrompt === true
      ? `${text} ${SECURE_DESKTOP_PROMPT_HELP}`
      : text;
  }
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
