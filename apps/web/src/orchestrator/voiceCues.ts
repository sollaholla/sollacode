/**
 * Short tones marking what a voice surface is doing — every synthesized cue
 * the app can make, in one vocabulary.
 *
 * Talking to something with no screen feedback is guesswork: the reported
 * experience was not knowing whether it had heard, whether it was working, or
 * whether the session had quietly died. Cues answer that without asking anyone
 * to look at a phone. Both features that make sound — the orchestrator's voice
 * session and push-to-talk dictation — play from this table, so a sound means
 * the same thing wherever it is heard. (For the record, these are the *only*
 * sounds: there are no notification sounds, and the terminal deliberately
 * drops BEL.)
 *
 * Cues are named for what they mean, not which feature plays them:
 *
 *  - `mic-open`  — the microphone just opened; start talking. Played when a
 *                  voice session configures (first start *and* reconnect —
 *                  "the socket came back" is not worth a distinct sound, only
 *                  "you can talk now" is), when the platform gives a suspended
 *                  microphone back, and when push-to-talk starts recording.
 *  - `heard`     — the first words of this utterance came back as text, so the
 *                  system demonstrably heard you. Once per utterance.
 *  - `accepted`  — your turn closed and was accepted; an answer is owed.
 *  - `working`   — a soft pulse between "accepted" and the answer becoming
 *                  audible, so waiting is audibly work rather than silence.
 *  - `dropped`   — what you said did not land: you spoke over a reply that was
 *                  already generating, or a wait was abandoned and the floor
 *                  handed back. Nothing is broken; nothing to dismiss.
 *  - `deaf`      — the session cannot hear you: the transport dropped or the
 *                  platform took the microphone. Either way the right response
 *                  is the same — stop talking — so it is one sound.
 *
 * Meaning is carried by contour, because register is the first thing a pocket
 * or a cheap speaker eats. Each contour is reserved for one valence:
 *
 *  - rising          = you may act        (`mic-open`, and nothing else)
 *  - falling         = closed, success    (`accepted`, and nothing else)
 *  - flat            = state              (`heard` click, `working` pulse)
 *  - repeated knock  = negative           (`dropped` short, `deaf` long/low)
 *
 * Synthesised with an oscillator rather than shipped as audio files: a few
 * short blips are a few lines of maths, and this way there are no assets to
 * load, no cache to miss, and nothing that can 404 mid-conversation.
 */

export type VoiceCue = "mic-open" | "heard" | "accepted" | "working" | "dropped" | "deaf";

/**
 * What a cue is allowed to interrupt. Every cue declares one; the gate in
 * {@link mayPlayCue} decides from the class alone, so adding a cue means
 * picking a class rather than amending the policy.
 *
 *  - `corrective`   — plays over anything. These exist to correct a belief the
 *                     user is acting on *right now*: they are talking to
 *                     something that cannot hear them (`deaf`), or over a
 *                     reply that was already generating (`dropped`) — which is
 *                     precisely why it must be allowed over assistant audio.
 *  - `confirmation` — plays over the user (it is *about* their speech: `heard`
 *                     lands mid-sentence by design, `accepted` at the instant
 *                     their turn closed) but never over the assistant.
 *  - `ambient`      — a courtesy. Yields to everyone.
 */
export type VoiceCueClass = "corrective" | "confirmation" | "ambient";

const CUE_CLASSES: Readonly<Record<VoiceCue, VoiceCueClass>> = {
  "mic-open": "ambient",
  working: "ambient",
  heard: "confirmation",
  accepted: "confirmation",
  dropped: "corrective",
  deaf: "corrective",
};

export function cueClass(cue: VoiceCue): VoiceCueClass {
  return CUE_CLASSES[cue];
}

/** Deliberately quiet: audible under speech, never over it. */
const CUE_GAIN = 0.045;
const WORKING_GAIN = 0.025;
/** Quieter still: this one lands while the user is actually talking. */
const HEARD_GAIN = 0.02;
/** Gap between working pulses. Slow enough to read as waiting, not alarm. */
export const THINKING_PULSE_INTERVAL_MS = 1_400;

interface CueTone {
  /** Frequencies played in sequence, in hertz. */
  readonly steps: ReadonlyArray<number>;
  /** Duration of each step, in seconds. */
  readonly stepSeconds: number;
  readonly gain: number;
}

