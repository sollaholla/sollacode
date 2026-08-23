/**
 * A faithful stand-in for the browser audio and socket surface the voice
 * session runs on.
 *
 * The session's hardest bugs are all timing between three things it does not
 * own: frames from the provider, audio the platform schedules, and the clock.
 * Every one of them was previously faked by hand, per test file, with whatever
 * shape that test happened to need — and a fake that is only as complete as
 * the test using it cannot fail. The stuck-on-"Speaking" bug lived behind a
 * `createBufferSource` whose `addEventListener` discarded its argument: the
 * session waits for `ended` on every scheduled buffer before it reopens the
 * microphone, and in tests that event could never arrive, so no test could
 * tell a session that drains from one that hangs forever.
 *
 * So this models the parts the session actually depends on rather than the
 * parts a test wants to observe:
 *
 * - `currentTime` advances with the virtual clock, as an audio clock does.
 * - A buffer scheduled at `t` fires `ended` at `t + duration`, once, and only
 *   if it was not stopped first.
 * - `suspend()` freezes the audio clock while wall time keeps moving, which is
 *   what a phone does when it locks or takes a call, and is the one condition
 *   under which `ended` legitimately never arrives.
 *
 * The point is that a scenario written against it is a claim about the
 * platform, checkable against a real recording of one.
 */

/** A scheduled buffer, from the harness's side. */
interface ScheduledSource {
  readonly startedAt: number;
  readonly duration: number;
  readonly fireEnded: () => void;
  stopped: boolean;
  ended: boolean;
}

export interface VoiceHarnessAudio {
  /** Audio-clock seconds, frozen while suspended. */
  readonly currentTime: number;
  /** Buffers scheduled but not yet ended or stopped. */
  readonly pending: number;
  /** Freezes the audio clock the way a locked phone does. */
  suspendClock(): void;
  resumeClock(): void;
  /** Advances the audio clock by `ms`, firing every `ended` that falls due. */
  advance(ms: number): void;
}

/**
 * Builds the AudioContext constructor the session will call, plus a handle for
 * driving it.
 *
 * One context object is shared by capture, playback and cue tones, matching the
 * session's own rule that it opens at most one.
 */
export function createHarnessAudioContext(): {
  readonly constructor: unknown;
  readonly audio: VoiceHarnessAudio;
  readonly captureProcessors: ReadonlyArray<CaptureProcessor>;
  readonly cueFrequencies: ReadonlyArray<number>;
} {
  let audioClockMs = 0;
  let suspended = false;
  const scheduled: ScheduledSource[] = [];
  const captureProcessors: CaptureProcessor[] = [];
  const cueFrequencies: number[] = [];

  const fireDue = () => {
    // Snapshot: an `ended` handler can schedule more audio, and that new
    // buffer must not be considered due in this same pass.
    for (const source of [...scheduled]) {
      if (source.stopped || source.ended) continue;
      if (audioClockMs + 1e-6 < (source.startedAt + source.duration) * 1_000) continue;
      source.ended = true;
      source.fireEnded();
    }
  };

  const audio: VoiceHarnessAudio = {
    get currentTime() {
      return audioClockMs / 1_000;
    },
    get pending() {
      return scheduled.filter((source) => !source.stopped && !source.ended).length;
    },
    suspendClock: () => {
      suspended = true;
    },
    resumeClock: () => {
      suspended = false;
    },
    advance: (ms: number) => {
      if (suspended) return;
      audioClockMs += ms;
      fireDue();
    },
  };

  function AudioContextMock(this: Record<string, unknown>) {
    this.destination = {};
    Object.defineProperty(this, "currentTime", { get: () => audioClockMs / 1_000 });
    this.sampleRate = 24_000;
    this.state = "running";
    this.resume = async () => undefined;
    this.close = async () => undefined;
    this.createMediaStreamSource = () => ({
      connect: () => undefined,
      disconnect: () => undefined,
    });
    this.createMediaStreamDestination = () => ({ stream: { getAudioTracks: () => [] } });
    this.createAnalyser = () => ({
      fftSize: 0,
      frequencyBinCount: 16,
      getByteFrequencyData: () => undefined,
      getByteTimeDomainData: () => undefined,
      connect: () => undefined,
      disconnect: () => undefined,
    });
    this.createScriptProcessor = () => {
      const node: CaptureProcessor = {
        connect: () => undefined,
        disconnect: () => undefined,
        onaudioprocess: null,
        speak: (level = 0.2, frames = 8) =>
          node.onaudioprocess?.({
            inputBuffer: { getChannelData: () => new Float32Array(frames).fill(level) },
          }),
      };
      captureProcessors.push(node);
      return node;
    };
    this.createGain = () => ({
      gain: {
        value: 1,
        setValueAtTime: () => undefined,
        linearRampToValueAtTime: () => undefined,
        cancelScheduledValues: () => undefined,
      },
      connect: () => undefined,
      disconnect: () => undefined,
    });
    this.createBuffer = (_channels: number, frameCount: number, sampleRate: number) => ({
      duration: frameCount / sampleRate,
      copyToChannel: () => undefined,
      getChannelData: () => new Float32Array(frameCount),
    });
    this.createBufferSource = () => {
      const listeners: Array<() => void> = [];
      let entry: ScheduledSource | null = null;
      return {
        buffer: null as { duration: number } | null,
        connect: () => undefined,
        disconnect: () => undefined,
        addEventListener: (type: string, listener: () => void) => {
          if (type === "ended") listeners.push(listener);
        },
        start(this: { buffer: { duration: number } | null }, when = 0) {
          entry = {
            startedAt: when,
            duration: this.buffer?.duration ?? 0,
            stopped: false,
            ended: false,
            // Snapshot: a handler may schedule the next chunk, and the array
            // it lands in must not be the one being iterated.
            fireEnded: () => {
              for (const listener of [...listeners]) listener();
            },
          };
          scheduled.push(entry);
        },
        stop: () => {
          if (entry !== null) entry.stopped = true;
        },
      };
    };
    this.createOscillator = () => ({
      type: "sine",
      frequency: {
        value: 0,
        setValueAtTime: (value: number) => cueFrequencies.push(value),
        linearRampToValueAtTime: () => undefined,
      },
      connect: () => undefined,
      disconnect: () => undefined,
      start: () => undefined,
      stop: () => undefined,
    });
  }

  return {
    constructor: AudioContextMock,
    audio,
    captureProcessors,
    cueFrequencies,
  };
}

