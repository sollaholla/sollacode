import {
  MEDIA_CHANNEL_CLOSE_REPLACED,
  MEDIA_CHANNEL_CLOSE_TOPIC_ENDED,
  type MediaPublisherNotice,
  type MediaSubscriberNotice,
} from "@t3tools/contracts";
import { encodeMediaAck, encodeMediaPacket } from "@t3tools/shared/mediaPacket";
import { describe, expect, it } from "vite-plus/test";

import { createMediaRelayCore, type MediaRelayConnection } from "./mediaRelayCore.ts";

interface FakeConnection extends MediaRelayConnection {
  readonly packets: number[];
  readonly notices: Array<MediaPublisherNotice | MediaSubscriberNotice>;
  closed: { code: number; reason: string } | null;
}

function fakeConnection(id: string): FakeConnection {
  const connection: FakeConnection = {
    id,
    packets: [],
    notices: [],
    closed: null,
    send: (data) => {
      if (typeof data === "string") {
        connection.notices.push(JSON.parse(data));
      } else {
        connection.packets.push(new DataView(data.buffer, data.byteOffset).getUint32(8));
      }
    },
    close: (code, reason) => {
      connection.closed = { code, reason };
    },
  };
  return connection;
}

const packet = (sequence: number, key: boolean, bytes = 100) =>
  encodeMediaPacket({
    key,
    epoch: 1,
    sequence,
    capturedAt: 0,
    timestamp: sequence,
    payload: new Uint8Array(bytes),
  });

const view = { width: 390, height: 748, devicePixelRatio: 3, zoom: 1 };
const hello = JSON.stringify({ type: "hello", codecs: ["avc1.640033"], view });

