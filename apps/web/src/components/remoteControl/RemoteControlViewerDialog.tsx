"use client";

import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  RemoteControlDisplay,
  RemoteControlInput,
  RemoteControlPointerButton,
  RemoteControlSession,
  RemoteControlVideoChunk,
} from "@t3tools/contracts";
import {
  Gamepad2Icon,
  KeyboardIcon,
  MaximizeIcon,
  MinimizeIcon,
  MonitorIcon,
  ShieldCheckIcon,
  SquareStackIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { useEnvironmentQuery } from "~/state/query";
import { remoteControlEnvironment } from "~/state/remoteControl";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOnScreenKeyboard } from "~/hooks/useOnScreenKeyboard";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import {
  controllerPlatform,
  objectContainContentRect,
  normalizeRemoteControlKeyCode,
  normalizedRemotePoint,
  remotePointerButton,
  remoteSurfaceCursorStyle,
  shouldForwardEscapeOnPointerUnlock,
  shouldForwardRemoteSurfaceInput,
} from "./remoteControlInput";
import { RemoteControlFpsOverlay } from "./RemoteControlFpsOverlay";
import { type FpsMovementCode, shouldShowFpsController } from "./remoteControlFpsController";
import { createRemoteControlInputScheduler } from "./remoteControlInputScheduler";
import { describeHostStatus } from "./remoteControlHostStatus";
import { clampPointerDelta } from "./remoteControlPointerMotion";
import { resolveRemoteControlSurface } from "./remoteControlSurfaceState";
import {
  createRemoteControlVideoSink,
  describeUnsupportedCodec,
  formatVideoStats,
  type RemoteControlVideoSink,
} from "./remoteControlPlayer";

/**
 * How long an approved session may show nothing before the spinner admits that
 * this is longer than it should be. Comfortably past the 5s video watchdog, so
 * a session that merely fell back to JPEG never trips it.
 */
const FIRST_FRAME_SLOW_MS = 12_000;

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error && cause.message.trim()
    ? cause.message
    : "Remote control could not be started.";
}

/** Magnification steps the two magnifier buttons walk between. */
const ZOOM_STEPS = [1, 1.5, 2, 3, 4] as const;

