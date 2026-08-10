import type { RemoteControlInput } from "@t3tools/contracts";

type RemoteControlPointerInput = Extract<RemoteControlInput, { readonly type: "pointer" }>;
type RemoteControlPointerMove = RemoteControlPointerInput & { readonly action: "move" };

/** Mirrors the contract's per-event delta bound. */
export const REMOTE_CONTROL_POINTER_DELTA_LIMIT = 4_000;

function clamp(value: number, limit: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-limit, Math.min(limit, value));
}

/**
 * Keep one locked-pointer sample wire-safe without manufacturing follow-up
 * events. Oversized motion is clipped, not split: replaying the remainder
 * later is exactly the stale-input catch-up that makes remote control laggy.
 */
export function clampPointerDelta(value: number): number {
  return clamp(value, REMOTE_CONTROL_POINTER_DELTA_LIMIT);
}

/**
 * Collapse pointer samples captured within one display frame.
 *
 * Absolute motion names a destination, so only the newest position matters.
 * Relative motion is accumulated only inside the current frame, then clipped
 * to one wire event. This preserves normal mouse-look resolution without
 * creating a backlog that has to be replayed after the user's hand has moved
 * somewhere else.
 */
export function coalescePointerFrame(
  current: RemoteControlPointerMove | undefined,
  incoming: RemoteControlPointerMove,
): RemoteControlPointerMove {
  if (!current) return incoming;
  const currentIsRelative = current.dx !== undefined || current.dy !== undefined;
  const incomingIsRelative = incoming.dx !== undefined || incoming.dy !== undefined;
  if (!incomingIsRelative || currentIsRelative !== incomingIsRelative) return incoming;
  return {
    ...incoming,
    dx: clampPointerDelta((current.dx ?? 0) + (incoming.dx ?? 0)),
    dy: clampPointerDelta((current.dy ?? 0) + (incoming.dy ?? 0)),
  };
}
