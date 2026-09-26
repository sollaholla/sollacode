// @effect-diagnostics preferSchemaOverJson:off
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createVoiceSession, type VoiceSessionCallbacks } from "./realtimeSession";
import { createLiveTranscriptContext, liveAppendChunks, parseLiveTranscript } from "./liveProtocol";
import { mergeLiveVoiceUsage } from "./liveUsageStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(callbacks: Partial<VoiceSessionCallbacks> = {}) {
  const listeners = new Map<string, (event: { data: string }) => void>();
  const track = { enabled: true, stop: vi.fn(), addEventListener: vi.fn() };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const channel = {
    readyState: "open",
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: (name: string, fn: (event: { data: string }) => void) =>
      listeners.set(name, fn),
  };
  const negotiated = deferred<void>();
  const peer = {
    iceGatheringState: "complete",
    localDescription: { sdp: "offer" },
    connectionState: "connected",
    close: vi.fn(),
    addTrack: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    createDataChannel: () => channel,
    createOffer: async () => ({ type: "offer", sdp: "offer" }),
    setLocalDescription: async () => undefined,
    setRemoteDescription: async () => {
      negotiated.resolve();
    },
  };
  const getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal(
    "AudioContext",
    class {
      resume = async () => undefined;
      close = async () => undefined;
      createAnalyser = () => ({
        fftSize: 256,
        getByteTimeDomainData: (array: Uint8Array) => array.fill(128),
      });
      createMediaStreamSource = () => ({ connect: vi.fn() });
    },
  );
  vi.stubGlobal(
    "Audio",
    class {
      autoplay = false;
      pause = vi.fn();
      play = async () => undefined;
      srcObject = null;
    },
  );
  vi.stubGlobal("RTCPeerConnection", function () {
    return peer;
  });
  const workRequest = deferred<Record<string, unknown>>();
  const workController = deferred<ReadableStreamDefaultController<Uint8Array>>();
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/delegation")) {
      workRequest.resolve(JSON.parse(String(init.body)));
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => workController.resolve(controller),
        }),
      );
    }
    if (url.endsWith("/release")) return new Response(null, { status: 204 });
    return Response.json({
      sessionId: "session-opaque",
      sdp: "answer",
      model: "gpt-live-1",
      voice: "marin",
      agentName: "Personal Assistant",
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const session = createVoiceSession(
    {
      httpBaseUrl: "https://environment.example",
      bearerToken: "fixture-token",
      model: "gpt-live-1",
      authority: "full",
      confirmDestructiveActions: true,
      language: "en",
    },
    { onToolCall: async () => undefined, ...callbacks },
  );
  const event = (value: object) => listeners.get("message")?.({ data: JSON.stringify(value) });
  return {
    session,
    event,
    channel,
    peer,
    track,
    getUserMedia,
    stream,
    fetchMock,
    workRequest,
    workController,
    ready: async () => {
      const starting = session.start();
      await negotiated.promise;
      event({ type: "session.started" });
      await starting;
    },
    negotiating: negotiated.promise,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("GPT-Live transport", () => {
  it("waits for session.started, sends native Live commands and keeps transport for final usage", async () => {
    const usage = vi.fn();
    const f = fixture({ onLiveUsage: usage });
    const starting = f.session.start();
    await f.negotiating;
    expect(f.track.enabled).toBe(false);
    expect(f.session.announce("Hello")).toBe(false);
    f.event({ type: "session.started" });
    await starting;
    expect(f.track.enabled).toBe(true);
    expect(f.session.announce("Hello")).toBe(true);
    f.event({ type: "session.usage.updated", usage: { seconds: 12 } });
    f.event({ type: "session.usage.updated", usage: { seconds: 9 } });
    f.session.stop();
    expect(f.track.enabled).toBe(false);
    expect(f.peer.close).not.toHaveBeenCalled();
    f.event({ type: "session.closed", usage: { seconds: 14 }, reason: "client_requested" });
    expect(f.peer.close).toHaveBeenCalledOnce();
    expect(f.track.stop).toHaveBeenCalled();
    expect(usage).toHaveBeenLastCalledWith({
      sessionId: "session-opaque",
      seconds: 14,
      finalized: true,
    });
    expect(f.channel.send.mock.calls.map(([raw]) => JSON.parse(raw).type)).toEqual([
      "session.commentary.append",
      "session.close",
    ]);
  });

  it("releases a late microphone grant after Stop without starting transport", async () => {
    const f = fixture();
    const grant = deferred<typeof f.stream>();
    const requested = deferred<void>();
    f.getUserMedia.mockImplementation(() => {
      requested.resolve();
      return grant.promise;
    });
    const starting = f.session.start();
    await requested.promise;
    f.session.stop();
    grant.resolve(f.stream);
    await starting;
    expect(f.track.stop).toHaveBeenCalled();
    expect(f.fetchMock).not.toHaveBeenCalled();
    expect(f.session.state).toBe("idle");
  });

  it("delegates only on metadata, keeps opaque IDs and deduplicates repeated delegation events", async () => {
    const working = vi.fn();
    const f = fixture({ onWorkingChange: working });
    await f.ready();
    f.event({
      type: "session.input_transcript.delta",
      event_id: "transcript",
      delta: "Check my appointments",
      start_ms: 0,
      end_ms: 800,
    });
    await vi.advanceTimersByTimeAsync(900);
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
    const task = {
      type: "session.delegation.created",
      offset_ms: 800,
      delegation: { type: "delegation", target: "client", id: "opaque_ID:untouched" },
    };
    f.event(task);
    f.event(task);
    await vi.advanceTimersByTimeAsync(350);
    expect(await f.workRequest.promise).toMatchObject({
      sessionId: "session-opaque",
      delegationId: "opaque_ID:untouched",
      sequence: 1,
    });
    expect(working).toHaveBeenCalledWith(true);
    const controller = await f.workController.promise;
    controller.enqueue(
      new TextEncoder().encode(
        JSON.stringify({
          delegationId: "durable-work",
          status: "completed",
          text: "You have two appointments.",
        }) + "\n",
      ),
    );
    controller.close();
    await vi.advanceTimersByTimeAsync(0);
    const sent = f.channel.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "session.commentary.append",
        delegation_id: "opaque_ID:untouched",
        content: "You have two appointments.",
      }),
    );
    expect(working).toHaveBeenLastCalledWith(false);
    f.session.stop();
    f.event({ type: "session.closed", usage: { seconds: 2 } });
  });

  it("does not speak late task results after Stop and never fabricates a final usage receipt", async () => {
    const usage = vi.fn();
    const f = fixture({ onLiveUsage: usage });
    await f.ready();
    f.event({
      type: "session.input_transcript.delta",
      delta: "Check my appointments",
      start_ms: 0,
      end_ms: 800,
    });
    f.event({ type: "session.delegation.created", delegation: { target: "client", id: "one" } });
    await vi.advanceTimersByTimeAsync(350);
    const controller = await f.workController.promise;
    f.session.stop();
    controller.enqueue(
      new TextEncoder().encode(
        JSON.stringify({ delegationId: "work", status: "completed", text: "Late result" }) + "\n",
      ),
    );
    controller.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.channel.send.mock.calls.map(([raw]) => JSON.parse(raw).type)).toEqual([
      "session.close",
    ]);
    expect(usage).toHaveBeenLastCalledWith(expect.objectContaining({ finalized: false }));
    expect(f.peer.close).toHaveBeenCalledOnce();
  });
});

