import type { RemoteControlInput } from "@t3tools/contracts";

import { coalescePointerFrame } from "./remoteControlPointerMotion.ts";

type PointerMove = Extract<RemoteControlInput, { readonly type: "pointer" }> & {
  readonly action: "move";
};
type WheelInput = Extract<RemoteControlInput, { readonly type: "wheel" }>;
type ContinuousInput = PointerMove | WheelInput;
type ContinuousLane = "pointer" | "wheel";

interface LaneState {
  running: boolean;
  pending: ContinuousInput | undefined;
}

export interface RemoteControlInputSchedulerOptions {
  readonly send: (input: RemoteControlInput) => Promise<void>;
  readonly onError?: (cause: unknown) => void;
  /**
   * Controller-side sampling hook. Omit it at the host boundary, where the
   * first event should be injected immediately and only an in-flight successor
   * needs coalescing.
   */
  readonly scheduleFrame?: (callback: () => void) => number;
  readonly cancelFrame?: (handle: number) => void;
}

export interface RemoteControlInputScheduler {
  readonly enqueue: (input: RemoteControlInput) => void;
  readonly discardPointerMotion: () => void;
  readonly clear: () => void;
}

const WHEEL_DELTA_LIMIT = 2_000;

function clampWheel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-WHEEL_DELTA_LIMIT, Math.min(WHEEL_DELTA_LIMIT, value));
}

function coalesceWheelFrame(current: WheelInput | undefined, incoming: WheelInput): WheelInput {
  if (!current) return incoming;
  return {
    ...incoming,
    deltaX: clampWheel(current.deltaX + incoming.deltaX),
    deltaY: clampWheel(current.deltaY + incoming.deltaY),
  };
}

function laneFor(input: ContinuousInput): ContinuousLane {
  return input.type === "pointer" ? "pointer" : "wheel";
}

/**
 * A freshness-first remote-input dispatcher.
 *
 * Motion is sampled at most once per controller display frame. Once a sample
 * is in flight, there is room for exactly one successor per motion lane, and a
 * newer sample replaces that successor instead of joining a replay queue.
 * Button and key edges bypass motion lanes entirely because their ordering is
 * state, not telemetry. Browser key-repeat samples are redundant once a key is
 * down and are discarded defensively here as well as at the event source.
 */
export function createRemoteControlInputScheduler(
  options: RemoteControlInputSchedulerOptions,
): RemoteControlInputScheduler {
  const lanes: Record<ContinuousLane, LaneState> = {
    pointer: { running: false, pending: undefined },
    wheel: { running: false, pending: undefined },
  };
  let stagedPointer: PointerMove | undefined;
  let stagedWheel: WheelInput | undefined;
  let frameHandle: number | undefined;
  let generation = 0;

  const fail = (cause: unknown) => {
    stagedPointer = undefined;
    stagedWheel = undefined;
    lanes.pointer.pending = undefined;
    lanes.wheel.pending = undefined;
    if (frameHandle !== undefined) {
      options.cancelFrame?.(frameHandle);
      frameHandle = undefined;
    }
    options.onError?.(cause);
  };

  const sendContinuous = (input: ContinuousInput): void => {
    const lane = lanes[laneFor(input)];
    if (lane.running) {
      // Replacement for a POSITION, accumulation for a DELTA - which is what
      // these coalescers already encode, so the successor slot uses the same
      // rule as the frame staging rather than a second, different one.
      //
      // An absolute sample names a destination, so an older unsent one is
      // simply stale. A relative sample names a distance travelled, and
      // dropping it does not go stale - it goes missing. While one send is in
      // flight over a phone's round-trip, several frames' worth of deltas land
      // here, and replacing them threw away all but the last: mouse-look moved
      // a fraction of the drag and read as a dead stick, while movement (key
      // edges, which never enter a motion lane) worked perfectly.
      //
      // Still exactly one pending event per lane, so this adds no replay
      // backlog - only the total distance is preserved.
      lane.pending =
        input.type === "pointer"
          ? coalescePointerFrame(lane.pending as PointerMove | undefined, input)
          : coalesceWheelFrame(lane.pending as WheelInput | undefined, input);
      return;
    }
    lane.running = true;
    const startedGeneration = generation;
    void options.send(input).then(
      () => {
        if (startedGeneration !== generation) return;
        lane.running = false;
        const pending = lane.pending;
        lane.pending = undefined;
        if (pending) sendContinuous(pending);
      },
      (cause: unknown) => {
        if (startedGeneration !== generation) return;
        lane.running = false;
        fail(cause);
      },
    );
  };

  const flushFrame = () => {
    frameHandle = undefined;
    const pointer = stagedPointer;
    const wheel = stagedWheel;
    stagedPointer = undefined;
    stagedWheel = undefined;
    if (pointer) sendContinuous(pointer);
    if (wheel) sendContinuous(wheel);
  };

  const stageContinuous = (input: ContinuousInput) => {
    if (!options.scheduleFrame) {
      sendContinuous(input);
      return;
    }
    if (input.type === "pointer") {
      stagedPointer = coalescePointerFrame(stagedPointer, input);
    } else {
      stagedWheel = coalesceWheelFrame(stagedWheel, input);
    }
    frameHandle ??= options.scheduleFrame(flushFrame);
  };

  const discardPointerMotion = () => {
    stagedPointer = undefined;
    lanes.pointer.pending = undefined;
  };

  const enqueue = (input: RemoteControlInput): void => {
    if (input.type === "key" && input.action === "down" && input.repeat) return;
    if (input.type === "pointer" && input.action === "move") {
      stageContinuous(input as PointerMove);
      return;
    }
    if (input.type === "wheel") {
      stageContinuous(input);
      return;
    }
    if (input.type === "pointer") discardPointerMotion();
    const startedGeneration = generation;
    void options.send(input).catch((cause: unknown) => {
      if (startedGeneration === generation) fail(cause);
    });
  };

  const clear = () => {
    generation += 1;
    stagedPointer = undefined;
    stagedWheel = undefined;
    lanes.pointer.running = false;
    lanes.pointer.pending = undefined;
    lanes.wheel.running = false;
    lanes.wheel.pending = undefined;
    if (frameHandle !== undefined) {
      options.cancelFrame?.(frameHandle);
      frameHandle = undefined;
    }
  };

  return { enqueue, discardPointerMotion, clear };
}
