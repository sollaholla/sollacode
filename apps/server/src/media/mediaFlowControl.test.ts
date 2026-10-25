import { describe, expect, it } from "vite-plus/test";

import {
  acknowledge,
  admitPacket,
  createMediaFlow,
  flowSnapshot,
  isCongested,
  wantsKeyframe,
} from "./mediaFlowControl.ts";

const options = { queueBudgetMs: 100, keyframeQueueLimitMs: 500, maxInFlightBytes: 1_000_000 };
const key = (sequence: number, bytes = 10_000) => ({ sequence, bytes, key: true });
const delta = (sequence: number, bytes = 1_000) => ({ sequence, bytes, key: false });

describe("media flow control", () => {
  it("holds a new subscriber until a key frame, then sends everything", () => {
    const flow = createMediaFlow();
    expect(admitPacket(flow, delta(1), 0, options)).toBe("drop");
    expect(admitPacket(flow, key(2), 0, options)).toBe("send");
    expect(admitPacket(flow, delta(3), 1, options)).toBe("send");
    expect(flow.inFlightBytes).toBe(11_000);
  });

  it("measures round trip and delivered rate from acknowledgements", () => {
    const flow = createMediaFlow();
    admitPacket(flow, key(1, 50_000), 1_000, options);
    admitPacket(flow, delta(2, 25_000), 1_010, options);
    acknowledge(flow, 1, 1_040);
    acknowledge(flow, 2, 1_052);
    expect(flow.inFlightBytes).toBe(0);
    const snapshot = flowSnapshot(flow, 1_100);
    expect(snapshot.rttMs).toBe(42);
    expect(snapshot.minRttMs).toBe(40);
    expect(snapshot.queueMs).toBe(0);
    expect(snapshot.deliveredBitsPerSecond).toBe(75_000 * 8);
  });

  it("drops inter frames once queueing exceeds the floor plus budget, and recovers at a key frame", () => {
    const flow = createMediaFlow();
    admitPacket(flow, key(1), 0, options);
    acknowledge(flow, 1, 40); // floor round trip 40 ms
    expect(admitPacket(flow, delta(2), 100, options)).toBe("send");
    // Nothing acknowledged for 150 ms: 150 > 40 + 100.
    expect(isCongested(flow, 250, options)).toBe(true);
    expect(admitPacket(flow, delta(3), 250, options)).toBe("drop");
    expect(flow.waitingForKeyframe).toBe(true);
    // Still congested: no key frame request yet, it would only queue too.
    expect(wantsKeyframe(flow, 250, options)).toBe(false);
    // The path drains, and only now is a key frame worth asking for.
    acknowledge(flow, 2, 260);
    expect(wantsKeyframe(flow, 260, options)).toBe(true);
    expect(admitPacket(flow, delta(4), 270, options)).toBe("drop");
    expect(admitPacket(flow, key(5), 280, options)).toBe("send");
    expect(wantsKeyframe(flow, 280, options)).toBe(false);
    expect(admitPacket(flow, delta(6), 290, options)).toBe("send");
    expect(flowSnapshot(flow, 300).dropped).toBe(2);
    expect(flowSnapshot(flow, 300).dropped).toBe(0);
  });

  it("holds a key frame back while the path is badly behind", () => {
    const flow = createMediaFlow();
    admitPacket(flow, key(1), 0, options);
    admitPacket(flow, delta(2), 10, options);
    expect(admitPacket(flow, key(3), 600, options)).toBe("drop");
    acknowledge(flow, 2, 610);
    expect(admitPacket(flow, key(4), 620, options)).toBe("send");
  });

  it("enforces the byte ceiling regardless of timing", () => {
    const flow = createMediaFlow();
    expect(admitPacket(flow, key(1, 900_000), 0, options)).toBe("send");
    expect(admitPacket(flow, delta(2, 200_000), 1, options)).toBe("drop");
    expect(admitPacket(flow, key(3, 200_000), 2, options)).toBe("drop");
  });

  it("forgets round-trip samples older than its window", () => {
    const flow = createMediaFlow();
    admitPacket(flow, key(1), 0, options);
    acknowledge(flow, 1, 20);
    admitPacket(flow, delta(2), 20_000, options);
    acknowledge(flow, 2, 20_080);
    expect(flowSnapshot(flow, 20_100).minRttMs).toBe(80);
  });
});
