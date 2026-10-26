import {
  PREVIEW_MEDIA_CAPTURE_STATE_KEY,
  PREVIEW_MEDIA_PAGE_STATE_KEY,
  type PreviewMediaDemand,
  type PreviewRemoteFramePageState,
} from "@t3tools/contracts";
import {
  createVideoStreamPublisher,
  supportsVideoStreamPublishing,
  type MediaBroadcastBody,
  type VideoSource,
  type VideoStreamPublisher,
  type VideoStreamPublisherOptions,
} from "@t3tools/client-runtime/media/video-stream-publisher";

export function canPublishPreviewMedia(): boolean {
  return (
    supportsVideoStreamPublishing() &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

export interface PreviewVideoSourceDescriptor {
  readonly sourceId: string;
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
  readonly webContentsId?: number;
}

/** Chromium pads tab capture to the requested bounds, so both dimensions must match the page. */
export function previewCaptureSize(
  source: Pick<PreviewVideoSourceDescriptor, "width" | "height" | "devicePixelRatio">,
) {
  if (
    ![source.width, source.height, source.devicePixelRatio].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  ) {
    throw new Error("The preview tab returned invalid capture dimensions.");
  }
  const scale = Math.min(
    source.devicePixelRatio,
    2560 / source.width,
    2560 / source.height,
    Math.sqrt((2560 * 1600) / (source.width * source.height)),
  );
  return {
    width: Math.max(1, Math.floor(source.width * scale)),
    height: Math.max(1, Math.floor(source.height * scale)),
  };
}

/** The one-shot source id and viewport belong to the same native page and requesting renderer. */
export async function capturePreviewTab(
  source: PreviewVideoSourceDescriptor,
): Promise<VideoSource> {
  const size = previewCaptureSize(source);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: source.sourceId,
        maxWidth: size.width,
        maxHeight: size.height,
        maxFrameRate: 30,
      },
    },
  } as unknown as MediaStreamConstraints);
  const close = () => {
    for (const track of stream.getTracks()) track.stop();
  };
  const track = stream.getVideoTracks()[0];
  if (!track) {
    close();
    throw new Error("The preview tab capture returned no video track.");
  }
  const settings = track.getSettings();
  if (
    !settings.width ||
    !settings.height ||
    Math.abs(settings.width - (settings.height * source.width) / source.height) > 2
  ) {
    close();
    throw new Error("The preview capture aspect ratio does not match its page.");
  }
  return { track, close };
}

interface PreviewMediaRuntime {
  readonly runtimeTabId: string;
  /** Changes when a stable guest must be registered again after reconnecting. */
  readonly generation: string;
}

export interface PreviewMediaHostOptions {
  readonly runtime: (target: PreviewMediaDemand) => PreviewMediaRuntime;
  readonly resolveUrl: (target: PreviewMediaDemand) => Promise<string>;
  readonly openSource: (runtimeTabId: string) => Promise<VideoSource>;
  readonly readState: (
    target: PreviewMediaDemand,
    runtimeTabId: string,
  ) => PreviewRemoteFramePageState | null;
  readonly subscribeTarget: (target: PreviewMediaDemand, changed: () => void) => () => void;
  readonly createPublisher?: (options: VideoStreamPublisherOptions) => PreviewPublisher;
}

type PreviewPublisher = Pick<VideoStreamPublisher, "broadcast" | "restartSource" | "stop">;

interface Watched {
  readonly target: PreviewMediaDemand;
  runtime: PreviewMediaRuntime;
  publisher: PreviewPublisher;
  unsubscribe: () => void;
  state: string | null;
  capturing: boolean | null;
  revision: number;
  disposed: boolean;
}

const targetKey = (target: PreviewMediaDemand) => `${target.threadId}\u0000${target.tabId}`;

