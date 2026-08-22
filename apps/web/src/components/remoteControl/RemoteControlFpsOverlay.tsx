import { useCallback, useEffect, useRef, useState } from "react";

import type { PointerEvent as ReactPointerEvent } from "react";

import {
  diffHeldKeys,
  FPS_LOOK_SENSITIVITY_DEFAULT,
  type FpsMovementCode,
  fpsMovementKeysForVector,
  resolveFpsStickVector,
  scaleFpsLookDelta,
} from "./remoteControlFpsController";

/** Radius of the movement stick's travel, in CSS pixels. */
const STICK_RADIUS = 56;

/** Key taps the action pad can send, beyond the two mouse buttons. */
const ACTION_KEYS = [
  { code: "Space", key: " ", label: "Jump" },
  { code: "ShiftLeft", key: "Shift", label: "Sprint" },
  { code: "ControlLeft", key: "Control", label: "Crouch" },
  { code: "KeyR", key: "r", label: "Reload" },
] as const;

export interface RemoteControlFpsOverlayProps {
  /** Emit a movement key edge. Every press is guaranteed a later release. */
  readonly onMovementKey: (code: FpsMovementCode, action: "down" | "up") => void;
  /** Emit an action key edge. */
  readonly onActionKey: (code: string, key: string, action: "down" | "up") => void;
  /** Emit a relative look delta, already scaled and clamped. */
  readonly onLook: (dx: number, dy: number) => void;
  /** Emit a mouse button edge (fire / aim). */
  readonly onPointerButton: (button: "left" | "right", action: "down" | "up") => void;
  readonly onExit: () => void;
  readonly lookSensitivity?: number;
}

/**
 * Touch controller for a remote game that has grabbed the cursor.
 *
 * The screen splits into a movement half and a look half, each tracking its
 * own pointer so a thumb on the stick and a thumb on the look pad work at the
 * same time. Nothing here reaches the surface underneath: every handler stops
 * propagation, or the same touch would also be delivered as an absolute
 * pointer move to the remote desktop.
 *
 * The invariant that matters most is that no input is left stuck down. A
 * remote key has no idea this UI exists, so a press that never gets its
 * release leaves the character running into a wall until the session ends.
 * Releases are therefore emitted from the pointer handlers, from `pointercancel`
 * (which mobile fires for system gestures like the app switcher), and from
 * unmount — which covers leaving FPS mode, losing the lock, and closing the
 * dialog.
 */
