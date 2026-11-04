/**
 * What the orchestrator sounds like while it works on a voice request: a low,
 * slowly breathing hum under short runs of soft data blips, like a ship's
 * console in the background. Agent calls have desk typing for the same job
 * (`phoneLine.ts`); this is the orchestrator's own, and it follows the same
 * rules: only while work runs and the voice is quiet, at the cue volume, and
 * synthesised, so there is nothing to load.
 */

/** One blip, `gap` seconds after the one before it. */
export interface AmbienceBeat {
  readonly gap: number;
  /** Starting pitch in hertz; each blip glides a little upward. */
  readonly frequency: number;
  /** Seconds the blip lasts. */
  readonly length: number;
  /** A slower, quieter sweep instead of a blip, now and then. */
  readonly sweep: boolean;
}

/** A pentatonic set, so any run of blips sounds deliberate rather than random. */
const BLIP_PITCHES = [1_318.5, 1_568, 1_760, 2_093, 2_349.3] as const;

const between = (random: () => number, low: number, high: number) => low + random() * (high - low);

/**
 * Blips without end: groups of two to five close together, then a pause, with
 * a slow sweep in place of a group about one time in six.
 */
export function* ambienceBeats(random: () => number = Math.random): Generator<AmbienceBeat, never> {
  let first = true;
  while (true) {
    const pause = first ? between(random, 0.3, 0.6) : between(random, 0.9, 2.6);
    first = false;
    if (random() < 1 / 6) {
      yield { gap: pause, frequency: between(random, 380, 460), length: 0.42, sweep: true };
      continue;
    }
    const count = 2 + Math.floor(random() * 4);
    for (let index = 0; index < count; index += 1) {
      const pitch = BLIP_PITCHES[Math.floor(random() * BLIP_PITCHES.length)] ?? BLIP_PITCHES[0];
      yield {
        gap: index === 0 ? pause : between(random, 0.08, 0.16),
        frequency: pitch,
        length: between(random, 0.035, 0.07),
        sweep: false,
      };
    }
  }
}

/** Level of the hum at full cue volume: felt more than heard. */
const HUM_GAIN = 0.018;
/** Level of a blip at full cue volume: under speech, like the cues. */
const BLIP_GAIN = 0.032;
const LOOKAHEAD_SECONDS = 0.35;

export interface WorkingAmbience {
  /** Plays while active; going inactive fades everything out. */
  setActive(active: boolean): void;
  /** Schedules the next fraction of a second. Call it about every 100 ms while active. */
  pump(): void;
  dispose(): void;
}

export function createWorkingAmbience(input: {
  readonly context: AudioContext;
  readonly destination: AudioNode;
  /** Read for every sound, 0 to 1, so a volume change lands at once and 0 is silent. */
  readonly volume: () => number;
  readonly random?: () => number;
}): WorkingAmbience {
  const { context, destination, volume } = input;
  const random = input.random ?? Math.random;
  let run: {
    readonly beats: Generator<AmbienceBeat, never>;
    pending: AmbienceBeat | null;
    next: number;
    readonly gain: GainNode;
    readonly stopHum: (at: number) => void;
  } | null = null;
  const level = () => Math.min(Math.max(volume(), 0), 1);

  /** Two detuned tones and a fifth, through a filter that slowly opens and closes. */
  const startHum = (output: GainNode) => {
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 520;
    filter.Q.value = 2;
    const lfo = context.createOscillator();
    lfo.frequency.value = 0.13;
    const lfoDepth = context.createGain();
    lfoDepth.gain.value = 260;
    lfo.connect(lfoDepth);
    lfoDepth.connect(filter.frequency);
    const hum = context.createGain();
    const now = context.currentTime;
    hum.gain.setValueAtTime(0.0001, now);
    hum.gain.linearRampToValueAtTime(Math.max(HUM_GAIN * level(), 0.0001), now + 0.8);
    filter.connect(hum);
    hum.connect(output);
    const tones = [98, 98.6, 146.8].map((frequency, index) => {
      const tone = context.createOscillator();
      tone.type = index === 2 ? "sine" : "triangle";
      tone.frequency.value = frequency;
      tone.connect(filter);
      tone.start(now);
      return tone;
    });
    lfo.start(now);
    return (at: number) => {
      for (const node of [...tones, lfo]) node.stop(at + 0.05);
    };
  };

  const blip = (output: GainNode, at: number, beat: AmbienceBeat) => {
    const peak = (beat.sweep ? BLIP_GAIN * 0.45 : BLIP_GAIN) * level() * (0.6 + random() * 0.4);
    if (peak <= 0) return;
    const tone = context.createOscillator();
    tone.type = beat.sweep ? "sine" : "triangle";
    tone.frequency.setValueAtTime(beat.frequency, at);
    tone.frequency.exponentialRampToValueAtTime(
      beat.frequency * (beat.sweep ? 2.1 : 1.12),
      at + beat.length,
    );
    const envelope = context.createGain();
    // Ramped, never switched: a hard edge is a click of its own.
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.linearRampToValueAtTime(peak, at + Math.min(0.006, beat.length / 4));
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + beat.length);
    tone.connect(envelope);
    envelope.connect(output);
    tone.start(at);
    tone.stop(at + beat.length + 0.02);
  };

  const stop = () => {
    if (!run) return;
    const { gain, stopHum } = run;
    run = null;
    const now = context.currentTime;
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + 0.4);
    stopHum(now + 0.4);
    setTimeout(() => gain.disconnect(), 600);
  };

  return {
    setActive: (active) => {
      if (!active) {
        stop();
        return;
      }
      if (run) return;
      const gain = context.createGain();
      gain.connect(destination);
      run = {
        beats: ambienceBeats(random),
        pending: null,
        next: context.currentTime + 0.05,
        gain,
        stopHum: startHum(gain),
      };
    },
    pump: () => {
      if (!run) return;
      const now = context.currentTime;
      const horizon = now + LOOKAHEAD_SECONDS;
      for (let guard = 0; guard < 64; guard += 1) {
        const beat = run.pending ?? run.beats.next().value;
        let at = run.next + beat.gap;
        if (at < now) {
          // A backgrounded tab stalls the clock: pick up from now rather than
          // playing everything that was missed at once.
          at = now + 0.02;
        }
        if (at > horizon) {
          run.pending = beat;
          return;
        }
        run.pending = null;
        blip(run.gain, at, beat);
        run.next = at;
      }
    },
    dispose: stop,
  };
}
