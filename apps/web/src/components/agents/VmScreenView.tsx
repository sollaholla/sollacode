import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, VmAgent, VmAgentInput, VmPointerButton } from "@t3tools/contracts";
import {
  HandIcon,
  KeyboardIcon,
  MaximizeIcon,
  MinimizeIcon,
  MousePointer2Icon,
  PlayIcon,
  RotateCwIcon,
  SquareIcon,
} from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
import { vmAgentEnvironment } from "~/state/vmAgents";

/**
 * The agent's live computer: a docked, full-screen-capable pane that renders the
 * VM's screen frames, overlays the agent's own cursor so the user can see where
 * it is about to act, and lets the user take control (which pauses the agent's
 * perception server-side). Replaces the old cramped floating window.
 */
export function VmScreenView(props: {
  readonly agent: VmAgent;
  readonly environmentId: EnvironmentId;
}) {
  const { agent, environmentId } = props;
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const mobileKeyboardRef = useRef<HTMLTextAreaElement | null>(null);
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [fullScreenSupported, setFullScreenSupported] = useState(false);

  const setControlMode = useAtomCommand(vmAgentEnvironment.setControlMode, {
    reportFailure: false,
  });
  const startAgent = useAtomCommand(vmAgentEnvironment.start, { reportFailure: false });
  const stopAgent = useAtomCommand(vmAgentEnvironment.stop, { reportFailure: false });
  const sendInput = useAtomCommand(vmAgentEnvironment.sendInput, { reportFailure: false });

  const screenAtom = useMemo(
    () => vmAgentEnvironment.screen({ environmentId, input: { vmAgentId: agent.vmAgentId } }),
    [agent.vmAgentId, environmentId],
  );
  const result = useAtomValue(screenAtom);
  const view = Option.getOrNull(AsyncResult.value(result));
  const frame = view?.frame ?? null;
  const controlMode = view?.controlMode ?? agent.controlMode;
  const userInControl = controlMode === "user";

  // Track the rendered size of the surface so the agent cursor can be mapped
  // from frame-pixel coordinates onto the letterboxed `object-contain` image.
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSurfaceSize({ width: rect.width, height: rect.height });
    });
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  // Full screen mirrors the browser: the user can leave with Escape or system
  // chrome without touching our control, so the flag only ever reflects reality.
  useEffect(() => {
    const sync = () => setIsFullScreen(document.fullscreenElement === surfaceRef.current);
    setFullScreenSupported(
      typeof surfaceRef.current?.requestFullscreen === "function" &&
        typeof document.exitFullscreen === "function",
    );
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const toggleFullScreen = useCallback(() => {
    if (document.fullscreenElement) {
      void Promise.resolve(document.exitFullscreen()).catch(() => undefined);
      return;
    }
    const surface = surfaceRef.current;
    if (!surface) return;
    // Refusable (needs a user gesture / can be policy-blocked); a refusal just
    // leaves the pane windowed, which is where it already was.
    void Promise.resolve(surface.requestFullscreen({ navigationUI: "hide" })).catch(
      () => undefined,
    );
  }, []);

  const running = agent.status === "running";
  const busy = agent.status === "starting" || agent.status === "provisioning";

  const toggleControl = () =>
    void setControlMode({
      environmentId,
      input: {
        vmAgentId: agent.vmAgentId,
        controlMode: userInControl ? "agent" : "user",
      },
    });

  // ── Input forwarding (only while the user holds control) ──────────────────
  const sequenceRef = useRef(0);
  const pressedButtonRef = useRef<VmPointerButton | null>(null);
  const pendingMoveRef = useRef<VmAgentInput | null>(null);
  const rafRef = useRef<number | null>(null);
  const [focused, setFocused] = useState(false);

  const dispatch = useCallback(
    (event: VmAgentInput) => {
      void sendInput({
        environmentId,
        input: { vmAgentId: agent.vmAgentId, sequence: sequenceRef.current++, input: event },
      });
    },
    [agent.vmAgentId, environmentId, sendInput],
  );

  // Coalesce high-frequency moves to one per animation frame so a fast drag
  // doesn't flood the socket; only the latest position matters.
  const flushMove = useCallback(() => {
    rafRef.current = null;
    const pending = pendingMoveRef.current;
    pendingMoveRef.current = null;
    if (pending) dispatch(pending);
  }, [dispatch]);
  const queueMove = useCallback(
    (event: VmAgentInput) => {
      pendingMoveRef.current = event;
      if (rafRef.current === null) rafRef.current = window.requestAnimationFrame(flushMove);
    },
    [flushMove],
  );
  /**
   * Discard a coalesced move that has not been sent yet. Press and release
   * carry their own coordinates, so a queued move is already superseded — and
   * letting it arrive *after* the press would drag the pointer mid-click.
   */
  const dropPendingMove = useCallback(() => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingMoveRef.current = null;
  }, []);
  useEffect(
    () => () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  // Normalize a client point onto 0..1 within the letterboxed frame image.
  const normalizedPoint = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const surface = surfaceRef.current;
      if (!surface || !frame) return null;
      const rect = surface.getBoundingClientRect();
      const scale = Math.min(rect.width / frame.width, rect.height / frame.height);
      const renderedWidth = frame.width * scale;
      const renderedHeight = frame.height * scale;
      const localX = clientX - rect.left - (rect.width - renderedWidth) / 2;
      const localY = clientY - rect.top - (rect.height - renderedHeight) / 2;
      return {
        x: Math.min(1, Math.max(0, localX / renderedWidth)),
        y: Math.min(1, Math.max(0, localY / renderedHeight)),
      };
    },
    [frame],
  );

  const canDrive = running && userInControl;

  /**
   * Taking control has to hand the keyboard over too. Without this the surface
   * stays unfocused, the chat composer keeps focus, and everything the user
   * types goes into the chat box instead of the agent's screen.
   */
  useEffect(() => {
    if (!canDrive) return;
    surfaceRef.current?.focus({ preventScroll: true });
  }, [canDrive]);

  const takeControl = useCallback(() => {
    void setControlMode({
      environmentId,
      input: { vmAgentId: agent.vmAgentId, controlMode: "user" },
    });
  }, [agent.vmAgentId, environmentId, setControlMode]);

  const onSurfacePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!canDrive) return;
    const point = normalizedPoint(event.clientX, event.clientY);
    if (!point) return;
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const button = pointerButton(event.button);
    pressedButtonRef.current = button;
    dropPendingMove();
    dispatch({ type: "pointer", action: "down", x: point.x, y: point.y, button });
  };
  const onSurfacePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!canDrive) return;
    const point = normalizedPoint(event.clientX, event.clientY);
    if (!point) return;
    queueMove({
      type: "pointer",
      action: "move",
      x: point.x,
      y: point.y,
      button: pressedButtonRef.current ?? "left",
    });
  };
  const onSurfacePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!canDrive) return;
    const point = normalizedPoint(event.clientX, event.clientY);
    const button = pressedButtonRef.current ?? pointerButton(event.button);
    pressedButtonRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dropPendingMove();
    if (point) dispatch({ type: "pointer", action: "up", x: point.x, y: point.y, button });
  };
  const onSurfaceWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!canDrive) return;
    const point = normalizedPoint(event.clientX, event.clientY);
    if (!point) return;
    dispatch({
      type: "scroll",
      x: point.x,
      y: point.y,
      deltaX: Math.max(-2000, Math.min(2000, event.deltaX)),
      deltaY: Math.max(-2000, Math.min(2000, event.deltaY)),
    });
  };

  // Keyboard is forwarded while the surface is focused and the user has control.
  useEffect(() => {
    if (!canDrive || !focused) return;
    // Claim the key outright: this listener is on window's capture phase, so
    // stopping propagation here keeps the keystroke from also reaching the
    // chat composer's shortcuts (or React) while the VM has the keyboard.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target === mobileKeyboardRef.current) return;
      if (!event.code) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dispatch({
        type: "key",
        action: "down",
        key: event.key.slice(0, 64),
        code: event.code.slice(0, 64),
      });
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.target === mobileKeyboardRef.current) return;
      if (!event.code) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dispatch({
        type: "key",
        action: "up",
        key: event.key.slice(0, 64),
        code: event.code.slice(0, 64),
      });
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [canDrive, focused, dispatch]);

  // Map the agent cursor (frame-pixel space) into the rendered, letterboxed image.
  const cursorPoint =
    frame?.cursor && surfaceSize.width > 0 && surfaceSize.height > 0
      ? projectCursor({
          cursor: frame.cursor,
          frameWidth: frame.width,
          frameHeight: frame.height,
          surfaceWidth: surfaceSize.width,
          surfaceHeight: surfaceSize.height,
        })
      : null;

  const typeMobileText = (event: FormEvent<HTMLTextAreaElement>) => {
    const text = event.currentTarget.value;
    event.currentTarget.value = "";
    if (text.length > 0) dispatch({ type: "text", text });
  };
  const desktopStatus = running
    ? frame
      ? userInControl
        ? focused
          ? "You are in control · keyboard here"
          : "You are in control · tap Keyboard to type"
        : "Live · agent working"
      : "Connecting…"
    : `VM ${agent.status}`;
  const compactStatus = running
    ? frame
      ? userInControl
        ? "Control"
        : "Live"
      : "Connecting"
    : agent.status;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      {/* Toolbar */}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-b px-2 py-2 sm:gap-2 sm:px-3">
        <MousePointer2Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">Computer</span>
        <StatusDot agent={agent} />
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
          {running ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void stopAgent({ environmentId, input: { vmAgentId: agent.vmAgentId } })
              }
            >
              <SquareIcon /> <span className="hidden sm:inline">Stop</span>
            </Button>
          ) : (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void startAgent({ environmentId, input: { vmAgentId: agent.vmAgentId } })
              }
            >
              <PlayIcon /> <span className="hidden sm:inline">Start</span>
            </Button>
          )}
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            aria-label="Restart the VM"
            onClick={() => {
              void (async () => {
                if (running) {
                  await stopAgent({ environmentId, input: { vmAgentId: agent.vmAgentId } });
                }
                await startAgent({ environmentId, input: { vmAgentId: agent.vmAgentId } });
              })();
            }}
          >
            <RotateCwIcon /> <span className="hidden sm:inline">Restart</span>
          </Button>
          <Button
            size="xs"
            variant={userInControl ? "default" : "outline"}
            disabled={!running}
            onClick={toggleControl}
          >
            <HandIcon />
            <span className="hidden sm:inline">
              {userInControl ? "Release control" : "Take control"}
            </span>
          </Button>
          {userInControl ? (
            <Button
              size="xs"
              variant="outline"
              className="md:hidden"
              aria-label="Open keyboard"
              onClick={() => mobileKeyboardRef.current?.focus({ preventScroll: true })}
            >
              <KeyboardIcon />
              <span className="hidden min-[360px]:inline">Keyboard</span>
            </Button>
          ) : null}
        </div>
      </div>

      <textarea
        ref={mobileKeyboardRef}
        aria-label={`Type on ${agent.name}'s computer`}
        className="fixed -left-[10000px] top-0 h-px w-px opacity-0"
        autoCapitalize="sentences"
        autoCorrect="on"
        spellCheck
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onInput={typeMobileText}
        onKeyDown={(event) => {
          if (
            ![
              "Enter",
              "Backspace",
              "Delete",
              "Tab",
              "ArrowUp",
              "ArrowDown",
              "ArrowLeft",
              "ArrowRight",
            ].includes(event.key)
          )
            return;
          event.preventDefault();
          dispatch({ type: "press", keys: event.key });
        }}
      />

      {/* Surface */}
      <div className="relative min-h-0 flex-1 bg-black">
        <div
          ref={surfaceRef}
          role={canDrive ? "application" : undefined}
          aria-label={canDrive ? `Control ${agent.name}'s computer` : undefined}
          tabIndex={canDrive ? 0 : -1}
          className={cn(
            "absolute inset-0 overflow-hidden outline-hidden",
            userInControl && "ring-2 ring-primary ring-inset",
            canDrive ? "cursor-crosshair touch-none select-none" : "cursor-default",
          )}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={onSurfacePointerDown}
          onPointerMove={onSurfacePointerMove}
          onPointerUp={onSurfacePointerUp}
          onPointerCancel={onSurfacePointerUp}
          onWheel={onSurfaceWheel}
        >
          {frame ? (
            <img
              alt={`${agent.name} screen`}
              src={`data:image/${frame.format};base64,${frame.data}`}
              className="pointer-events-none h-full w-full select-none object-contain"
              draggable={false}
            />
          ) : (
            <ScreenPlaceholder agent={agent} />
          )}

          {/* Agent cursor overlay — hidden while the user has control (the agent
              is paused, so its pointer is stale). */}
          {cursorPoint && !userInControl ? (
            <AgentCursor x={cursorPoint.x} y={cursorPoint.y} label={agent.name} />
          ) : null}

          {/* Takeover banner */}
          {userInControl ? (
            <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center gap-2 bg-primary/95 px-3 py-1 text-center text-xs font-medium text-primary-foreground">
              <HandIcon className="size-3.5" />
              You have control — the agent is paused.
            </div>
          ) : null}

          {/*
            Without control the surface ignores input entirely, so a click used
            to do nothing at all and the keyboard stayed in the chat composer.
            Make the click do the obvious thing instead: take control.
          */}
          {running && !userInControl ? (
            <button
              type="button"
              aria-label={`Take control of ${agent.name}'s computer`}
              onClick={takeControl}
              className="group absolute inset-0 flex cursor-pointer items-center justify-center bg-transparent transition-colors hover:bg-black/30 focus-visible:bg-black/30 focus-visible:outline-hidden"
            >
              <span className="flex items-center gap-2 rounded-full bg-black/75 px-3 py-1.5 text-xs font-medium text-white opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-visible:opacity-100">
                <HandIcon className="size-3.5" />
                Click to take control
              </span>
            </button>
          ) : null}

          {/* Live / status pill */}
          <div className="pointer-events-none absolute bottom-2 left-2 flex max-w-[calc(100%-4rem)] items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs text-white sm:bottom-3 sm:left-3">
            <span
              className={cn(
                "size-1.5 rounded-full",
                running && frame
                  ? userInControl
                    ? "bg-primary"
                    : "bg-emerald-400"
                  : "bg-white/40",
              )}
            />
            <span className="truncate sm:hidden">{compactStatus}</span>
            <span className="truncate max-sm:hidden">{desktopStatus}</span>
          </div>

          {/* Full-screen toggle */}
          {fullScreenSupported ? (
            <button
              type="button"
              aria-label={isFullScreen ? "Exit full screen" : "Enter full screen"}
              className="absolute right-2 bottom-2 flex cursor-pointer items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs text-white hover:bg-black/85 sm:right-3 sm:bottom-3"
              // Sits over the input surface: don't let a click here also drive the guest.
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                toggleFullScreen();
              }}
            >
              {isFullScreen ? (
                <MinimizeIcon className="size-3.5" />
              ) : (
                <MaximizeIcon className="size-3.5" />
              )}
              <span className="hidden sm:inline">{isFullScreen ? "Exit" : "Full screen"}</span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Browser `MouseEvent.button` ordinal → the guest's named pointer button. */
