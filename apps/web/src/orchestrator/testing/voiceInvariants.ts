import type { VoiceSessionState } from "../realtimeSession";

/**
 * Properties a voice session must hold whatever the provider does.
 *
 * Written as checks over a recorded timeline rather than assertions inside
 * individual tests, because the failures worth catching are the ones no test
 * thought to look for. Every scenario — scripted, or replayed from a real
 * provider recording — is run through the same checks, so a frame order nobody
 * anticipated is still held to the rules.
 *
 * Each rule below is a bug that actually happened, stated as the condition
 * that would have caught it.
 */

/** One sample of everything observable about a session from outside it. */
export interface VoiceTimelineSample {
  /** Virtual wall-clock milliseconds since the session started. */
  readonly atMs: number;
  readonly state: VoiceSessionState;
  /** Buffers the session has scheduled and the platform has not yet ended. */
  readonly audioPending: number;
  /** Whether the provider has an in-flight response, from its own frames. */
  readonly responseActive: boolean;
  /**
   * Whether captured audio is reaching the provider right now.
   *
   * Measured, not inferred: the harness pushes a buffer through the capture
   * node and looks for the upload frame. "Listening" with this false is the
   * precise shape of a session that looks fine and cannot hear anyone.
   */
  readonly uploadingCapture: boolean;
}

export interface VoiceInvariantViolation {
  readonly rule: string;
  readonly atMs: number;
  readonly detail: string;
}

export interface VoiceInvariantOptions {
  /**
   * How long the session may stay in `speaking` after the last thing that
   * could justify it. Generous: the point is to catch a session that never
   * leaves, not to police the exact moment it does.
   */
  readonly speakingGraceMs?: number;
  /**
   * How long `listening` may show before capture must actually be flowing.
   * Non-zero because the microphone is opened a tick after the state changes.
   */
  readonly captureGraceMs?: number;
  /**
   * Whether this session closes the microphone while the assistant speaks.
   *
   * Only meaningful for rule 3. On a full-duplex session capture during
   * playback is not a fault but the mechanism of barge-in, so applying the
   * rule everywhere would forbid the feature.
   */
  readonly halfDuplex?: boolean;
}

const DEFAULT_SPEAKING_GRACE_MS = 10_000;
const DEFAULT_CAPTURE_GRACE_MS = 250;

/**
 * Checks a recorded session timeline and returns every rule it broke.
 *
 * Returns violations rather than throwing so a caller can report all of them
 * at once: when a session goes wrong it usually breaks several rules together,
 * and fixing them one failed assertion at a time hides the shape of the fault.
 */
export function findVoiceInvariantViolations(
  timeline: ReadonlyArray<VoiceTimelineSample>,
  options: VoiceInvariantOptions = {},
): ReadonlyArray<VoiceInvariantViolation> {
  const speakingGraceMs = options.speakingGraceMs ?? DEFAULT_SPEAKING_GRACE_MS;
  const captureGraceMs = options.captureGraceMs ?? DEFAULT_CAPTURE_GRACE_MS;
  const violations: VoiceInvariantViolation[] = [];

  /**
   * Rule 1 — speaking ends.
   *
   * Nothing justifies "speaking" once the provider has finished the response
   * and no audio remains scheduled. This is the reported bug: a reply that had
   * finished playing minutes earlier, an orb still reading "Speaking", and a
   * microphone that only reopens when speaking ends.
   */
  let strandedSince: number | null = null;
  for (const sample of timeline) {
    const justified = sample.responseActive || sample.audioPending > 0;
    if (sample.state !== "speaking" || justified) {
      strandedSince = null;
      continue;
    }
    strandedSince ??= sample.atMs;
    if (sample.atMs - strandedSince > speakingGraceMs) {
      violations.push({
        rule: "speaking-ends",
        atMs: sample.atMs,
        detail: `still speaking ${sample.atMs - strandedSince}ms after the response finished and the audio drained`,
      });
      strandedSince = null;
    }
  }

  /**
   * Rule 2 — listening can hear.
   *
   * The state is a promise to the user that talking will work. A session that
   * shows it while capture is not flowing is the same failure as the one
   * above, one screen earlier.
   */
  let deafSince: number | null = null;
  for (const sample of timeline) {
    if (sample.state !== "listening" || sample.uploadingCapture) {
      deafSince = null;
      continue;
    }
    deafSince ??= sample.atMs;
    if (sample.atMs - deafSince > captureGraceMs) {
      violations.push({
        rule: "listening-hears",
        atMs: sample.atMs,
        detail: `listening for ${sample.atMs - deafSince}ms without uploading captured audio`,
      });
      deafSince = null;
    }
  }

  /**
   * Rule 3 — the microphone is closed while the assistant is audible.
   *
   * The inverse of rule 2, and the reason rule 2 cannot simply be "always
   * upload": on a half-duplex device an open microphone during playback feeds
   * the assistant's own voice back and it answers itself. Half duplex only —
   * elsewhere capture during playback is barge-in working as designed.
   */
  if (options.halfDuplex === true) {
    for (const sample of timeline) {
      if (sample.state === "speaking" && sample.audioPending > 0 && sample.uploadingCapture) {
        violations.push({
          rule: "speaking-is-deaf",
          atMs: sample.atMs,
          detail: "uploading captured audio while the assistant is still audible",
        });
      }
    }
  }

  /**
   * Rule 4 — no state is terminal.
   *
   * A session that ends its recording anywhere other than idle, listening, or
   * error is one the user has to restart by hand. Checked at the end rather
   * than continuously: passing through connecting or speaking is the point.
   */
  const last = timeline.at(-1);
  if (last !== undefined && last.state !== "idle" && last.state !== "listening") {
    if (last.state !== "error") {
      violations.push({
        rule: "no-terminal-state",
        atMs: last.atMs,
        detail: `session came to rest in "${last.state}", which the user cannot leave without restarting`,
      });
    }
  }

  return violations;
}

/** Formats violations for an assertion message that says what actually broke. */
export function describeVoiceInvariantViolations(
  violations: ReadonlyArray<VoiceInvariantViolation>,
): string {
  if (violations.length === 0) return "no violations";
  return violations
    .map((violation) => `[${violation.rule} @${violation.atMs}ms] ${violation.detail}`)
    .join("\n");
}