function setup() {
  let now = 0;
  const core = createMediaRelayCore({
    now: () => now,
    flow: { queueBudgetMs: 100, keyframeQueueLimitMs: 500, maxInFlightBytes: 1_000_000 },
    keyframeRequestIntervalMs: 250,
    statsIntervalMs: 250,
  });
  return {
    core,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const ofType = <T extends { type: string }>(notices: ReadonlyArray<T>, type: string) =>
  notices.filter((notice) => notice.type === type);

describe("media relay core", () => {
  it("announces subscribers to the publisher and asks for a key frame on join", () => {
    const { core } = setup();
    const publisher = fakeConnection("pub");
    core.connectPublisher("topic", publisher);
    const viewer = fakeConnection("viewer");
    const endpoint = core.connectSubscriber("topic", viewer);
    expect(viewer.notices).toEqual([{ type: "publisher", online: true }]);
    endpoint.onMessage(hello);
    expect(ofType(publisher.notices, "subscribers").at(-1)).toEqual({
      type: "subscribers",
      subscribers: [{ id: "viewer", codecs: ["avc1.640033"], view }],
    });
    expect(ofType(publisher.notices, "keyframe")).toHaveLength(1);
  });

  it("fans packets out from the first key frame, and only to subscribers that said hello", () => {
    const { core } = setup();
    const publisher = fakeConnection("pub");
    const pub = core.connectPublisher("topic", publisher);
    const ready = fakeConnection("ready");
    core.connectSubscriber("topic", ready).onMessage(hello);
    const silent = fakeConnection("silent");
    core.connectSubscriber("topic", silent);
    pub.onMessage(packet(1, false));
    pub.onMessage(packet(2, true));
    pub.onMessage(packet(3, false));
    expect(ready.packets).toEqual([2, 3]);
    expect(silent.packets).toEqual([]);
  });

  it("drops a slow subscriber to the next key frame without holding back a fast one", () => {
    const { core, advance } = setup();
    const publisher = fakeConnection("pub");
    const pub = core.connectPublisher("topic", publisher);
    const fast = fakeConnection("fast");
    const fastEndpoint = core.connectSubscriber("topic", fast);
    fastEndpoint.onMessage(hello);
    const slow = fakeConnection("slow");
    const slowEndpoint = core.connectSubscriber("topic", slow);
    slowEndpoint.onMessage(hello);
    publisher.notices.length = 0;

    pub.onMessage(packet(1, true));
    for (let sequence = 2; sequence <= 8; sequence += 1) {
      advance(33);
      pub.onMessage(packet(sequence, false));
      fastEndpoint.onMessage(encodeMediaAck(sequence));
    }
    // 7 x 33 ms without an acknowledgement from the slow viewer: congested.
    expect(fast.packets).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(slow.packets.length).toBeLessThan(8);
    const droppedStats = ofType(publisher.notices, "stats").filter(
      (notice) => notice.type === "stats" && notice.stats.subscriber === "slow",
    );
    expect(droppedStats.some((notice) => notice.type === "stats" && notice.stats.dropped > 0)).toBe(
      true,
    );
    // No key frame request while the slow path is still congested.
    expect(ofType(publisher.notices, "keyframe")).toHaveLength(0);
    // The slow viewer catches up; now a key frame is worth sending - but the
    // join request 241 ms ago still holds the rate limit, and the screen
    // sends nothing more that could retry it. The relay's tick does.
    advance(10);
    slowEndpoint.onMessage(encodeMediaAck(8));
    expect(ofType(publisher.notices, "keyframe")).toHaveLength(0);
    advance(20);
    core.tick();
    expect(ofType(publisher.notices, "keyframe")).toHaveLength(1);
    core.tick();
    expect(ofType(publisher.notices, "keyframe")).toHaveLength(1);
    advance(5);
    pub.onMessage(packet(9, false));
    pub.onMessage(packet(10, true));
    expect(slow.packets.slice(-1)).toEqual([10]);
  });

  it("retains broadcasts for late subscribers and relays unsupported notices", () => {
    const { core } = setup();
    const publisher = fakeConnection("pub");
    const pub = core.connectPublisher("topic", publisher);
    pub.onMessage(JSON.stringify({ type: "broadcast", key: "displays", body: { n: 1 } }));
    pub.onMessage(JSON.stringify({ type: "broadcast", key: "displays", body: { n: 2 } }));
    const viewer = fakeConnection("viewer");
    core.connectSubscriber("topic", viewer).onMessage(hello);
    expect(ofType(viewer.notices, "broadcast")).toEqual([
      { type: "broadcast", key: "displays", body: { n: 2 } },
    ]);
    pub.onMessage(
      JSON.stringify({ type: "unsupported", subscriber: "viewer", reason: "No common codec." }),
    );
    expect(ofType(viewer.notices, "unsupported")).toEqual([
      { type: "unsupported", reason: "No common codec." },
    ]);
  });

  it("tells subscribers when the publisher comes and goes, and replaces a second publisher", () => {
    const { core } = setup();
    const viewer = fakeConnection("viewer");
    core.connectSubscriber("topic", viewer).onMessage(hello);
    expect(viewer.notices.at(-1)).toEqual({ type: "publisher", online: false });
    const first = fakeConnection("first");
    core.connectPublisher("topic", first);
    expect(viewer.notices.at(-1)).toEqual({ type: "publisher", online: true });
    const second = fakeConnection("second");
    const secondEndpoint = core.connectPublisher("topic", second);
    expect(first.closed?.code).toBe(MEDIA_CHANNEL_CLOSE_REPLACED);
    secondEndpoint.disconnect();
    expect(viewer.notices.at(-1)).toEqual({ type: "publisher", online: false });
  });

  it("updates the publisher when a viewer resizes or leaves", () => {
    const { core } = setup();
    const publisher = fakeConnection("pub");
    core.connectPublisher("topic", publisher);
    const viewer = fakeConnection("viewer");
    const endpoint = core.connectSubscriber("topic", viewer);
    endpoint.onMessage(hello);
    endpoint.onMessage(JSON.stringify({ type: "view", view: { ...view, zoom: 2 } }));
    const latest = ofType(publisher.notices, "subscribers").at(-1);
    expect(latest?.type === "subscribers" && latest.subscribers[0]?.view.zoom).toBe(2);
    endpoint.disconnect();
    expect(ofType(publisher.notices, "subscribers").at(-1)).toEqual({
      type: "subscribers",
      subscribers: [],
    });
    expect(core.stats().topics).toBe(1);
  });

  it("closes every connection when the topic ends, and frees it", () => {
    const { core } = setup();
    const publisher = fakeConnection("pub");
    core.connectPublisher("topic", publisher);
    const viewer = fakeConnection("viewer");
    core.connectSubscriber("topic", viewer);
    core.closeTopic("topic", "Session over.");
    expect(publisher.closed).toEqual({
      code: MEDIA_CHANNEL_CLOSE_TOPIC_ENDED,
      reason: "Session over.",
    });
    expect(viewer.closed?.code).toBe(MEDIA_CHANNEL_CLOSE_TOPIC_ENDED);
    expect(core.stats().topics).toBe(0);
  });

  it("closes a publisher that sends something that is not a media packet", () => {
    const { core } = setup();
    const publisher = fakeConnection("pub");
    const pub = core.connectPublisher("topic", publisher);
    pub.onMessage(new Uint8Array([1, 2, 3]));
    expect(publisher.closed).not.toBeNull();
  });
});
