import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createStreamingLinearResampler, resampleLinear } from "./pcmAudio";
import { parseRealtimeEvent } from "./realtimeProtocol";
import { createVoiceSession } from "./realtimeSession";
import { shouldCommitUtterance } from "./utteranceCoalesce";

function makeTrack() {
  return {
    kind: "audio",
    enabled: true,
    muted: false,
    stop: vi.fn(),
    addEventListener: vi.fn(),
  };
}

function makeStream(track: ReturnType<typeof makeTrack>) {
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
}

function makeDataChannel() {
  const listeners = new Map<string, (event: unknown) => void>();
  return {
    channel: {
      readyState: "connecting" as RTCDataChannelState,
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      },
      send: vi.fn(),
      close: vi.fn(),
    },
    fire: (type: string, event: unknown) => listeners.get(type)?.(event),
  };
}

async function openWebRtcSession(onTranscript?: (entry: { role: string; text: string }) => void) {
  const track = makeTrack();
  const stream = makeStream(track);
  const dataChannel = makeDataChannel();

  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async () => stream),
      getSupportedConstraints: () => ({}),
    },
  });
  vi.stubGlobal(
    "Audio",
    vi.fn(function AudioMock(this: Record<string, unknown>) {
      this.autoplay = false;
      this.srcObject = null;
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(
        url.includes("api.openai.com")
          ? { ok: true, text: async () => "v=0 answer" }
          : {
              ok: true,
              json: async () => ({
                value: "ephemeral-secret",
                model: "gpt-realtime",
                voice: "marin",
              }),
            },
      ),
    ),
  );
  vi.stubGlobal(
    "RTCPeerConnection",
    vi.fn(function RTCPeerConnectionMock(this: Record<string, unknown>) {
      Object.assign(this, {
        ontrack: null,
        createDataChannel: vi.fn(() => dataChannel.channel),
        addTrack: vi.fn(),
        createOffer: vi.fn(async () => ({ type: "offer", sdp: "v=0" })),
        setLocalDescription: vi.fn(async () => undefined),
        setRemoteDescription: vi.fn(async () => undefined),
        close: vi.fn(),
      });
    }),
  );

  const session = createVoiceSession(
    {
      httpBaseUrl: "http://localhost:3773",
      bearerToken: null,
      authority: "full",
      confirmDestructiveActions: true,
      language: "en",
    },
    {
      onToolCall: async () => ({}),
      ...(onTranscript === undefined ? {} : { onTranscript }),
    },
  );
  await session.start();
  dataChannel.channel.readyState = "open";
  dataChannel.fire("open", {});
  dataChannel.fire("message", { data: JSON.stringify({ type: "session.updated" }) });
  dataChannel.channel.send.mockClear();
  return { session, dataChannel, track };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("voice audit regressions", () => {
  it("keeps a farewell session alive until the audible output buffer drains", async () => {
    const { session, dataChannel } = await openWebRtcSession();
    dataChannel.fire("message", { data: JSON.stringify({ type: "response.created" }) });
    dataChannel.fire("message", {
      data: JSON.stringify({ type: "output_audio_buffer.started" }),
    });
    session.endAfterReply();

    dataChannel.fire("message", { data: JSON.stringify({ type: "response.done" }) });
    expect(session.state).not.toBe("idle");

    dataChannel.fire("message", {
      data: JSON.stringify({ type: "output_audio_buffer.stopped" }),
    });
    expect(session.state).toBe("idle");
  });

  it("keeps a short user command spoken during silent model work", async () => {
    const transcripts: Array<{ role: string; text: string }> = [];
    const { session, dataChannel } = await openWebRtcSession((entry) => transcripts.push(entry));
    dataChannel.fire("message", { data: JSON.stringify({ type: "response.created" }) });

    dataChannel.fire("message", {
      data: JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "open settings",
      }),
    });

    expect(transcripts).toContainEqual({ role: "user", text: "open settings" });
    session.stop();
  });

  it("does not treat Grok's audio-generation completion as speaker playback completion", () => {
    expect(parseRealtimeEvent({ type: "response.output_audio.done" }, "xai")).not.toEqual({
      kind: "speaking-stopped",
    });
  });

  it("preserves the exact sample count when capture is resampled in 2048-frame chunks", () => {
    const chunks = Array.from({ length: 100 }, () => new Float32Array(2_048));
    const resampler = createStreamingLinearResampler(44_100, 24_000);
    const streamedLength = chunks.reduce(
      (total, chunk) => total + resampler.process(chunk).length,
      0,
    );
    const wholeLength = resampleLinear(new Float32Array(204_800), 44_100, 24_000).length;

    expect(streamedLength).toBe(wholeLength);
  });

  it("keeps a correction in a distinct VAD item even when its text shares a prefix", () => {
    expect(
      shouldCommitUtterance({
        pending: { text: "not that one", itemId: "item-2" },
        lastCommitted: { text: "no", itemId: "item-1", atMs: 1_000 },
        nowMs: 1_500,
      }),
    ).toBe(true);
  });
});