describe("Live transcript and usage protocol", () => {
  it("bounds appends in UTF-8 without splitting characters and rejects malformed transcript timing", () => {
    const chunks = liveAppendChunks("🌊".repeat(260));
    expect(chunks.join("")).toBe("🌊".repeat(260));
    expect(chunks.every((chunk) => new TextEncoder().encode(chunk).length <= 480)).toBe(true);
    expect(
      parseLiveTranscript({
        type: "session.input_transcript.delta",
        delta: "hello",
        start_ms: 3,
        end_ms: 2,
      }),
    ).toBeNull();
    const context = createLiveTranscriptContext();
    context.append({ role: "assistant", text: "reply", startMs: 20, endMs: 40 });
    expect(context.hasUserSpeech()).toBe(false);
    context.append({ role: "user", text: "question", startMs: 1, endMs: 10 });
    expect(context.context()).toBe("user [1-10ms]: question\nassistant [20-40ms]: reply");
  });
  it("merges cumulative receipts instead of adding them twice", () => {
    const now = new Date("2026-09-10T00:00:00Z");
    const first = mergeLiveVoiceUsage([], { sessionId: "one", seconds: 10, finalized: false }, now);
    const second = mergeLiveVoiceUsage(
      first,
      { sessionId: "one", seconds: 15, finalized: true },
      now,
    );
    const replay = mergeLiveVoiceUsage(
      second,
      { sessionId: "one", seconds: 12, finalized: false },
      now,
    );
    expect(replay).toEqual([
      { sessionId: "one", seconds: 15, finalized: true, date: now.toISOString() },
    ]);
  });
});
