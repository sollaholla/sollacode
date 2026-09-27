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
/** Keep enough decoded history for keyframes without retaining a whole session. */
export const VIDEO_BUFFER_HISTORY_SECONDS = 10;
const VIDEO_BUFFER_TRIM_INTERVAL_SECONDS = 5;
export const VIDEO_MAX_QUEUED_BYTES = 8 * 1024 * 1024;
export const VIDEO_MAX_QUEUED_CHUNKS = 128;

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
  let queuedBytes = 0;
  let failed = false;

  const fail = (detail: string) => {
    if (disposed || failed) return;
    failed = true;
    queue.length = 0;
    queuedBytes = 0;
    onError?.(detail);
  };
  const handleBufferError = () => {
    fail("The video stream could not be parsed. Falling back to image frames.");
  };
  const handleVideoError = () => {
    fail("The video stream could not be decoded. Falling back to image frames.");
  };
  video.addEventListener("error", handleVideoError);

  const pump = () => {
    if (disposed || failed || !sourceBuffer || sourceBuffer.updating) return;
    try {
      const trimBefore = video.currentTime - VIDEO_BUFFER_HISTORY_SECONDS;
      if (
        sourceBuffer.buffered.length > 0 &&
        trimBefore - sourceBuffer.buffered.start(0) >= VIDEO_BUFFER_TRIM_INTERVAL_SECONDS
      ) {
        sourceBuffer.remove(0, trimBefore);
        return; // updateend resumes appending after the asynchronous removal.
      }
      const next = queue.shift();
      if (!next) return;
      queuedBytes -= next.byteLength;
      // `as ArrayBuffer` — a Uint8Array view is a valid BufferSource at runtime.
      sourceBuffer.appendBuffer(next as unknown as ArrayBuffer);
      chunksAppended += 1;
      bytesAppended += next.byteLength;
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleUpdateEnd = () => {
    if (disposed || failed) return;
    const target = liveEdgeSeekTarget(video.buffered, video.currentTime);
    if (target !== null) video.currentTime = target;
    if (video.paused) void video.play().catch(() => undefined);
    pump();
  };
  const handleSourceOpen = () => {
    if (disposed || failed || sourceBuffer) return;
    sourceOpen = true;
    try {
      sourceBuffer = mediaSource.addSourceBuffer(mimeType);
      sourceBuffer.addEventListener("updateend", handleUpdateEnd);
      sourceBuffer.addEventListener("error", handleBufferError);
      pump();
    } catch (cause) {
      sourceBuffer = null;
      fail(
        `The video buffer could not be initialised for ${mimeType}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  };
  mediaSource.addEventListener("sourceopen", handleSourceOpen);

  return {
    url,
    append: (chunk) => {
      if (disposed || failed) return;
      // A new init segment means the host restarted its encoder (a monitor
      // switch). Drop anything still queued from the previous container so the
      // two are never interleaved.
      if (chunk.isInit) {
        queue.length = 0;
        queuedBytes = 0;
      }
      // Check before decoding as well: a stalled decoder must not cause an
      // unbounded queue or allocate a huge temporary byte array.
      if (
        queue.length >= VIDEO_MAX_QUEUED_CHUNKS ||
        queuedBytes + Math.ceil((chunk.data.length * 3) / 4) > VIDEO_MAX_QUEUED_BYTES
      ) {
        fail("The video decoder fell behind the live stream. Falling back to image frames.");
        return;
      }
      try {
        const bytes = decodeBase64Chunk(chunk.data);
        queue.push(bytes);
        queuedBytes += bytes.byteLength;
      } catch (cause) {
        fail(cause instanceof Error ? cause.message : String(cause));
        return;
      }
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
      if (disposed) return;
      disposed = true;
      queue.length = 0;
      queuedBytes = 0;
      mediaSource.removeEventListener("sourceopen", handleSourceOpen);
      sourceBuffer?.removeEventListener("updateend", handleUpdateEnd);
      sourceBuffer?.removeEventListener("error", handleBufferError);
      video.removeEventListener("error", handleVideoError);
      video.pause();
      video.removeAttribute("src");
      video.load();
      try {
        if (mediaSource.readyState === "open") mediaSource.endOfStream();
      } catch {
        // Already torn down by the element; nothing to clean up.
      }
      URL.revokeObjectURL(url);
    },
  };
}
