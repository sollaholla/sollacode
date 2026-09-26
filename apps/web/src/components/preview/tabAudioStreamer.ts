import type {
  PreviewTabAudioEvent,
  PreviewTabAudioFormat,
  PreviewTabAudioPacket,
  PreviewTabAudioTarget,
} from "@t3tools/contracts";
import { PREVIEW_TAB_AUDIO_MAX_PACKETS } from "@t3tools/contracts";

/**
 * How long a tab may fall quiet before its capture stops. Pages go silent
 * between tracks, sentences and sound effects; tearing the capture down for
 * each gap would clip the start of the next sound.
 */
export const TAB_AUDIO_SILENCE_GRACE_MS = 2_000;
/** Packets travel in batches this long: ten small messages a second. */
export const TAB_AUDIO_BATCH_MS = 100;
/** Opus at this rate is transparent for speech and fine for music. */
export const TAB_AUDIO_BITRATE = 48_000;

export type TabAudioPacketsEvent = Extract<PreviewTabAudioEvent, { type: "packets" }>;

export interface TabAudioCapture {
  readonly stop: () => void;
}

interface TimerHost {
  readonly setTimeout: (handler: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

const browserTimers: TimerHost = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const targetKey = (target: PreviewTabAudioTarget) => `${target.threadId}\u0000${target.tabId}`;

/**
 * The desktop half of remote tab audio. The server says which tabs someone
 * is listening to; this captures a tab only while it is listened to AND
 * making sound, and stops again once it has been quiet for a moment or the
 * last listener leaves. Listeners are told when sound starts and stops so
 * their players can reset cleanly.
 */
export function createTabAudioStreamer(deps: {
  /** The desktop tab a server tab renders in. */
  readonly runtimeTabId: (target: PreviewTabAudioTarget) => string;
  readonly isAudible: (runtimeTabId: string) => boolean;
  /** Null when this window cannot capture the tab (not shown here, no support). */
  readonly startCapture: (
    runtimeTabId: string,
    onPackets: (event: TabAudioPacketsEvent) => void,
    onEnded: (reason: string) => void,
  ) => Promise<TabAudioCapture | null>;
  readonly publish: (target: PreviewTabAudioTarget, event: PreviewTabAudioEvent) => void;
  readonly timers?: TimerHost;
}) {
  const timers = deps.timers ?? browserTimers;
  interface Entry {
    readonly target: PreviewTabAudioTarget;
    readonly runtimeTabId: string;
    /** Capturing or about to: listeners have been told sound is on. */
    live: boolean;
    capture: TabAudioCapture | null;
    /** Bumped on every start and stop, so a late capture can tell it is stale. */
    generation: number;
    quietTimer: unknown;
  }
  const entries = new Map<string, Entry>();
  let disposed = false;

  const clearQuietTimer = (entry: Entry) => {
    if (entry.quietTimer === undefined) return;
    timers.clearTimeout(entry.quietTimer);
    entry.quietTimer = undefined;
  };

  const stop = (entry: Entry, announce: boolean) => {
    clearQuietTimer(entry);
    entry.generation += 1;
    entry.capture?.stop();
    entry.capture = null;
    const wasLive = entry.live;
    entry.live = false;
    if (announce && wasLive) deps.publish(entry.target, { type: "audible", audible: false });
  };

  const start = (entry: Entry) => {
    entry.live = true;
    const generation = (entry.generation += 1);
    const current = () => !disposed && entry.generation === generation;
    deps.publish(entry.target, { type: "audible", audible: true });
    // Listeners hear that the sound stopped, and the server's trace keeps
    // why, which is the only place a failed desktop capture shows up.
    const giveUp = (reason: string) => {
      if (!current()) return;
      entry.capture = null;
      entry.live = false;
      deps.publish(entry.target, { type: "audible", audible: false, reason });
    };
    void deps
      .startCapture(
        entry.runtimeTabId,
        (event) => {
          if (current()) deps.publish(entry.target, event);
        },
        giveUp,
      )
      .then(
        (capture) => {
          if (!current()) {
            capture?.stop();
            return;
          }
          if (capture === null) giveUp("This window cannot capture the tab.");
          else entry.capture = capture;
        },
        (error: unknown) => giveUp(describeCaptureFailure(error)),
      );
  };

  const evaluate = (entry: Entry) => {
    if (deps.isAudible(entry.runtimeTabId)) {
      clearQuietTimer(entry);
      if (!entry.live) start(entry);
      return;
    }
    if (!entry.live || entry.quietTimer !== undefined) return;
    entry.quietTimer = timers.setTimeout(() => {
      entry.quietTimer = undefined;
      if (!deps.isAudible(entry.runtimeTabId)) stop(entry, true);
    }, TAB_AUDIO_SILENCE_GRACE_MS);
  };

  return {
    /** The server's full set of listened-to tabs. */
    setDemand: (tabs: ReadonlyArray<PreviewTabAudioTarget>) => {
      if (disposed) return;
      const wanted = new Map(tabs.map((target) => [targetKey(target), target]));
      for (const [key, entry] of entries) {
        if (wanted.has(key)) continue;
        // Nobody is left to tell.
        stop(entry, false);
        entries.delete(key);
      }
      for (const [key, target] of wanted) {
        if (entries.has(key)) continue;
        const entry: Entry = {
          target,
          runtimeTabId: deps.runtimeTabId(target),
          live: false,
          capture: null,
          generation: 0,
          quietTimer: undefined,
        };
        entries.set(key, entry);
        evaluate(entry);
      }
    },
    /** A desktop tab started or stopped making sound. */
    audibleChanged: (runtimeTabId: string) => {
      if (disposed) return;
      for (const entry of entries.values()) {
        if (entry.runtimeTabId === runtimeTabId) evaluate(entry);
      }
    },
    dispose: () => {
      disposed = true;
      for (const entry of entries.values()) stop(entry, false);
      entries.clear();
    },
  };
}

export function describeCaptureFailure(error: unknown): string {
  const text =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : "Unknown capture failure.";
  return text.slice(0, 500);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }
  return btoa(binary);
}

function bufferSourceBytes(source: AllowSharedBufferSource): Uint8Array {
  return source instanceof ArrayBuffer || source instanceof SharedArrayBuffer
    ? new Uint8Array(source)
    : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}

/** Chromium's `MediaStreamTrackProcessor`, which the DOM typings do not carry yet. */
type TrackProcessorConstructor = new (init: { readonly track: MediaStreamTrack }) => {
  readonly readable: ReadableStream<AudioData>;
};

function trackProcessor(): TrackProcessorConstructor | undefined {
  return (globalThis as { MediaStreamTrackProcessor?: TrackProcessorConstructor })
    .MediaStreamTrackProcessor;
}

/** Whether this window can capture and encode a tab's sound at all. */
export function canCaptureTabAudio(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof AudioEncoder !== "undefined" &&
    trackProcessor() !== undefined
  );
}

