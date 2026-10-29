/**
 * What makes an agent call sound like a phone call: the line the agent's voice
 * comes down, and the desk it works at while you wait.
 *
 * Both run on the call's own AudioContext. The voice is filtered where it
 * plays, and the desk sounds are short bursts of filtered noise scheduled a
 * fraction of a second ahead, so there are no assets to load and nothing runs
 * while the desk is quiet.
 */

/** A handset's passband: a telephone channel carries roughly 300 Hz to 3.4 kHz. */
const LINE_LOW_HZ = 300;
const LINE_HIGH_HZ = 3_400;
/** The bump around 2 kHz that makes a phone voice sound forward and slightly nasal. */
const LINE_PRESENCE_HZ = 1_900;
const LINE_PRESENCE_DB = 4;
/** Make-up gain after the band is cut, so the call is not quieter than before. */
const LINE_MAKEUP_GAIN = 1.5;
/** How hard the line's soft clipper is driven: a little grit, never distortion. */
const LINE_DRIVE = 1.6;

/**
 * The soft clipper's transfer curve: `tanh` normalised so full scale stays
 * full scale. Close to linear for speech-level input, and bounded at ±1, so
 * the make-up gain can never clip the output.
 */
export function lineDriveCurve(
  samples: number,
  drive: number = LINE_DRIVE,
): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(samples);
  const scale = Math.tanh(drive);
  for (let index = 0; index < samples; index += 1) {
    const x = (index / (samples - 1)) * 2 - 1;
    curve[index] = Math.tanh(drive * x) / scale;
  }
  return curve;
}

export interface PhoneLine {
  /** Connect anything that should sound as if it came down the line. */
  readonly input: AudioNode;
  /** Silences what the line plays and restores it, as a mute would. */
  setMuted(muted: boolean): void;
  disconnect(): void;
}

/**
 * A telephone channel into the context's speakers: band-limited, a presence
 * bump, an automatic gain control's compression, and a soft clip. Built from
 * stock nodes, so it costs nothing while nothing plays into it.
 */
export function createPhoneLine(context: AudioContext): PhoneLine {
  const lowCut = context.createBiquadFilter();
  lowCut.type = "highpass";
  lowCut.frequency.value = LINE_LOW_HZ;
  lowCut.Q.value = 0.9;
  const highCut = context.createBiquadFilter();
  highCut.type = "lowpass";
  highCut.frequency.value = LINE_HIGH_HZ;
  highCut.Q.value = 0.9;
  // A second cut on each side gives the steep edges that make it a phone.
  const lowCutSteep = context.createBiquadFilter();
  lowCutSteep.type = "highpass";
  lowCutSteep.frequency.value = LINE_LOW_HZ;
  lowCutSteep.Q.value = 0.6;
  const highCutSteep = context.createBiquadFilter();
  highCutSteep.type = "lowpass";
  highCutSteep.frequency.value = LINE_HIGH_HZ;
  highCutSteep.Q.value = 0.6;
  const presence = context.createBiquadFilter();
  presence.type = "peaking";
  presence.frequency.value = LINE_PRESENCE_HZ;
  presence.Q.value = 1;
  presence.gain.value = LINE_PRESENCE_DB;
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -26;
  compressor.knee.value = 8;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.2;
  const makeup = context.createGain();
  makeup.gain.value = LINE_MAKEUP_GAIN;
  const clip = context.createWaveShaper();
  clip.curve = lineDriveCurve(1_024);
  clip.oversample = "2x";
  const output = context.createGain();
  output.gain.value = 1;
  const chain: ReadonlyArray<AudioNode> = [
    lowCut,
    lowCutSteep,
    highCut,
    highCutSteep,
    presence,
    compressor,
    makeup,
    clip,
    output,
  ];
  chain.forEach((node, index) => node.connect(chain[index + 1] ?? context.destination));
  return {
    input: lowCut,
    setMuted: (muted) => {
      output.gain.setValueAtTime(muted ? 0 : 1, context.currentTime);
    },
    disconnect: () => {
      for (const node of chain) node.disconnect();
    },
  };
}

export type DeskSound = "key" | "space" | "backspace" | "click";

