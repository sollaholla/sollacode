import { RING_VIBRATION_PATTERN, nextRingBurstDelay } from "./agentCallLogic";

/**
 * The ring: an original mallet phrase, soft and rounded in the manner of a
 * phone's ringtone. Every call sound here is synthesized, so nothing of anyone
 * else's ships with the app.
 */
const RING_NOTE_SECONDS = 0.22;
const RING_PHRASE_HZ = [659.25, 830.61, 987.77, 1318.51, 987.77, 830.61, 987.77, 1318.51] as const;
const PEAK_GAIN = 0.16;

/** Harmonics of a struck bar: the body, and a bright attack that dies at once. */
const STRUCK_PARTIALS = [
  { ratio: 1, level: 1, decay: 1 },
  { ratio: 4, level: 0.16, decay: 0.22 },
] as const;

/** One struck note. Faded in over milliseconds: a hard edge on a sine is a click. */
function scheduleStruckNote(input: {
  readonly context: AudioContext;
  readonly frequency: number;
  readonly at: number;
  readonly seconds: number;
  readonly peak: number;
}): OscillatorNode[] {
  const { context, frequency, at, seconds, peak } = input;
  return STRUCK_PARTIALS.map((partial) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const end = at + seconds * partial.decay;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency * partial.ratio, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak * partial.level, 0.0002), at + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(at);
    oscillator.stop(end + 0.01);
    return oscillator;
  });
}

export interface Ringtone {
  stop(): void;
}

/**
 * Schedules one phrase on the context's own clock, with nothing for the page to
 * do until the next one four seconds later.
 */
function scheduleRingBurst(context: AudioContext, volume: number): void {
  const start = context.currentTime + 0.02;
  const peak = PEAK_GAIN * Math.min(Math.max(volume, 0), 1);
  RING_PHRASE_HZ.forEach((frequency, index) => {
    scheduleStruckNote({
      context,
      frequency,
      at: start + index * RING_NOTE_SECONDS,
      seconds: RING_NOTE_SECONDS * 2.4,
      peak,
    });
  });
}

/**
 * Rings until stopped or until the ring expires: two seconds of a synthesized
 * phrase, four of silence, with a vibration pattern per burst where the device
 * has one. `volume` is read at every burst, so changing the sound-cue volume
 * lands on the next ring. Best-effort throughout — a browser that will not
 * start audio without a tap gets its first ring after the next tap, and a
 * missing sound is never a reason the call fails.
 */
export function startRingtone(input: {
  readonly tone: boolean;
  readonly vibrate: boolean;
  readonly volume: () => number;
  readonly expiresAt: number | null;
}): Ringtone {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let context: AudioContext | null = null;
  const startedAt = Date.now();
  const unlock = () => {
    void context?.resume().catch(() => undefined);
  };
  if (input.tone && typeof AudioContext !== "undefined") {
    try {
      context = new AudioContext();
    } catch {
      context = null;
    }
    if (context && context.state === "suspended") {
      void context.resume().catch(() => undefined);
      window.addEventListener("pointerdown", unlock, { capture: true, once: true });
      window.addEventListener("keydown", unlock, { capture: true, once: true });
    }
  }
  const vibrate = (pattern: ReadonlyArray<number> | number) => {
    if (!input.vibrate || typeof navigator === "undefined") return;
    if (typeof navigator.vibrate !== "function") return;
    try {
      navigator.vibrate(typeof pattern === "number" ? pattern : [...pattern]);
    } catch {
      /* Vibration is a courtesy. */
    }
  };
  const burst = () => {
    timer = null;
    if (stopped) return;
    const playedAt = Date.now();
    if (context) {
      try {
        scheduleRingBurst(context, input.volume());
      } catch {
        /* A ring is never worth failing over. */
      }
    }
    vibrate(RING_VIBRATION_PATTERN);
    // Measured just past this burst so the one that just played is not due again.
    const delay = nextRingBurstDelay({
      startedAt,
      now: Math.max(Date.now(), playedAt + 1),
      expiresAt: input.expiresAt,
    });
    if (delay !== null) timer = setTimeout(burst, delay);
  };
  burst();
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      window.removeEventListener("pointerdown", unlock, { capture: true });
      window.removeEventListener("keydown", unlock, { capture: true });
      vibrate(0);
      void context?.close().catch(() => undefined);
      context = null;
    },
  };
}