function pointerButton(button: number): VmPointerButton {
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "left";
}

/** Frame-pixel cursor → rendered position inside a letterboxed `object-contain`. */
function projectCursor(input: {
  cursor: { readonly x: number; readonly y: number };
  frameWidth: number;
  frameHeight: number;
  surfaceWidth: number;
  surfaceHeight: number;
}): { x: number; y: number } {
  const scale = Math.min(
    input.surfaceWidth / input.frameWidth,
    input.surfaceHeight / input.frameHeight,
  );
  const renderedWidth = input.frameWidth * scale;
  const renderedHeight = input.frameHeight * scale;
  const offsetX = (input.surfaceWidth - renderedWidth) / 2;
  const offsetY = (input.surfaceHeight - renderedHeight) / 2;
  return {
    x: offsetX + input.cursor.x * scale,
    y: offsetY + input.cursor.y * scale,
  };
}

function AgentCursor(props: { x: number; y: number; label: string }) {
  return (
    <div
      className="pointer-events-none absolute z-10 transition-[left,top] duration-100 ease-linear"
      style={{ left: props.x, top: props.y }}
    >
      <MousePointer2Icon
        className="size-5 fill-primary text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
        strokeWidth={1.5}
      />
      <span className="absolute top-4 left-4 rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-primary-foreground shadow">
        {props.label}
      </span>
    </div>
  );
}

