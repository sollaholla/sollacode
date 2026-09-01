"use client";

import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  RemoteControlDisplay,
  RemoteControlHost,
  RemoteControlHostStatus,
  RemoteControlHostStatusReason,
  RemoteControlHostStreamEvent,
  RemoteControlInput,
  RemoteControlSession,
} from "@t3tools/contracts";
import { REMOTE_CONTROL_CHUNK_MAX_BASE64_LENGTH } from "@t3tools/contracts";
import { MonitorUpIcon, ShieldCheckIcon } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { remoteControlEnvironment } from "~/state/remoteControl";
import {
  encodeBlobToBase64,
  openDisplayStream,
  REMOTE_CONTROL_TIMESLICE_MS,
  REMOTE_CONTROL_VIDEO_BITS_PER_SECOND,
  selectRemoteControlMimeType,
  stopStream,
  supportsRemoteControlVideo,
} from "./remoteControlEncoder";
import {
  classifyCaptureFailure,
  classifyInputFailure,
  isSameHostStatus,
  recoveryDelayMs,
  REMOTE_CONTROL_RECOVERY_GIVE_UP_MS,
} from "./remoteControlHostStatus";
import { createRemoteControlInputScheduler } from "./remoteControlInputScheduler";
import { createRemoteControlVideoPublishQueue } from "./remoteControlVideoPublishQueue";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  isRemoteControlDeviceRemembered,
  rememberRemoteControlDevice,
} from "~/remoteControlTrustedDevices";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";

function hostPlatform(): RemoteControlHost["platform"] {
  const platform = navigator.userAgent.toLowerCase();
  if (platform.includes("mac")) return "macos";
  if (platform.includes("win")) return "windows";
  if (platform.includes("linux")) return "linux";
  return "unknown";
}

function commandError(result: Parameters<typeof squashAtomCommandFailure>[0]): Error {
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error ? cause : new Error(String(cause));
}

interface PendingApproval {
  readonly connectionId: string;
  readonly requestId: string;
  readonly session: RemoteControlSession;
}

interface ActiveShare {
  readonly connectionId: string;
  readonly session: RemoteControlSession;
}

export function RemoteControlCoordinator() {
  const environment = usePrimaryEnvironment();
  const bridge = window.desktopBridge;

  if (!bridge || !environment || environment.connection.phase !== "connected") return null;

  return (
    <RemoteControlHostCoordinator
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  );
}

