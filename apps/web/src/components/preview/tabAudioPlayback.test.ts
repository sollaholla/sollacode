import type { PreviewTabAudioEvent } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createTabAudioPlayer,
  TAB_AUDIO_MAX_QUEUED_SECONDS,
  TAB_AUDIO_START_LEAD_SECONDS,
  tabAudioPacketStart,
} from "./tabAudioPlayback";

describe("tabAudioPacketStart", () => {
  it("waits a short lead before the first packet so the next ones can arrive", () => {
    expect(tabAudioPacketStart(null, 10)).toBeCloseTo(10 + TAB_AUDIO_START_LEAD_SECONDS);
  });

  it("plays packets back to back while sound keeps arriving", () => {
    expect(tabAudioPacketStart(10.3, 10.1)).toBe(10.3);
  });

  it("re-buffers after running dry instead of playing in the past", () => {
    expect(tabAudioPacketStart(9.9, 10)).toBeCloseTo(10 + TAB_AUDIO_START_LEAD_SECONDS);
  });

  it("drops what would play too late, keeping the listener live", () => {
    expect(tabAudioPacketStart(10 + TAB_AUDIO_MAX_QUEUED_SECONDS + 0.1, 10)).toBeNull();
  });
});

const packets: PreviewTabAudioEvent = {
  type: "packets",
  format: { codec: "opus", sampleRate: 48_000, numberOfChannels: 2 },
  packets: [
    { timestamp: 0, duration: 20_000, data: "AAEC" },
    { timestamp: 20_000, duration: 20_000, data: "AwQF" },
  ],
};

/** Web Audio and WebCodecs stand-ins: every packet decodes to 20 ms of sound. */
function installFakeAudio(options: { readonly decoderFails?: boolean } = {}) {
  const started: number[] = [];
  class FakeContext {
    state = "suspended";
    currentTime = 1;
    destination = {};
    resume() {
      this.state = "running";
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
    createBuffer(channels: number, frames: number, rate: number) {
      const data = Array.from({ length: channels }, () => new Float32Array(frames));
      return {
        duration: frames / rate,
        getChannelData: (channel: number) => data[channel]!,
        copyToChannel: (plane: Float32Array, channel: number) => data[channel]!.set(plane),
      };
    }
    createBufferSource() {
      return {
        buffer: null,
        connect: () => undefined,
        addEventListener: () => undefined,
        start: (at: number) => started.push(at),
        stop: () => undefined,
      };
    }
  }
  class FakeDecoder {
    state = "unconfigured";
    constructor(
      private readonly init: {
        readonly output: (data: unknown) => void;
        readonly error: (error: Error) => void;
      },
    ) {}
    configure() {
      this.state = "configured";
    }
    decode() {
      if (options.decoderFails) {
        this.init.error(new DOMException("Unsupported codec", "NotSupportedError"));
        return;
      }
      this.init.output({
        numberOfChannels: 2,
        numberOfFrames: 960,
        sampleRate: 48_000,
        format: "f32-planar",
        copyTo: () => undefined,
        close: () => undefined,
      });
    }
    close() {
      this.state = "closed";
    }
  }
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("AudioDecoder", FakeDecoder);
  vi.stubGlobal(
    "EncodedAudioChunk",
    class {
      constructor(readonly init: unknown) {}
    },
  );
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("navigator", {});
  return { started };
}

describe("createTabAudioPlayer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("counts sound that arrives before a tap, then what it decodes and plays", async () => {
    const audio = installFakeAudio();
    const player = createTabAudioPlayer({});

    player.handle(packets);
    expect(player.stats()).toMatchObject({ batches: 1, batchesWhileLocked: 1, buffersStarted: 0 });

    player.unlock();
    await Promise.resolve();
    player.handle(packets);

    expect(player.stats()).toEqual({
      batches: 2,
      batchesWhileLocked: 1,
      packetsDecoded: 2,
      framesOut: 2,
      buffersStarted: 2,
      lateDropped: 0,
      contextState: "running",
      lastError: null,
    });
    // Back to back, after the start lead.
    expect(audio.started[1]! - audio.started[0]!).toBeCloseTo(0.02);
    player.dispose();
  });

  it("keeps the decoder's reason when it refuses the sound", async () => {
    installFakeAudio({ decoderFails: true });
    const player = createTabAudioPlayer({});
    player.unlock();
    await Promise.resolve();
    player.handle(packets);

    expect(player.stats()).toMatchObject({
      buffersStarted: 0,
      lastError: "Decoder failed: NotSupportedError: Unsupported codec",
    });
    player.dispose();
  });
});
