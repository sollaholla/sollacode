import type { VoiceSessionState } from "./realtimeSession";

/**
 * What the full-screen voice view says about itself.
 *
 * Split out from the component because the wording is the whole product on a
 * phone: there is no sidebar, no thread list and no console to fall back on, so
 * a user walking with headphones has only this line to tell them whether the
 * thing is listening, thinking, or quietly broken.
 */
export interface MobileVoicePresentation {
  /** Large line under the orb. */
  readonly title: string;
  /** Smaller line under that. Empty when the title says enough. */
  readonly hint: string;
  /** What tapping the orb does next. */
  readonly action: "start" | "stop";
  /** Label for assistive technology, which needs the action, not the state. */
  readonly actionLabel: string;
  /** Whether the orb should read as active rather than dormant. */
  readonly live: boolean;
}

export function describeMobileVoice(input: {
  readonly state: VoiceSessionState;
  readonly canStart: boolean;
  readonly canInterrupt?: boolean;
  /** A committed user turn is waiting for its first audible answer. */
  readonly working?: boolean;
  readonly error: string | null;
}): MobileVoicePresentation {
  // An error with a live session is a warning, not a state: the session below is
  // still usable and saying "error" would send the user back to their desk.
  if (input.error !== null && (input.state === "idle" || input.state === "error")) {
    return {
      title: "Voice stopped",
      hint: input.error,
      action: "start",
      actionLabel: "Start voice",
      live: false,
    };
  }

  switch (input.state) {
    case "connecting":
      return {
        title: "Connecting",
        // Names the wait so a two-second pause does not read as a dead button.
        hint: "Opening the microphone once the session is ready.",
        action: "stop",
        actionLabel: "Cancel connecting",
        live: true,
      };
    case "listening":
      if (input.working === true) {
        return {
          title: "Heard you — thinking",
          hint:
            input.canInterrupt === false
              ? "The microphone reopens when it is ready for another turn."
              : "Talk over it if you need to add something.",
          action: "stop",
          actionLabel: "Stop voice",
          live: true,
        };
      }
      return {
        title: "Listening",
        hint: "Ask about your threads, or send work to one.",
        action: "stop",
        actionLabel: "Stop voice",
        live: true,
      };
    case "speaking":
      return {
        title: "Speaking",
        hint:
          input.canInterrupt === false
            ? "The microphone reopens when it finishes speaking."
            : "Talk over it to interrupt.",
        action: "stop",
        actionLabel: "Stop voice",
        live: true,
      };
    case "error":
      return {
        title: "Voice stopped",
        hint: "Something went wrong. Tap to try again.",
        action: "start",
        actionLabel: "Start voice",
        live: false,
      };
    case "idle":
      return input.canStart
        ? {
            title: "Tap to talk",
            hint: "",
            action: "start",
            actionLabel: "Start voice",
            live: false,
          }
        : {
            title: "Not connected",
            // The one thing they can act on from a phone, said plainly.
            hint: "Connect to an environment first, or check that your Mac is awake.",
            action: "start",
            actionLabel: "Start voice",
            live: false,
          };
  }
}

/**
 * Whether the full-screen voice surface belongs on this device.
 *
 * It exists because a phone has nowhere else to put the state: no sidebar, no
 * thread list, and a 56-pixel orb is invisible at arm's length. None of that is
 * true of a desktop, where covering the whole app to say "the microphone is
 * open" takes the screen away from the work the user is talking *about*.
 *
 * The desktop app answers the same need with the floating bubble — a small
 * always-on-top window that says the same thing without owning the screen — so
 * the overlay is refused there outright. Everywhere else it is a question of
 * form factor rather than of app versus browser: a coarse pointer and a small
 * viewport means a handheld, and a handheld is where this earns its place.
 *
 * Deliberately requires a coarse pointer as well as a small window, so a
 * narrowed desktop browser does not suddenly black itself out.
 */
export const VOICE_OVERLAY_MAX_VIEWPORT = 900;

export function shouldShowVoiceOverlay(
  input: {
    readonly coarsePointer?: boolean;
    readonly viewportWidth?: number;
    readonly isDesktopApp?: boolean;
  } = {},
): boolean {
  const isDesktopApp =
    input.isDesktopApp ?? (typeof window !== "undefined" && window.desktopBridge !== undefined);
  if (isDesktopApp) return false;

  const coarsePointer =
    input.coarsePointer ??
    (typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches);
  if (coarsePointer !== true) return false;

  const viewportWidth =
    input.viewportWidth ?? (typeof window === "undefined" ? Number.NaN : window.innerWidth);
  // A coarse pointer with an unknown width is a phone or tablet; there is no
  // desktop it could be.
  if (!Number.isFinite(viewportWidth)) return true;
  return viewportWidth <= VOICE_OVERLAY_MAX_VIEWPORT;
}

/**
 * Orb diameter as a share of the smaller screen edge.
 *
 * A phone held at arm's length while walking is a much worse target than a
 * mouse pointer, so the orb is deliberately enormous — it is the only control
 * on the screen and should be hittable without looking.
 */