export interface CaptureProcessor {
  connect: () => void;
  disconnect: () => void;
  onaudioprocess:
    | ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void)
    | null;
  /** Pushes one buffer of captured audio, as the platform does ~every 21ms. */
  speak: (level?: number, frames?: number) => void;
}

export interface HarnessSocket {
  /** Frames the session sent, in order, parsed. */
  readonly sent: ReadonlyArray<Record<string, unknown>>;
  readonly sentTypes: ReadonlyArray<string>;
  /** Delivers one frame from the provider. */
  deliver: (frame: Record<string, unknown>) => void;
  /** Drops the connection the way a network does. */
  close: (code?: number) => void;
  clearSent: () => void;
}

/** Builds the WebSocket constructor the Grok transport will call. */
export function createHarnessSocket(): {
  readonly constructor: unknown;
  /** Resolves once the session has opened a socket. */
  readonly sockets: ReadonlyArray<HarnessSocket>;
} {
  const sockets: HarnessSocket[] = [];

  function WebSocketMock(this: Record<string, unknown>) {
    const listeners = new Map<string, Array<(event: unknown) => void>>();
    const sent: Array<Record<string, unknown>> = [];
    // Snapshot, so a listener that removes itself while handling does not
    // make the loop skip the next one.
    const fire = (type: string, event: unknown) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    };
    this.readyState = 0;
    this.send = (payload: string) => {
      try {
        sent.push(JSON.parse(payload) as Record<string, unknown>);
      } catch {
        sent.push({ type: "<binary>" });
      }
    };
    this.close = () => {
      this.readyState = 3;
    };
    this.addEventListener = (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    };
    this.removeEventListener = (type: string, listener: (event: unknown) => void) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((entry) => entry !== listener),
      );
    };
    sockets.push({
      get sent() {
        return sent;
      },
      get sentTypes() {
        return sent.map((frame) => String(frame.type));
      },
      deliver: (frame) => fire("message", { data: JSON.stringify(frame) }),
      close: (code = 1_006) => {
        this.readyState = 3;
        fire("close", { code });
      },
      clearSent: () => sent.splice(0),
    });
    queueMicrotask(() => {
      this.readyState = 1;
      fire("open", {});
    });
  }
  (WebSocketMock as unknown as { OPEN: number }).OPEN = 1;

  return { constructor: WebSocketMock, sockets };
}