/** One sound at the desk, `gap` seconds after the one before it. */
export interface DeskBeat {
  readonly gap: number;
  readonly sound: DeskSound;
}

/** Seconds between keystrokes inside a word: a quick, uneven typist. */
function keyGap(random: () => number): number {
  const hesitation = random() < 0.08 ? 0.12 + random() * 0.2 : 0;
  return 0.075 + random() * 0.11 + hesitation;
}

function count(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * Someone working at a desk, without end: a click into the window, words
 * typed in bursts with a space after each, now and then a typo backed out and
 * retyped, and pauses to read with a click or a double-click in them.
 */
export function* deskBeats(random: () => number = Math.random): Generator<DeskBeat, never> {
  yield { gap: 0.2 + random() * 0.3, sound: "click" };
  let pause = 0.35 + random() * 0.4;
  for (;;) {
    const words = count(random, 2, 8);
    for (let word = 0; word < words; word += 1) {
      const letters = count(random, 2, 8);
      for (let letter = 0; letter < letters; letter += 1) {
        yield { gap: pause + keyGap(random), sound: "key" };
        pause = 0;
      }
      if (random() < 0.1) {
        const typo = count(random, 1, 3);
        // Noticing it takes a moment; holding backspace does not.
        yield { gap: 0.25 + random() * 0.3, sound: "backspace" };
        for (let key = 1; key < typo; key += 1)
          yield { gap: 0.08 + random() * 0.04, sound: "backspace" };
        for (let key = 0; key < typo; key += 1) yield { gap: keyGap(random), sound: "key" };
      }
      yield { gap: keyGap(random), sound: "space" };
    }
    // Reading what came back, or reaching for the mouse.
    const rest = 0.8 + random() * 2.6;
    if (random() < 0.5) {
      const reach = rest * (0.3 + random() * 0.4);
      yield { gap: reach, sound: "click" };
      let after = rest - reach;
      if (random() < 0.3) {
        const second = 0.13 + random() * 0.06;
        yield { gap: second, sound: "click" };
        after = Math.max(after - second, 0.2);
      }
      pause = after;
    } else {
      pause = rest;
    }
  }
}

/** Overall level of the desk at full cue volume: background, under the voice. */
const DESK_GAIN = 0.12;
/** How far ahead of the context clock desk sounds are scheduled, in seconds. */
const DESK_LOOKAHEAD_SECONDS = 0.35;
const NOISE_SECONDS = 0.25;

interface Hit {
  /** Centre of the noise band, in hertz. */
  readonly centre: number;
  readonly q: number;
  /** Seconds until the hit has died away. */
  readonly decay: number;
  /** Relative to the desk's level. */
  readonly gain: number;
}

export interface DeskSounds {
  /** Typing while active; going inactive fades out what is already scheduled. */
  setActive(active: boolean): void;
  /**
   * Schedules the next fraction of a second on the context clock. Call it
   * often while active; the voice session's level meter does, every 100 ms.
   */
  pump(): void;
  dispose(): void;
}

/**
 * Plays {@link deskBeats} into `destination` (the phone line). `volume` is
 * read for every sound, 0 to 1, so a cue-volume change lands at once and 0
 * plays nothing.
 */
export function createDeskSounds(input: {
  readonly context: AudioContext;
  readonly destination: AudioNode;
  readonly volume: () => number;
  readonly random?: () => number;
}): DeskSounds {
  const { context, destination, volume } = input;
  const random = input.random ?? Math.random;
  let noise: AudioBuffer | null = null;
  let run: {
    readonly beats: Generator<DeskBeat, never>;
    /** The beat that was not due yet when the last pump stopped. */
    pending: DeskBeat | null;
    /** When the beat before `pending` sounds, on the context clock. */
    next: number;
    readonly gain: GainNode;
  } | null = null;
  const faded = new Set<GainNode>();

  const noiseBuffer = () => {
    if (noise) return noise;
    const buffer = context.createBuffer(
      1,
      Math.ceil(context.sampleRate * NOISE_SECONDS),
      context.sampleRate,
    );
    const data = buffer.getChannelData(0);
    for (let index = 0; index < data.length; index += 1) data[index] = random() * 2 - 1;
    noise = buffer;
    return buffer;
  };

  const hit = (gain: GainNode, at: number, shape: Hit, level: number) => {
    const source = context.createBufferSource();
    source.buffer = noiseBuffer();
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = shape.centre;
    band.Q.value = shape.q;
    const envelope = context.createGain();
    const peak = Math.max(shape.gain * level, 0.0002);
    // Ramped, never switched: a hard edge would be a click of its own.
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.linearRampToValueAtTime(peak, at + 0.0015);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + shape.decay);
    source.connect(band);
    band.connect(envelope);
    envelope.connect(gain);
    const offset = random() * (NOISE_SECONDS - shape.decay - 0.02);
    source.start(at, Math.max(offset, 0), shape.decay + 0.02);
  };

  /** A sound, with its key or button coming back up after it. */
  const play = (gain: GainNode, at: number, sound: DeskSound) => {
    const level = DESK_GAIN * Math.min(Math.max(volume(), 0), 1) * (0.7 + random() * 0.6);
    if (level <= 0) return;
    const spread = (centre: number, by: number) => centre * (1 - by + random() * by * 2);
    switch (sound) {
      case "key":
      case "backspace": {
        const top = sound === "key" ? 2_900 : 2_300;
        hit(gain, at, { centre: spread(top, 0.2), q: 1.4, decay: 0.018, gain: 1 }, level);
        hit(gain, at, { centre: spread(650, 0.2), q: 1, decay: 0.032, gain: 0.5 }, level);
        const up = at + 0.065 + random() * 0.045;
        hit(gain, up, { centre: spread(3_400, 0.15), q: 2, decay: 0.012, gain: 0.35 }, level);
        return;
      }
      case "space": {
        hit(gain, at, { centre: spread(1_500, 0.15), q: 1.2, decay: 0.03, gain: 0.9 }, level);
        hit(gain, at, { centre: spread(300, 0.15), q: 0.9, decay: 0.06, gain: 0.8 }, level);
        const up = at + 0.085 + random() * 0.045;
        hit(gain, up, { centre: spread(1_900, 0.15), q: 1.5, decay: 0.02, gain: 0.4 }, level);
        return;
      }
      case "click": {
        hit(gain, at, { centre: spread(3_100, 0.1), q: 3, decay: 0.007, gain: 0.9 }, level);
        hit(gain, at, { centre: spread(1_800, 0.1), q: 4, decay: 0.011, gain: 0.4 }, level);
        const up = at + 0.07 + random() * 0.03;
        hit(gain, up, { centre: spread(3_300, 0.1), q: 3, decay: 0.006, gain: 0.45 }, level);
        return;
      }
    }
  };

  const stop = () => {
    if (!run) return;
    const { gain } = run;
    run = null;
    // Sounds already scheduled play into a gain that is fading to silence.
    const now = context.currentTime;
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + 0.04);
    faded.add(gain);
  };

  return {
    setActive: (active) => {
      if (!active) {
        stop();
        return;
      }
      if (run) return;
      // Earlier runs have long finished by the time another starts.
      for (const gain of faded) gain.disconnect();
      faded.clear();
      const gain = context.createGain();
      gain.connect(destination);
      run = { beats: deskBeats(random), pending: null, next: context.currentTime + 0.05, gain };
    },
    pump: () => {
      if (!run) return;
      const now = context.currentTime;
      const horizon = now + DESK_LOOKAHEAD_SECONDS;
      for (let guard = 0; guard < 64; guard += 1) {
        const beat = run.pending ?? run.beats.next().value;
        let at = run.next + beat.gap;
        if (at < now) {
          // Missed (a backgrounded tab stalls the clock): picks up from now
          // instead of playing everything it missed at once.
          at = now + 0.02;
          run.next = at - beat.gap;
        }
        if (at > horizon) {
          run.pending = beat;
          return;
        }
        run.pending = null;
        play(run.gain, at, beat.sound);
        run.next = at;
      }
    },
    dispose: () => {
      stop();
      for (const gain of faded) gain.disconnect();
      faded.clear();
    },
  };
}