export const MOBILE_ORB_VIEWPORT_FRACTION = 0.5;
export const MOBILE_ORB_MIN_PX = 180;
export const MOBILE_ORB_MAX_PX = 320;

export function computeMobileOrbDiameter(shorterEdgePx: number): number {
  const target = Math.round(shorterEdgePx * MOBILE_ORB_VIEWPORT_FRACTION);
  return Math.min(MOBILE_ORB_MAX_PX, Math.max(MOBILE_ORB_MIN_PX, target));
}

/**
 * How far the orb swells with the live audio level.
 *
 * Capped well below the layout's breathing room: an orb that can grow past its
 * container makes the whole screen jump on a loud noise.
 */
export function computeMobileOrbScale(level: number, live: boolean): number {
  if (!live) return 1;
  const clamped = Math.min(1, Math.max(0, level));
  return 1 + clamped * 0.18;
}

/**
 * Who currently holds the conversation, for the overlay orb.
 *
 * Derived from levels rather than session state alone, because state cannot
 * tell the two speakers apart: a session is "listening" both while the user is
 * mid-sentence and while the room is silent, and those should not look the
 * same. The orb previously used one colour at two opacities for every one of
 * these, so nothing about it answered "is it hearing me?".
 */
export type VoiceSpeaker = "connecting" | "assistant" | "user" | "waiting" | "idle";

/** Level above which a microphone is carrying speech rather than room tone. */
export const SPEAKING_LEVEL = 0.08;

export function resolveVoiceSpeaker(input: {
  readonly state: VoiceSessionState;
  readonly micLevel: number;
  readonly assistantLevel: number;
  /** The assistant holds the floor while silent — a tool call between sentences. */
  readonly working?: boolean;
}): VoiceSpeaker {
  if (input.state === "connecting") return "connecting";
  if (input.state === "idle" || input.state === "error") return "idle";
  // Playback wins a tie: the assistant's own voice coming back through a
  // speaker registers on the microphone, and colouring that as the user would
  // be wrong in exactly the situation that is hardest to read.
  if (input.state === "speaking" || input.assistantLevel >= SPEAKING_LEVEL) return "assistant";
  if (input.working === true) return "waiting";
  return input.micLevel >= SPEAKING_LEVEL ? "user" : "idle";
}

/**
 * How long the orb keeps a speaker after their sound dips below threshold.
 *
 * Levels are instantaneous, and speech is not: the assistant's output drops
 * under `SPEAKING_LEVEL` between every word and syllable, so resolving the
 * speaker from the raw level flipped the orb assistant→idle→assistant several
 * times a second for the whole reply — the icon visibly strobed between the
 * audio-lines glyph and the microphone. Matches `ASSISTANT_AUDIO_GRACE_MS` in
 * the session, which exists for the same gaps.
 */
export const SPEAKER_HOLD_MS = 600;

/**
 * A `resolveVoiceSpeaker` with memory: promotions are instant, demotions wait.
 *
 * Becoming audible switches the speaker immediately — a user talking over the
 * assistant must win the orb at once, or "talk over it to interrupt" looks
 * ignored. Falling silent only reaches "idle" after `holdMs` of sustained
 * quiet, so inter-word dips do not read as the floor changing hands.
 *
 * The hold never bridges a session-state change: a session that stops or
 * errors shows it at once, because that "idle" comes from the state, not from
 * a quiet microphone.
 */
export function createVoiceSpeakerResolver(
  holdMs: number = SPEAKER_HOLD_MS,
): (input: Parameters<typeof resolveVoiceSpeaker>[0], nowMs: number) => VoiceSpeaker {
  let held: VoiceSpeaker | null = null;
  let heldAt = 0;
  return (input, nowMs) => {
    const raw = resolveVoiceSpeaker(input);
    if (raw === "assistant" || raw === "user") {
      held = raw;
      heldAt = nowMs;
      return raw;
    }
    const stateIsLive = input.state === "listening" || input.state === "speaking";
    if (raw === "idle" && stateIsLive && held !== null && nowMs - heldAt < holdMs) {
      return held;
    }
    // "waiting" and "connecting" are deliberate states, not level dips; they
    // take effect immediately and clear the hold with them.
    held = null;
    return raw;
  };
}

/** How loud the orb should read, 0..1, from whichever side is talking. */
export function voiceOrbIntensity(input: {
  readonly speaker: VoiceSpeaker;
  readonly micLevel: number;
  readonly assistantLevel: number;
}): number {
  switch (input.speaker) {
    case "assistant":
      return clampUnit(input.assistantLevel);
    case "user":
      return clampUnit(input.micLevel);
    case "waiting":
    case "connecting":
      // Nothing is audible, so a level would read as zero and the orb would sit
      // dead still at the moment it most needs to look alive. The component
      // supplies its own pulse for these.
      return 0;
    case "idle":
      return 0;
  }
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
