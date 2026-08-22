/**
 * Cleaning up the microphone before anything else hears it.
 *
 * Two capture sites — the realtime orchestrator session and push-to-talk — were
 * each asking for the same three browser audio constraints, independently. That
 * duplication is what this module replaces first: one place that decides what a
 * microphone request should ask for, so the two cannot drift.
 *
 * On top of that sits an optional processing stage for the realtime path. It is
 * pure DSP running inside an AudioWorklet — a noise gate with hysteresis over
 * an adaptive noise floor — and deliberately *not* a neural denoiser. This
 * build has no `SharedArrayBuffer` (no COOP/COEP headers anywhere), so ONNX
 * inference cannot share memory with the audio thread; moving 48 kHz audio
 * worklet → worker → back by `postMessage` is roughly 375 copies a second, and
 * a single stall becomes a dropout in the outgoing stream. Corrupting the audio
 * is worse than the noise it would remove. Steady-state noise — fans, hum,
 * traffic, a keyboard — is what users actually complain about, and a gate
 * handles it at sub-millisecond latency with no inference at all.
 *
 * Every failure path returns the raw stream. A broken worklet must never cost
 * someone their microphone.
 */

/**
 * `voiceIsolation` is Chrome-only and unknown constraints throw in some
 * browsers, so it is requested only where the browser admits to knowing it.
 */
export function supportsVoiceIsolation(
  mediaDevices?: { getSupportedConstraints?: () => Record<string, unknown> } | undefined,
): boolean {
  const devices =
    mediaDevices ??
    (typeof navigator === "undefined" ? undefined : (navigator.mediaDevices as never));
  if (devices === undefined) return false;
  const supported = devices.getSupportedConstraints?.();
  if (supported === undefined || supported === null) return false;
  return Object.hasOwn(supported, "voiceIsolation");
}

/**
 * The audio constraints every microphone request in the app should use.
 *
 * `voiceIsolation` is the platform's own speech isolation — free where it
 * exists, and strictly better than anything done in-process, so it is asked for
 * unconditionally rather than behind the setting that gates the worklet.
 */
export function microphoneConstraints(
  input: { readonly isolationSupported?: boolean } = {},
): MediaTrackConstraints {
  const isolation = input.isolationSupported ?? supportsVoiceIsolation();
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(isolation ? ({ voiceIsolation: true } as MediaTrackConstraints) : {}),
  };
}

/** Gate parameters, exported so the worklet source and the tests agree. */
export const GATE_ATTACK_SECONDS = 0.006;
export const GATE_RELEASE_SECONDS = 0.12;
/** How far above the running noise floor a frame must sit to open the gate. */
export const GATE_OPEN_MARGIN_DB = 9;
/** And how far it must fall back before closing — the hysteresis. */
export const GATE_CLOSE_MARGIN_DB = 4;
/** Never fully mute: a hard gate makes speech onsets click and sound clipped. */
export const GATE_FLOOR_GAIN = 0.06;

/**
 * Whether the gate should be open for a frame at `levelDb` given a noise floor.
 *
 * Split out as a pure function because web tests run in node with no DOM and no
 * `AudioContext` — the graph wiring can only be verified by hand, so the part
 * that decides anything must be testable on its own.
 */
export function shouldGateOpen(input: {
  readonly levelDb: number;
  readonly noiseFloorDb: number;
  readonly wasOpen: boolean;
}): boolean {
  const margin = input.levelDb - input.noiseFloorDb;
  // Hysteresis: a higher bar to open than to stay open, so a voice hovering at
  // the threshold does not chatter the gate on and off syllable by syllable.
  return input.wasOpen ? margin > GATE_CLOSE_MARGIN_DB : margin > GATE_OPEN_MARGIN_DB;
}

/**
 * Tracks the quietest recent level as the noise floor.
 *
 * Rises slowly and falls quickly: a room that gets noisier should be adapted to
 * gradually, but a genuinely quiet moment is the best evidence of the floor and
 * should be believed at once. The reverse — fast rise — lets a long sentence
 * drag the floor up until the gate closes over the speaker.
 */
export function updateNoiseFloor(input: {
  readonly current: number;
  readonly levelDb: number;
}): number {
  if (!Number.isFinite(input.levelDb)) return input.current;
  if (input.levelDb < input.current) {
    return input.current + (input.levelDb - input.current) * 0.5;
  }
  return input.current + (input.levelDb - input.current) * 0.0008;
}

