/**
 * Controller-side video sink for remote control.
 *
 * Feeds encoded chunks into a `MediaSource` so the browser decodes them with a
 * real video codec instead of swapping out an `<img>` per frame.
 *
 * The latency-critical part is not decoding, it is drift: `MediaSource` will
 * happily accumulate buffered media and play it back in order, so a viewer that
 * never trims falls further behind the host the longer it watches. This sink
 * therefore chases the live edge — it seeks forward whenever the buffer runs
 * ahead, trading a visible skip for staying current, which is the right trade
 * for a remote desktop.
 */

/** Seek to the live edge once buffered media runs this far ahead. */
export const LIVE_EDGE_MAX_DRIFT_SECONDS = 0.35;
/** Leave a sliver behind the edge so the decoder is never starved. */
export const LIVE_EDGE_TARGET_LAG_SECONDS = 0.08;

export function decodeBase64Chunk(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * How far ahead of the playhead the buffer currently is, or null when nothing
 * is buffered yet.
 */
export function bufferedDrift(
  buffered: { readonly length: number; end: (index: number) => number },
  currentTime: number,
): number | null {
  if (buffered.length === 0) return null;
  return buffered.end(buffered.length - 1) - currentTime;
}

/**
 * Target playhead position for a given buffer, or null to leave it alone.
 * Exposed separately from the DOM so the drift policy is directly testable.
 */
export function liveEdgeSeekTarget(
  buffered: { readonly length: number; end: (index: number) => number },
  currentTime: number,
): number | null {
  const drift = bufferedDrift(buffered, currentTime);
  if (drift === null || drift <= LIVE_EDGE_MAX_DRIFT_SECONDS) return null;
  const edge = buffered.end(buffered.length - 1);
  return Math.max(0, edge - LIVE_EDGE_TARGET_LAG_SECONDS);
}

/**
 * Counters describing what the pipeline actually did. Without these a stalled
 * stream is unattributable: "nothing decoded" looks identical whether the
 * buffer never opened, nothing was ever appended, or bytes went in and the
 * decoder rejected them.
 */
export interface RemoteControlVideoStats {
  readonly sourceOpen: boolean;
  readonly bufferCreated: boolean;
  readonly chunksAppended: number;
  readonly bytesAppended: number;
  readonly queued: number;
  readonly bufferedRanges: number;
  readonly bufferedEnd: number | null;
  readonly mediaSourceState: string;
}

export function formatVideoStats(stats: RemoteControlVideoStats): string {
  const buffered =
    stats.bufferedEnd === null
      ? "none"
      : `${stats.bufferedRanges}@${stats.bufferedEnd.toFixed(2)}s`;
  return (
    `sourceOpen=${stats.sourceOpen} buffer=${stats.bufferCreated} ` +
    `appended=${stats.chunksAppended} bytes=${stats.bytesAppended} ` +
    `queued=${stats.queued} buffered=${buffered} state=${stats.mediaSourceState}`
  );
}

export interface RemoteControlVideoSink {
  readonly url: string;
  /** Appends a chunk. `isInit` chunks of a new stream reset the buffer. */
  append: (chunk: { readonly data: string; readonly isInit: boolean }) => void;
  readonly stats: () => RemoteControlVideoStats;
  readonly dispose: () => void;
}

/**
 * Why a codec cannot be played here. Returned instead of a bare null so a
 * failure surfaces as a diagnosable message rather than a black rectangle.
 */
export function describeUnsupportedCodec(mimeType: string): string | null {
  if (typeof MediaSource === "undefined") {
    return "This client cannot play video streams (no MediaSource support).";
  }
  if (!MediaSource.isTypeSupported(mimeType)) {
    return `This client cannot decode the host's video format (${mimeType}).`;
  }
  return null;
}

/**
 * Creates a MediaSource-backed sink. Returns null when the runtime lacks
 * MediaSource support or cannot handle the codec, so the caller can keep using
 * the JPEG image path.
 */
export function createRemoteControlVideoSink(
  mimeType: string,
  video: HTMLVideoElement,
  onError?: (detail: string) => void,
): RemoteControlVideoSink | null {
  if (describeUnsupportedCodec(mimeType) !== null) return null;

  const mediaSource = new MediaSource();
  const url = URL.createObjectURL(mediaSource);
  const queue: Uint8Array[] = [];
  let sourceBuffer: SourceBuffer | null = null;
  let disposed = false;
  let sourceOpen = false;
  let chunksAppended = 0;
  let bytesAppended = 0;

  const pump = () => {
    if (disposed || !sourceBuffer || sourceBuffer.updating || queue.length === 0) return;
    const next = queue.shift();
    if (!next) return;
    try {
      // `as ArrayBuffer` — a Uint8Array view is a valid BufferSource at runtime.
      sourceBuffer.appendBuffer(next as unknown as ArrayBuffer);
      chunksAppended += 1;
      bytesAppended += next.byteLength;
    } catch (cause) {
      // Drop the backlog so the next init segment can resynchronise, but do not
      // swallow the reason: a persistently rejected append renders as a black
      // frame, which is indistinguishable from a blank screen without this.
      queue.length = 0;
      onError?.(cause instanceof Error ? cause.message : String(cause));
    }
  };

  mediaSource.addEventListener("sourceopen", () => {
    if (disposed) return;
    sourceOpen = true;
    try {
      sourceBuffer = mediaSource.addSourceBuffer(mimeType);
      sourceBuffer.addEventListener("updateend", () => {
        pump();
        const target = liveEdgeSeekTarget(video.buffered, video.currentTime);
        if (target !== null) video.currentTime = target;
        if (video.paused) void video.play().catch(() => undefined);
      });
      pump();
    } catch (cause) {
      sourceBuffer = null;
      onError?.(
        `The video buffer could not be initialised for ${mimeType}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  });

  return {
    url,
    append: (chunk) => {
      if (disposed) return;
      // A new init segment means the host restarted its encoder (a monitor
      // switch). Drop anything still queued from the previous container so the
      // two are never interleaved.
      if (chunk.isInit) queue.length = 0;
      queue.push(decodeBase64Chunk(chunk.data));
      pump();
    },
    stats: () => ({
      sourceOpen,
      bufferCreated: sourceBuffer !== null,
      chunksAppended,
      bytesAppended,
      queued: queue.length,
      bufferedRanges: video.buffered.length,
      bufferedEnd: video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) : null,
      mediaSourceState: mediaSource.readyState,
    }),
    dispose: () => {
      disposed = true;
      queue.length = 0;
      try {
        if (mediaSource.readyState === "open") mediaSource.endOfStream();
      } catch {
        // Already torn down by the element; nothing to clean up.
      }
      URL.revokeObjectURL(url);
    },
  };
}