/** A short synthesized cue: gliding sine notes, one after another. */
function playCueNotes(
  notes: ReadonlyArray<{ readonly from: number; readonly to: number; readonly seconds: number }>,
  volume: number,
): void {
  if (typeof AudioContext === "undefined") return;
  let context: AudioContext;
  try {
    context = new AudioContext();
  } catch {
    return;
  }
  try {
    void context.resume().catch(() => undefined);
    const peak = PEAK_GAIN * Math.min(Math.max(volume, 0), 1);
    const gain = context.createGain();
    gain.connect(context.destination);
    const oscillator = context.createOscillator();
    oscillator.type = "sine";
    oscillator.connect(gain);
    let at = context.currentTime + 0.02;
    const start = at;
    gain.gain.setValueAtTime(0.0001, at);
    for (const note of notes) {
      oscillator.frequency.setValueAtTime(note.from, at);
      oscillator.frequency.exponentialRampToValueAtTime(note.to, at + note.seconds);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.linearRampToValueAtTime(peak, at + 0.008);
      gain.gain.linearRampToValueAtTime(0.0001, at + note.seconds);
      at += note.seconds + 0.025;
    }
    oscillator.start(start);
    oscillator.stop(at);
    oscillator.addEventListener("ended", () => void context.close().catch(() => undefined));
  } catch {
    void context.close().catch(() => undefined);
  }
}

/** Two soft falling beeps, the sound of a call ending. */
const HANG_UP_NOTES = [
  { from: 620, to: 610, seconds: 0.12 },
  { from: 470, to: 460, seconds: 0.16 },
] as const;
/** A quick tick downwards as the microphone closes, and upwards as it opens. */
const MUTE_NOTES = [{ from: 620, to: 430, seconds: 0.07 }] as const;
const UNMUTE_NOTES = [{ from: 430, to: 720, seconds: 0.07 }] as const;

/**
 * Plays the hang-up sound once a connected call ends, from either side.
 * Best-effort like the ring: no audio is never a reason anything fails.
 */
export function playHangUpTone(volume: number): void {
  playCueNotes(HANG_UP_NOTES, volume);
}

/** Confirms the microphone changed, for someone not looking at the screen. */
export function playMuteTone(muted: boolean, volume: number): void {
  playCueNotes(muted ? MUTE_NOTES : UNMUTE_NOTES, volume);
}

/** North American ringback: two tones together, two seconds on, four off. */
const RINGBACK_HZ = [440, 480] as const;
const RINGBACK_ON_SECONDS = 2;
const RINGBACK_PERIOD_MS = 6_000;
/** Quieter than a ringtone: it plays at the ear, as a handset's does. */
const RINGBACK_GAIN = 0.06;

/**
 * Rings out while a call the person placed waits for the agent to pick up,
 * from the first moment: two seconds of the paired tones, four of silence.
 * `volume` is read at every ring. Stopping fades out, never clicks.
 * Best-effort like the ringtone.
 */
export function startRingback(input: { readonly volume: () => number }): Ringtone {
  if (typeof AudioContext === "undefined") return { stop: () => undefined };
  let context: AudioContext;
  try {
    context = new AudioContext();
  } catch {
    return { stop: () => undefined };
  }
  void context.resume().catch(() => undefined);
  const output = context.createGain();
  output.connect(context.destination);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const ring = () => {
    timer = null;
    if (stopped) return;
    try {
      const start = context.currentTime + 0.02;
      const end = start + RINGBACK_ON_SECONDS;
      const peak = RINGBACK_GAIN * Math.min(Math.max(input.volume(), 0), 1);
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(peak, start + 0.02);
      gain.gain.setValueAtTime(peak, end - 0.03);
      gain.gain.linearRampToValueAtTime(0.0001, end);
      gain.connect(output);
      for (const frequency of RINGBACK_HZ) {
        const oscillator = context.createOscillator();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, start);
        oscillator.connect(gain);
        oscillator.start(start);
        oscillator.stop(end + 0.02);
      }
    } catch {
      /* A ring is never worth failing over. */
    }
    timer = setTimeout(ring, RINGBACK_PERIOD_MS);
  };
  ring();
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      try {
        const now = context.currentTime;
        output.gain.setValueAtTime(output.gain.value, now);
        output.gain.linearRampToValueAtTime(0, now + 0.03);
      } catch {
        /* Closing below silences it anyway. */
      }
      setTimeout(() => void context.close().catch(() => undefined), 80);
    },
  };
}
