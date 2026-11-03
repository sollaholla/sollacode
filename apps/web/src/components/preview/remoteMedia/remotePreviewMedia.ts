import {
  PREVIEW_MEDIA_CAPTURE_STATE_KEY,
  PREVIEW_MEDIA_PAGE_STATE_KEY,
  PreviewMediaCaptureState,
  PreviewRemoteFramePageState,
  type MediaViewport,
  type PreviewMediaWatchEvent,
} from "@t3tools/contracts";
import { detectDecodableCodecs } from "@t3tools/client-runtime/media/video-codecs";
import {
  createVideoStreamSubscriber,
  type VideoStreamSubscriber,
} from "@t3tools/client-runtime/media/video-stream-subscriber";
import * as Schema from "effect/Schema";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/unstable/reactivity";

export type RemotePreviewMediaWatchEvent = PreviewMediaWatchEvent;

export const REMOTE_PREVIEW_MEDIA_STARTUP_MS = 8_000;
const isPageState = Schema.is(PreviewRemoteFramePageState);
const isCaptureState = Schema.is(PreviewMediaCaptureState);

export function listenToPreviewMedia<E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<RemotePreviewMediaWatchEvent, E>>,
  handlers: {
    readonly onEvent: (event: RemotePreviewMediaWatchEvent) => void;
    readonly onFailure: () => void;
  },
) {
  let last: RemotePreviewMediaWatchEvent | null = null;
  return registry.subscribe(
    atom,
    (result) => {
      if (AsyncResult.isFailure(result)) handlers.onFailure();
      else if (AsyncResult.isSuccess(result) && result.value !== last) {
        last = result.value;
        handlers.onEvent(result.value);
      }
    },
    { immediate: true },
  );
}

/** Owns one visible tab's media watch and decoder; JPEG remains until a frame arrives. */
export function createRemotePreviewMedia(options: {
  readonly canvas: HTMLCanvasElement;
  readonly regionCanvas?: HTMLCanvasElement | null;
  readonly watch: (handlers: {
    readonly onEvent: (event: RemotePreviewMediaWatchEvent) => void;
    readonly onFailure: () => void;
  }) => () => void;
  readonly resolveUrl: (watchId: string) => Promise<string>;
  readonly viewport: () => MediaViewport;
  readonly onPicture: (size: { readonly width: number; readonly height: number }) => void;
  readonly onState: (state: PreviewRemoteFramePageState) => void;
  readonly onFallback: (reason: string) => void;
}) {
  let stopped = false;
  let unsubscribe: (() => void) | null = null;
  let subscriber: VideoStreamSubscriber | null = null;
  let watchId: string | null = null;
  let generation = 0;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let picture: { width: number; height: number } | null = null;

  const cancelDeadline = () => {
    if (deadline !== null) clearTimeout(deadline);
    deadline = null;
  };
  const showFallback = (reason: string) => {
    if (stopped) return;
    cancelDeadline();
    picture = null;
    options.onFallback(reason);
  };
  const fallback = (reason: string) => {
    if (stopped) return;
    generation += 1;
    cancelDeadline();
    subscriber?.stop();
    subscriber = null;
    showFallback(reason);
  };
  const waitForPicture = () => {
    cancelDeadline();
    deadline = setTimeout(() => {
      const reason = "The browser host did not start video in time.";
      if (subscriber) showFallback(reason);
      else fallback(reason);
    }, REMOTE_PREVIEW_MEDIA_STARTUP_MS);
  };

  waitForPicture();
  void detectDecodableCodecs()
    .then((codecs) => {
      if (stopped) return;
      if (codecs.length === 0) {
        fallback("This browser cannot decode the host's video.");
        return;
      }
      const close = options.watch({
        onEvent: (event) => {
          if (stopped) return;
          if (event.type === "unavailable") {
            fallback(event.reason);
            return;
          }
          // Waiting/completion flags can re-announce a ready value. A failed
          // topic retries only when the server supplies a new watch ID.
          if (event.watchId === watchId) return;
          watchId = event.watchId;
          const currentWatch = event.watchId;
          const currentGeneration = ++generation;
          subscriber?.stop();
          subscriber = null;
          picture = null;
          waitForPicture();
          let captureInterrupted = false;
          const current = () => !stopped && generation === currentGeneration;
          try {
            const next = createVideoStreamSubscriber({
              canvas: options.canvas,
              regionCanvas: options.regionCanvas ?? null,
              codecs,
              resolveUrl: () => options.resolveUrl(currentWatch),
              viewport: options.viewport,
              onFrame: (_frame, config) => {
                if (!current() || captureInterrupted) return;
                const width = config.sourceWidth;
                const height = config.sourceHeight;
                if (
                  !Number.isFinite(width) ||
                  !Number.isFinite(height) ||
                  width <= 0 ||
                  height <= 0
                ) {
                  fallback("The browser host returned an invalid picture size.");
                  return;
                }
                cancelDeadline();
                if (picture?.width === width && picture.height === height) return;
                picture = { width, height };
                options.onPicture({ width, height });
              },
              onBroadcast: (key, body) => {
                if (!current()) return;
                if (key === PREVIEW_MEDIA_CAPTURE_STATE_KEY && isCaptureState(body)) {
                  if (captureInterrupted === !body.capturing) return;
                  captureInterrupted = !body.capturing;
                  subscriber?.setFrameExpected(body.capturing);
                  if (captureInterrupted) {
                    showFallback(
                      "The browser capture is interrupted; using preview frames while it recovers.",
                    );
                  } else waitForPicture();
                } else if (key === PREVIEW_MEDIA_PAGE_STATE_KEY && isPageState(body)) {
                  options.onState(body);
                }
              },
              onFatal: (reason) => {
                if (current()) fallback(reason);
              },
              onFrameTimeout: (reason) => {
                if (current()) showFallback(reason);
              },
              onEnded: () => {
                if (current()) fallback("The browser host ended this video stream.");
              },
            });
            if (current()) {
              subscriber = next;
              next.setFrameExpected(!captureInterrupted);
            } else next.stop();
          } catch {
            fallback("The browser video could not start.");
          }
        },
        onFailure: () => fallback("The browser media watch disconnected."),
      });
      if (stopped) close();
      else unsubscribe = close;
    })
    .catch(() => fallback("The browser video could not initialize."));

  return {
    updateViewport: () => subscriber?.updateViewport(),
    stop: () => {
      if (stopped) return;
      stopped = true;
      generation += 1;
      cancelDeadline();
      unsubscribe?.();
      unsubscribe = null;
      subscriber?.stop();
      subscriber = null;
    },
  };
}
