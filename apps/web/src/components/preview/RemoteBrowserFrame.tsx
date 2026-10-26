import { RemoteClickMarkers, useRemoteClickFeedback } from "./RemoteClickMarkers";
import {
  PreviewTabId,
  type PreviewAgentControl,
  type PreviewContextMenuTarget,
  type PreviewRemoteFramePageState,
  type PreviewRemoteInputAction,
  type PreviewRemoteInputResult,
  type PreviewRemoteSnapshotResult,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  FRAME_TAP_SLOP_PX,
  containedFrameRect,
  frameFraction,
  resolveFrameGesture,
  type FramePoint,
  type FrameSize,
} from "@t3tools/shared/remoteFrameGestures";
import { RegistryContext } from "@effect/atom-react";
import { RemotePreviewCommandCoordinator } from "@t3tools/client-runtime/preview/remote-command-coordinator";
import { mediaChannelUrl } from "@t3tools/client-runtime/media/media-channel-socket";
import {
  mergeRemoteSnapshot,
  remoteSnapshotRequest,
} from "@t3tools/client-runtime/preview/remote-frame";
import {
  REMOTE_FRAME_STREAM_GRACE_MS,
  planRemoteFrameEvents,
  remoteFrameRequestSize,
  remoteFrameShouldPoll,
  type HeldRemoteFrame,
} from "@t3tools/client-runtime/preview/remote-frame-feed";
import { isPublicWebPreviewUrl } from "@t3tools/shared/preview";
import * as Cause from "effect/Cause";
import { KeyboardIcon } from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { toastManager } from "~/components/ui/toast";
import { useOnScreenKeyboard } from "~/hooks/useOnScreenKeyboard";
import { useServerConfigs } from "~/state/entities";
import { previewEnvironment } from "~/state/preview";
import { readPreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import { TouchActionRadialMenu } from "../remoteControl/TouchActionRadialMenu";
import {
  createTouchActionMenu,
  type TouchMenuState,
  type TouchPoint,
} from "../remoteControl/touchActionMenu";
import { RemoteViewZoomReadout, useRemoteViewZoom } from "../remoteView/RemoteViewZoom";
import { RemoteAgentCursor } from "./RemoteAgentCursor";
import { RemoteBrowserContextMenu } from "./RemoteBrowserContextMenu";
import { RemoteBrowserErrorChip } from "./RemoteBrowserErrorChip";
import { RemoteTabAudioButton, useRemoteTabAudio } from "./RemoteTabAudio";
import { usePreviewPageVisible } from "./previewPageVisibility";
import { createRemoteFramePainter, listenToRemoteFrames } from "./remoteFrames/remoteFrameCanvas";
import { createRemotePreviewMedia, listenToPreviewMedia } from "./remoteMedia/remotePreviewMedia";
import {
  createRemoteBrowserTouchGestures,
  attachRemoteKeyboardInput,
  createRemoteKeyboardQueue,
  remoteSearchUrl,
  type RemoteBrowserTouchGesture,
  type RemoteContextMenuItemId,
} from "./remoteBrowserInput";

/** How often the viewer polls for a snapshot when it cannot stream (older servers and desktops). */
const LIVE_FRAME_INTERVAL_MS = 2_500;
/** Faster while an agent drives the tab, so its cursor visibly moves with it. */
const AGENT_FRAME_INTERVAL_MS = 1_000;
const WHEEL_FLUSH_MS = 140;
/** Longest paste forwarded in one go; the keyboard queue sends it in type-sized runs. */
const PASTE_MAX_CHARS = 20_000;

/** Keys forwarded from a physical keyboard while the frame is focused. */
const FORWARDED_PRESS_KEYS = new Set([
  "Enter",
  "Backspace",
  "Tab",
  "Escape",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

interface ActiveGesture {
  readonly pointerId: number;
  readonly pointerType: string;
  /** Viewport-absolute origin of the letterboxed content rect. */
  readonly origin: FramePoint;
  readonly contentSize: FrameSize;
  readonly startedAt: number;
  readonly start: FramePoint;
  end: FramePoint;
  maxDistancePx: number;
  firstMovedAt: number | null;
}

/** Copies on the viewer's own device, falling back to the legacy command on plain-HTTP origins. */
function copyOnThisDevice(value: string): Promise<boolean> {
  const legacyCopy = () => {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    try {
      return document.execCommand("copy");
    } finally {
      area.remove();
    }
  };
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(value).then(
      () => true,
      () => legacyCopy(),
    );
  }
  return Promise.resolve(legacyCopy());
}

function commandError(cause: Cause.Cause<unknown>, fallback: string): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

/** What the viewer shows around the picture, from whichever feed drew it. */
interface RemoteFrameView {
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly url: string;
  readonly agentPointer: PreviewRemoteSnapshotResult["agentPointer"];
  readonly pendingDownloadApprovals: PreviewRemoteSnapshotResult["pendingDownloadApprovals"];
}

/** Letterbox the canvas exactly like the fallback image, preserving input geometry. */
function canvasBox(pane: FrameSize | null, picture: FrameSize | null) {
  if (pane === null || picture === null) return undefined;
  return containedFrameRect(pane, picture) ?? undefined;
}

/**
 * The web stand-in for the desktop's embedded browser surface: a live view of
 * the desktop host's real tab, with touches, wheel, and keys forwarded
 * through the same automation operations agents use. Rendering never changes
 * hands — the desktop keeps its own guest; this view only exists where no
 * local guest can (phone Safari, plain browsers).
 *
 * Compatible hosts send video sized for this viewer. JPEG keyframes and
 * patches cover startup and video failures; older hosts fall back to snapshots.
 */
export function RemoteBrowserFrame(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly visible: boolean;
  /** Who the rendering desktop reports is driving this tab. */
  readonly agentControl: PreviewAgentControl;
  readonly className?: string;
  /** Opens a URL in a new tab of the desktop browser; the page menu's "in new tab" items. */
  readonly onOpenInNewTab?: (url: string) => void;
}) {
  const { threadRef, tabId, visible, agentControl, onOpenInNewTab } = props;
  const { feedback: clickFeedback, markers: clickMarkers } = useRemoteClickFeedback(
    JSON.stringify([threadRef.environmentId, threadRef.threadId, tabId]),
  );
  const pageVisible = usePreviewPageVisible();
  const frameIntervalRef = useRef(LIVE_FRAME_INTERVAL_MS);
  frameIntervalRef.current =
    agentControl === "agent" ? AGENT_FRAME_INTERVAL_MS : LIVE_FRAME_INTERVAL_MS;
  const [frame, setFrame] = useState<PreviewRemoteSnapshotResult | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [touchMenu, setTouchMenu] = useState<TouchMenuState | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    readonly target: PreviewContextMenuTarget;
    readonly at: TouchPoint;
  } | null>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const tabAudio = useRemoteTabAudio({ threadRef, tabId, visible });
  const tabAudioRef = useRef(tabAudio);
  tabAudioRef.current = tabAudio;
  const touchClient = useOnScreenKeyboard();
  const keyboardInputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const coordinatorRef = useRef(new RemotePreviewCommandCoordinator());
  // A phone renders the whole desktop page a few inches wide, where a link is
  // smaller than a fingertip. Magnifying it is what makes the mirror clickable
  // at all, so the frame carries the same zoom control as the remote desktop.
  const imageRef = useRef<HTMLElement | null>(null);
  const zoomView = useRemoteViewZoom();
  const setImageElement = useCallback((element: HTMLElement | null) => {
    imageRef.current = element;
  }, []);
  // Two fingers own the picture (pinch to zoom, drag both to move); one finger
  // owns the page. Flipped synchronously in the pointer handlers so the gate
  // closes on the sample that starts the pinch, not one render later.
  const zoomAdjustingRef = useRef(zoomView.pinching);
  zoomAdjustingRef.current = zoomView.pinching;

  // The pushed feed. Painting happens straight on the canvas; React only
  // hears of a new picture size and new page state.
  const registry = useContext(RegistryContext);
  const serverConfigs = useServerConfigs();
  const streamSupported =
    typeof ResizeObserver !== "undefined" &&
    serverConfigs.get(threadRef.environmentId)?.environment.capabilities.remotePreviewFrames ===
      true;
  const mediaSupported =
    typeof ResizeObserver !== "undefined" &&
    serverConfigs.get(threadRef.environmentId)?.environment.capabilities
      .remotePreviewMediaChannel === true;
  const mediaCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mediaViewerRef = useRef<ReturnType<typeof createRemotePreviewMedia> | null>(null);
  const mediaZoomRef = useRef(zoomView.view.zoom);
  mediaZoomRef.current = zoomView.view.zoom;
  const [mediaPicture, setMediaPicture] = useState<FrameSize | null>(null);
  const [mediaActive, setMediaActive] = useState(false);
  const mediaActiveRef = useRef(false);
  const [streamPicture, setStreamPicture] = useState<{
    readonly width: number;
    readonly height: number;
  } | null>(null);
  const [streamState, setStreamState] = useState<PreviewRemoteFramePageState | null>(null);
  const [paneSize, setPaneSize] = useState<{
    readonly width: number;
    readonly height: number;
  } | null>(null);
  const [streamGeneration, setStreamGeneration] = useState(0);
  const [pollNeeded, setPollNeeded] = useState(!streamSupported);
  const pollNeededRef = useRef(pollNeeded);
  pollNeededRef.current = pollNeeded;
  const heldStreamFrameRef = useRef<HeldRemoteFrame | null>(null);
  const streamTimesRef = useRef<{
    subscribedAt: number | null;
    lastPictureAt: number | null;
    unavailableAt: number | null;
  }>({ subscribedAt: null, lastPictureAt: null, unavailableAt: null });
  const reconsiderPolling = useCallback(() => {
    if (mediaActiveRef.current) {
      pollNeededRef.current = false;
      setPollNeeded(false);
      return;
    }
    // Wait for the measured pane to subscribe before starting its grace period.
    // A bootstrap snapshot here would duplicate the stream's first picture.
    if (streamSupported && streamTimesRef.current.subscribedAt === null) {
      pollNeededRef.current = false;
      setPollNeeded(false);
      return;
    }
    const needed = remoteFrameShouldPoll({
      streamSupported,
      ...streamTimesRef.current,
      now: Date.now(),
    });
    pollNeededRef.current = needed;
    setPollNeeded(needed);
  }, [streamSupported]);
  const [painter] = useState(() =>
    createRemoteFramePainter({
      onError: () => {
        heldStreamFrameRef.current = null;
        streamTimesRef.current.unavailableAt = Date.now();
        reconsiderPollingRef.current();
        setStreamGeneration((value) => value + 1);
      },
      onPicture: (picture) => {
        if (mediaActiveRef.current) return;
        setMediaPicture(null);
        const first = streamTimesRef.current.lastPictureAt === null;
        streamTimesRef.current.lastPictureAt = Date.now();
        streamTimesRef.current.unavailableAt = null;
        setFrameError(null);
        setStreamPicture((held) =>
          held?.width === picture.width && held.height === picture.height ? held : picture,
        );
        if (first || pollNeededRef.current) reconsiderPollingRef.current();
      },
    }),
  );
  const reconsiderPollingRef = useRef(reconsiderPolling);
  reconsiderPollingRef.current = reconsiderPolling;

  // A pushed picture, once there is one, wins over a polled one.
  const view: RemoteFrameView | null =
    mediaPicture !== null
      ? {
          width: mediaPicture.width,
          height: mediaPicture.height,
          title: streamState?.title ?? frame?.title ?? "",
          url: streamState?.url ?? frame?.url ?? "",
          agentPointer: streamState?.agentPointer,
          pendingDownloadApprovals: streamState?.pendingDownloadApprovals,
        }
      : streamPicture !== null
        ? {
            width: streamPicture.width,
            height: streamPicture.height,
            title: streamState?.title ?? frame?.title ?? "",
            url: streamState?.url ?? frame?.url ?? "",
            agentPointer: streamState?.agentPointer,
            pendingDownloadApprovals: streamState?.pendingDownloadApprovals,
          }
        : frame !== null
          ? {
              width: frame.screenshot.width,
              height: frame.screenshot.height,
              title: frame.title,
              url: frame.url,
              agentPointer: frame.agentPointer,
              pendingDownloadApprovals: frame.pendingDownloadApprovals,
            }
          : null;
  const viewRef = useRef<RemoteFrameView | null>(view);
  viewRef.current = view;
  const frameRef = useRef<PreviewRemoteSnapshotResult | null>(null);
  frameRef.current = frame;
  const gestureRef = useRef<ActiveGesture | null>(null);
  const touchPointerRef = useRef<number | null>(null);
  // Android fires `contextmenu` on a long press; only a mouse's right button
  // may open the page menu that way, the finger has the radial menu.
  const lastPointerTypeRef = useRef("mouse");
  // Scroll pixels waiting to go out, and the viewport point the wheel turns at.
  const wheelAccumulatorRef = useRef<{ x: number; y: number; at: TouchPoint | null }>({
    x: 0,
    y: 0,
    at: null,
  });
  const wheelFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchGestureRef = useRef<(gesture: RemoteBrowserTouchGesture) => void>(() => {});
  const touchScrollRef = useRef<(delta: TouchPoint, at: TouchPoint) => void>(() => {});

  // One finger gets the remote desktop's gestures: tap clicks, a pan scrolls,
  // and holding still opens the radial menu (Drag, Right-click, Hold). The
  // mirror is request-per-action, so the menu's press stream is folded into
  // whole gestures that go out when the finger lifts.
  const [touch] = useState(() => {
    const gestures = createRemoteBrowserTouchGestures({
      gesture: (gesture) => touchGestureRef.current(gesture),
    });
    const actions = createTouchActionMenu({
      menu: (state) => {
        if (state) clickFeedback.cancelPress();
        gestures.menu(state);
        setTouchMenu(state);
      },
      pointer: gestures.pointer,
      scroll: (anchor, delta) => touchScrollRef.current(delta, anchor),
      panScrolls: true,
    });
    return { gestures, actions };
  });

  const captureRemoteSnapshot = useAtomCommand(previewEnvironment.remoteSnapshot, {
    reportFailure: false,
  });
  const sendRemoteInput = useAtomCommand(previewEnvironment.remoteInput, {
    reportFailure: false,
  });
  const getMediaTicket = useAtomCommand(previewEnvironment.mediaTicket, { reportFailure: false });
  const resolveMediaUrl = useEffectEvent(async (watchId: string) => {
    const result = await getMediaTicket({
      environmentId: threadRef.environmentId,
      input: { watchId },
    });
    if (result._tag === "Failure") {
      throw new Error(commandError(result.cause, "The browser media ticket was unavailable."));
    }
    const connection = readPreparedConnection(threadRef.environmentId);
    if (!connection) throw new Error("The environment is disconnected.");
    return mediaChannelUrl(connection.socketUrl, result.value.ticket);
  });

  const capture = useCallback(
    async (reportError = true): Promise<boolean> => {
      const coordinated = await coordinatorRef.current.latestCapture(() =>
        captureRemoteSnapshot({
          environmentId: threadRef.environmentId,
          // Names the frame already on screen, so a page that has not moved is
          // answered without downloading the same JPEG again.
          input: remoteSnapshotRequest(
            { threadId: threadRef.threadId, tabId: PreviewTabId.make(tabId) },
            frameRef.current,
          ),
        }),
      );
      if (coordinated.status === "stale") return false;
      const result = coordinated.value;
      if (result._tag === "Failure") {
        if (reportError) {
          setFrameError(
            commandError(result.cause, "The desktop browser host did not return a rendered frame."),
          );
        }
        return false;
      }
      if (!result.value.loading && pollNeededRef.current) {
        const next = mergeRemoteSnapshot(frameRef.current, result.value);
        setFrame(next);
        // Keep the last canvas visible through capture loss until polling has
        // a valid replacement. A recovered stream claims it again on paint.
        if (next !== null) {
          setStreamPicture(null);
          setMediaPicture(null);
        }
      }
      setFrameError(null);
      return true;
    },
    [captureRemoteSnapshot, threadRef.environmentId, threadRef.threadId, tabId],
  );

  const dispatchInput = useCallback(
    async (action: PreviewRemoteInputAction): Promise<PreviewRemoteInputResult | null> => {
      const clickId = action.kind === "click" ? clickFeedback.submit(action.position) : null;
      const coordinated = await coordinatorRef.current.queueInput(() =>
        sendRemoteInput({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, tabId: PreviewTabId.make(tabId), action },
        }),
      );
      if (coordinated.status === "stale") return null;
      const result = coordinated.value;
      if (clickId !== null) clickFeedback.settle(clickId, result._tag === "Success");
      if (result._tag === "Failure") {
        setFrameError(commandError(result.cause, "The desktop browser did not accept the input."));
        return null;
      }
      setFrameError(null);
      // Show the gesture's effect right away instead of waiting for the poll.
      // A streaming viewer needs nothing: the desktop pushes the change.
      if (pollNeededRef.current) await capture(false);
      return result.value;
    },
    [capture, clickFeedback, sendRemoteInput, threadRef.environmentId, threadRef.threadId, tabId],
  );
  const dispatchInputRef = useRef(dispatchInput);
  dispatchInputRef.current = dispatchInput;

  const [keyboardQueue] = useState(() =>
    createRemoteKeyboardQueue((entry) =>
      dispatchInputRef.current(
        entry.kind === "text"
          ? { kind: "type", text: entry.text }
          : { kind: "press", key: entry.key },
      ),
    ),
  );

  useEffect(() => {
    const input = keyboardInputRef.current;
    if (!touchClient || input === null) return;
    return attachRemoteKeyboardInput(input, {
      forwardedKeys: FORWARDED_PRESS_KEYS,
      onText: (text) => keyboardQueue.push({ kind: "text", text: text.slice(0, PASTE_MAX_CHARS) }),
      onKey: (key) => keyboardQueue.push({ kind: "key", key }),
      isBlocked: () => zoomAdjustingRef.current,
    });
  }, [keyboardQueue, touchClient]);

  useEffect(() => {
    coordinatorRef.current.reset();
    setFrame(null);
    setFrameError(null);
    setContextMenu(null);
    painter.reset();
    heldStreamFrameRef.current = null;
    streamTimesRef.current = { subscribedAt: null, lastPictureAt: null, unavailableAt: null };
    setStreamPicture(null);
    setMediaPicture(null);
    mediaActiveRef.current = false;
    setMediaActive(false);
    setStreamState(null);
    keyboardQueue.clear();
    touch.gestures.abandon();
    touch.actions.cancel();
    touchPointerRef.current = null;
    gestureRef.current = null;
    wheelAccumulatorRef.current = { x: 0, y: 0, at: null };
  }, [keyboardQueue, painter, touch, tabId, threadRef.environmentId, threadRef.threadId]);

  // The picture box, so the desktop sends pictures no larger than this screen shows.
  useEffect(() => {
    const element = containerRef.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setPaneSize((held) =>
        held?.width === width && held.height === height ? held : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Zooming in past 1.5x asks for twice the pixels, once the pinch settles.
  const requestZoom = !zoomView.pinching && zoomView.view.zoom >= 1.5 ? 2 : 1;
  const request =
    paneSize === null || paneSize.width === 0 || paneSize.height === 0
      ? null
      : remoteFrameRequestSize({
          boxWidth: paneSize.width,
          boxHeight: paneSize.height,
          devicePixelRatio: typeof window === "undefined" ? 1 : window.devicePixelRatio,
          zoom: requestZoom,
        });
  const requestWidth = request?.maxWidth ?? null;
  const requestHeight = request?.maxHeight ?? null;

  useEffect(() => {
    const canvas = mediaCanvasRef.current;
    if (!mediaSupported || !visible || !pageVisible || canvas === null) return;
    const viewer = createRemotePreviewMedia({
      canvas,
      watch: (handlers) =>
        listenToPreviewMedia(
          registry,
          previewEnvironment.mediaWatch({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, tabId: PreviewTabId.make(tabId) },
          }),
          handlers,
        ),
      resolveUrl: resolveMediaUrl,
      viewport: () => {
        const rect = containerRef.current?.getBoundingClientRect();
        return {
          width: Math.max(1, rect?.width ?? 640),
          height: Math.max(1, rect?.height ?? 480),
          devicePixelRatio: window.devicePixelRatio || 1,
          zoom: mediaZoomRef.current,
        };
      },
      onPicture: (picture) => {
        mediaActiveRef.current = true;
        setMediaActive(true);
        setMediaPicture((held) =>
          held?.width === picture.width && held.height === picture.height ? held : picture,
        );
        painter.reset();
        reconsiderPolling();
        setFrameError(null);
      },
      onState: setStreamState,
      onFallback: () => {
        // Retain the last video picture until the image feed has a replacement.
        mediaActiveRef.current = false;
        setMediaActive(false);
        reconsiderPolling();
      },
    });
    mediaViewerRef.current = viewer;
    return () => {
      viewer.stop();
      mediaViewerRef.current = null;
      mediaActiveRef.current = false;
      setMediaActive(false);
    };
  }, [
    mediaSupported,
    pageVisible,
    painter,
    reconsiderPolling,
    registry,
    tabId,
    threadRef.environmentId,
    threadRef.threadId,
    visible,
  ]);

  useEffect(() => {
    mediaViewerRef.current?.updateViewport();
  }, [paneSize?.width, paneSize?.height, zoomView.view.zoom]);

  useEffect(() => {
    if (
      !streamSupported ||
      mediaActive ||
      !visible ||
      !pageVisible ||
      requestWidth === null ||
      requestHeight === null
    ) {
      return;
    }
    const tabIdValue = PreviewTabId.make(tabId);
    const atom = previewEnvironment.remoteFrames({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        tabId: tabIdValue,
        maxWidth: requestWidth,
        maxHeight: requestHeight,
        patches: true,
        resync: streamGeneration,
      },
    });
    streamTimesRef.current = { subscribedAt: Date.now(), lastPictureAt: null, unavailableAt: null };
    heldStreamFrameRef.current = null;
    painter.reset();
    reconsiderPolling();
    // No picture within the grace period: poll until one arrives.
    const graceTimer = setTimeout(() => {
      reconsiderPolling();
    }, REMOTE_FRAME_STREAM_GRACE_MS + 50);
    let resyncTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = listenToRemoteFrames(registry, atom, {
      onEvents: (events) => {
        if (mediaActiveRef.current) return;
        const batch = planRemoteFrameEvents(heldStreamFrameRef.current, events);
        heldStreamFrameRef.current = batch.held;
        if (batch.state !== null) setStreamState(batch.state);
        if (batch.unavailable !== null) {
          painter.reset();
          streamTimesRef.current.unavailableAt = Date.now();
          reconsiderPolling();
        }
        painter.paint(batch.draws);
        if (batch.resync && resyncTimer === null) {
          // A patch for a picture this viewer does not hold. Subscribe again,
          // once the old subscription is gone, for a fresh keyframe.
          heldStreamFrameRef.current = null;
          resyncTimer = setTimeout(() => setStreamGeneration((value) => value + 1), 100);
        }
      },
      onFailure: () => {
        if (mediaActiveRef.current) return;
        painter.reset();
        streamTimesRef.current.unavailableAt = Date.now();
        reconsiderPolling();
      },
    });
    return () => {
      clearTimeout(graceTimer);
      if (resyncTimer !== null) clearTimeout(resyncTimer);
      unsubscribe();
      painter.reset();
      streamTimesRef.current.subscribedAt = null;
    };
  }, [
    painter,
    mediaActive,
    pageVisible,
    reconsiderPolling,
    registry,
    requestHeight,
    requestWidth,
    streamGeneration,
    streamSupported,
    tabId,
    threadRef.environmentId,
    threadRef.threadId,
    visible,
  ]);

  useEffect(() => {
    reconsiderPolling();
  }, [reconsiderPolling]);

  useEffect(
    () => () => {
      coordinatorRef.current.reset();
      touch.gestures.abandon();
      touch.actions.cancel();
    },
    [touch],
  );

  useEffect(() => {
    if (!visible || !pageVisible || !pollNeeded) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      await capture();
      if (active) timer = setTimeout(() => void tick(), frameIntervalRef.current);
    };
    void tick();
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [capture, pageVisible, pollNeeded, visible]);

  const contentGeometry = useCallback((): {
    readonly origin: FramePoint;
    readonly size: FrameSize;
  } | null => {
    // The IMAGE's box, not the container's: it is the one that carries the
    // zoom transform, so reading it keeps a tap landing on whatever the viewer
    // is actually looking at. The two are identical at 1x.
    const element = imageRef.current ?? containerRef.current;
    const current = viewRef.current;
    if (element === null || current === null) return null;
    const bounds = element.getBoundingClientRect();
    const rect = containedFrameRect(
      { width: bounds.width, height: bounds.height },
      { width: current.width, height: current.height },
    );
    if (rect === null) return null;
    return {
      origin: { x: bounds.left + rect.left, y: bounds.top + rect.top },
      size: { width: rect.width, height: rect.height },
    };
  }, []);

  /** The page fraction under a viewport point, or null when it sits in the letterbox bars. */
  const pagePoint = useCallback(
    (client: TouchPoint, { clamp }: { readonly clamp: boolean }) => {
      const geometry = contentGeometry();
      if (geometry === null) return null;
      const local = { x: client.x - geometry.origin.x, y: client.y - geometry.origin.y };
      if (
        !clamp &&
        (local.x < 0 ||
          local.y < 0 ||
          local.x > geometry.size.width ||
          local.y > geometry.size.height)
      ) {
        return null;
      }
      return frameFraction(geometry.size, local);
    },
    [contentGeometry],
  );

  const openContextMenu = useCallback(
    async (client: TouchPoint) => {
      const position = pagePoint(client, { clamp: true });
      if (position === null) return;
      const result = await dispatchInputRef.current({ kind: "contextMenu", position });
      // A null menu means the page drew its own, which the next frame shows.
      if (result?.contextMenu) setContextMenu({ target: result.contextMenu, at: client });
    },
    [pagePoint],
  );

  const flushScroll = useCallback(() => {
    wheelFlushTimerRef.current = null;
    const accumulated = wheelAccumulatorRef.current;
    wheelAccumulatorRef.current = { x: 0, y: 0, at: null };
    const geometry = contentGeometry();
    if (geometry === null) return;
    const deltaX = accumulated.x / geometry.size.width;
    const deltaY = accumulated.y / geometry.size.height;
    if (deltaX === 0 && deltaY === 0) return;
    // The wheel turns under the finger, so the panel there scrolls: most web
    // apps scroll an inner container, never the window itself.
    const position = accumulated.at === null ? null : pagePoint(accumulated.at, { clamp: true });
    void dispatchInputRef.current({
      kind: "scroll",
      deltaX,
      deltaY,
      ...(position === null ? {} : { position }),
    });
  }, [contentGeometry, pagePoint]);

  /**
   * Adds a scroll in viewport pixels, turned at viewport point `at`; a burst
   * goes out as one request.
   */
  const queueScroll = useCallback(
    (delta: TouchPoint, at: TouchPoint) => {
      wheelAccumulatorRef.current = {
        x: wheelAccumulatorRef.current.x + delta.x,
        y: wheelAccumulatorRef.current.y + delta.y,
        at,
      };
      wheelFlushTimerRef.current ??= setTimeout(flushScroll, WHEEL_FLUSH_MS);
    },
    [flushScroll],
  );

  touchScrollRef.current = queueScroll;
  touchGestureRef.current = (gesture) => {
    switch (gesture.kind) {
      case "click": {
        const position = pagePoint(gesture.at, { clamp: true });
        if (position !== null) void dispatchInputRef.current({ kind: "click", position });
        return;
      }
      case "contextMenu":
        void openContextMenu(gesture.at);
        return;
      case "drag": {
        const from = pagePoint(gesture.from, { clamp: true });
        const to = pagePoint(gesture.to, { clamp: true });
        if (from === null || to === null) return;
        void dispatchInputRef.current({
          kind: "drag",
          from,
          to,
          ...(gesture.button === undefined ? {} : { button: gesture.button }),
          ...(gesture.holdMs === undefined ? {} : { holdMs: gesture.holdMs }),
        });
        return;
      }
    }
  };

  const abandonTouch = () => {
    clickFeedback.cancelPress();
    touchPointerRef.current = null;
    touch.gestures.abandon();
    touch.actions.cancel();
  };

  const releaseCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    lastPointerTypeRef.current = event.pointerType;
    if (zoomView.onPointerDown(event)) {
      // A second finger: the picture is being pinched. Nothing has reached
      // the page yet - gestures are resolved on release - so the one in
      // flight is simply abandoned rather than delivered as a tap.
      zoomAdjustingRef.current = true;
      gestureRef.current = null;
      abandonTouch();
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    // Panning and dragging on the page are the same gesture; while the view is
    // being pinched, nothing is sent to the desktop tab.
    if (zoomAdjustingRef.current) return;
    const client = { x: event.clientX, y: event.clientY };
    // Input landing in the letterbox bars belongs to the panel, not the page.
    const point = pagePoint(client, { clamp: false });
    if (point === null) return;
    if (event.button === 0) clickFeedback.press(point, client);
    if (event.pointerType === "touch") {
      if (touchPointerRef.current !== null) return;
      // Keeps focus where it is, so an open keyboard stays up while the
      // viewer taps from field to field on the page.
      event.preventDefault();
      touchPointerRef.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      touch.actions.start(client, {
        x: Math.max(102, Math.min(window.innerWidth - 102, client.x)),
        y: Math.max(102, Math.min(window.innerHeight - 145, client.y)),
      });
      return;
    }
    if (event.button !== 0 || gestureRef.current !== null) return;
    const geometry = contentGeometry();
    if (geometry === null) return;
    const start = { x: client.x - geometry.origin.x, y: client.y - geometry.origin.y };
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      origin: geometry.origin,
      contentSize: geometry.size,
      startedAt: Date.now(),
      start,
      end: start,
      maxDistancePx: 0,
      firstMovedAt: null,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    clickFeedback.movePress({ x: event.clientX, y: event.clientY }, FRAME_TAP_SLOP_PX);
    if (zoomView.onPointerMove(event)) return;
    // A drag already in flight when the pinch began must not keep reporting;
    // the gesture was abandoned when the second finger landed.
    if (zoomAdjustingRef.current) return;
    if (touchPointerRef.current === event.pointerId) {
      touch.actions.move({ x: event.clientX, y: event.clientY });
      return;
    }
    const gesture = gestureRef.current;
    if (gesture === null || gesture.pointerId !== event.pointerId) return;
    const point = {
      x: event.clientX - gesture.origin.x,
      y: event.clientY - gesture.origin.y,
    };
    gesture.end = point;
    const distance = Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y);
    if (distance > gesture.maxDistancePx) gesture.maxDistancePx = distance;
    // The drag-hold clock starts when the pointer truly leaves the tap slop;
    // press-time jitter must not count as movement.
    if (gesture.firstMovedAt === null && distance > FRAME_TAP_SLOP_PX) {
      gesture.firstMovedAt = Date.now();
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    clickFeedback.cancelPress();
    // Browsers only let sound start from a tap, and a finger's tap only
    // counts once it lifts. Pressing play in the page is that tap.
    tabAudioRef.current.unlockFromGesture();
    if (zoomView.onPointerUp(event)) {
      zoomAdjustingRef.current = zoomView.pinchingRef.current;
      if (touchPointerRef.current === event.pointerId) touchPointerRef.current = null;
      releaseCapture(event);
      return;
    }
    if (zoomAdjustingRef.current) {
      // Abandon a gesture that was in flight when the pinch began rather
      // than returning early and leaving it latched: gestureRef would stay set
      // and the next real press would be rejected as "already dragging".
      if (gestureRef.current?.pointerId === event.pointerId) gestureRef.current = null;
      if (touchPointerRef.current === event.pointerId) abandonTouch();
      releaseCapture(event);
      return;
    }
    if (touchPointerRef.current === event.pointerId) {
      touchPointerRef.current = null;
      touch.actions.end();
      releaseCapture(event);
      return;
    }
    const gesture = gestureRef.current;
    if (gesture === null || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    releaseCapture(event);
    const sample = {
      startedAt: gesture.startedAt,
      start: gesture.start,
      end: gesture.end,
      maxDistancePx: gesture.maxDistancePx,
      firstMovedAt: gesture.firstMovedAt,
    };
    // A mouse drags deliberately (there is a wheel for scrolling); a pen
    // pans to scroll and holds to drag.
    let action: PreviewRemoteInputAction | null;
    if (gesture.pointerType === "mouse" && gesture.maxDistancePx > FRAME_TAP_SLOP_PX) {
      const from = frameFraction(gesture.contentSize, gesture.start);
      const to = frameFraction(gesture.contentSize, gesture.end);
      action = from !== null && to !== null ? { kind: "drag", from, to } : null;
    } else {
      action = resolveFrameGesture(gesture.contentSize, sample);
    }
    if (action !== null) void dispatchInputRef.current(action);
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    clickFeedback.cancelPress();
    // The browser took the touch (a system gesture): drop it, never deliver it.
    if (touchPointerRef.current === event.pointerId) abandonTouch();
    if (zoomView.onPointerUp(event)) {
      zoomAdjustingRef.current = zoomView.pinchingRef.current;
      releaseCapture(event);
      return;
    }
    if (gestureRef.current?.pointerId === event.pointerId) gestureRef.current = null;
    releaseCapture(event);
  };

  // The container is both the wheel listener's element and the pane the
  // picture fills at 1x, so it carries both refs.
  const paneRef = zoomView.paneRef;
  const containerRefCallback = useCallback(
    (element: HTMLDivElement | null) => {
      containerRef.current = element;
      paneRef(element);
    },
    [paneRef],
  );

  useEffect(() => {
    const element = containerRef.current;
    if (element === null || !visible) return;
    // React's synthetic wheel handlers are passive; preventing the panel from
    // scrolling underneath the frame needs a non-passive native listener.
    const onWheel = (event: WheelEvent) => {
      if (viewRef.current === null) return;
      // Still swallow the event so the panel behind does not scroll, but send
      // nothing: a trackpad scroll while the view is being adjusted belongs to
      // the viewer, not to the page they are looking at.
      event.preventDefault();
      if (zoomAdjustingRef.current) return;
      // Line and page deltas (Firefox's mouse wheel) become pixels.
      const scale =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? element.clientHeight
            : 1;
      queueScroll(
        { x: event.deltaX * scale, y: event.deltaY * scale },
        { x: event.clientX, y: event.clientY },
      );
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", onWheel);
      if (wheelFlushTimerRef.current !== null) {
        clearTimeout(wheelFlushTimerRef.current);
        wheelFlushTimerRef.current = null;
      }
    };
  }, [queueScroll, visible]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (zoomAdjustingRef.current) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target !== event.currentTarget) return;
    if (FORWARDED_PRESS_KEYS.has(event.key) || event.key.length === 1) {
      event.preventDefault();
      keyboardQueue.push({ kind: "key", key: event.key });
    }
  };

  const pasteText = (text: string) => {
    keyboardQueue.push({ kind: "text", text: text.slice(0, PASTE_MAX_CHARS) });
  };

  const copyWithNotice = async (value: string, what: string): Promise<boolean> => {
    const copied = await copyOnThisDevice(value);
    toastManager.add(
      copied
        ? { type: "success", title: `${what} copied` }
        : { type: "error", title: `Could not copy the ${what.toLowerCase()}` },
    );
    return copied;
  };

  const pasteFromThisDevice = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
      toastManager.add({
        type: "error",
        title: "This browser will not share its clipboard here",
        description: "Open the keyboard and paste from it instead.",
      });
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text.length > 0) pasteText(text);
    } catch {
      toastManager.add({ type: "error", title: "Clipboard access was refused" });
    }
  };

  const handleContextMenuChoice = (item: RemoteContextMenuItemId) => {
    const menu = contextMenu;
    setContextMenu(null);
    if (menu === null) return;
    const { target } = menu;
    switch (item) {
      case "open-link-host":
        onOpenInNewTab?.(target.linkUrl);
        return;
      case "open-link-here":
        if (isPublicWebPreviewUrl(target.linkUrl))
          window.open(target.linkUrl, "_blank", "noopener,noreferrer");
        return;
      case "copy-link":
        void copyWithNotice(target.linkUrl, "Link address");
        return;
      case "open-media-host":
        onOpenInNewTab?.(target.srcUrl);
        return;
      case "copy-media":
        void copyWithNotice(target.srcUrl, "Address");
        return;
      case "undo":
      case "redo":
        void dispatchInputRef.current({ kind: "editCommand", command: item });
        return;
      case "select-all":
        void dispatchInputRef.current({ kind: "editCommand", command: "selectAll" });
        return;
      case "cut":
        void copyWithNotice(target.selectionText, "Text").then((copied) => {
          if (copied) void dispatchInputRef.current({ kind: "editCommand", command: "delete" });
        });
        return;
      case "copy":
        void copyWithNotice(target.selectionText, "Text");
        return;
      case "paste":
        void pasteFromThisDevice();
        return;
      case "search":
        onOpenInNewTab?.(remoteSearchUrl(target.selectionText));
        return;
      case "back":
      case "forward":
      case "reload":
        void dispatchInputRef.current({ kind: "history", action: item });
        return;
      case "copy-page":
        void copyWithNotice(target.pageUrl, "Page address");
        return;
    }
  };

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  return (
    <div className={cn("flex min-h-0 flex-col bg-background", props.className)}>
      <div
        ref={containerRefCallback}
        aria-label={
          view
            ? `Rendered browser tab ${view.title || view.url}. Touches are sent to the desktop tab.`
            : "Waiting for the browser page"
        }
        className="relative min-h-0 flex-1 select-none overflow-hidden bg-black outline-none"
        data-preview-viewport
        data-remote-preview-feed={mediaPicture ? "video" : streamPicture ? "frames" : "snapshot"}
        role="application"
        // No callout either: iOS would otherwise offer to save the picture
        // under a long press the radial menu is meant to own.
        style={{ touchAction: "none", WebkitTouchCallout: "none" }}
        tabIndex={0}
        onContextMenu={(event) => {
          event.preventDefault();
          if (lastPointerTypeRef.current === "touch" || zoomAdjustingRef.current) return;
          const client = { x: event.clientX, y: event.clientY };
          if (pagePoint(client, { clamp: false }) === null) return;
          void openContextMenu(client);
        }}
        onKeyDown={handleKeyDown}
        onLostPointerCapture={(event) => {
          if (touchPointerRef.current === event.pointerId) abandonTouch();
        }}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text/plain");
          if (text.length === 0) return;
          event.preventDefault();
          pasteText(text);
        }}
        onPointerCancel={handlePointerCancel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <TouchActionRadialMenu state={touchMenu} />
        {mediaSupported || mediaPicture !== null ? (
          <div
            className="absolute inset-0"
            ref={mediaPicture !== null ? setImageElement : undefined}
            style={{ ...zoomView.style, visibility: mediaPicture === null ? "hidden" : "visible" }}
          >
            <canvas
              className="absolute"
              ref={mediaCanvasRef}
              style={canvasBox(paneSize, mediaPicture)}
            />
          </div>
        ) : null}
        {streamSupported || streamPicture !== null ? (
          // Pushed pictures are painted here. The wrapper fills the pane like
          // the polled image does, so zoom and touch geometry are the same.
          <div
            className="absolute inset-0"
            ref={mediaPicture === null && streamPicture !== null ? setImageElement : undefined}
            style={{
              ...zoomView.style,
              visibility: mediaPicture === null && streamPicture !== null ? "visible" : "hidden",
            }}
          >
            <canvas
              className="absolute"
              ref={painter.attach}
              style={canvasBox(paneSize, streamPicture)}
            />
          </div>
        ) : null}
        {mediaPicture === null && streamPicture === null && frame ? (
          <img
            alt=""
            className="absolute inset-0 h-full w-full object-contain"
            draggable={false}
            ref={setImageElement}
            src={`data:${frame.screenshot.mimeType};base64,${frame.screenshot.data}`}
            style={zoomView.style}
          />
        ) : null}
        {view === null ? (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-white/70">
            Waiting for the browser page…
          </div>
        ) : null}
        {view ? (
          <RemoteAgentCursor
            pointer={view.agentPointer}
            frame={view}
            // Waiting for the user means no agent is driving: the cursor dims.
            controller={agentControl === "agent" ? "agent" : "none"}
            style={zoomView.style}
          />
        ) : null}
        {view ? (
          <RemoteClickMarkers markers={clickMarkers} frame={view} style={zoomView.style} />
        ) : null}
        {view?.pendingDownloadApprovals?.length ? (
          <div className="absolute inset-x-3 top-3 space-y-2">
            {view.pendingDownloadApprovals.map((approval) => (
              <div
                key={approval.id}
                className="rounded-lg border border-amber-500/40 bg-amber-950/90 px-3 py-2 text-xs text-amber-100"
              >
                <p className="font-medium">Allow download from {approval.domain}?</p>
                <p className="mt-0.5 break-all text-amber-200/80">{approval.fileName}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(
                    [
                      ["Allow always", "allow-domain"],
                      ["Allow once", "allow-once"],
                      ["Deny", "deny"],
                    ] as const
                  ).map(([label, decision]) => (
                    <button
                      key={decision}
                      type="button"
                      className="rounded-md border border-amber-400/40 px-2 py-1 font-medium text-amber-50"
                      onClick={() => {
                        void dispatchInput({
                          kind: "answerDownloadApproval",
                          approvalId: approval.id,
                          decision,
                        });
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {contextMenu ? (
        <RemoteBrowserContextMenu
          target={contextMenu.target}
          at={contextMenu.at}
          canOpenInNewTab={onOpenInNewTab !== undefined}
          onChoose={handleContextMenuChoice}
          onClose={closeContextMenu}
        />
      ) : null}
      {/* The controls live in this strip, in flow, so nothing floats over the
          page: the picture is pinched, not buttoned. Their pointer-down keeps
          focus put, so tapping one leaves an open keyboard open. */}
      <div className="relative flex shrink-0 items-center gap-2 border-t border-border bg-background px-2 py-2">
        {touchClient ? (
          <input
            ref={keyboardInputRef}
            // Always mounted, never visible: it summons the on-screen keyboard
            // and receives its text, exactly as the remote desktop viewer's
            // does. Mobile browsers only raise the keyboard for a focus()
            // issued synchronously inside the tap, so it cannot mount on
            // demand. 16px keeps iOS from zooming the page when it focuses.
            className="absolute bottom-0 left-0 size-px text-[16px] opacity-0"
            aria-label="Keyboard input for the desktop tab"
            tabIndex={-1}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            onFocus={() => setKeyboardOpen(true)}
            onBlur={() => setKeyboardOpen(false)}
          />
        ) : null}
        <RemoteViewZoomReadout view={zoomView.view} onReset={zoomView.reset} />
        <div className="min-w-0 flex-1" />
        <RemoteBrowserErrorChip error={frameError} onRetry={capture} />
        <RemoteTabAudioButton state={tabAudio.state} onToggle={tabAudio.toggle} />
        {touchClient ? (
          <button
            aria-label={keyboardOpen ? "Hide keyboard" : "Show keyboard"}
            aria-pressed={keyboardOpen}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm",
              keyboardOpen && "bg-accent",
            )}
            type="button"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (keyboardOpen) {
                keyboardInputRef.current?.blur();
                return;
              }
              // Synchronously, inside the tap: a deferred focus raises nothing.
              keyboardInputRef.current?.focus();
            }}
          >
            <KeyboardIcon className="size-4" />
            Keyboard
          </button>
        ) : null}
        <button
          aria-label="Press Enter in the desktop tab"
          className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm"
          type="button"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => keyboardQueue.push({ kind: "key", key: "Enter" })}
        >
          ⏎
        </button>
        <button
          aria-label="Press Backspace in the desktop tab"
          className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm"
          type="button"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => keyboardQueue.push({ kind: "key", key: "Backspace" })}
        >
          ⌫
        </button>
      </div>
    </div>
  );
}
