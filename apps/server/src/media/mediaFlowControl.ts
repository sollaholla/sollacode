/**
 * Per-subscriber pacing for the media relay.
 *
 * TCP never drops, so a viewer on a link slower than the stream does not lose
 * frames - it receives every one of them later and later, and the picture
 * drifts seconds behind the screen. The relay therefore keeps its own account
 * of what is in flight: every packet it sends waits for the subscriber's
 * acknowledgement, and the age of the oldest unacknowledged packet is the
 * queueing delay on the path right now. Once that exceeds the link's floor
 * round trip by more than a budget, inter frames are dropped and the
 * subscriber waits for the next key frame, which is the only point a decoder
 * can resume from after a gap. The publisher sees the same numbers through
 * `flowSnapshot` and lowers its bitrate so the drops stop.
 */

export interface MediaFlowOptions {
  /** Queueing tolerated above the floor round trip before dropping. */
  readonly queueBudgetMs: number;
  /** A key frame is held back too while the path is this far behind. */
  readonly keyframeQueueLimitMs: number;
  /** Hard ceiling on unacknowledged bytes, whatever the timing says. */
  readonly maxInFlightBytes: number;
}

export const DEFAULT_MEDIA_FLOW_OPTIONS: MediaFlowOptions = {
  queueBudgetMs: 120,
  keyframeQueueLimitMs: 800,
  maxInFlightBytes: 6 * 1024 * 1024,
};

interface InFlight {
  readonly sequence: number;
  readonly bytes: number;
  readonly sentAt: number;
}

export interface MediaFlowState {
  readonly inFlight: InFlight[];
  inFlightBytes: number;
  /** Nothing but a key frame can be decoded until one arrives. */
  waitingForKeyframe: boolean;
  /** Dropped because of congestion; ask for a key frame once it drains. */
  keyframeWanted: boolean;
  lastRttMs: number | null;
  /** Per-second minimum round trips, newest last, for a windowed floor. */
  readonly rttFloor: Array<{ second: number; rtt: number }>;
  readonly delivered: Array<{ at: number; bytes: number }>;
  droppedSinceSnapshot: number;
  droppedTotal: number;
}

export function createMediaFlow(): MediaFlowState {
  return {
    inFlight: [],
    inFlightBytes: 0,
    waitingForKeyframe: true,
    keyframeWanted: false,
    lastRttMs: null,
    rttFloor: [],
    delivered: [],
    droppedSinceSnapshot: 0,
    droppedTotal: 0,
  };
}

const RTT_FLOOR_WINDOW_SECONDS = 10;

function floorRtt(flow: MediaFlowState): number {
  let floor = Number.POSITIVE_INFINITY;
  for (const entry of flow.rttFloor) floor = Math.min(floor, entry.rtt);
  return Number.isFinite(floor) ? floor : 0;
}

/** Queueing delay on the path: how long the oldest unacknowledged packet has waited. */
export function queueDelay(flow: MediaFlowState, now: number): number {
  const oldest = flow.inFlight[0];
  return oldest ? Math.max(0, now - oldest.sentAt) : 0;
}

export function isCongested(
  flow: MediaFlowState,
  now: number,
  options: MediaFlowOptions = DEFAULT_MEDIA_FLOW_OPTIONS,
): boolean {
  return (
    queueDelay(flow, now) > floorRtt(flow) + options.queueBudgetMs ||
    flow.inFlightBytes > options.maxInFlightBytes
  );
}

/**
 * Decides whether one packet goes to this subscriber, and records it as in
 * flight when it does.
 */
export function admitPacket(
  flow: MediaFlowState,
  packet: { readonly sequence: number; readonly bytes: number; readonly key: boolean },
  now: number,
  options: MediaFlowOptions = DEFAULT_MEDIA_FLOW_OPTIONS,
): "send" | "drop" {
  const fitsHardCap = flow.inFlightBytes + packet.bytes <= options.maxInFlightBytes;
  if (packet.key) {
    if (queueDelay(flow, now) > options.keyframeQueueLimitMs || !fitsHardCap) {
      return drop(flow, true);
    }
    flow.waitingForKeyframe = false;
    flow.keyframeWanted = false;
  } else {
    if (flow.waitingForKeyframe) return drop(flow, false);
    if (!fitsHardCap || isCongested(flow, now, options)) {
      flow.waitingForKeyframe = true;
      return drop(flow, true);
    }
  }
  flow.inFlight.push({ sequence: packet.sequence, bytes: packet.bytes, sentAt: now });
  flow.inFlightBytes += packet.bytes;
  return "send";
}

function drop(flow: MediaFlowState, wantKeyframe: boolean): "drop" {
  flow.droppedSinceSnapshot += 1;
  flow.droppedTotal += 1;
  if (wantKeyframe) flow.keyframeWanted = true;
  return "drop";
}

/** Records an acknowledgement; everything up to `sequence` has arrived. */
export function acknowledge(flow: MediaFlowState, sequence: number, now: number): void {
  let newest: InFlight | undefined;
  while (flow.inFlight.length > 0 && flow.inFlight[0]!.sequence <= sequence) {
    const entry = flow.inFlight.shift()!;
    flow.inFlightBytes -= entry.bytes;
    flow.delivered.push({ at: now, bytes: entry.bytes });
    newest = entry;
  }
  if (!newest) return;
  const rtt = Math.max(0, now - newest.sentAt);
  flow.lastRttMs = rtt;
  const second = Math.floor(now / 1_000);
  const last = flow.rttFloor.at(-1);
  if (last?.second === second) last.rtt = Math.min(last.rtt, rtt);
  else flow.rttFloor.push({ second, rtt });
  while (
    flow.rttFloor.length > 0 &&
    flow.rttFloor[0]!.second <= second - RTT_FLOOR_WINDOW_SECONDS
  ) {
    flow.rttFloor.shift();
  }
}

/** Whether a key frame should be requested for this subscriber now. */
export function wantsKeyframe(
  flow: MediaFlowState,
  now: number,
  options: MediaFlowOptions = DEFAULT_MEDIA_FLOW_OPTIONS,
): boolean {
  return flow.keyframeWanted && !isCongested(flow, now, options);
}

export interface MediaFlowSnapshot {
  readonly rttMs: number;
  readonly minRttMs: number;
  readonly queueMs: number;
  readonly deliveredBitsPerSecond: number;
  readonly dropped: number;
}

/** Link measurements for the publisher; resets the drop counter. */
export function flowSnapshot(flow: MediaFlowState, now: number): MediaFlowSnapshot {
  while (flow.delivered.length > 0 && flow.delivered[0]!.at <= now - 1_000) {
    flow.delivered.shift();
  }
  const bytes = flow.delivered.reduce((sum, entry) => sum + entry.bytes, 0);
  const dropped = flow.droppedSinceSnapshot;
  flow.droppedSinceSnapshot = 0;
  return {
    rttMs: Math.round(flow.lastRttMs ?? 0),
    minRttMs: Math.round(floorRtt(flow)),
    queueMs: Math.round(queueDelay(flow, now)),
    deliveredBitsPerSecond: bytes * 8,
    dropped,
  };
}