export function RemoteControlFpsOverlay({
  onMovementKey,
  onActionKey,
  onLook,
  onPointerButton,
  onExit,
  lookSensitivity = FPS_LOOK_SENSITIVITY_DEFAULT,
}: RemoteControlFpsOverlayProps) {
  // Only the origin is state: it changes once when a thumb lands and once when
  // it lifts. The thumb's position within the stick is written straight to the
  // node instead, because a touchscreen samples faster than the display
  // refreshes and re-rendering React on every sample is the one thing here
  // that would visibly cost frames.
  const [stickOrigin, setStickOrigin] = useState<{ x: number; y: number } | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);

  const stickPointerRef = useRef<number | null>(null);
  const stickOriginRef = useRef<{ x: number; y: number } | null>(null);
  const heldMovementRef = useRef<ReadonlySet<FpsMovementCode>>(new Set());

  const lookPointerRef = useRef<number | null>(null);
  const lookLastRef = useRef<{ x: number; y: number } | null>(null);

  const heldActionsRef = useRef(new Set<string>());
  const heldButtonsRef = useRef(new Set<"left" | "right">());

  // Handlers are read through refs by the unmount cleanup so that releasing
  // stuck input never depends on the identity of a prop callback.
  const onMovementKeyRef = useRef(onMovementKey);
  onMovementKeyRef.current = onMovementKey;
  const onActionKeyRef = useRef(onActionKey);
  onActionKeyRef.current = onActionKey;
  const onPointerButtonRef = useRef(onPointerButton);
  onPointerButtonRef.current = onPointerButton;

  const applyMovement = useCallback((next: ReadonlySet<FpsMovementCode>) => {
    const { pressed, released } = diffHeldKeys(heldMovementRef.current, next);
    heldMovementRef.current = next;
    // Release first: a reversal frees the old direction before claiming the
    // new one, so the host never sees W and S held together.
    for (const code of released) onMovementKeyRef.current(code, "up");
    for (const code of pressed) onMovementKeyRef.current(code, "down");
  }, []);

  const resetStick = useCallback(() => {
    stickPointerRef.current = null;
    stickOriginRef.current = null;
    setStickOrigin(null);
    applyMovement(new Set());
  }, [applyMovement]);

  // Release everything still held when this overlay goes away for any reason.
  useEffect(
    () => () => {
      for (const code of heldMovementRef.current) onMovementKeyRef.current(code, "up");
      heldMovementRef.current = new Set();
      for (const code of heldActionsRef.current) {
        const action = ACTION_KEYS.find((entry) => entry.code === code);
        onActionKeyRef.current(code, action?.key ?? "", "up");
      }
      heldActionsRef.current.clear();
      for (const button of heldButtonsRef.current) onPointerButtonRef.current(button, "up");
      heldButtonsRef.current.clear();
    },
    [],
  );

  const handleStickDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (stickPointerRef.current !== null) return;
    stickPointerRef.current = event.pointerId;
    // The stick appears under the thumb rather than at a fixed spot: on a
    // phone you cannot see where your thumb landed, and a fixed origin means
    // the first movement of every touch is a correction.
    //
    // Two coordinate spaces, deliberately: the vector math stays in client
    // space (where the move events already are), while rendering needs the
    // origin relative to this zone. The rect is read once per touch rather
    // than per move — the zone cannot move mid-drag.
    stickOriginRef.current = { x: event.clientX, y: event.clientY };
    const rect = event.currentTarget.getBoundingClientRect();
    setStickOrigin({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    if (thumbRef.current) thumbRef.current.style.transform = "translate3d(0px, 0px, 0)";
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleStickMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (stickPointerRef.current !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const origin = stickOriginRef.current;
    if (!origin) return;
    const vector = resolveFpsStickVector({
      origin,
      point: { x: event.clientX, y: event.clientY },
      radius: STICK_RADIUS,
    });
    const thumb = thumbRef.current;
    if (thumb) {
      thumb.style.transform = `translate3d(${vector.x * STICK_RADIUS}px, ${
        vector.y * STICK_RADIUS
      }px, 0)`;
    }
    applyMovement(fpsMovementKeysForVector(vector));
  };

  const handleStickUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (stickPointerRef.current !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resetStick();
  };

  const handleLookDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (lookPointerRef.current !== null) return;
    lookPointerRef.current = event.pointerId;
    lookLastRef.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleLookMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (lookPointerRef.current !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const last = lookLastRef.current;
    if (!last) return;
    // Incremental against the previous sample, not the touch origin: aiming is
    // a series of deltas, and measuring from the origin would re-apply the
    // whole drag on every move.
    const dx = scaleFpsLookDelta(event.clientX - last.x, lookSensitivity);
    const dy = scaleFpsLookDelta(event.clientY - last.y, lookSensitivity);
    lookLastRef.current = { x: event.clientX, y: event.clientY };
    if (dx !== 0 || dy !== 0) onLook(dx, dy);
  };

  const handleLookUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (lookPointerRef.current !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    lookPointerRef.current = null;
    lookLastRef.current = null;
  };

  const holdButton = (button: "left" | "right") => ({
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (heldButtonsRef.current.has(button)) return;
      heldButtonsRef.current.add(button);
      event.currentTarget.setPointerCapture(event.pointerId);
      onPointerButton(button, "down");
    },
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (!heldButtonsRef.current.delete(button)) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      onPointerButton(button, "up");
    },
    onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (!heldButtonsRef.current.delete(button)) return;
      onPointerButton(button, "up");
    },
  });

  const holdKey = (code: string, key: string) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (heldActionsRef.current.has(code)) return;
      heldActionsRef.current.add(code);
      event.currentTarget.setPointerCapture(event.pointerId);
      onActionKey(code, key, "down");
    },
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (!heldActionsRef.current.delete(code)) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      onActionKey(code, key, "up");
    },
    onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (!heldActionsRef.current.delete(code)) return;
      onActionKey(code, key, "up");
    },
  });

  return (
    <div data-remote-fps-overlay className="absolute inset-0 z-20 flex touch-none select-none">
      {/* Movement half */}
      <div
        data-remote-fps-zone="move"
        aria-hidden="true"
        className="relative flex-[42] touch-none"
        onPointerDown={handleStickDown}
        onPointerMove={handleStickMove}
        onPointerUp={handleStickUp}
        onPointerCancel={handleStickUp}
        onContextMenu={(event) => event.preventDefault()}
      >
        {stickOrigin ? (
          <>
            <div
              className="pointer-events-none absolute rounded-full border-2 border-white/35 bg-black/25"
              style={{
                left: stickOrigin.x - STICK_RADIUS,
                top: stickOrigin.y - STICK_RADIUS,
                width: STICK_RADIUS * 2,
                height: STICK_RADIUS * 2,
              }}
            />
            <div
              ref={thumbRef}
              className="pointer-events-none absolute rounded-full border border-white/60 bg-white/35 will-change-transform"
              style={{
                left: stickOrigin.x - 22,
                top: stickOrigin.y - 22,
                width: 44,
                height: 44,
              }}
            />
          </>
        ) : (
          <div className="pointer-events-none absolute bottom-6 left-6 rounded-full bg-black/55 px-3 py-1 text-[11px] text-white/80">
            Drag to move
          </div>
        )}
      </div>

      {/* The split itself, so the two halves read as a controller rather than
          as an invisible gesture area. */}
      <div className="pointer-events-none w-px self-stretch bg-white/15" />

      {/* Look half */}
      <div
        data-remote-fps-zone="look"
        aria-hidden="true"
        className="relative flex-[58] touch-none"
        onPointerDown={handleLookDown}
        onPointerMove={handleLookMove}
        onPointerUp={handleLookUp}
        onPointerCancel={handleLookUp}
        onContextMenu={(event) => event.preventDefault()}
      >
        <div className="pointer-events-none absolute top-6 right-6 rounded-full bg-black/55 px-3 py-1 text-[11px] text-white/80">
          Drag to look
        </div>

        {/* Bounded and wrapping: in portrait this half is barely 220px wide,
            and a single row of four action keys plus the fire cluster is wider
            than that. Buttons stay at a 44px touch target and take a second
            row rather than overflowing off-screen. */}
        <div className="absolute right-3 bottom-3 flex max-w-[min(90%,340px)] flex-col items-end gap-2">
          <div className="flex flex-wrap justify-end gap-2">
            {ACTION_KEYS.map((action) => (
              <button
                key={action.code}
                type="button"
                aria-label={action.label}
                className="h-11 min-w-11 cursor-pointer rounded-full border border-white/25 bg-black/55 px-3 text-[11px] font-medium text-white active:bg-white/25"
                {...holdKey(action.code, action.key)}
              >
                {action.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Aim (right mouse button)"
              className="size-14 cursor-pointer rounded-full border border-white/25 bg-black/55 text-[11px] font-medium text-white active:bg-white/25"
              {...holdButton("right")}
            >
              Aim
            </button>
            <button
              type="button"
              aria-label="Fire (left mouse button)"
              className="size-20 cursor-pointer rounded-full border-2 border-white/40 bg-white/20 text-sm font-semibold text-white active:bg-white/40"
              {...holdButton("left")}
            >
              Fire
            </button>
          </div>
        </div>
      </div>

      <button
        type="button"
        aria-label="Exit FPS controller"
        className="absolute top-3 left-1/2 h-9 -translate-x-1/2 cursor-pointer rounded-full border border-white/25 bg-black/65 px-4 text-xs font-medium text-white active:bg-white/25"
        // Deliberately no preventDefault here: suppressing the pointerdown
        // default also suppresses the compatibility mouse events a browser
        // synthesises `click` from, which would leave the only way out of FPS
        // mode dead. Stopping propagation is enough to keep the surface
        // underneath from seeing the tap.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onExit();
        }}
      >
        Exit FPS
      </button>
    </div>
  );
}