const CUE_TONES: Readonly<Record<VoiceCue, CueTone>> = {
  // The one rising cue: "you may act".
  "mic-open": { steps: [660, 880], stepSeconds: 0.07, gain: CUE_GAIN },
  // The one falling cue: "closed, success".
  accepted: { steps: [880, 660], stepSeconds: 0.06, gain: CUE_GAIN },
  // A single very short blip — a click, not a tone. It fires while the user is
  // mid-sentence, so it has to be over before they notice it started; anything
  // longer would be something talking under them.
  heard: { steps: [1_200], stepSeconds: 0.025, gain: HEARD_GAIN },
  working: { steps: [440], stepSeconds: 0.09, gain: WORKING_GAIN },
  // A knock on one pitch, so it cannot be mistaken for `accepted` however bad
  // the speaker: repetition, not direction, is what marks the negative family.
  dropped: { steps: [340, 340], stepSeconds: 0.055, gain: CUE_GAIN },
  // The same knock, lower and nearly three times slower: unmistakably its
  // sibling, unmistakably worse. Long enough to land mid-speech, because
  // someone talking to something that cannot hear them should find out with
  // the least breath wasted.
  deaf: { steps: [250, 250], stepSeconds: 0.15, gain: CUE_GAIN },
};

/** How long a cue sounds, for callers that must sequence something after it. */
export function cueDurationMs(cue: VoiceCue): number {
  const tone = CUE_TONES[cue];
  return tone.steps.length * tone.stepSeconds * 1_000;
}

/**
 * Whether cues sound at all, and how loud, on this device.
 *
 * Resolved from client settings at play time (not construction time), so a
 * settings change lands mid-session without a restart.
 */
export interface VoiceCuePolicy {
  readonly enabled: boolean;
  /** Multiplier over each tone's designed gain, 0–1. */
  readonly volume: number;
}

export const DEFAULT_VOICE_CUE_POLICY: VoiceCuePolicy = { enabled: true, volume: 1 };

/** Maps the persisted client settings shape onto a play-time policy. */
export function resolveVoiceCuePolicy(settings: {
  readonly soundCues: boolean;
  readonly soundCueVolume: number;
}): VoiceCuePolicy {
  return {
    enabled: settings.soundCues,
    volume: Math.min(Math.max(settings.soundCueVolume / 100, 0), 1),
  };
}

export interface VoiceCuePlayer {
  readonly play: (cue: VoiceCue) => void;
  readonly startThinking: () => void;
  readonly stopThinking: () => void;
  readonly dispose: () => void;
}

/** The slice of `AudioContext` used here, so tests need no Web Audio. */
export interface CueAudioContextLike {
  readonly currentTime: number;
  readonly destination: unknown;
  createOscillator(): {
    frequency: { setValueAtTime(value: number, when: number): void };
    connect(destination: unknown): void;
    start(when: number): void;
    stop(when: number): void;
  };
  createGain(): {
    gain: {
      setValueAtTime(value: number, when: number): void;
      linearRampToValueAtTime(value: number, when: number): void;
    };
    connect(destination: unknown): void;
  };
  close?(): Promise<void>;
  resume?(): Promise<void>;
}

/** Schedules one tone on a context. Shared by the session player and one-shots. */
function scheduleTone(context: CueAudioContextLike, tone: CueTone, volume: number): void {
  void context.resume?.();
  const start = context.currentTime;
  tone.steps.forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const from = start + index * tone.stepSeconds;
    const to = from + tone.stepSeconds;
    oscillator.frequency.setValueAtTime(frequency, from);
    // Ramped rather than switched: an abrupt stop on a sine is a click, and
    // a click in your ear reads as something breaking.
    gain.gain.setValueAtTime(tone.gain * volume, from);
    gain.gain.linearRampToValueAtTime(0.0001, to);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(from);
    oscillator.stop(to);
  });
}

/**
 * Builds a cue player over an audio context.
 *
 * Pass `null` where there is no Web Audio and every call becomes a no-op — a
 * missing sound must never be the reason a conversation fails. `getPolicy` is
 * consulted on every play, so turning cues off (or down) in settings takes
 * effect on the next tone rather than the next session.
 */
