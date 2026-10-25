import type { MediaSubscriberStats } from "@t3tools/contracts";

import type { PixelSize } from "./mediaEncodeSize.ts";

/**
 * The byte budget a media-channel stream may spend, from what the relay
 * measured.
 *
 * Delay-based, like WebRTC's congestion control and for the same reason:
 * over TCP a link that is too slow never loses packets, it queues them, so
 * growing queueing delay is the only early signal. The relay reports the age
 * of its oldest unacknowledged packet (`queueMs`) next to the link's floor
 * round trip (`minRttMs`); their difference is time spent in buffers.
 *
 * - Queueing past `CONGESTED_EXCESS_MS`, or any packet the relay had to drop:
 *   cut to 75% of what actually got through, at most once per event.
 * - A clear path while the stream really uses its budget: grow 10% per
 *   report. Screen content is idle most of the time, and an idle stream
 *   proves nothing about the link, so it holds rather than ratchets up.
 *
 * The ceiling is a property of the picture, not the link: about what the
 * legacy 8 Mbps VP8 stream spent on a full desktop, scaled by pixel count, so
 * a phone-sized picture can never cost what a desktop-sized one does.
 */
export interface BitrateControllerState {
  readonly minBitsPerSecond: number;
  readonly maxBitsPerSecond: number;
  readonly targetBitsPerSecond: number;
  readonly lastDecreaseAt: number;
}

export const CONGESTED_EXCESS_MS = 90;
const CLEAR_EXCESS_MS = 35;
const DECREASE_HOLD_MS = 400;
const INCREASE_AFTER_DECREASE_MS = 1_500;
const BITS_PER_PIXEL = 0.06;
const FULL_FRAME_RATE = 30;

export function maxBitrateFor(size: PixelSize): number {
  return Math.round(
    Math.min(
      7_500_000,
      Math.max(1_500_000, size.width * size.height * FULL_FRAME_RATE * BITS_PER_PIXEL),
    ),
  );
}

export function createBitrateController(size: PixelSize): BitrateControllerState {
  const maxBitsPerSecond = maxBitrateFor(size);
  return {
    minBitsPerSecond: 200_000,
    maxBitsPerSecond,
    targetBitsPerSecond: Math.min(4_000_000, maxBitsPerSecond),
    lastDecreaseAt: Number.NEGATIVE_INFINITY,
  };
}

/** Same target, new ceiling: the picture was resized. */
export function resizeBitrateController(
  state: BitrateControllerState,
  size: PixelSize,
): BitrateControllerState {
  const maxBitsPerSecond = maxBitrateFor(size);
  return {
    ...state,
    maxBitsPerSecond,
    targetBitsPerSecond: Math.min(maxBitsPerSecond, state.targetBitsPerSecond),
  };
}

export function updateBitrate(
  state: BitrateControllerState,
  stats: MediaSubscriberStats,
  now: number,
): BitrateControllerState {
  const excess = stats.queueMs - stats.minRttMs;
  if (stats.dropped > 0 || excess > CONGESTED_EXCESS_MS) {
    if (now - state.lastDecreaseAt < DECREASE_HOLD_MS) return state;
    const delivered = stats.deliveredBitsPerSecond;
    const base =
      delivered > 0 ? Math.min(state.targetBitsPerSecond, delivered) : state.targetBitsPerSecond;
    return {
      ...state,
      targetBitsPerSecond: Math.max(state.minBitsPerSecond, Math.round(base * 0.75)),
      lastDecreaseAt: now,
    };
  }
  if (
    excess < CLEAR_EXCESS_MS &&
    now - state.lastDecreaseAt > INCREASE_AFTER_DECREASE_MS &&
    stats.deliveredBitsPerSecond >= state.targetBitsPerSecond * 0.6
  ) {
    return {
      ...state,
      targetBitsPerSecond: Math.min(
        state.maxBitsPerSecond,
        Math.round(state.targetBitsPerSecond * 1.1),
      ),
    };
  }
  return state;
}