/** The worklet, as source, so it can be registered from a blob URL. */
export const GATE_WORKLET_SOURCE = `
const ATTACK = ${GATE_ATTACK_SECONDS};
const RELEASE = ${GATE_RELEASE_SECONDS};
const OPEN_MARGIN = ${GATE_OPEN_MARGIN_DB};
const CLOSE_MARGIN = ${GATE_CLOSE_MARGIN_DB};
const FLOOR_GAIN = ${GATE_FLOOR_GAIN};

class VoiceGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.noiseFloorDb = -60;
    this.gain = 1;
    this.open = false;
    this.bypass = false;
    this.port.onmessage = (event) => {
      if (event.data && typeof event.data.bypass === "boolean") this.bypass = event.data.bypass;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output) return true;

    let sumSquares = 0;
    let count = 0;
    for (const channel of input) {
      for (let i = 0; i < channel.length; i += 1) {
        sumSquares += channel[i] * channel[i];
        count += 1;
      }
    }
    const rms = count === 0 ? 0 : Math.sqrt(sumSquares / count);
    const levelDb = rms > 0 ? 20 * Math.log10(rms) : -120;

    if (levelDb < this.noiseFloorDb) {
      this.noiseFloorDb += (levelDb - this.noiseFloorDb) * 0.5;
    } else {
      this.noiseFloorDb += (levelDb - this.noiseFloorDb) * 0.0008;
    }

    const margin = levelDb - this.noiseFloorDb;
    this.open = this.open ? margin > CLOSE_MARGIN : margin > OPEN_MARGIN;

    const target = this.bypass || this.open ? 1 : FLOOR_GAIN;
    const seconds = 128 / sampleRate;
    const coefficient = 1 - Math.exp(-seconds / (target > this.gain ? ATTACK : RELEASE));
    this.gain += (target - this.gain) * coefficient;

    for (let channelIndex = 0; channelIndex < output.length; channelIndex += 1) {
      const source = input[Math.min(channelIndex, input.length - 1)];
      const destination = output[channelIndex];
      if (!source || !destination) continue;
      for (let i = 0; i < destination.length; i += 1) {
        destination[i] = source[i] * this.gain;
      }
    }
    return true;
  }
}

registerProcessor("voice-gate", VoiceGateProcessor);
`;

export interface VoiceIsolationResult {
  /** The stream to send. The raw one whenever isolation could not be built. */
  readonly stream: MediaStream;
  /** Stops the processing graph. Safe to call when nothing was built. */
  readonly release: () => void;
  readonly applied: boolean;
}

/**
 * Wraps a microphone stream in the gate, or hands it straight back.
 *
 * The context is injected so a caller can share the one it already has, and so
 * this is not hard-wired to a global that does not exist in tests.
 */
export async function applyVoiceIsolation(input: {
  readonly stream: MediaStream;
  readonly context: AudioContext | null;
  readonly enabled: boolean;
}): Promise<VoiceIsolationResult> {
  const passthrough: VoiceIsolationResult = {
    stream: input.stream,
    release: () => undefined,
    applied: false,
  };
  if (!input.enabled) return passthrough;
  const context = input.context;
  if (context === null || typeof context.createMediaStreamSource !== "function") {
    return passthrough;
  }
  if (context.audioWorklet === undefined) return passthrough;

  let objectUrl: string | null = null;
  try {
    const blob = new Blob([GATE_WORKLET_SOURCE], { type: "application/javascript" });
    objectUrl = URL.createObjectURL(blob);
    await context.audioWorklet.addModule(objectUrl);

    const source = context.createMediaStreamSource(input.stream);
    const gate = new AudioWorkletNode(context, "voice-gate");
    const destination = context.createMediaStreamDestination();
    source.connect(gate);
    gate.connect(destination);

    return {
      stream: destination.stream,
      applied: true,
      release: () => {
        // Ordered outward-in so nothing is left connected to a disposed node.
        try {
          gate.disconnect();
          source.disconnect();
        } catch {
          // A context already closed disposes its nodes; nothing to undo.
        }
        // The destination's track is ours and outlives the graph otherwise —
        // one leaked track per session, held open against the device.
        for (const track of destination.stream.getTracks()) track.stop();
      },
    };
  } catch {
    // Any failure at all — no worklet support, a blocked blob URL, a context in
    // the wrong state — leaves the user with a working microphone.
    return passthrough;
  } finally {
    if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
  }
}