export function RemoteControlViewerDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { environmentId, environmentLabel, open, onOpenChange } = props;
  const generatedId = useId();
  const clientId = `controller-${generatedId}`;
  const [session, setSession] = useState<RemoteControlSession | null>(null);
  const [frameData, setFrameData] = useState<string | null>(null);
  const [displays, setDisplays] = useState<ReadonlyArray<RemoteControlDisplay>>([]);
  const [activeDisplayId, setActiveDisplayId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  // A host condition that suspends the stream without ending it — a UAC prompt
  // being the usual one. Cleared by the host reporting itself healthy again.
  const [hostNotice, setHostNotice] = useState<string | null>(null);
  const [inputCaptured, setInputCaptured] = useState(false);
  const inputCapturedRef = useRef(false);
  // Mirrors the remote pointer grab. `remoteLocked` is what the host reports;
  // `pointerLocked` is what the browser actually granted, which can lag or be
  // refused (pointer lock needs a user gesture and can be denied outright).
  const [remoteLocked, setRemoteLocked] = useState(false);
  const remoteLockedRef = useRef(false);
  remoteLockedRef.current = remoteLocked;
  // Host OS cursor shape, mirrored onto the local cursor while input is
  // captured so hovering a remote text field shows the beam, a link the hand.
  const [remoteCursorShape, setRemoteCursorShape] = useState("default");
  const [pointerLocked, setPointerLocked] = useState(false);
  const pointerLockedRef = useRef(false);
  // Armed by the user; the controller only appears once something actually
  // locks the pointer, which is when relative motion starts meaning anything.
  const [fpsArmed, setFpsArmed] = useState(false);
  const programmaticPointerUnlockRef = useRef(false);
  const surfaceElementRef = useRef<HTMLDivElement | null>(null);
  const requestStartedRef = useRef(false);
  const frameImageRef = useRef<HTMLImageElement>(null);
  const frameVideoRef = useRef<HTMLVideoElement>(null);
  const [videoMimeType, setVideoMimeType] = useState<string | null>(null);
  // Bumped per init segment: each container needs a fresh MediaSource even
  // when the codec string is identical across encoder restarts.
  const [videoEpoch, setVideoEpoch] = useState(0);
  const videoSinkRef = useRef<RemoteControlVideoSink | null>(null);
  const videoMimeTypeRef = useRef<string | null>(null);
  const pendingChunksRef = useRef<RemoteControlVideoChunk[]>([]);
  // Set once video is confirmed undecodable here, which permanently hands the
  // session back to the JPEG frames the host also understands.
  //
  // Deliberately not shown to the user. Falling back is the session working as
  // designed — the picture arrives either way — so the string is a diagnostic,
  // surfaced on the surface element as a data attribute for debugging and
  // nowhere else. It used to render as an amber banner over the desktop and as
  // a headline explaining itself, which read as a failure at the exact moment
  // the viewer was successfully recovering.
  const [videoUnavailable, setVideoUnavailable] = useState<string | null>(null);
  const videoUnavailableRef = useRef<string | null>(null);
  videoUnavailableRef.current = videoUnavailable;
  const decodedRef = useRef(false);
  // Whether anything has actually been painted yet, by either path. Until this
  // flips, the surface is a black rectangle that looks broken.
  const [hasRenderedFrame, setHasRenderedFrame] = useState(false);
  const [firstFrameSlow, setFirstFrameSlow] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);
  /**
   * iPhone Safari implements the Fullscreen API for <video> only — an
   * arbitrary element cannot go fullscreen at all, so the button did nothing
   * on the one device most likely to want it. This fills the viewport with CSS
   * instead, which is what the user was asking for either way.
   */
  const [pseudoFullScreen, setPseudoFullScreen] = useState(false);
  /** 1 = fit the pane. Above that, the picture is magnified about `zoomOrigin`. */
  const [zoom, setZoom] = useState(1);
  const [zoomOrigin, setZoomOrigin] = useState({ x: 50, y: 50 });
  // Where the last touch landed, so zooming in magnifies what was just tapped
  // rather than always the middle of the screen.
  const lastPointerFractionRef = useRef({ x: 0.5, y: 0.5 });
  // Touch devices have no hardware keyboard to capture; this summons the
  // on-screen one via a hidden input and forwards its text natively.
  const [virtualKeyboardOpen, setVirtualKeyboardOpen] = useState(false);
  // The FPS thumbsticks and the on-screen keyboard summoner are touch
  // affordances. A desktop client captures the real mouse and keyboard
  // directly, so there the buttons are dead weight.
  const touchClient = useOnScreenKeyboard();
  const virtualKeyboardInputRef = useRef<HTMLInputElement>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const inputSequenceRef = useRef(0);
  const pressedKeysRef = useRef(new Map<string, string>());
  const pressedPointerButtonRef = useRef<RemoteControlPointerButton | null>(null);
  const lastPointerPointRef = useRef({ x: 0.5, y: 0.5 });
  const platform = useMemo(() => controllerPlatform(navigator.userAgent), []);
  const requestAccess = useAtomCommand(remoteControlEnvironment.requestAccess, {
    label: "request remote control",
    reportFailure: false,
  });
  const cancel = useAtomCommand(remoteControlEnvironment.cancel, {
    label: "cancel remote control",
    reportFailure: false,
  });
  const sendInputCommand = useAtomCommand(remoteControlEnvironment.sendInput, {
    label: "send remote-control input",
    reportFailure: false,
  });
  const watch = useEnvironmentQuery(
    open && session
      ? remoteControlEnvironment.watch({
          environmentId,
          input: { sessionId: session.sessionId },
        })
      : null,
  );

  useEffect(() => {
    if (!open || requestStartedRef.current) return;
    requestStartedRef.current = true;
    setError(null);
    setFrameData(null);
    setHasRenderedFrame(false);
    setFirstFrameSlow(false);

    void (async () => {
      const result = await requestAccess({
        environmentId,
        input: {
          clientId,
          requestedCapabilities: ["screen", "pointer", "keyboard"],
        },
      });
      if (result._tag === "Failure") {
        setError(failureMessage(result));
        return;
      }
      setSession(result.value);
    })();
  }, [clientId, environmentId, open, requestAccess]);

  /**
   * Buffers chunks until the <video> element exists, then hands them to the
   * sink. The codec is only known from the first chunk, so the element cannot
   * be rendered any earlier — and a chunk that arrives in between must not be
   * lost, or decoding starts mid-container and never recovers.
   */
  const appendVideoChunk = useCallback((chunk: RemoteControlVideoChunk) => {
    if (videoUnavailableRef.current) return;
    // EVERY init segment supersedes the current container, same codec or not:
    // a host encoder restart (watcher joined, monitor switch, capture
    // recovery) restarts timestamps at zero, and appending a second WebM
    // header into a live SourceBuffer is exactly the "stream parsing failed"
    // demuxer error that used to kill video. A fresh MediaSource per
    // container is the only shape Chromium accepts.
    if (chunk.isInit) {
      videoSinkRef.current?.dispose();
      videoSinkRef.current = null;
      videoMimeTypeRef.current = chunk.mimeType;
      pendingChunksRef.current = [chunk];
      setVideoMimeType(chunk.mimeType);
      // The mime is often unchanged across restarts, so a separate nonce is
      // what actually re-runs the sink-attach effect.
      setVideoEpoch((epoch) => epoch + 1);
      return;
    }
    if (videoSinkRef.current) {
      videoSinkRef.current.append(chunk);
      return;
    }
    // Still waiting on the element; keep only what is decodable from the last
    // init segment so the backlog cannot grow without bound.
    if (pendingChunksRef.current.length > 0) pendingChunksRef.current.push(chunk);
  }, []);

  // Attaches the sink once the element for this codec has mounted; re-runs per
  // init segment (videoEpoch) because each container needs its own MediaSource.
  useEffect(() => {
    if (!videoMimeType || videoSinkRef.current) return;
    const unsupported = describeUnsupportedCodec(videoMimeType);
    if (unsupported) {
      setVideoUnavailable(unsupported);
      return;
    }
    const video = frameVideoRef.current;
    if (!video) return;
    const sink = createRemoteControlVideoSink(videoMimeType, video, (detail) => {
      // Only a failure before anything decoded is fatal; a mid-stream hiccup
      // resynchronises on the next init segment.
      if (!decodedRef.current) setVideoUnavailable(detail);
    });
    if (!sink) {
      setVideoUnavailable(`This client could not start video playback (${videoMimeType}).`);
      return;
    }
    videoSinkRef.current = sink;
    video.src = sink.url;
    for (const pending of pendingChunksRef.current) sink.append(pending);
    pendingChunksRef.current = [];
  }, [videoEpoch, videoMimeType]);

  /**
   * Watchdog. Chunks can arrive and append cleanly yet still decode to nothing,
   * which renders as an unexplained black rectangle. If no frame has decoded a
   * few seconds in, say so and fall back to JPEG rather than sit on black.
   */
  useEffect(() => {
    if (!videoMimeType || videoUnavailable) return;
    const timer = window.setTimeout(() => {
      const video = frameVideoRef.current;
      if (video && video.videoWidth > 0) {
        decodedRef.current = true;
        return;
      }
      const stats = videoSinkRef.current?.stats();
      setVideoUnavailable(
        `No video decoded from the host after 5s (${videoMimeType}). Falling back to image frames.` +
          (stats ? ` [${formatVideoStats(stats)}]` : " [no video sink was created]"),
      );
    }, 5_000);
    return () => window.clearTimeout(timer);
    // videoEpoch re-arms the window per container: an encoder restart replaces
    // the element's media, so the previous container's verdict is stale.
  }, [videoEpoch, videoMimeType, videoUnavailable]);

  useEffect(
    () => () => {
      videoSinkRef.current?.dispose();
      videoSinkRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const event = watch.data;
    if (!event) return;
    if (event.type === "video-chunk") {
      if (event.chunk.displays) setDisplays(event.chunk.displays);
      if (event.chunk.displayId) setActiveDisplayId(event.chunk.displayId);
      appendVideoChunk(event.chunk);
      return;
    }
    if (event.type === "pointer-lock-changed") {
      setRemoteLocked(event.locked);
      return;
    }
    if (event.type === "cursor-changed") {
      setRemoteCursorShape(event.shape);
      return;
    }
    if (event.type === "host-status") {
      // Transient by definition: the session is still approved and the stream
      // is expected back, so this is a notice rather than an error.
      setHostNotice(describeHostStatus(event.status));
      if (event.status.state === "ok") setInputError(null);
      return;
    }
    if (event.type === "frame") {
      setFrameData(`data:${event.frame.mimeType};base64,${event.frame.data}`);
      if (event.frame.displays) setDisplays(event.frame.displays);
      // Track what the host is actually sending rather than what we asked for,
      // so the picker self-corrects if a requested monitor was unavailable.
      if (event.frame.displayId) setActiveDisplayId(event.frame.displayId);
      return;
    }
    setSession(event.session);
    if (event.session.status === "declined") {
      setError(`${environmentLabel} declined the screen-sharing request.`);
    } else if (event.session.status === "failed") {
      setError(
        event.session.failureReason ?? `${environmentLabel} could not start screen sharing.`,
      );
    }
  }, [environmentLabel, watch.data]);

  useEffect(() => {
    if (watch.error) setError(watch.error);
  }, [watch.error]);

  const dispatchInput = useCallback(
    async (input: RemoteControlInput) => {
      const currentSession = sessionRef.current;
      if (currentSession?.status !== "approved") return;
      const outcome = await sendInputCommand({
        environmentId,
        input: {
          sessionId: currentSession.sessionId,
          sequence: inputSequenceRef.current++,
          input,
        },
      });
      if (outcome._tag === "Failure") {
        throw new Error(failureMessage(outcome));
      }
      // Recovery is only observable here, so a stale error must not outlive
      // the condition that caused it.
      setInputError((current) => (current === null ? current : null));
    },
    [environmentId, sendInputCommand],
  );

  const inputScheduler = useMemo(
    () =>
      createRemoteControlInputScheduler({
        send: dispatchInput,
        onError: (cause) => {
          setInputError(
            cause instanceof Error && cause.message.trim()
              ? cause.message
              : "The remote computer could not apply that input.",
          );
        },
        scheduleFrame: (callback) => window.requestAnimationFrame(callback),
        cancelFrame: (handle) => window.cancelAnimationFrame(handle),
      }),
    [dispatchInput],
  );

  const enqueueInput = useCallback(
    (input: RemoteControlInput) => inputScheduler.enqueue(input),
    [inputScheduler],
  );

  // The media elements fill the pane (so the stream scales up to the window,
  // fullscreen included) and object-contain letterboxes INSIDE the element —
  // so pointer math must use the picture's rectangle, not the element's.
  const remoteSurfaceRect = useCallback(() => {
    const video = frameVideoRef.current;
    if (video) {
      return objectContainContentRect(video.getBoundingClientRect(), {
        width: video.videoWidth,
        height: video.videoHeight,
      });
    }
    const image = frameImageRef.current;
    if (image) {
      return objectContainContentRect(image.getBoundingClientRect(), {
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    }
    return null;
  }, []);

  // Tell the host to stop encoding video once this client has given up on it,
  // otherwise it keeps sending chunks nobody can render and the view stays black.
  useEffect(() => {
    if (!videoUnavailable) return;
    videoSinkRef.current?.dispose();
    videoSinkRef.current = null;
    enqueueInput({ type: "request-image-fallback" });
  }, [enqueueInput, videoUnavailable]);

  const releasePressedInputs = useCallback(() => {
    for (const [code, key] of pressedKeysRef.current) {
      enqueueInput({ type: "key", action: "up", code, key, repeat: false });
    }
    pressedKeysRef.current.clear();
    const pressedPointerButton = pressedPointerButtonRef.current;
    if (pressedPointerButton) {
      enqueueInput({
        type: "pointer",
        action: "up",
        ...lastPointerPointRef.current,
        button: pressedPointerButton,
      });
    }
    pressedPointerButtonRef.current = null;
  }, [enqueueInput]);

  const releaseInputCapture = useCallback(() => {
    inputCapturedRef.current = false;
    setInputCaptured(false);
    releasePressedInputs();
  }, [releasePressedInputs]);

  const captureInput = useCallback(() => {
    inputCapturedRef.current = true;
    setInputCaptured(true);
    setInputError(null);
  }, []);

  /**
   * Mirror the remote pointer grab into browser pointer lock.
   *
   * Without this the local cursor keeps wandering across the viewer — and off
   * it — while the remote cursor is pinned inside a game, so the two disagree
   * about where the mouse is and the local pointer eventually leaves the
   * window entirely. Pointer lock also unlocks `movementX/Y`, which is the
   * only way to get the relative deltas mouse-look needs.
   *
   * Escape exits pointer lock natively and the browser consumes that key event.
   * `pointerlockchange` is therefore also the only reliable place to forward
   * the same Escape edge to the host. Programmatic exits are marked separately
   * so closing the dialog or leaving control mode never invents a key press.
   */
  useEffect(() => {
    const handlePointerLockChange = () => {
      const wasLocked = pointerLockedRef.current;
      const locked = document.pointerLockElement === surfaceElementRef.current;
      const programmatic = programmaticPointerUnlockRef.current;
      programmaticPointerUnlockRef.current = false;
      pointerLockedRef.current = locked;
      setPointerLocked(locked);
      // A mode edge invalidates any unsent motion sampled in the previous mode.
      inputScheduler.discardPointerMotion();
      if (
        shouldForwardEscapeOnPointerUnlock({
          wasLocked,
          isLocked: locked,
          programmatic,
          inputCaptured: inputCapturedRef.current,
          keyboardGranted:
            sessionRef.current?.status === "approved" &&
            sessionRef.current.grantedCapabilities.includes("keyboard"),
          documentVisible: document.visibilityState === "visible",
          documentFocused: document.hasFocus(),
        })
      ) {
        enqueueInput({ type: "key", action: "down", code: "Escape", key: "Escape", repeat: false });
        enqueueInput({ type: "key", action: "up", code: "Escape", key: "Escape", repeat: false });
      }
    };
    document.addEventListener("pointerlockchange", handlePointerLockChange);
    return () => {
      document.removeEventListener("pointerlockchange", handlePointerLockChange);
      pointerLockedRef.current = false;
      inputScheduler.discardPointerMotion();
    };
  }, [enqueueInput, inputScheduler]);

  useEffect(() => {
    if (!inputCaptured) return;
    const handleWindowBlur = () => releaseInputCapture();
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") releaseInputCapture();
    };
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [inputCaptured, releaseInputCapture]);

  useEffect(
    () => () => {
      inputCapturedRef.current = false;
      inputScheduler.clear();
      pressedKeysRef.current.clear();
      pressedPointerButtonRef.current = null;
    },
    [inputScheduler],
  );

  const close = async () => {
    const current = session;
    requestStartedRef.current = false;
    setSession(null);
    setFrameData(null);
    setError(null);
    setInputError(null);
    setHostNotice(null);
    inputCapturedRef.current = false;
    setInputCaptured(false);
    inputScheduler.clear();
    pressedKeysRef.current.clear();
    onOpenChange(false);
    if (
      current &&
      (current.status === "waiting-for-host-approval" || current.status === "approved")
    ) {
      await cancel({
        environmentId,
        input: { sessionId: current.sessionId },
      });
    }
  };

  const status = session?.status ?? "waiting-for-host-approval";
  const isWaiting = !error && status === "waiting-for-host-approval";
  const isApproved = !error && status === "approved";
  const isTerminal =
    status === "declined" || status === "cancelled" || status === "ended" || status === "failed";
  const canPointer = isApproved && session?.grantedCapabilities.includes("pointer") === true;
  const canKeyboard = isApproved && session?.grantedCapabilities.includes("keyboard") === true;
  const canControl = canPointer || canKeyboard;
  const surface = resolveRemoteControlSurface({
    isApproved,
    videoMimeType,
    videoUnavailable,
    frameData,
    hasRenderedFrame,
  });

  /**
   * Ask the browser to actually lock the mouse to the surface. Chromium only
   * grants pointer lock with transient user activation, so a request fired
   * from an effect (the host reporting "locked" mid-session) can be refused
   * even with the permission granted. This is therefore called from BOTH
   * places: the state effect below (works when the state change follows a
   * recent click) and directly inside pointer-down handlers, where activation
   * is guaranteed — the first click on the surface after a game grabs the
   * remote cursor is what reliably engages the local lock.
   */
  const engagePointerLock = useCallback(() => {
    const surface = surfaceElementRef.current;
    if (!surface || document.pointerLockElement === surface) return;
    void Promise.resolve(surface.requestPointerLock()).catch(() => undefined);
  }, []);

  useEffect(() => {
    const surface = surfaceElementRef.current;
    if (!surface) return;
    if (remoteLocked && inputCaptured && canPointer) {
      engagePointerLock();
      return;
    }
    if (document.pointerLockElement === surface) {
      programmaticPointerUnlockRef.current = true;
      document.exitPointerLock();
    }
  }, [canPointer, engagePointerLock, inputCaptured, remoteLocked]);

  useEffect(() => {
    if (!canControl && inputCaptured) releaseInputCapture();
  }, [canControl, inputCaptured, releaseInputCapture]);

  /**
   * Says so when the first frame is taking unusually long.
   *
   * The 5s video watchdog hands the session to JPEG silently, which fixes most
   * stalls without the user ever knowing. This covers the case that outlives
   * even that: approved, connected, and still nothing painted. It stays a
   * notice rather than an error — the session is not dead and frames may yet
   * arrive — so it only adds a line under the spinner.
   */
  useEffect(() => {
    if (!isApproved || hasRenderedFrame) {
      setFirstFrameSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setFirstFrameSlow(true), FIRST_FRAME_SLOW_MS);
    return () => window.clearTimeout(timer);
  }, [hasRenderedFrame, isApproved]);

  /**
   * Full screen is driven by the browser, not by us: the user can leave with
   * Escape or the system chrome without touching our button, so the flag is
   * only ever a mirror of the fullscreen element. WebKit engines that predate
   * the unprefixed API fire the prefixed event and expose the prefixed
   * element, so both spellings are mirrored.
   */
  useEffect(() => {
    const sync = () => {
      const fullscreenElement =
        document.fullscreenElement ??
        (document as { webkitFullscreenElement?: Element | null }).webkitFullscreenElement ??
        null;
      setIsFullScreen(
        fullscreenElement !== null && fullscreenElement === surfaceElementRef.current,
      );
    };
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);

  const zoomIn = useCallback(() => {
    const next = ZOOM_STEPS.find((step) => step > zoom + 0.001) ?? zoom;
    if (next === zoom) return;
    // Anchor on the last touch only when leaving 1x. Re-anchoring on every
    // step would walk the picture out from under the finger.
    if (zoom === 1) {
      const { x, y } = lastPointerFractionRef.current;
      setZoomOrigin({ x: Math.round(x * 100), y: Math.round(y * 100) });
    }
    setZoom(next);
  }, [zoom]);

  const zoomOut = useCallback(() => {
    const next = [...ZOOM_STEPS].reverse().find((step) => step < zoom - 0.001) ?? 1;
    if (next === zoom) return;
    if (next === 1) setZoomOrigin({ x: 50, y: 50 });
    setZoom(next);
  }, [zoom]);

  const toggleFullScreen = useCallback(() => {
    // The CSS fallback owns the toggle once it is on: there is no browser
    // fullscreen state to exit, so asking the document would leave it stuck.
    if (pseudoFullScreen) {
      setPseudoFullScreen(false);
      return;
    }
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => void;
    };
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      if (doc.exitFullscreen) {
        void Promise.resolve(doc.exitFullscreen()).catch(() => undefined);
      } else {
        doc.webkitExitFullscreen?.();
      }
      return;
    }
    const surface = surfaceElementRef.current as
      | (HTMLDivElement & { webkitRequestFullscreen?: () => void })
      | null;
    if (!surface) return;
    // Fallback ladder: standard element fullscreen → prefixed WebKit element
    // fullscreen → iOS Safari, which only fullscreens <video> elements via its
    // own non-fullscreen-API method. Only when every rung is missing or
    // refused does the button admit it cannot work here.
    const enterVideoFullscreen = () => {
      const video = frameVideoRef.current as
        | (HTMLVideoElement & { webkitEnterFullscreen?: () => void })
        | null;
      if (video?.webkitEnterFullscreen) {
        try {
          video.webkitEnterFullscreen();
          return true;
        } catch {
          return false;
        }
      }
      return false;
    };
    const reportUnavailable = () => {
      if (enterVideoFullscreen()) return;
      // Every native rung refused — iPhone Safari, in practice. Fill the
      // viewport with CSS rather than telling the user it cannot be done.
      setPseudoFullScreen(true);
    };
    if (surface.requestFullscreen) {
      void Promise.resolve(surface.requestFullscreen({ navigationUI: "hide" })).catch(
        reportUnavailable,
      );
      return;
    }
    if (surface.webkitRequestFullscreen) {
      try {
        surface.webkitRequestFullscreen();
        return;
      } catch {
        // Fall through to the video rung.
      }
    }
    reportUnavailable();
  }, [pseudoFullScreen]);

  // Leaving the dialog while still full screen would strand the browser there.
  useEffect(() => {
    if (open) return;
    if (document.fullscreenElement === surfaceElementRef.current && document.fullscreenElement) {
      void Promise.resolve(document.exitFullscreen()).catch(() => undefined);
    }
  }, [open]);

  const sendPointer = (
    event: ReactPointerEvent<HTMLDivElement>,
    action: "move" | "down" | "up",
    button = remotePointerButton(event.button),
  ) => {
    if (
      !shouldForwardRemoteSurfaceInput({
        capabilityGranted: canPointer,
        inputCaptured: inputCapturedRef.current,
        kind: `pointer-${action}`,
        hasActivePointerPress: pressedPointerButtonRef.current !== null,
      })
    ) {
      return;
    }
    event.preventDefault();

    // Locked: the remote app is in mouse-look, so it reads deltas and the
    // cursor position is meaningless to it. The scheduler samples these at
    // display-frame cadence and keeps only one replaceable successor; there is
    // deliberately no residual motion to replay later.
    //
    // The HOST's lock state decides the mode, not just the local browser
    // lock: the moment a remote game captures the cursor, absolute warps
    // would spin its aim, and movementX/Y are available on ordinary moves
    // too. Local pointer lock (which can lag behind by one click) only adds
    // cursor confinement on top.
    if (pointerLockedRef.current || remoteLockedRef.current) {
      const point = lastPointerPointRef.current ?? { x: 0.5, y: 0.5 };
      if (action === "move") {
        const dx = clampPointerDelta(event.movementX);
        const dy = clampPointerDelta(event.movementY);
        if (dx !== 0 || dy !== 0) {
          enqueueInput({ type: "pointer", action, ...point, button, dx, dy });
        }
        return;
      }
      // A click must not carry motion, or pressing fire would nudge the aim.
      enqueueInput({ type: "pointer", action, ...point, button, dx: 0, dy: 0 });
      return;
    }

    const point = normalizedRemotePoint({
      clientX: event.clientX,
      clientY: event.clientY,
      rect: remoteSurfaceRect() ?? event.currentTarget.getBoundingClientRect(),
    });
    lastPointerPointRef.current = point;
    enqueueInput({
      type: "pointer",
      action,
      ...point,
      button,
    });
  };

  const sendWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (
      !shouldForwardRemoteSurfaceInput({
        capabilityGranted: canPointer,
        inputCaptured: inputCapturedRef.current,
        kind: "wheel",
      })
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const point = normalizedRemotePoint({
      clientX: event.clientX,
      clientY: event.clientY,
      rect: remoteSurfaceRect() ?? event.currentTarget.getBoundingClientRect(),
    });
    enqueueInput({
      type: "wheel",
      ...point,
      deltaX: Math.max(-2_000, Math.min(2_000, event.deltaX)),
      deltaY: Math.max(-2_000, Math.min(2_000, event.deltaY)),
    });
  };

  /**
   * FPS controller wiring.
   *
   * Every one of these mirrors what the locked-pointer path in `sendPointer`
   * already does, so the host cannot tell a thumb from a mouse: motion carries
   * `dx`/`dy` and no position, and a button edge carries no motion at all —
   * otherwise pressing fire would nudge the aim.
   */
  const fpsActive = shouldShowFpsController({
    armed: fpsArmed,
    canControl,
    canPointer,
    canKeyboard,
    remoteLocked,
    pointerLocked,
  });

  const sendFpsKey = useCallback(
    (code: string, key: string, action: "down" | "up") => {
      // Same gate as the physical keyboard path. The pad can be on screen with
      // capture lost — the host's lock state raises it, not this window's
      // focus — and without this it would keep feeding a surface the rest of
      // the component considers unfocused.
      if (
        !shouldForwardRemoteSurfaceInput({
          capabilityGranted: canKeyboard,
          inputCaptured: inputCapturedRef.current,
          kind: "key",
        })
      ) {
        // A release still has to land, or the key stays down on the host
        // forever. Only new presses are suppressed.
        if (action === "down" || !pressedKeysRef.current.has(code)) return;
      }
      // Same one-edge-per-key bookkeeping the physical keyboard path uses, so
      // a thumb held on Sprint cannot stack duplicate downs, and a release
      // with nothing held is dropped rather than inventing an up edge.
      if (action === "down") {
        if (pressedKeysRef.current.has(code)) return;
        pressedKeysRef.current.set(code, key);
      } else if (!pressedKeysRef.current.delete(code)) {
        return;
      }
      enqueueInput({ type: "key", action, code, key, repeat: false });
    },
    [canKeyboard, enqueueInput],
  );

  const sendFpsMovementKey = useCallback(
    (code: FpsMovementCode, action: "down" | "up") => {
      sendFpsKey(code, code.slice(3).toLowerCase(), action);
    },
    [sendFpsKey],
  );

  const sendFpsLook = useCallback(
    (dx: number, dy: number) => {
      if (
        !shouldForwardRemoteSurfaceInput({
          capabilityGranted: canPointer,
          inputCaptured: inputCapturedRef.current,
          kind: "pointer-move",
        })
      ) {
        return;
      }
      const point = lastPointerPointRef.current ?? { x: 0.5, y: 0.5 };
      enqueueInput({ type: "pointer", action: "move", ...point, button: "left", dx, dy });
    },
    [canPointer, enqueueInput],
  );

  const sendFpsPointerButton = useCallback(
    (button: "left" | "right", action: "down" | "up") => {
      if (
        !shouldForwardRemoteSurfaceInput({
          capabilityGranted: canPointer,
          inputCaptured: inputCapturedRef.current,
          kind: action === "down" ? "pointer-down" : "pointer-up",
          hasActivePointerPress: true,
        })
      ) {
        return;
      }
      const point = lastPointerPointRef.current ?? { x: 0.5, y: 0.5 };
      enqueueInput({ type: "pointer", action, ...point, button, dx: 0, dy: 0 });
    },
    [canPointer, enqueueInput],
  );

  const sendKey = useCallback(
    (event: KeyboardEvent, action: "down" | "up") => {
      if (
        !event.code ||
        !shouldForwardRemoteSurfaceInput({
          capabilityGranted: canKeyboard,
          inputCaptured: inputCapturedRef.current,
          kind: "key",
        })
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const code = normalizeRemoteControlKeyCode(event.code, platform);
      const pressedKey = pressedKeysRef.current.get(code);
      // One down edge holds the remote key until its up edge. Forwarding every
      // browser auto-repeat adds no state and creates a latency queue.
      if (action === "down") {
        if (event.repeat || pressedKey !== undefined) return;
        pressedKeysRef.current.set(code, event.key);
      } else {
        if (pressedKey === undefined) return;
        pressedKeysRef.current.delete(code);
      }
      enqueueInput({
        type: "key",
        action,
        code,
        key: (pressedKey ?? event.key).slice(0, 64),
        repeat: false,
      });
    },
    [canKeyboard, enqueueInput, platform],
  );

  useEffect(() => {
    if (!inputCaptured || !canKeyboard) return;
    const handleKeyDown = (event: KeyboardEvent) => sendKey(event, "down");
    const handleKeyUp = (event: KeyboardEvent) => sendKey(event, "up");
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
    };
  }, [canKeyboard, inputCaptured, sendKey]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && void close()}>
      <DialogPopup
        // Full-bleed on phones — the remote desktop needs every pixel — and a
        // large centered panel on anything bigger.
        //
        // `max-sm:fixed max-sm:inset-0` is load-bearing, not decoration. The
        // dialog viewport is a `p-4` grid, and opting out of the mobile sheet
        // (`bottomStickOnMobile={false}`) is also what opts out of the
        // `max-sm:p-0` that would have removed it. A `100vw` popup inside 16px
        // of padding starts 16px in and runs 16px past the right edge, which
        // clipped the Close button off-screen. Going fixed positions against
        // the viewport instead, the same escape ProviderModelPicker uses.
        // Full screen has to be escaped at the dialog, not inside it. A phone
        // in landscape is wider than the `sm` breakpoint, so the popup became
        // the rounded inset panel below and clipped a `fixed inset-0` child to
        // its own rounded box — full screen rendered as a masked rectangle
        // floating in the middle of the screen (reported 2026-09-01).
        className={
          pseudoFullScreen
            ? "fixed inset-0 h-[100svh] max-h-none w-screen max-w-none rounded-none sm:h-[100svh] sm:max-h-none sm:w-screen sm:max-w-none sm:rounded-none"
            : "h-dvh max-h-none w-screen max-w-none rounded-none max-sm:fixed max-sm:inset-0 sm:h-[min(90dvh,900px)] sm:max-h-[90dvh] sm:w-[min(94vw,1500px)] sm:rounded-lg"
        }
        showCloseButton={false}
        bottomStickOnMobile={false}
      >
        <DialogHeader className="flex-row items-center justify-between gap-2 max-sm:p-3 sm:gap-4">
          <div className="min-w-0 space-y-1">
            <DialogTitle className="flex items-center gap-2">
              <MonitorIcon className="size-5 shrink-0" />
              <span className="truncate">{environmentLabel}</span>
            </DialogTitle>
            <DialogDescription className="sr-only sm:not-sr-only">
              {isWaiting
                ? "Waiting for approval on the remote computer…"
                : isApproved
                  ? canControl
                    ? "Interactive control over your trusted Solla Code connection"
                    : "Live view over your trusted Solla Code connection"
                  : "Remote viewing session"}
            </DialogDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isApproved && displays.length > 1 ? (
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="sr-only">Monitor</span>
                <select
                  className="h-8 max-w-28 rounded-md border border-input bg-background px-2 text-xs text-foreground sm:max-w-none"
                  value={activeDisplayId ?? ""}
                  aria-label="Monitor to view"
                  onChange={(event) => {
                    const displayId = event.target.value;
                    if (!displayId || displayId === activeDisplayId) return;
                    // Optimistic so the picker feels immediate; the next frame's
                    // displayId reconciles it against what the host really sent.
                    setActiveDisplayId(displayId);
                    enqueueInput({ type: "select-display", displayId });
                  }}
                >
                  {displays.map((display) => (
                    <option key={display.id} value={display.id}>
                      {display.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => void close()}>
              {isApproved ? (
                <>
                  Stop<span className="max-sm:hidden"> and close</span>
                </>
              ) : (
                "Close"
              )}
            </Button>
          </div>
        </DialogHeader>
        {/* Deliberately not `DialogPanel`: that wraps a ScrollArea sized to
            the full popup height, which is why this needed a hardcoded
            `calc(100% - 7rem)` header allowance in the first place. A plain
            flex child measures itself against whatever the header and footer
            actually take, at any width. */}
        <div
          data-slot="dialog-panel"
          className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-2 sm:p-3"
        >
          {error ? (
            <div className="max-w-lg space-y-3 rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-center">
              <p className="font-medium text-destructive">{error}</p>
              <p className="text-sm text-muted-foreground">
                The remote computer must be online with the latest Solla Code open. On macOS, the
                host may also need to enable System Settings → Privacy &amp; Security → Screen
                Recording.
              </p>
            </div>
          ) : isWaiting ? (
            <div className="max-w-md space-y-4 text-center">
              <Spinner className="mx-auto size-8" />
              <div>
                <p className="font-medium">Approve on {environmentLabel}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Solla Code will show a clear consent prompt on that computer. Nothing is shared
                  until someone approves it there.
                </p>
              </div>
            </div>
          ) : surface.showSurface ? (
            <div
              ref={surfaceElementRef}
              role="application"
              aria-label={`Remote desktop control for ${environmentLabel}`}
              data-remote-input-capture={inputCaptured ? "active" : "inactive"}
              data-remote-pointer-lock={pointerLocked ? "locked" : "unlocked"}
              data-remote-video-fallback={videoUnavailable ?? undefined}
              style={{
                cursor: remoteSurfaceCursorStyle({
                  shape: remoteCursorShape,
                  inputCaptured,
                  pointerGranted: canPointer,
                }),
              }}
              className={`relative flex touch-none select-none items-center justify-center overflow-hidden bg-black outline-hidden overscroll-none ${
                pseudoFullScreen
                  ? // The popup above is already filling the viewport, so this
                    // just fills the popup. It must NOT go fixed itself: a
                    // fixed child is still clipped by an ancestor that
                    // establishes a containing block, which is what put full
                    // screen inside a rounded mask.
                    "size-full rounded-none"
                  : "size-full rounded-lg"
              } ${
                inputCaptured
                  ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
                  : "focus-visible:ring-2 focus-visible:ring-ring"
              }`}
              tabIndex={canControl ? 0 : -1}
              onFocus={() => {
                if (canControl) captureInput();
              }}
              onBlur={(event) => {
                // Focus moving to a child (the virtual-keyboard input) is not
                // leaving the surface; releasing capture would close the
                // keyboard the moment it opens.
                if (event.currentTarget.contains(event.relatedTarget)) return;
                releaseInputCapture();
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onDragStart={(event) => event.preventDefault()}
              onDrop={(event) => event.preventDefault()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onAuxClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerDown={(event) => {
                if (!canControl) return;
                captureInput();
                event.currentTarget.focus({ preventScroll: true });
                if (!canPointer) return;
                // Inside a genuine gesture — the one place pointer lock is
                // always grantable. This is what actually engages the local
                // lock when the host reported "locked" while no click was
                // recent enough for the effect-driven request to succeed.
                if (remoteLockedRef.current && !pointerLockedRef.current) {
                  engagePointerLock();
                }
                event.currentTarget.setPointerCapture(event.pointerId);
                const surfaceRect = event.currentTarget.getBoundingClientRect();
                if (surfaceRect.width > 0 && surfaceRect.height > 0) {
                  lastPointerFractionRef.current = {
                    x: (event.clientX - surfaceRect.left) / surfaceRect.width,
                    y: (event.clientY - surfaceRect.top) / surfaceRect.height,
                  };
                }
                const button = remotePointerButton(event.button);
                pressedPointerButtonRef.current = button;
                sendPointer(event, "down", button);
              }}
              onPointerMove={(event) =>
                sendPointer(event, "move", pressedPointerButtonRef.current ?? "left")
              }
              onPointerUp={(event) => {
                sendPointer(
                  event,
                  "up",
                  pressedPointerButtonRef.current ?? remotePointerButton(event.button),
                );
                pressedPointerButtonRef.current = null;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
              }}
              onPointerCancel={(event) => {
                sendPointer(event, "up", pressedPointerButtonRef.current ?? "left");
                pressedPointerButtonRef.current = null;
              }}
              onWheel={sendWheel}
            >
              {surface.media === "video" ? (
                <video
                  ref={frameVideoRef}
                  aria-label={`Live desktop view from ${environmentLabel}`}
                  autoPlay
                  muted
                  playsInline
                  // `loadeddata` is the first moment a frame is actually
                  // decoded, which is also what the 5s watchdog is waiting to
                  // hear about — marking it here spares the fallback.
                  onLoadedData={() => {
                    decodedRef.current = true;
                    setHasRenderedFrame(true);
                  }}
                  onPlaying={() => setHasRenderedFrame(true)}
                  // Transform rather than layout: pointer math reads the
                  // element's bounding rect, which already reflects it, so
                  // clicks keep landing where the user aimed while zoomed.
                  style={
                    zoom === 1
                      ? undefined
                      : {
                          transform: `scale(${zoom})`,
                          transformOrigin: `${zoomOrigin.x}% ${zoomOrigin.y}%`,
                        }
                  }
                  className="pointer-events-none size-full touch-none select-none object-contain"
                />
              ) : surface.media === "image" ? (
                <img
                  ref={frameImageRef}
                  src={frameData ?? undefined}
                  alt={`Live desktop view from ${environmentLabel}`}
                  draggable={false}
                  // Receiving bytes is not the same as painting them. Keep the
                  // loading overlay up until the browser has decoded the first
                  // JPEG, otherwise a slow image decode still exposes black.
                  onLoad={() => setHasRenderedFrame(true)}
                  // Transform rather than layout: pointer math reads the
                  // element's bounding rect, which already reflects it, so
                  // clicks keep landing where the user aimed while zoomed.
                  style={
                    zoom === 1
                      ? undefined
                      : {
                          transform: `scale(${zoom})`,
                          transformOrigin: `${zoomOrigin.x}% ${zoomOrigin.y}%`,
                        }
                  }
                  className="pointer-events-none size-full touch-none select-none object-contain"
                />
              ) : null}
              {surface.showLoadingOverlay ? (
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 text-center">
                  <Spinner className="size-8 text-white" />
                  <p className="text-sm text-white/80">Starting the live desktop stream…</p>
                  {firstFrameSlow ? (
                    <p className="max-w-sm text-xs text-white/60">
                      This is taking longer than usual. If {environmentLabel} is a Mac, it may need
                      System Settings → Privacy &amp; Security → Screen Recording enabled for Solla
                      Code.
                    </p>
                  ) : null}
                </div>
              ) : null}
              {touchClient && canKeyboard ? (
                <input
                  ref={virtualKeyboardInputRef}
                  // Always mounted, never visible: it exists to summon the
                  // on-screen keyboard and receive its text. It must already
                  // be in the DOM when the Keyboard button is tapped — mobile
                  // browsers only raise the keyboard for a focus() issued
                  // synchronously inside the tap gesture, so mounting it on
                  // demand (focus deferred a frame) read as a dead click.
                  // Characters are forwarded as native text injection
                  // (layout-independent); Enter and Backspace arrive as key
                  // edits of the field and are mapped back to key taps. Keys
                  // that carry a real `code` are handled by the window-level
                  // capture listener before they reach here.
                  // 16px is not cosmetic on a 1px invisible input: iOS Safari
                  // zooms the whole page whenever it focuses a field whose
                  // computed font-size is under 16px, so raising the keyboard
                  // magnified the UI and left the user pinching back out every
                  // single time.
                  className="absolute bottom-0 left-0 size-px text-[16px] opacity-0"
                  aria-label="Remote keyboard input"
                  tabIndex={-1}
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  onFocus={() => setVirtualKeyboardOpen(true)}
                  onBlur={() => setVirtualKeyboardOpen(false)}
                  onBeforeInput={(event) => {
                    const native = event.nativeEvent as InputEvent;
                    if (
                      native.inputType === "insertText" ||
                      native.inputType === "insertFromPaste" ||
                      native.inputType === "insertCompositionText"
                    ) {
                      event.preventDefault();
                      const text = native.data;
                      if (text) enqueueInput({ type: "text", text: text.slice(0, 256) });
                      return;
                    }
                    if (native.inputType === "insertLineBreak") {
                      event.preventDefault();
                      enqueueInput({
                        type: "key",
                        action: "down",
                        code: "Enter",
                        key: "Enter",
                        repeat: false,
                      });
                      enqueueInput({
                        type: "key",
                        action: "up",
                        code: "Enter",
                        key: "Enter",
                        repeat: false,
                      });
                      return;
                    }
                    if (native.inputType === "deleteContentBackward") {
                      event.preventDefault();
                      enqueueInput({
                        type: "key",
                        action: "down",
                        code: "Backspace",
                        key: "Backspace",
                        repeat: false,
                      });
                      enqueueInput({
                        type: "key",
                        action: "up",
                        code: "Backspace",
                        key: "Backspace",
                        repeat: false,
                      });
                    }
                  }}
                />
              ) : null}
              {/* One row, not two absolutely-positioned corners: the pill and
                  the buttons used to be independent and could run into each
                  other, and the clearance needed differed per breakpoint
                  because the buttons reveal their labels at `sm`. Here the
                  pill simply truncates against whatever the buttons take. */}
              <div
                className="absolute inset-x-3 z-40 flex items-center justify-between gap-2"
                // Clear of the home indicator and any browser chrome when the
                // surface is filling the viewport; a plain bottom-3 sat under
                // both.
                style={{
                  bottom: pseudoFullScreen
                    ? "calc(0.75rem + env(safe-area-inset-bottom, 0px))"
                    : "0.75rem",
                }}
              >
                <div className="flex min-w-0 items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs text-white">
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${
                      inputCaptured ? "bg-primary" : "bg-emerald-400"
                    }`}
                  />
                  <span className="truncate">
                    {canControl
                      ? fpsActive
                        ? "FPS controller · left thumb moves, right thumb looks"
                        : fpsArmed
                          ? // Armed but idle. Without this the FPS button lights up
                            // and nothing else happens, which reads as a dead
                            // control rather than as waiting for the remote app.
                            "FPS ready · starts when the remote game captures the mouse"
                          : pointerLocked
                            ? "Live · mouse captured — Esc releases"
                            : remoteLocked && canPointer && inputCaptured
                              ? "Live · click to capture your mouse"
                              : inputCaptured
                                ? "Live · input focused"
                                : "Live · click to focus"
                      : "Live · view only"}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {touchClient && canControl && canPointer && canKeyboard ? (
                    <button
                      type="button"
                      aria-label={fpsArmed ? "Disable FPS controller" : "Enable FPS controller"}
                      aria-pressed={fpsArmed}
                      className={`flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-white ${
                        fpsArmed
                          ? "bg-primary/85 hover:bg-primary"
                          : "bg-black/70 hover:bg-black/85"
                      }`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setFpsArmed((armed) => !armed);
                        captureInput();
                      }}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <Gamepad2Icon className="size-3.5" />
                      <span className="sr-only sm:not-sr-only">FPS</span>
                    </button>
                  ) : null}
                  {touchClient && canKeyboard ? (
                    <button
                      type="button"
                      aria-label={virtualKeyboardOpen ? "Hide keyboard" : "Show keyboard"}
                      aria-pressed={virtualKeyboardOpen}
                      className="flex cursor-pointer items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs text-white hover:bg-black/85"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (virtualKeyboardOpen) {
                          virtualKeyboardInputRef.current?.blur();
                          return;
                        }
                        captureInput();
                        // Synchronously, inside the tap gesture — mobile
                        // browsers refuse to raise the keyboard for a deferred
                        // focus. Open/closed state follows the input's own
                        // focus events.
                        virtualKeyboardInputRef.current?.focus();
                      }}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <KeyboardIcon className="size-3.5" />
                      <span className="sr-only sm:not-sr-only">Keyboard</span>
                    </button>
                  ) : null}
                  {canControl ? (
                    <button
                      type="button"
                      aria-label="Show windows"
                      title="Show windows"
                      className="flex cursor-pointer items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs text-white hover:bg-black/85"
                      onClick={(event) => {
                        event.stopPropagation();
                        // The host picks the gesture for its own OS.
                        enqueueInput({ type: "show-window-switcher" });
                      }}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <SquareStackIcon className="size-3.5" />
                      <span className="sr-only sm:not-sr-only">Windows</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    aria-label="Zoom out"
                    title="Zoom out"
                    disabled={zoom === 1}
                    className="flex cursor-pointer items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs text-white hover:bg-black/85 disabled:cursor-default disabled:opacity-40"
                    onClick={(event) => {
                      event.stopPropagation();
                      zoomOut();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <ZoomOutIcon className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="Zoom in"
                    title="Zoom in"
                    disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]!}
                    className="flex cursor-pointer items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs text-white hover:bg-black/85 disabled:cursor-default disabled:opacity-40"
                    onClick={(event) => {
                      event.stopPropagation();
                      zoomIn();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <ZoomInIcon className="size-3.5" />
                    {zoom === 1 ? null : <span className="tabular-nums">{zoom}×</span>}
                  </button>
                  <button
                    type="button"
                    aria-label={
                      isFullScreen || pseudoFullScreen ? "Exit full screen" : "Enter full screen"
                    }
                    // Bottom right, opposite the status pill: the top edge belongs
                    // to the host/input notices, which span the full width.
                    className="flex cursor-pointer items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs text-white hover:bg-black/85"
                    onClick={(event) => {
                      // The surface below forwards clicks to the remote desktop;
                      // pressing this must not also click over there.
                      event.stopPropagation();
                      toggleFullScreen();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    {isFullScreen || pseudoFullScreen ? (
                      <MinimizeIcon className="size-3.5" />
                    ) : (
                      <MaximizeIcon className="size-3.5" />
                    )}
                    <span className="sr-only sm:not-sr-only">
                      {isFullScreen || pseudoFullScreen ? "Exit full screen" : "Full screen"}
                    </span>
                  </button>
                </div>
              </div>
              {fpsActive ? (
                <RemoteControlFpsOverlay
                  onMovementKey={sendFpsMovementKey}
                  onActionKey={sendFpsKey}
                  onLook={sendFpsLook}
                  onPointerButton={sendFpsPointerButton}
                  onExit={() => setFpsArmed(false)}
                />
              ) : null}
              {/* Above the FPS pad: a host notice means input is going nowhere
                  (a UAC prompt, a stalled encoder), which is exactly when a
                  player needs to be told rather than left mashing keys. */}
              {hostNotice ? (
                <div className="absolute inset-x-3 top-3 z-30 flex items-start gap-3 rounded-lg border border-amber-500/35 bg-background/95 px-3 py-2 text-sm text-amber-600 shadow-lg dark:text-amber-400">
                  <Spinner className="mt-0.5 size-4 shrink-0" />
                  <span className="min-w-0 flex-1 break-words">{hostNotice}</span>
                </div>
              ) : inputError ? (
                <div className="absolute inset-x-3 top-3 z-30 rounded-lg border border-destructive/35 bg-background/95 px-3 py-2 text-sm text-destructive shadow-lg">
                  {inputError}
                </div>
              ) : null}
            </div>
          ) : isTerminal ? (
            <div className="space-y-3 text-center">
              <ShieldCheckIcon className="mx-auto size-8 text-muted-foreground" />
              <p className="font-medium">Screen sharing ended</p>
            </div>
          ) : null}
        </div>
        <DialogFooter className="py-2 text-xs text-muted-foreground max-sm:hidden" variant="bare">
          {canControl
            ? inputCaptured
              ? "Input is focused on the remote computer. Click outside the screen or close the window to release it. Command and Control map automatically."
              : "Click the remote screen to focus mouse and keyboard control."
            : "The host granted view-only access for this session."}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
