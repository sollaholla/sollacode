import type { PreviewTabAudioEvent, PreviewTabAudioFormat } from "@t3tools/contracts";

import { decodeBase64Chunk } from "../remoteControl/remoteControlPlayer";

/**
 * How far ahead of "now" playback starts after a gap. Enough to absorb a
 * phone network's jitter between 100 ms batches without audible dropouts.
 */
export const TAB_AUDIO_START_LEAD_SECONDS = 0.18;
/**
 * The most sound allowed to queue up. Past this the listener has fallen
 * behind the page (a stall, then a burst), so the backlog is dropped rather
 * than played seconds late.
 */
export const TAB_AUDIO_MAX_QUEUED_SECONDS = 0.8;
/** Closer than this to running dry counts as dry: restart with a fresh lead. */
const UNDERRUN_MARGIN_SECONDS = 0.02;

/**
 * When a decoded packet should start, or null to drop it. Packets play back
 * to back; after running dry the next one waits a short lead so a few more
 * can arrive, and a queue that has grown too long is cut back to live.
 */
export function tabAudioPacketStart(scheduledEnd: number | null, now: number): number | null {
  if (scheduledEnd === null || scheduledEnd < now + UNDERRUN_MARGIN_SECONDS) {
    return now + TAB_AUDIO_START_LEAD_SECONDS;
  }
  if (scheduledEnd > now + TAB_AUDIO_MAX_QUEUED_SECONDS) return null;
  return scheduledEnd;
}

type AudioSessionNavigator = Navigator & {
  audioSession?: { type: string };
};

function audioContextConstructor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

/** Whether this browser can decode and play relayed tab sound (Safari 26+, Chromium, Firefox). */
export function canPlayTabAudio(): boolean {
  return typeof AudioDecoder !== "undefined" && audioContextConstructor() !== undefined;
}

function formatKey(format: PreviewTabAudioFormat): string {
  return [format.codec, format.sampleRate, format.numberOfChannels, format.description ?? ""].join(
    "|",
  );
}

/** Copies decoded sound into a Web Audio buffer, whatever layout the decoder chose. */
function toAudioBuffer(context: BaseAudioContext, data: AudioData): AudioBuffer {
  const channels = data.numberOfChannels;
  const frames = data.numberOfFrames;
  const buffer = context.createBuffer(channels, frames, data.sampleRate);
  if (data.format === "f32") {
    const interleaved = new Float32Array(frames * channels);
    data.copyTo(interleaved, { planeIndex: 0 });
    for (let channel = 0; channel < channels; channel += 1) {
      const out = buffer.getChannelData(channel);
      for (let frame = 0; frame < frames; frame += 1) {
        out[frame] = interleaved[frame * channels + channel]!;
      }
    }
    return buffer;
  }
  for (let channel = 0; channel < channels; channel += 1) {
    const plane = new Float32Array(frames);
    data.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
    buffer.copyToChannel(plane, channel);
  }
  return buffer;
}

/** What the player did with the sound it was handed, for its periodic report. */
export interface TabAudioPlaybackStats {
  readonly batches: number;
  readonly batchesWhileLocked: number;
  readonly packetsDecoded: number;
  readonly framesOut: number;
  readonly buffersStarted: number;
  readonly lateDropped: number;
  readonly contextState: string;
  readonly lastError: string | null;
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, 500);
}

/**
 * Plays a relayed tab's sound on this device: Opus packets are decoded with
 * WebCodecs and queued back to back on a Web Audio clock. Browsers only let
 * sound start from a tap, so `unlock` must run inside one.
 */
