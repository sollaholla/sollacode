"use client";

import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  RemoteControlInput,
  RemoteControlPointerButton,
  RemoteControlSession,
} from "@t3tools/contracts";
import { MonitorIcon, ShieldCheckIcon } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
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

import { Button } from "../ui/button";
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
import {
  controllerPlatform,
  normalizeRemoteControlKeyCode,
  normalizedRemotePoint,
  remotePointerButton,
  shouldForwardRemoteSurfaceInput,
} from "./remoteControlInput";

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error && cause.message.trim()
    ? cause.message
    : "Remote control could not be started.";
}

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
  const [error, setError] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [inputCaptured, setInputCaptured] = useState(false);
  const requestStartedRef = useRef(false);
  const frameImageRef = useRef<HTMLImageElement>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const inputSequenceRef = useRef(0);
  const inputQueueRef = useRef<RemoteControlInput[]>([]);
  const inputSendingRef = useRef(false);
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

  useEffect(() => {
    const event = watch.data;
    if (!event) return;
    if (event.type === "frame") {
      setFrameData(`data:${event.frame.mimeType};base64,${event.frame.data}`);
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

  const drainInputQueue = useCallback(
    async function drainRemoteInputQueue() {
      if (inputSendingRef.current) return;
      const currentSession = sessionRef.current;
      const input = inputQueueRef.current.shift();
      if (!input || currentSession?.status !== "approved") return;
      inputSendingRef.current = true;
      try {
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
      } catch (cause) {
        inputQueueRef.current = [];
        setInputError(
          cause instanceof Error && cause.message.trim()
            ? cause.message
            : "The remote computer could not apply that input.",
        );
      } finally {
        inputSendingRef.current = false;
        if (inputQueueRef.current.length > 0) void drainRemoteInputQueue();
      }
    },
    [environmentId, sendInputCommand],
  );

  const enqueueInput = useCallback(
    (input: RemoteControlInput) => {
      if (input.type === "pointer" && input.action === "move") {
        const lastIndex = inputQueueRef.current.length - 1;
        const last = inputQueueRef.current[lastIndex];
        if (last?.type === "pointer" && last.action === "move") {
          inputQueueRef.current[lastIndex] = input;
        } else {
          inputQueueRef.current.push(input);
        }
      } else {
        inputQueueRef.current.push(input);
      }
      void drainInputQueue();
    },
    [drainInputQueue],
  );

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
    setInputCaptured(false);
    releasePressedInputs();
  }, [releasePressedInputs]);

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
      inputQueueRef.current = [];
      pressedKeysRef.current.clear();
      pressedPointerButtonRef.current = null;
    },
    [],
  );

  const close = async () => {
    const current = session;
    requestStartedRef.current = false;
    setSession(null);
    setFrameData(null);
    setError(null);
    setInputError(null);
    setInputCaptured(false);
    inputQueueRef.current = [];
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

  useEffect(() => {
    if (!canControl && inputCaptured) releaseInputCapture();
  }, [canControl, inputCaptured, releaseInputCapture]);

  const sendPointer = (
    event: ReactPointerEvent<HTMLDivElement>,
    action: "move" | "down" | "up",
    button = remotePointerButton(event.button),
  ) => {
    if (
      !shouldForwardRemoteSurfaceInput({
        capabilityGranted: canPointer,
        inputCaptured,
        kind: `pointer-${action}`,
        hasActivePointerPress: pressedPointerButtonRef.current !== null,
      })
    ) {
      return;
    }
    event.preventDefault();
    const point = normalizedRemotePoint({
      clientX: event.clientX,
      clientY: event.clientY,
      rect:
        frameImageRef.current?.getBoundingClientRect() ??
        event.currentTarget.getBoundingClientRect(),
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
        inputCaptured,
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
      rect:
        frameImageRef.current?.getBoundingClientRect() ??
        event.currentTarget.getBoundingClientRect(),
    });
    enqueueInput({
      type: "wheel",
      ...point,
      deltaX: Math.max(-2_000, Math.min(2_000, event.deltaX)),
      deltaY: Math.max(-2_000, Math.min(2_000, event.deltaY)),
    });
  };

  const sendKey = (event: ReactKeyboardEvent<HTMLDivElement>, action: "down" | "up") => {
    if (
      !event.code ||
      !shouldForwardRemoteSurfaceInput({
        capabilityGranted: canKeyboard,
        inputCaptured,
        kind: "key",
      })
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const code = normalizeRemoteControlKeyCode(event.code, platform);
    if (action === "down") pressedKeysRef.current.set(code, event.key);
    else pressedKeysRef.current.delete(code);
    enqueueInput({
      type: "key",
      action,
      code,
      key: event.key.slice(0, 64),
      repeat: action === "down" && event.repeat,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && void close()}>
      <DialogPopup
        className="h-[min(90dvh,900px)] w-[min(94vw,1500px)] max-w-none"
        showCloseButton={false}
        bottomStickOnMobile={false}
      >
        <DialogHeader className="flex-row items-center justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <DialogTitle className="flex items-center gap-2">
              <MonitorIcon className="size-5 shrink-0" />
              <span className="truncate">{environmentLabel}</span>
            </DialogTitle>
            <DialogDescription>
              {isWaiting
                ? "Waiting for approval on the remote computer…"
                : isApproved
                  ? canControl
                    ? "Interactive control over your trusted Solla Code connection"
                    : "Live view over your trusted Solla Code connection"
                  : "Remote viewing session"}
            </DialogDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => void close()}>
            {isApproved ? "Stop and close" : "Close"}
          </Button>
        </DialogHeader>
        <DialogPanel className="flex h-[calc(100%-7rem)] min-h-0 items-center justify-center p-3">
          {error ? (
            <div className="max-w-lg space-y-3 rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-center">
              <p className="font-medium text-destructive">{error}</p>
              <p className="text-sm text-muted-foreground">
                The remote computer must be online with the latest Solla Code open. On macOS, the
                host may also need to enable System Settings → Privacy &amp; Security → Screen
                Recording. No GitHub sign-in is required.
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
          ) : frameData && isApproved ? (
            <div
              role="application"
              aria-label={`Remote desktop control for ${environmentLabel}`}
              data-remote-input-capture={inputCaptured ? "active" : "inactive"}
              className={`relative flex size-full touch-none select-none items-center justify-center overflow-hidden rounded-lg bg-black outline-hidden overscroll-none ${
                inputCaptured
                  ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
                  : "focus-visible:ring-2 focus-visible:ring-ring"
              }`}
              tabIndex={canControl ? 0 : -1}
              onFocus={() => {
                if (canControl) setInputCaptured(true);
              }}
              onBlur={releaseInputCapture}
              onKeyDown={(event) => sendKey(event, "down")}
              onKeyUp={(event) => sendKey(event, "up")}
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
                setInputCaptured(true);
                event.currentTarget.focus({ preventScroll: true });
                if (!canPointer) return;
                event.currentTarget.setPointerCapture(event.pointerId);
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
              <img
                ref={frameImageRef}
                src={frameData}
                alt={`Live desktop view from ${environmentLabel}`}
                draggable={false}
                className="pointer-events-none max-h-full max-w-full touch-none select-none object-contain"
              />
              <div className="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs text-white">
                <span
                  className={`size-1.5 rounded-full ${
                    inputCaptured ? "bg-primary" : "bg-emerald-400"
                  }`}
                />
                {canControl
                  ? inputCaptured
                    ? "Live · input focused"
                    : "Live · click to focus"
                  : "Live · view only"}
              </div>
              {inputError ? (
                <div className="absolute inset-x-3 top-3 rounded-lg border border-destructive/35 bg-background/95 px-3 py-2 text-sm text-destructive shadow-lg">
                  {inputError}
                </div>
              ) : null}
            </div>
          ) : isApproved ? (
            <div className="space-y-3 text-center">
              <Spinner className="mx-auto size-8" />
              <p className="text-sm text-muted-foreground">Starting the live desktop stream…</p>
            </div>
          ) : isTerminal ? (
            <div className="space-y-3 text-center">
              <ShieldCheckIcon className="mx-auto size-8 text-muted-foreground" />
              <p className="font-medium">Screen sharing ended</p>
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter className="py-2 text-xs text-muted-foreground" variant="bare">
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
