import {
  PreviewTabId,
  ThreadId,
  type PreviewTabAudioEvent,
  type PreviewTabAudioTarget,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  TAB_AUDIO_SILENCE_GRACE_MS,
  createTabAudioStreamer,
  type TabAudioPacketsEvent,
} from "./tabAudioStreamer";

const tab: PreviewTabAudioTarget = {
  threadId: ThreadId.make("thread-1"),
  tabId: PreviewTabId.make("tab-1"),
};
const runtimeTabId = "runtime:tab-1";

const packets: TabAudioPacketsEvent = {
  type: "packets",
  format: { codec: "opus", sampleRate: 48_000, numberOfChannels: 2 },
  packets: [{ timestamp: 0, duration: 20_000, data: "AAEC" }],
};

function harness(options: { readonly captureAvailable?: boolean } = {}) {
  const audible = new Map<string, boolean>();
  const published: PreviewTabAudioEvent[] = [];
  const captures: Array<{
    readonly stop: ReturnType<typeof vi.fn>;
    readonly emit: (event: TabAudioPacketsEvent) => void;
    readonly end: (reason: string) => void;
  }> = [];
  let resolveCapture: (() => void) | null = null;
  const streamer = createTabAudioStreamer({
    runtimeTabId: () => runtimeTabId,
    isAudible: (id) => audible.get(id) ?? false,
    startCapture: (_id, onPackets, onEnded) =>
      new Promise((resolve) => {
        resolveCapture = () => {
          if (options.captureAvailable === false) {
            resolve(null);
            return;
          }
          const capture = { stop: vi.fn(), emit: onPackets, end: onEnded };
          captures.push(capture);
          resolve(capture);
        };
      }),
    publish: (_target, event) => published.push(event),
  });
  return {
    streamer,
    published,
    captures,
    setAudible: (value: boolean) => {
      audible.set(runtimeTabId, value);
      streamer.audibleChanged(runtimeTabId);
    },
    /** Lets the pending getUserMedia settle. */
    settleCapture: async () => {
      resolveCapture?.();
      resolveCapture = null;
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("createTabAudioStreamer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("captures nothing for a quiet tab, however many listen", () => {
    const h = harness();
    h.streamer.setDemand([tab]);
    expect(h.published).toEqual([]);
    expect(h.captures).toHaveLength(0);
  });

  it("captures nothing for a playing tab nobody listens to", async () => {
    const h = harness();
    h.setAudible(true);
    await h.settleCapture();
    expect(h.published).toEqual([]);
    expect(h.captures).toHaveLength(0);
  });

  it("streams while listened to and making sound", async () => {
    const h = harness();
    h.streamer.setDemand([tab]);
    h.setAudible(true);
    await h.settleCapture();
    h.captures[0]!.emit(packets);

    expect(h.published).toEqual([{ type: "audible", audible: true }, packets]);
  });

  it("rides out a short silence, then stops and says so", async () => {
    const h = harness();
    h.streamer.setDemand([tab]);
    h.setAudible(true);
    await h.settleCapture();

    // A gap between two sounds keeps the same capture.
    h.setAudible(false);
    vi.advanceTimersByTime(TAB_AUDIO_SILENCE_GRACE_MS - 1);
    h.setAudible(true);
    vi.advanceTimersByTime(TAB_AUDIO_SILENCE_GRACE_MS);
    expect(h.captures[0]!.stop).not.toHaveBeenCalled();

    h.setAudible(false);
    vi.advanceTimersByTime(TAB_AUDIO_SILENCE_GRACE_MS);
    expect(h.captures[0]!.stop).toHaveBeenCalledTimes(1);
    expect(h.published.at(-1)).toEqual({ type: "audible", audible: false });
    expect(h.captures).toHaveLength(1);
  });

  it("stops at once when the last listener leaves", async () => {
    const h = harness();
    h.streamer.setDemand([tab]);
    h.setAudible(true);
    await h.settleCapture();

    h.streamer.setDemand([]);
    expect(h.captures[0]!.stop).toHaveBeenCalledTimes(1);
    // Nobody is left to tell, and nothing more goes out.
    h.captures[0]!.emit(packets);
    expect(h.published).toEqual([{ type: "audible", audible: true }]);
  });

  it("drops a capture that arrives after its listener left", async () => {
    const h = harness();
    h.streamer.setDemand([tab]);
    h.setAudible(true);
    h.streamer.setDemand([]);
    await h.settleCapture();

    expect(h.captures[0]!.stop).toHaveBeenCalledTimes(1);
  });

  it("tells listeners the sound is gone when this window cannot capture the tab", async () => {
    const h = harness({ captureAvailable: false });
    h.streamer.setDemand([tab]);
    h.setAudible(true);
    await h.settleCapture();

    expect(h.published).toEqual([
      { type: "audible", audible: true },
      { type: "audible", audible: false, reason: "This window cannot capture the tab." },
    ]);
  });

  it("reports why the desktop could not start capturing", async () => {
    const h = harness();
    const failing = createTabAudioStreamer({
      runtimeTabId: () => runtimeTabId,
      isAudible: () => true,
      startCapture: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")),
      publish: (_target, event) => h.published.push(event),
    });
    failing.setDemand([tab]);
    await Promise.resolve();
    await Promise.resolve();

    expect(h.published).toEqual([
      { type: "audible", audible: true },
      { type: "audible", audible: false, reason: "NotAllowedError: Permission denied" },
    ]);
  });

  it("starts over when a capture ends on its own", async () => {
    const h = harness();
    h.streamer.setDemand([tab]);
    h.setAudible(true);
    await h.settleCapture();
    h.captures[0]!.end("Encoding failed: EncodingError: bad input");

    expect(h.published.at(-1)).toEqual({
      type: "audible",
      audible: false,
      reason: "Encoding failed: EncodingError: bad input",
    });
    // The next change in sound tries again.
    h.setAudible(false);
    h.setAudible(true);
    await h.settleCapture();
    expect(h.captures).toHaveLength(2);
  });
});