export function createTabAudioPlayer(options: {
  /** Whether sound is coming out right now; for the speaker button. */
  readonly onPlayingChange?: (playing: boolean) => void;
}) {
  const Context = audioContextConstructor();
  let context: AudioContext | null = null;
  let decoder: AudioDecoder | null = null;
  let decoderFormat: string | null = null;
  let scheduledEnd: number | null = null;
  let playing = false;
  let disposed = false;
  let restoreSessionType: string | null = null;
  const sources = new Set<AudioBufferSourceNode>();
  const counts = {
    batches: 0,
    batchesWhileLocked: 0,
    packetsDecoded: 0,
    framesOut: 0,
    buffersStarted: 0,
    lateDropped: 0,
  };
  let lastError: string | null = null;

  const setPlaying = (next: boolean) => {
    if (playing === next) return;
    playing = next;
    options.onPlayingChange?.(next);
  };

  // iPhones silence Web Audio with the ring/silent switch unless the page
  // says it is playing media, so claim that only while sound is flowing.
  const claimPlaybackSession = () => {
    const session = (navigator as AudioSessionNavigator).audioSession;
    if (!session || restoreSessionType !== null || session.type === "playback") return;
    restoreSessionType = session.type;
    session.type = "playback";
  };
  const releasePlaybackSession = () => {
    const session = (navigator as AudioSessionNavigator).audioSession;
    if (!session || restoreSessionType === null) return;
    session.type = restoreSessionType;
    restoreSessionType = null;
  };

  const silence = () => {
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // Already finished.
      }
    }
    sources.clear();
    scheduledEnd = null;
    setPlaying(false);
    releasePlaybackSession();
  };

  const closeDecoder = () => {
    if (decoder && decoder.state !== "closed") decoder.close();
    decoder = null;
    decoderFormat = null;
  };

  const play = (data: AudioData) => {
    counts.framesOut += 1;
    try {
      if (disposed || !context || context.state !== "running") return;
      const start = tabAudioPacketStart(scheduledEnd, context.currentTime);
      if (start === null) {
        counts.lateDropped += 1;
        return;
      }
      const buffer = toAudioBuffer(context, data);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.addEventListener("ended", () => {
        sources.delete(source);
        if (sources.size === 0 && context && (scheduledEnd ?? 0) <= context.currentTime + 0.01) {
          setPlaying(false);
        }
      });
      source.start(start);
      counts.buffersStarted += 1;
      sources.add(source);
      scheduledEnd = start + buffer.duration;
      claimPlaybackSession();
      setPlaying(true);
    } catch (error) {
      lastError = `Playing decoded sound failed: ${describeError(error)}`;
    } finally {
      data.close();
    }
  };

  const decoderFor = (format: PreviewTabAudioFormat): AudioDecoder | null => {
    const key = formatKey(format);
    if (decoder && decoderFormat === key && decoder.state === "configured") return decoder;
    closeDecoder();
    const next = new AudioDecoder({
      output: play,
      // A corrupt packet: start over with the next batch.
      error: (error) => {
        lastError = `Decoder failed: ${describeError(error)}`;
        if (decoder === next) closeDecoder();
      },
    });
    try {
      next.configure({
        codec: format.codec,
        sampleRate: format.sampleRate,
        numberOfChannels: format.numberOfChannels,
        ...(format.description ? { description: decodeBase64Chunk(format.description) } : {}),
      });
    } catch (error) {
      lastError = `Decoder setup failed: ${describeError(error)}`;
      next.close();
      return null;
    }
    decoder = next;
    decoderFormat = key;
    return next;
  };

  return {
    /** Starts (or resumes) sound output. Call from inside a tap or click. */
    unlock: () => {
      if (disposed || !Context) return;
      context ??= new Context();
      if (context.state !== "running") void context.resume().catch(() => undefined);
    },
    /** Whether a tap has let sound play on this device yet. */
    get unlocked() {
      return context !== null && context.state === "running";
    },
    handle: (event: PreviewTabAudioEvent) => {
      if (disposed) return;
      if (event.type === "audible") {
        if (!event.audible) {
          silence();
          closeDecoder();
        }
        return;
      }
      counts.batches += 1;
      // Nothing can come out until a tap unlocks sound; decoding would only
      // build a backlog to drop.
      if (!context || context.state !== "running") {
        counts.batchesWhileLocked += 1;
        return;
      }
      const target = decoderFor(event.format);
      if (!target) return;
      for (const packet of event.packets) {
        try {
          target.decode(
            new EncodedAudioChunk({
              type: "key",
              timestamp: packet.timestamp,
              duration: packet.duration,
              data: decodeBase64Chunk(packet.data),
            }),
          );
          counts.packetsDecoded += 1;
        } catch (error) {
          lastError = `Decoding a packet failed: ${describeError(error)}`;
          closeDecoder();
          return;
        }
      }
    },
    stats: (): TabAudioPlaybackStats => ({
      ...counts,
      contextState: context?.state ?? "none",
      lastError,
    }),
    dispose: () => {
      if (disposed) return;
      silence();
      closeDecoder();
      disposed = true;
      void context?.close().catch(() => undefined);
      context = null;
    },
  };
}