/**
 * Captures one tab's sound (`sourceId` from the desktop's `getTabAudioSource`)
 * and encodes it as Opus in batches. Chromium takes a captured tab's sound
 * off this machine's speakers, so it is played here as well: the person at
 * the desktop keeps hearing the page while someone else listens remotely.
 */
export async function captureTabAudio(input: {
  readonly sourceId: string;
  readonly onPackets: (event: TabAudioPacketsEvent) => void;
  readonly onEnded: (reason: string) => void;
}): Promise<TabAudioCapture> {
  const Processor = trackProcessor();
  if (!Processor || !canCaptureTabAudio()) {
    throw new Error("This window has no tab capture or Opus encoder support.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: input.sourceId },
    },
    video: false,
  } as unknown as MediaStreamConstraints);
  const track = stream.getAudioTracks()[0];
  if (!track) {
    for (const each of stream.getTracks()) each.stop();
    throw new Error("The tab capture came back without a sound track.");
  }

  const localEcho = new Audio();
  localEcho.srcObject = stream;
  void localEcho.play().catch(() => undefined);

  let stopped = false;
  let format: PreviewTabAudioFormat | null = null;
  let pending: PreviewTabAudioPacket[] = [];
  let configured: { readonly sampleRate: number; readonly channels: number } | null = null;

  const flush = () => {
    if (pending.length === 0 || format === null) return;
    const packets = pending;
    pending = [];
    input.onPackets({ type: "packets", format, packets });
  };
  const flushTimer = setInterval(flush, TAB_AUDIO_BATCH_MS);
  const reader = new Processor({ track }).readable.getReader();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(flushTimer);
    void reader.cancel().catch(() => undefined);
    for (const each of stream.getTracks()) each.stop();
    if (encoder.state !== "closed") encoder.close();
    localEcho.pause();
    localEcho.srcObject = null;
  };

  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      const config = metadata?.decoderConfig;
      if (config) {
        format = {
          codec: "opus",
          sampleRate: config.sampleRate,
          numberOfChannels: config.numberOfChannels,
          ...(config.description
            ? { description: bytesToBase64(bufferSourceBytes(config.description)) }
            : {}),
        };
      }
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      pending.push({
        timestamp: chunk.timestamp,
        duration: chunk.duration ?? 20_000,
        data: bytesToBase64(bytes),
      });
      if (pending.length >= PREVIEW_TAB_AUDIO_MAX_PACKETS) flush();
    },
    error: (error) => {
      stop();
      input.onEnded(`Opus encoder failed: ${describeCaptureFailure(error)}`);
    },
  });

  void (async () => {
    let endedBecause = "The tab's sound stream ended.";
    // `stop()` flips `stopped` from outside; a cancelled read ends the loop too.
    for (;;) {
      if (stopped) break;
      const next = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (next.done || !next.value) break;
      const data = next.value;
      try {
        if (
          configured === null ||
          configured.sampleRate !== data.sampleRate ||
          configured.channels !== data.numberOfChannels
        ) {
          configured = { sampleRate: data.sampleRate, channels: data.numberOfChannels };
          encoder.configure({
            codec: "opus",
            sampleRate: data.sampleRate,
            numberOfChannels: data.numberOfChannels,
            bitrate: TAB_AUDIO_BITRATE,
            opus: { frameDuration: 20_000 },
          });
        }
        encoder.encode(data);
      } catch (error) {
        endedBecause = `Encoding failed: ${describeCaptureFailure(error)}`;
        break;
      } finally {
        data.close();
      }
    }
    if (!stopped) {
      stop();
      input.onEnded(endedBecause);
    }
  })();

  return { stop };
}