function RemoteControlHostCoordinator(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const bridge = window.desktopBridge!;
  /**
   * Latest cursor-capture state, refreshed on a timer rather than per frame.
   *
   * Every publish call stamps this so the controller learns about a game
   * grabbing the pointer without a channel of its own. Polling at 10Hz keeps
   * the helper round-trip off the frame path entirely — at 60fps a synchronous
   * query per frame would gate encoding on IPC latency, and lock transitions
   * are a human-scale event that does not need frame-accurate timing.
   */
  const pointerLockedRef = useRef(false);
  /** Latest host cursor shape from the same 10Hz poll; stamped per publish. */
  const cursorShapeRef = useRef<string | undefined>(undefined);
  const generatedId = useId();
  const clientId = `desktop-${generatedId}`;
  const host = useMemo<RemoteControlHost>(
    () => ({
      clientId,
      environmentId,
      platform: hostPlatform(),
      capabilities: ["screen", "pointer", "keyboard"],
    }),
    [clientId, environmentId],
  );
  const hostEvents = useEnvironmentQuery(
    remoteControlEnvironment.hostEvents({
      environmentId,
      input: host,
    }),
  );
  const respond = useAtomCommand(remoteControlEnvironment.respondToRequest, {
    label: "remote control approval",
    reportFailure: false,
  });
  const publishVideoChunk = useAtomCommand(remoteControlEnvironment.publishVideoChunk, {
    label: "remote control video chunk",
    reportFailure: false,
  });
  const publishFrame = useAtomCommand(remoteControlEnvironment.publishFrame, {
    label: "remote control screen frame",
    reportFailure: false,
  });
  const endByHost = useAtomCommand(remoteControlEnvironment.endByHost, {
    label: "stop remote control",
    reportFailure: false,
  });
  const reportHostStatus = useAtomCommand(remoteControlEnvironment.reportHostStatus, {
    label: "remote control host status",
    reportFailure: false,
  });
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [active, setActive] = useState<ActiveShare | null>(null);
  const [isResponding, setIsResponding] = useState(false);
  const [rememberDevice, setRememberDevice] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [imageFallback, setImageFallback] = useState(false);
  const autoApprovalRequestIdRef = useRef<string | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const selectedDisplayIdRef = useRef<string | undefined>(undefined);
  const activeDisplayIdRef = useRef<string | undefined>(undefined);
  const displaysRef = useRef<ReadonlyArray<RemoteControlDisplay>>([]);
  // Set by the encoder effect so an incoming selection can restart capture
  // without this component re-rendering the whole session.
  const displaySelectionListenerRef = useRef<(() => void) | null>(null);
  // Same pattern for broker-requested encoder restarts: a controller that
  // subscribes mid-stream cannot decode a WebM container from the middle, so
  // the broker asks for a fresh init segment when a watcher attaches.
  const videoRestartListenerRef = useRef<(() => void) | null>(null);
  // Last status actually sent, so a condition that repeats on every dropped
  // event — which is what a UAC prompt does — is reported once.
  const lastHostStatusRef = useRef<RemoteControlHostStatus | null>(null);
  /**
   * The two conditions are tracked separately and reduced to one status,
   * rather than each path reporting its own.
   *
   * A UAC prompt causes both at the same time — input is refused and the
   * capture surface is lost — so last-writer-wins would have the notice
   * flapping between two descriptions of the same prompt. The input block is
   * the more specific and more actionable of the two, so it wins.
   */
  const inputBlockRef = useRef<RemoteControlHostStatusReason | null>(null);
  const captureInterruptedRef = useRef(false);
  /**
   * Input failing is not capture failing. Reporting them as one condition told
   * the viewer "the remote screen stopped being capturable" while frames were
   * arriving perfectly, which sent everyone looking at screen-recording
   * permission for what was a broken input helper.
   */
  const inputInterruptedRef = useRef(false);

  /**
   * Tells the controller that the host is temporarily unable to comply, or
   * that it can again. Never fails the session: this is the channel that keeps
   * a stream alive through a condition it used to die on.
   */
  const syncHostStatus = useCallback(() => {
    const current = activeRef.current;
    if (!current) return;
    const reason =
      inputBlockRef.current ??
      (captureInterruptedRef.current
        ? "capture-interrupted"
        : inputInterruptedRef.current
          ? "input-interrupted"
          : null);
    const status: RemoteControlHostStatus = reason
      ? { state: "interrupted", reason }
      : { state: "ok" };
    if (isSameHostStatus(lastHostStatusRef.current, status)) return;
    lastHostStatusRef.current = status;
    void reportHostStatus({
      environmentId,
      input: {
        clientId,
        connectionId: current.connectionId,
        sessionId: current.session.sessionId,
        status,
      },
    });
  }, [clientId, environmentId, reportHostStatus]);

  const dispatchHostInput = useCallback(
    async (input: RemoteControlInput) => {
      const current = activeRef.current;
      if (!current) return;
      try {
        const result = await bridge.sendRemoteControlInput({
          input,
          ...(activeDisplayIdRef.current !== undefined
            ? { displayId: activeDisplayIdRef.current }
            : {}),
        });
        // The host refusing input is a condition, not a failure: a UAC prompt,
        // the lock screen, or an elevated window owns the desktop temporarily.
        inputBlockRef.current = result.blocked ?? null;
        inputInterruptedRef.current = false;
        syncHostStatus();
      } catch (cause: unknown) {
        const failure = classifyInputFailure(cause);
        if (failure.kind === "transient") {
          inputInterruptedRef.current = true;
          syncHostStatus();
        } else {
          setCaptureError(failure.message);
          setActive((value) =>
            value?.session.sessionId === current.session.sessionId ? null : value,
          );
          void bridge.resetRemoteControlInput();
          void endByHost({
            environmentId,
            input: {
              clientId,
              connectionId: current.connectionId,
              sessionId: current.session.sessionId,
              failureReason: failure.message,
            },
          });
        }
        // Rejecting tells the scheduler to discard any motion that became
        // stale while the native helper was unavailable.
        throw cause;
      }
    },
    [bridge, clientId, endByHost, environmentId, syncHostStatus],
  );

  const hostInputScheduler = useMemo(
    () => createRemoteControlInputScheduler({ send: dispatchHostInput }),
    [dispatchHostInput],
  );

  useEffect(() => {
    // Session transitions invalidate pending motion from the previous desktop.
    hostInputScheduler.clear();
    if (!active) {
      pointerLockedRef.current = false;
      // A new session must not inherit the previous one's reported condition,
      // or its first genuine outage would be de-duplicated away.
      lastHostStatusRef.current = null;
      inputBlockRef.current = null;
      captureInterruptedRef.current = false;
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await bridge.readRemoteControlPointerLock();
        if (cancelled) return;
        pointerLockedRef.current = result.locked;
        cursorShapeRef.current = result.cursor;
        // This poll is the only thing still reaching the host while its input
        // is blocked, so it owns the recovery edge: nobody typing during a UAC
        // prompt would otherwise leave the viewer stuck on the warning.
        inputBlockRef.current = result.blocked ?? null;
        inputInterruptedRef.current = false;
        syncHostStatus();
      } catch {
        // An unavailable signal must not disturb the stream; absent lock state
        // just leaves the controller in absolute-pointer mode.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 100);
    return () => {
      cancelled = true;
      clearInterval(timer);
      pointerLockedRef.current = false;
    };
  }, [active, bridge, hostInputScheduler, syncHostStatus]);

  useEffect(() => () => hostInputScheduler.clear(), [hostInputScheduler]);

  useEffect(() => {
    const event: RemoteControlHostStreamEvent | null = hostEvents.data;
    if (!event) return;
    if (event.type === "input") {
      const current = activeRef.current;
      if (!current || current.session.sessionId !== event.sessionId) return;
      // Display selection retargets our own capture loop; it is never handed to
      // the OS input controller, which has no notion of it.
      if (event.input.type === "select-display") {
        selectedDisplayIdRef.current = event.input.displayId;
        displaySelectionListenerRef.current?.();
        return;
      }
      // The controller cannot decode our video; drop to JPEG for this session.
      if (event.input.type === "request-image-fallback") {
        setImageFallback(true);
        return;
      }
      hostInputScheduler.enqueue(event.input);
      return;
    }
    if (event.type === "video-restart-requested") {
      const current = activeRef.current;
      if (!current || current.session.sessionId !== event.sessionId) return;
      videoRestartListenerRef.current?.();
      return;
    }
    if (event.type === "access-requested") {
      const request = {
        connectionId: event.connectionId,
        requestId: event.requestId,
        session: event.session,
      };
      if (
        isRemoteControlDeviceRemembered(
          environmentId,
          event.session.requester.deviceId,
          event.session.requestedCapabilities,
        )
      ) {
        if (autoApprovalRequestIdRef.current === event.requestId) return;
        autoApprovalRequestIdRef.current = event.requestId;
        setPending(null);
        setIsResponding(true);
        void (async () => {
          try {
            const outcome = await respond({
              environmentId,
              input: {
                clientId,
                connectionId: event.connectionId,
                requestId: event.requestId,
                decision: "approve",
                grantedCapabilities: event.session.requestedCapabilities,
              },
            });
            if (outcome._tag === "Failure") throw commandError(outcome);
            await bridge.activateRemoteControlHost().catch(() => undefined);
            setCaptureError(null);
            setActive({
              connectionId: event.connectionId,
              session: outcome.value,
            });
          } catch {
            // Trust only removes the consent prompt. Any stale connection or
            // capability mismatch falls back to the normal explicit prompt.
            setRememberDevice(false);
            setPending(request);
          } finally {
            setIsResponding(false);
          }
        })();
        return;
      }
      setRememberDevice(false);
      setPending(request);
      return;
    }
    if (event.type === "session-ended") {
      setPending((current) =>
        current?.session.sessionId === event.session.sessionId ? null : current,
      );
      setActive((current) =>
        current?.session.sessionId === event.session.sessionId ? null : current,
      );
    }
  }, [clientId, environmentId, hostEvents.data, hostInputScheduler, respond]);

  // Video path: a live MediaStream encoded by the platform codec. Falls back to
  // the JPEG loop below when this runtime cannot encode video, or when the
  // encoder fails to start.
  useEffect(() => {
    if (!active || imageFallback || !supportsRemoteControlVideo()) return;
    let cancelled = false;
    let sequence = 0;
    let stream: MediaStream | null = null;
    let recorder: MediaRecorder | null = null;
    let restartTimer: number | null = null;
    let recoveryTimer: number | null = null;
    let recoveryAttempt = 0;
    // When the current outage began, so a host that never comes back is still
    // eventually given up on.
    let outageStartedAt: number | null = null;
    // Identifies the capture attempt an event belongs to. A recorder we tore
    // down ourselves fires its own stop/error afterwards, and without this its
    // late events would restart capture a second time.
    let generation = 0;
    type PublishItem = {
      readonly blob: Blob;
      readonly capturedAt: string;
      readonly displayId: string | undefined;
      readonly isInit: boolean;
    };
    let publishQueue: ReturnType<typeof createRemoteControlVideoPublishQueue<PublishItem>> | null =
      null;
    const mimeType = selectRemoteControlMimeType();
    if (!mimeType) return;

    const endSession = (message: string) => {
      if (cancelled) return;
      cancelled = true;
      publishQueue?.close();
      setCaptureError(message);
      setActive((current) =>
        current?.session.sessionId === active.session.sessionId ? null : current,
      );
      void endByHost({
        environmentId,
        input: {
          clientId,
          connectionId: active.connectionId,
          sessionId: active.session.sessionId,
          failureReason: message,
        },
      });
    };

    const stopCapture = () => {
      generation += 1;
      publishQueue?.close();
      publishQueue = null;
      try {
        recorder?.stop();
      } catch {
        // A recorder already stopped by an error path throws; nothing to undo.
      }
      recorder = null;
      stopStream(stream);
      stream = null;
    };

    /**
     * The recovery path.
     *
     * Windows moves the desktop out from under a capture whenever it shows a
     * UAC prompt, which invalidates the duplication surface and ends the
     * capture track. That used to arrive here as a fatal encoder error and end
     * the session; it is really a pause, so capture is rebuilt on a backoff and
     * the session is only abandoned if the host stays gone for minutes.
     */
    const handleCaptureIssue = (cause: unknown) => {
      if (cancelled) return;
      const failure = classifyCaptureFailure(cause);
      if (failure.kind === "fatal") {
        endSession(failure.message);
        return;
      }
      const now = performance.now();
      outageStartedAt ??= now;
      if (now - outageStartedAt > REMOTE_CONTROL_RECOVERY_GIVE_UP_MS) {
        endSession(failure.message);
        return;
      }
      captureInterruptedRef.current = true;
      syncHostStatus();
      stopCapture();
      if (recoveryTimer !== null) return;
      recoveryTimer = window.setTimeout(() => {
        recoveryTimer = null;
        if (cancelled) return;
        void startRecorder().catch(handleCaptureIssue);
      }, recoveryDelayMs(recoveryAttempt++));
    };

    const startRecorder = async () => {
      const attempt = generation;
      const catalog = await bridge.listRemoteControlCaptureSources();
      if (cancelled || attempt !== generation) return;
      displaysRef.current = catalog.displays;
      const requested = selectedDisplayIdRef.current;
      const match =
        catalog.sources.find((candidate) => candidate.displayId === requested) ??
        catalog.sources.find(
          (candidate) =>
            candidate.displayId === catalog.displays.find((display) => display.isPrimary)?.id,
        ) ??
        catalog.sources[0];
      if (!match) throw new Error("No capturable display was found on this computer.");
      activeDisplayIdRef.current = match.displayId;

      stream = await openDisplayStream(match.sourceId);
      if (cancelled || attempt !== generation) {
        stopStream(stream);
        stream = null;
        return;
      }
      // A capture whose surface is invalidated ends its track rather than
      // raising anything, so without this the stream simply goes quiet and the
      // viewer sits on a frozen frame with no explanation.
      for (const track of stream.getVideoTracks()) {
        track.addEventListener("ended", () => {
          if (attempt !== generation) return;
          handleCaptureIssue(new Error("The remote screen capture stopped."));
        });
      }

      // Each attempt gets its own queue: a queue that has reported an error is
      // permanently closed, so reusing it across a recovery would silently
      // drop every chunk that followed.
      const currentQueue = createRemoteControlVideoPublishQueue<PublishItem>({
        // A binary payload this large encodes to the contract's 4 MB base64
        // ceiling. Keeping this as the total retained budget also guarantees one
        // malformed MediaRecorder event cannot allocate an oversized base64 copy.
        maxPendingBytes: Math.floor(REMOTE_CONTROL_CHUNK_MAX_BASE64_LENGTH / 4) * 3,
        pauseAtBytes: 512 * 1_024,
        resumeAtBytes: 128 * 1_024,
        sizeOf: (item) => item.blob.size,
        publish: async ({ blob, capturedAt, displayId, isInit }) => {
          const data = await encodeBlobToBase64(blob);
          if (cancelled || attempt !== generation) return;
          const outcome = await publishVideoChunk({
            environmentId,
            input: {
              clientId,
              connectionId: active.connectionId,
              pointerLocked: pointerLockedRef.current,
              ...(cursorShapeRef.current !== undefined
                ? { cursorShape: cursorShapeRef.current }
                : {}),
              chunk: {
                sessionId: active.session.sessionId,
                sequence: sequence++,
                capturedAt,
                mimeType,
                isInit,
                data,
                ...(displayId !== undefined ? { displayId } : {}),
                ...(displaysRef.current.length > 0 ? { displays: displaysRef.current } : {}),
              },
            },
          });
          if (outcome._tag === "Failure") throw commandError(outcome);
        },
        onError: (cause) => {
          if (attempt !== generation) return;
          handleCaptureIssue(cause);
        },
      });
      publishQueue = currentQueue;

      const currentRecorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: REMOTE_CONTROL_VIDEO_BITS_PER_SECOND,
      });
      recorder = currentRecorder;
      // MediaRecorder emits the container header in its first blob, so that one
      // is the init segment the broker retains for late-joining controllers.
      let isFirstBlob = true;
      currentRecorder.addEventListener("dataavailable", (event) => {
        if (cancelled || attempt !== generation || event.data.size === 0) return;
        // Real encoded output is the only proof capture recovered — `start()`
        // returning is not, since a dead surface still starts cleanly.
        if (outageStartedAt !== null) {
          outageStartedAt = null;
          recoveryAttempt = 0;
          captureInterruptedRef.current = false;
          syncHostStatus();
        }
        const isInit = isFirstBlob;
        isFirstBlob = false;
        currentQueue.enqueue(
          {
            blob: event.data,
            capturedAt: new Date().toISOString(),
            displayId: activeDisplayIdRef.current,
            isInit,
          },
          currentRecorder,
        );
      });
      currentRecorder.addEventListener("error", () => {
        if (attempt !== generation) return;
        handleCaptureIssue(new Error("The screen encoder stopped unexpectedly."));
      });
      // A recorder that stops on its own — rather than because we replaced it —
      // has lost its source and needs the same rebuild.
      currentRecorder.addEventListener("stop", () => {
        if (attempt !== generation) return;
        handleCaptureIssue(new Error("The screen encoder stopped unexpectedly."));
      });
      currentRecorder.start(REMOTE_CONTROL_TIMESLICE_MS);
    };

    // Switching monitors means a new stream, which means a new container: stop
    // the old recorder and start a fresh one whose first blob re-inits decoding.
    const applyDisplaySelection = () => {
      if (cancelled || selectedDisplayIdRef.current === activeDisplayIdRef.current) return;
      if (restartTimer !== null) return;
      restartTimer = window.setTimeout(() => {
        restartTimer = null;
        if (cancelled) return;
        stopCapture();
        void startRecorder().catch(handleCaptureIssue);
      }, 0);
    };

    // Debounced so several controllers attaching at once cost one restart.
    // Reuses the display-switch restart timer: both are "cut a new container".
    const applyVideoRestart = () => {
      if (cancelled || restartTimer !== null) return;
      restartTimer = window.setTimeout(() => {
        restartTimer = null;
        if (cancelled) return;
        stopCapture();
        void startRecorder().catch(handleCaptureIssue);
      }, 150);
    };

    displaySelectionListenerRef.current = applyDisplaySelection;
    videoRestartListenerRef.current = applyVideoRestart;
    void startRecorder().catch(handleCaptureIssue);

    return () => {
      cancelled = true;
      generation += 1;
      publishQueue?.close();
      displaySelectionListenerRef.current = null;
      videoRestartListenerRef.current = null;
      if (restartTimer !== null) window.clearTimeout(restartTimer);
      if (recoveryTimer !== null) window.clearTimeout(recoveryTimer);
      try {
        recorder?.stop();
      } catch {
        // A recorder already stopped by an error path throws; nothing to undo.
      }
      stopStream(stream);
    };
  }, [
    active,
    bridge,
    clientId,
    endByHost,
    environmentId,
    imageFallback,
    publishVideoChunk,
    syncHostStatus,
  ]);

  useEffect(() => {
    // Only the fallback path runs the JPEG loop; the video encoder owns capture
    // whenever this runtime supports it.
    if (!active || (supportsRemoteControlVideo() && !imageFallback)) return;
    let cancelled = false;
    let sequence = 0;

    // The previous loop captured, awaited the publish round trip, then slept a
    // fixed 180ms — so the frame period was capture + network + 180ms, capping
    // the stream near 3-4fps regardless of how fast the machine or link was.
    // Now publishing overlaps the next capture and the pace is set by measured
    // work, so the stream runs as fast as the slower of the two stages allows.
    const TARGET_FRAME_INTERVAL_MS = 1_000 / 30;
    // One outstanding publish keeps capture busy while the previous frame is in
    // flight without letting a slow link build an unbounded backlog of stale
    // frames — on a congested link, dropping to the newest frame beats queueing.
    let inFlight: Promise<void> | null = null;
    let recoveryAttempt = 0;
    let outageStartedAt: number | null = null;

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => window.setTimeout(resolve, Math.max(0, ms)));

    const endSession = (message: string) => {
      setCaptureError(message);
      setActive((current) =>
        current?.session.sessionId === active.session.sessionId ? null : current,
      );
      void endByHost({
        environmentId,
        input: {
          clientId,
          connectionId: active.connectionId,
          sessionId: active.session.sessionId,
          failureReason: message,
        },
      });
    };

    const run = async () => {
      while (true) {
        if (cancelled || activeRef.current?.session.sessionId !== active.session.sessionId) {
          return;
        }
        const startedAt = performance.now();
        try {
          const captured = await bridge.captureRemoteControlFrame({
            maxWidth: 1_600,
            jpegQuality: 65,
            ...(selectedDisplayIdRef.current !== undefined
              ? { displayId: selectedDisplayIdRef.current }
              : {}),
          });
          if (cancelled) return;
          // Input mapping keys off this, so the fallback path has to keep it
          // current too — otherwise pointer coordinates are never remapped.
          activeDisplayIdRef.current = captured.displayId;
          displaysRef.current = captured.displays;

          // Settle the previous publish before starting another so at most one
          // frame is ever in flight.
          if (inFlight) {
            await inFlight;
            if (cancelled) return;
          }
          const frameSequence = sequence;
          sequence += 1;
          inFlight = publishFrame({
            environmentId,
            input: {
              clientId,
              connectionId: active.connectionId,
              pointerLocked: pointerLockedRef.current,
              ...(cursorShapeRef.current !== undefined
                ? { cursorShape: cursorShapeRef.current }
                : {}),
              frame: {
                sessionId: active.session.sessionId,
                sequence: frameSequence,
                ...captured,
              },
            },
          }).then((outcome) => {
            if (outcome._tag === "Failure") throw commandError(outcome);
          });

          if (outageStartedAt !== null) {
            outageStartedAt = null;
            recoveryAttempt = 0;
            captureInterruptedRef.current = false;
            syncHostStatus();
          }
        } catch (cause) {
          if (cancelled) return;
          // A frame that cannot be captured is almost always a desktop the OS
          // has taken away for a moment — a UAC prompt, the lock screen, a
          // resolution change. Keep the session and try again.
          const failure = classifyCaptureFailure(cause);
          const now = performance.now();
          outageStartedAt ??= now;
          if (
            failure.kind === "fatal" ||
            now - outageStartedAt > REMOTE_CONTROL_RECOVERY_GIVE_UP_MS
          ) {
            endSession(failure.message);
            return;
          }
          captureInterruptedRef.current = true;
          syncHostStatus();
          // A failed capture leaves the previous publish unobserved; drop it so
          // its rejection cannot surface later as an unhandled one.
          inFlight = inFlight?.catch(() => undefined) ?? null;
          await sleep(recoveryDelayMs(recoveryAttempt++));
          continue;
        }

        const elapsed = performance.now() - startedAt;
        // Yield to the event loop even when already behind, so input events
        // and session updates are not starved by a saturated capture loop.
        await sleep(TARGET_FRAME_INTERVAL_MS - elapsed);
      }
    };

    void run();
    return () => {
      cancelled = true;
      void bridge.resetRemoteControlInput();
    };
  }, [
    active,
    bridge,
    clientId,
    endByHost,
    environmentId,
    imageFallback,
    publishFrame,
    syncHostStatus,
  ]);

  const answerRequest = async (
    decision: "approve" | "decline",
    access: "view" | "control" = "view",
  ) => {
    if (!pending) return;
    setIsResponding(true);
    try {
      const outcome = await respond({
        environmentId,
        input: {
          clientId,
          connectionId: pending.connectionId,
          requestId: pending.requestId,
          decision,
          ...(decision === "approve"
            ? {
                grantedCapabilities:
                  access === "control"
                    ? pending.session.requestedCapabilities
                    : (["screen"] as const),
              }
            : {}),
        },
      });
      if (outcome._tag === "Failure") throw commandError(outcome);
      if (decision === "approve") {
        await bridge.activateRemoteControlHost().catch(() => undefined);
        setCaptureError(null);
        if (rememberDevice) {
          rememberRemoteControlDevice(
            environmentId,
            pending.session.requester.deviceId,
            outcome.value.grantedCapabilities,
          );
        }
        setActive({
          connectionId: pending.connectionId,
          session: outcome.value,
        });
      }
      setRememberDevice(false);
      setPending(null);
    } catch (cause) {
      setCaptureError(
        cause instanceof Error
          ? cause.message
          : "The remote-control request could not be answered.",
      );
    } finally {
      setIsResponding(false);
    }
  };

  const stopSharing = async () => {
    if (!active) return;
    const ending = active;
    setActive(null);
    await bridge.resetRemoteControlInput().catch(() => undefined);
    const outcome = await endByHost({
      environmentId,
      input: {
        clientId,
        connectionId: ending.connectionId,
        sessionId: ending.session.sessionId,
      },
    });
    if (outcome._tag === "Failure") setCaptureError(commandError(outcome).message);
  };

  return (
    <>
      {active ? (
        // Bottom-right, not top-center: parked over the titlebar it sat on top
        // of every header's actions. The corners are spoken for elsewhere —
        // toasts top-right, sidebar bottom-left, composer bottom-center — so
        // this is the one spot with nothing interactive underneath.
        <div className="fixed bottom-3 right-3 z-[70] flex items-center gap-2 rounded-full border border-success/35 bg-background/95 px-3 py-1.5 text-xs shadow-lg backdrop-blur">
          <span className="size-2 rounded-full bg-success" aria-hidden />
          <span className="font-medium">
            {active.session.grantedCapabilities.some(
              (capability) => capability === "pointer" || capability === "keyboard",
            )
              ? `Controlled by ${active.session.requester.label}`
              : `Screen shared with ${active.session.requester.label}`}
          </span>
          <Button size="xs" variant="outline" onClick={() => void stopSharing()}>
            Stop
          </Button>
        </div>
      ) : null}

      <Dialog open={pending !== null}>
        <DialogPopup showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MonitorUpIcon className="size-5" />
              {pending?.session.requestedCapabilities.some(
                (capability) => capability === "pointer" || capability === "keyboard",
              )
                ? "Allow remote control?"
                : "Share this screen?"}
            </DialogTitle>
            <DialogDescription>
              {pending?.session.requester.label ?? "A connected device"} wants to view and control
              this computer through your existing trusted Solla Code connection.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex gap-3 rounded-lg border bg-muted/30 p-3 text-sm">
              <ShieldCheckIcon className="mt-0.5 size-5 shrink-0 text-success" />
              <div className="space-y-1">
                <p className="font-medium">You choose the access level</p>
                <p className="text-muted-foreground">
                  View only shares the primary display. Allow control also enables pointer and
                  keyboard input. You can stop the session from this computer at any time.
                </p>
              </div>
            </div>
            <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-lg border border-border/70 px-3 py-2.5">
              <Checkbox
                className="mt-0.5"
                checked={rememberDevice}
                disabled={isResponding}
                onCheckedChange={(checked) => setRememberDevice(checked === true)}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">Remember for this device</span>
                <span className="block text-xs leading-relaxed text-muted-foreground">
                  Future requests for the access level you approve will start automatically.
                  Additional permissions or pairing the device again requires approval.
                </span>
              </span>
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={isResponding}
              onClick={() => void answerRequest("decline")}
            >
              Decline
            </Button>
            <Button
              variant="outline"
              disabled={isResponding}
              onClick={() => void answerRequest("approve", "view")}
            >
              View only
            </Button>
            <Button
              disabled={isResponding}
              onClick={() => void answerRequest("approve", "control")}
            >
              {isResponding ? <Spinner className="size-4" /> : null}
              Allow control
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog open={captureError !== null} onOpenChange={(open) => !open && setCaptureError(null)}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Screen sharing needs attention</DialogTitle>
            <DialogDescription>{captureError}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <p className="text-sm text-muted-foreground">
              On macOS, open System Settings → Privacy &amp; Security → Screen Recording, enable
              Solla Code, and also enable Accessibility for keyboard and pointer control. Then
              completely quit and reopen it. No GitHub sign-in is required.
            </p>
          </DialogPanel>
          <DialogFooter>
            <Button onClick={() => setCaptureError(null)}>Got it</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
