import { vi } from "vite-plus/test";

import { createVoiceSession, type VoiceSessionOptions } from "../realtimeSession";
import {
  createHarnessAudioContext,
  createHarnessSocket,
  type CaptureProcessor,
  type HarnessSocket,
  type VoiceHarnessAudio,
} from "./voiceHarness";
import type { VoiceTimelineSample } from "./voiceInvariants";

/**
 * Runs a real voice session against the harness and records what it did.
 *
 * The session under test is the real one — no seam, no test double of its own
 * logic. Only the three things it does not own are simulated: the provider's
 * frames, the platform's audio, and time. Everything the invariants check is
 * then read back from outside, the way a user would experience it.
 */

const TOKEN_RESPONSE = {
  ok: true,
  json: async () => ({
    value: "harness-secret",
    model: "grok-voice-latest",
    voice: "eve",
    provider: "xai",
    transport: "websocket",
  }),
};

const BASE_OPTIONS: VoiceSessionOptions = {
  httpBaseUrl: "http://localhost:3773",
  bearerToken: null,
  authority: "full",
  confirmDestructiveActions: true,
  language: "en",
};

export interface VoiceScenario {
  readonly socket: HarnessSocket;
  readonly audio: VoiceHarnessAudio;
  readonly capture: CaptureProcessor;
  readonly session: { readonly state: string; stop: () => void; hush: () => void };
  readonly timeline: ReadonlyArray<VoiceTimelineSample>;
  /** Delivers a provider frame, then samples the timeline. */
  deliver: (frame: Record<string, unknown>) => Promise<void>;
  /**
   * Advances wall clock and audio clock together, sampling as it goes.
   *
   * They move together because that is what a working device does. A scenario
   * that wants them to diverge — the phone locking mid-reply — calls
   * `freezeAudioClock` first, which is exactly the condition being modelled.
   */
  advance: (ms: number) => Promise<void>;
  freezeAudioClock: () => void;
  thawAudioClock: () => void;
  sample: () => void;
}

/** Opens a configured Grok session with the harness installed. */
export async function openVoiceScenario(
  overrides: Partial<VoiceSessionOptions> = {},
): Promise<VoiceScenario> {
  const audioHarness = createHarnessAudioContext();
  const socketHarness = createHarnessSocket();
  const track = {
    kind: "audio",
    enabled: true,
    muted: false,
    stop: vi.fn(),
    addEventListener: () => undefined,
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;

  vi.stubGlobal("AudioContext", audioHarness.constructor);
  vi.stubGlobal("WebSocket", socketHarness.constructor);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => stream } });
  vi.stubGlobal(
    "Audio",
    vi.fn(function AudioMock(this: Record<string, unknown>) {
      this.autoplay = false;
      this.srcObject = null;
    }),
  );
  vi.stubGlobal("MediaStream", function MediaStreamMock() {
    return stream;
  });
  vi.stubGlobal("RTCPeerConnection", function PeerMock(this: Record<string, unknown>) {
    this.createDataChannel = () => ({
      readyState: "connecting",
      addEventListener: () => undefined,
      send: () => undefined,
      close: () => undefined,
    });
    this.addTrack = () => undefined;
    this.createOffer = async () => ({ type: "offer", sdp: "v=0" });
    this.setLocalDescription = async () => undefined;
    this.setRemoteDescription = async () => undefined;
    this.close = () => undefined;
  });
  vi.stubGlobal("fetch", async () => TOKEN_RESPONSE);

  const session = createVoiceSession(
    { ...BASE_OPTIONS, ...overrides },
    {
      onToolCall: async () => ({}),
    },
  );
  await session.start();

  const socket = socketHarness.sockets[0];
  if (socket === undefined) throw new Error("the session opened no socket");
  socket.deliver({ type: "session.updated" });

  const capture = audioHarness.captureProcessors[0];
  if (capture === undefined) throw new Error("the session started no capture");

  let atMs = 0;
  let responseActive = false;
  const timeline: VoiceTimelineSample[] = [];

  /**
   * Whether capture is reaching the provider, measured rather than assumed.
   *
   * Pushing one buffer through the capture node and looking for the upload
   * frame is the only way to tell an open microphone from a shut one: the
   * session mutes the Grok transport by dropping frames internally, so the
   * track's `enabled` flag says nothing.
   */
  const measureUploading = () => {
    const before = socket.sent.length;
    capture.speak();
    const uploaded = socket.sent
      .slice(before)
      .some((frame) => frame.type === "input_audio_buffer.append");
    return uploaded;
  };

  const sample = () => {
    timeline.push({
      atMs,
      state: session.state,
      audioPending: audioHarness.audio.pending,
      responseActive,
      uploadingCapture: measureUploading(),
    });
  };

  const noteFrame = (frame: Record<string, unknown>) => {
    if (frame.type === "response.created") responseActive = true;
    if (frame.type === "response.done") responseActive = false;
  };

  sample();

  return {
    socket,
    audio: audioHarness.audio,
    capture,
    session,
    timeline,
    deliver: async (frame) => {
      noteFrame(frame);
      socket.deliver(frame);
      await Promise.resolve();
      sample();
    },
    advance: async (ms: number) => {
      // In steps, so a deadline landing mid-window is observed where it fires
      // rather than only at the end of a long jump.
      const step = 100;
      for (let elapsed = 0; elapsed < ms; elapsed += step) {
        const slice = Math.min(step, ms - elapsed);
        atMs += slice;
        audioHarness.audio.advance(slice);
        await vi.advanceTimersByTimeAsync(slice);
        sample();
      }
    },
    freezeAudioClock: () => audioHarness.audio.suspendClock(),
    thawAudioClock: () => audioHarness.audio.resumeClock(),
    sample,
  };
}
