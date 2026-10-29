/**
 * A recording stand-in for the Web Audio nodes the phone line and desk sounds
 * build, so tests can read the graph and its scheduled automation. The clock
 * is `now()` in seconds, so a test drives it with the fake timers.
 */

export interface FakeParam {
  value: number;
  readonly calls: Array<{ readonly method: string; readonly value: number; readonly at: number }>;
  setValueAtTime(value: number, at: number): void;
  linearRampToValueAtTime(value: number, at: number): void;
  exponentialRampToValueAtTime(value: number, at: number): void;
}

export interface FakeNode {
  readonly kind: string;
  readonly connections: Array<FakeNode | object>;
  disconnected: boolean;
  type?: string;
  readonly gain: FakeParam;
  readonly frequency: FakeParam;
  readonly Q: FakeParam;
  readonly threshold: FakeParam;
  readonly knee: FakeParam;
  readonly ratio: FakeParam;
  readonly attack: FakeParam;
  readonly release: FakeParam;
  curve?: Float32Array | null;
  oversample?: string;
  buffer?: unknown;
  readonly starts: Array<{
    readonly at: number;
    readonly offset: number;
    readonly duration: number;
  }>;
  connect(target: FakeNode | object): void;
  disconnect(): void;
  start(at: number, offset?: number, duration?: number): void;
}

function param(initial: number): FakeParam {
  const calls: FakeParam["calls"] = [];
  const record = (method: string) => (value: number, at: number) => {
    calls.push({ method, value, at });
  };
  return {
    value: initial,
    calls,
    setValueAtTime: record("set"),
    linearRampToValueAtTime: record("linear"),
    exponentialRampToValueAtTime: record("exponential"),
  };
}

export function createFakeAudioGraph(now: () => number = () => 0) {
  const nodes: FakeNode[] = [];
  const destination = { kind: "destination" };
  const node = (kind: string): FakeNode => {
    const created: FakeNode = {
      kind,
      connections: [],
      disconnected: false,
      gain: param(1),
      frequency: param(350),
      Q: param(1),
      threshold: param(-24),
      knee: param(30),
      ratio: param(12),
      attack: param(0.003),
      release: param(0.25),
      starts: [],
      connect(target) {
        created.connections.push(target);
      },
      disconnect() {
        created.disconnected = true;
      },
      start(at, offset = 0, duration = 0) {
        created.starts.push({ at, offset, duration });
      },
    };
    nodes.push(created);
    return created;
  };
  const context = {
    destination,
    sampleRate: 48_000,
    get currentTime() {
      return now();
    },
    createBiquadFilter: () => node("biquad"),
    createDynamicsCompressor: () => node("compressor"),
    createGain: () => node("gain"),
    createWaveShaper: () => node("shaper"),
    createBufferSource: () => node("source"),
    createBuffer: (_channels: number, frames: number, sampleRate: number) => {
      const data = new Float32Array(frames);
      return { duration: frames / sampleRate, getChannelData: () => data };
    },
  };
  return {
    /** Typed as the real thing for the code under test. */
    context: context as unknown as AudioContext,
    destination,
    nodes,
    ofKind: (kind: string) => nodes.filter((entry) => entry.kind === kind),
  };
}
