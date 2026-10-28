import { RING_BURST_MS, RING_VIBRATION_PATTERN, nextRingBurstDelay } from "./agentCallLogic";

/** Two notes a major third apart, alternated quickly: a handset's trill. */
const RING_NOTES_HZ = [698.46, 880] as const;
const NOTE_SECONDS = 0.125;
const NOTES_PER_BURST = Math.floor(RING_BURST_MS / 1_000 / NOTE_SECONDS);
/** The short break that makes one burst read as "ring-ring". */
const BREAK_NOTES: ReadonlySet<number> = new Set([7, 8]);
const PEAK_GAIN = 0.16;

export interface Ringtone {
  stop(): void;
}

/**
 * Schedules one two-second burst on the context's own clock. Two audio nodes
 * per burst and no animation frames: Web Audio plays it without the page
 * doing any work until the next burst four seconds later.
 */
function scheduleRingBurst(context: AudioContext, volume: number): void {
  const start = context.currentTime + 0.02;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  const peak = PEAK_GAIN * Math.min(Math.max(volume, 0), 1);
  gain.gain.setValueAtTime(0.0001, start);
  for (let index = 0; index < NOTES_PER_BURST; index += 1) {
    if (BREAK_NOTES.has(index)) continue;
    const at = start + index * NOTE_SECONDS;
    oscillator.frequency.setValueAtTime(RING_NOTES_HZ[index % 2] ?? RING_NOTES_HZ[0], at);
    // Ramped, never switched: a hard edge on a sine is a click.
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(peak, at + 0.012);
    gain.gain.linearRampToValueAtTime(peak * 0.6, at + NOTE_SECONDS * 0.7);
    gain.gain.linearRampToValueAtTime(0.0001, at + NOTE_SECONDS);
  }
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + NOTES_PER_BURST * NOTE_SECONDS + 0.02);
}

/**
 * Rings until stopped or until the ring expires: two seconds of a synthesized
 * trill, four of silence, with a vibration pattern per burst where the device
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

/** Three falling notes, the sound of a call ending. */
const HANG_UP_NOTES_HZ = [784, 659.25, 523.25] as const;
const HANG_UP_NOTE_SECONDS = 0.13;

/**
 * Plays the hang-up sound once a connected call ends, from either side.
 * Best-effort like the ring: no audio is never a reason anything fails.
 */
export function playHangUpTone(volume: number): void {
  if (typeof AudioContext === "undefined") return;
  let context: AudioContext;
  try {
    context = new AudioContext();
  } catch {
    return;
  }
  try {
    const start = context.currentTime + 0.02;
    const peak = PEAK_GAIN * Math.min(Math.max(volume, 0), 1);
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    gain.gain.setValueAtTime(0.0001, start);
    HANG_UP_NOTES_HZ.forEach((frequency, index) => {
      const at = start + index * HANG_UP_NOTE_SECONDS;
      oscillator.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.linearRampToValueAtTime(peak, at + 0.012);
      gain.gain.linearRampToValueAtTime(0.0001, at + HANG_UP_NOTE_SECONDS * 0.9);
    });
    const end = start + HANG_UP_NOTES_HZ.length * HANG_UP_NOTE_SECONDS;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(end);
    oscillator.addEventListener("ended", () => void context.close().catch(() => undefined));
  } catch {
    void context.close().catch(() => undefined);
  }
}