export function createVoiceCuePlayer(
  context: CueAudioContextLike | null,
  getPolicy: () => VoiceCuePolicy = () => DEFAULT_VOICE_CUE_POLICY,
): VoiceCuePlayer {
  let thinkingTimer: ReturnType<typeof setTimeout> | null = null;

  const play = (cue: VoiceCue) => {
    if (context === null) return;
    try {
      const policy = getPolicy();
      if (!policy.enabled || policy.volume <= 0) return;
      scheduleTone(context, CUE_TONES[cue], policy.volume);
    } catch {
      // A cue is never worth failing a conversation over.
    }
  };

  const stopThinking = () => {
    if (thinkingTimer === null) return;
    clearTimeout(thinkingTimer);
    thinkingTimer = null;
  };

  const scheduleThinkingPulse = () => {
    thinkingTimer = setTimeout(() => {
      play("working");
      scheduleThinkingPulse();
    }, THINKING_PULSE_INTERVAL_MS);
  };

  return {
    play,
    startThinking: () => {
      if (thinkingTimer !== null) return;
      // The accepted contour gets the first beat to itself. Starting this pulse
      // immediately laid a third pitch over that two-note confirmation, which
      // made the one sound whose meaning matters most hard to recognise. Fast
      // answers now make no waiting noise at all; slow ones pulse after a beat.
      scheduleThinkingPulse();
    },
    stopThinking,
    dispose: () => {
      stopThinking();
      void context?.close?.().catch(() => undefined);
    },
  };
}

/**
 * Plays one cue on a context of its own and resolves when it has finished
 * sounding.
 *
 * For surfaces with no session to own a player — push-to-talk opens the
 * microphone for one recording and is gone. Resolving *after* the tone matters
 * to its caller: the desktop mutes system output while dictating, and the mute
 * must not land under the cue that says recording started.
 */
export async function playCueOnce(
  cue: VoiceCue,
  policy: VoiceCuePolicy = DEFAULT_VOICE_CUE_POLICY,
): Promise<void> {
  if (!policy.enabled || policy.volume <= 0) return;
  if (typeof AudioContext === "undefined") return;
  const context = new AudioContext();
  try {
    if (context.state === "suspended") {
      await context.resume();
    }
    scheduleTone(context, CUE_TONES[cue], policy.volume);
    await new Promise<void>((resolve) => {
      // A timer rather than the oscillator's `ended` event: with several steps
      // there are several oscillators, and the duration is already knowable.
      setTimeout(resolve, cueDurationMs(cue) + 30);
    });
  } finally {
    await context.close();
  }
}

/**
 * Whether the waiting tone should be sounding.
 *
 * Exactly one window qualifies: the user's turn has been accepted and the
 * answer has not started coming out yet. That is the only time someone is
 * waiting with nothing to listen to and no ability to take the floor back.
 *
 *  - Not while the assistant is audible — the answer is its own feedback, and a
 *    pulse under it is noise.
 *  - Not for background work. A thread finishing, or a tool call made off the
 *    back of an announcement, is not the user waiting on a reply, and beeping
 *    through it would turn every piece of housekeeping into an alarm. This is
 *    why the caller passes `awaitingUserAnswer` rather than "something is busy".
 *  - Not while the user is speaking, which cannot normally coincide but would
 *    be the worst possible moment for a noise if it did.
 */
export function shouldPlayThinkingCue(input: {
  readonly awaitingUserAnswer: boolean;
  readonly assistantAudible: boolean;
  readonly userSpeaking: boolean;
  /**
   * The assistant has spoken and gone quiet while it is still working — the
   * "let me check that…" pause.
   *
   * `awaitingUserAnswer` alone does not cover it: that window closes the
   * instant the first audio plays, so an answer that opens with a sentence and
   * *then* goes away to run a tool left dead silence. The user hears a
   * finished-sounding utterance, assumes the floor is theirs, and talks into a
   * session that is not listening.
   */
  readonly assistantWorking?: boolean;
}): boolean {
  if (input.userSpeaking) return false;
  if (input.assistantAudible) return false;
  return input.awaitingUserAnswer || input.assistantWorking === true;
}

/**
 * Whether a cue may be played right now.
 *
 * The rule the feature rests on — never make a noise while someone else has
 * the floor — applied per {@link VoiceCueClass} rather than per cue, so it
 * cannot be forgotten (or quietly excepted) at a new call site.
 */
export function mayPlayCue(input: {
  readonly cue: VoiceCue;
  readonly userSpeaking: boolean;
  readonly assistantAudible: boolean;
}): boolean {
  switch (cueClass(input.cue)) {
    case "corrective":
      return true;
    case "confirmation":
      return !input.assistantAudible;
    case "ambient":
      return !input.assistantAudible && !input.userSpeaking;
  }
}