function ScreenPlaceholder({ agent }: { agent: VmAgent }) {
  if (agent.status === "failed") {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm font-medium text-destructive">This agent's VM failed to start.</p>
        {agent.lastError ? (
          <p className="max-w-md text-xs text-white/50">{agent.lastError}</p>
        ) : null}
      </div>
    );
  }
  if (agent.status === "running") {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-center">
        <Spinner className="size-6 text-white/70" />
        <p className="text-xs text-white/60">Connecting to the live screen…</p>
      </div>
    );
  }
  if (agent.status === "starting" || agent.status === "provisioning") {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-center">
        <Spinner className="size-6 text-white/70" />
        <p className="text-xs text-white/60">
          {agent.status === "provisioning" ? "Provisioning the VM…" : "Booting the VM…"}
        </p>
      </div>
    );
  }
  return (
    <div className="flex h-full w-full items-center justify-center p-6 text-center">
      <p className="text-xs text-white/50">The VM is stopped. Start it to see the screen.</p>
    </div>
  );
}

function StatusDot({ agent }: { agent: VmAgent }) {
  const tone =
    agent.status === "running"
      ? "bg-emerald-500"
      : agent.status === "failed"
        ? "bg-destructive"
        : agent.status === "starting" || agent.status === "provisioning"
          ? "bg-amber-500"
          : "bg-muted-foreground/50";
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", tone)} />
      <span className="hidden sm:inline">{agent.status}</span>
    </span>
  );
}