/** Owns publishers for this automation connection, independently of JPEG and audio demand. */
export function createPreviewMediaHost(options: PreviewMediaHostOptions) {
  const watched = new Map<string, Watched>();
  let disposed = false;
  const createPublisher = options.createPublisher ?? createVideoStreamPublisher;

  const reportCapture = (entry: Watched, capturing: boolean) => {
    if (entry.disposed || entry.capturing === capturing) return;
    entry.capturing = capturing;
    entry.publisher.broadcast(PREVIEW_MEDIA_CAPTURE_STATE_KEY, { capturing });
  };
  const invalidateSource = (entry: Watched) => {
    entry.revision += 1;
    reportCapture(entry, false);
    entry.publisher.restartSource();
  };

  const publishState = (entry: Watched) => {
    const state = options.readState(entry.target, entry.runtime.runtimeTabId);
    if (state === null) return;
    const serialized = JSON.stringify(state);
    if (serialized === entry.state) return;
    entry.state = serialized;
    const body: Record<string, MediaBroadcastBody> = {
      url: state.url,
      title: state.title,
      loading: state.loading,
    };
    if (state.pendingDownloadApprovals) {
      body.pendingDownloadApprovals = state.pendingDownloadApprovals.map((approval) => ({
        ...approval,
      }));
    }
    if (state.agentPointer) body.agentPointer = { ...state.agentPointer };
    entry.publisher.broadcast(PREVIEW_MEDIA_PAGE_STATE_KEY, body);
  };

  const refresh = (entry: Watched) => {
    if (entry.disposed) return;
    const runtime = options.runtime(entry.target);
    if (
      runtime.runtimeTabId !== entry.runtime.runtimeTabId ||
      runtime.generation !== entry.runtime.generation
    ) {
      entry.runtime = runtime;
      entry.state = null;
      entry.unsubscribe();
      entry.unsubscribe = options.subscribeTarget(entry.target, () => refresh(entry));
      invalidateSource(entry);
    }
    publishState(entry);
  };

  const unwatch = (entry: Watched) => {
    entry.disposed = true;
    entry.revision += 1;
    entry.unsubscribe();
    entry.publisher.stop();
    watched.delete(targetKey(entry.target));
  };

  const watch = (target: PreviewMediaDemand) => {
    const runtime = options.runtime(target);
    const publisherOptions: VideoStreamPublisherOptions = {
      resolveUrl: () => options.resolveUrl(target),
      openSource: async () => {
        const revision = entry.revision;
        const source = await options.openSource(entry.runtime.runtimeTabId);
        if (entry.disposed || revision !== entry.revision) {
          source.close();
          throw new Error("The watched preview tab changed while capture was opening.");
        }
        return source;
      },
      onCaptureError: () => reportCapture(entry, false),
      onCaptureFrame: () => reportCapture(entry, true),
      onEnded: () => {
        if (entry.disposed) return;
        // Closing and immediately reopening the last watch rotates its topic.
        // The demand stream may coalesce the empty set between those watches.
        entry.revision += 1;
        entry.publisher = createPublisher(publisherOptions);
        entry.state = null;
        entry.capturing = null;
        publishState(entry);
      },
    };
    const entry: Watched = {
      target,
      runtime,
      revision: 0,
      state: null,
      capturing: null,
      disposed: false,
      unsubscribe: () => undefined,
      publisher: createPublisher(publisherOptions),
    };
    watched.set(targetKey(target), entry);
    entry.unsubscribe = options.subscribeTarget(target, () => refresh(entry));
    publishState(entry);
  };

  return {
    setDemand(tabs: ReadonlyArray<PreviewMediaDemand>) {
      if (disposed) return;
      const next = new Map(tabs.map((target) => [targetKey(target), target]));
      for (const [key, entry] of watched) if (!next.has(key)) unwatch(entry);
      for (const [key, target] of next) {
        const entry = watched.get(key);
        if (entry) refresh(entry);
        else watch(target);
      }
    },
    refresh() {
      for (const entry of watched.values()) refresh(entry);
    },
    stateChanged(runtimeTabId: string) {
      for (const entry of watched.values()) {
        if (entry.runtime.runtimeTabId === runtimeTabId) publishState(entry);
      }
    },
    sourceChanged(runtimeTabId: string) {
      for (const entry of watched.values()) {
        if (entry.runtime.runtimeTabId !== runtimeTabId) continue;
        invalidateSource(entry);
      }
    },
    hasRuntime(runtimeTabId: string) {
      return [...watched.values()].some((entry) => entry.runtime.runtimeTabId === runtimeTabId);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of watched.values()) unwatch(entry);
    },
  };
}

export type PreviewMediaHost = ReturnType<typeof createPreviewMediaHost>;
