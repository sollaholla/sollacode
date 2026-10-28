// @effect-diagnostics preferSchemaOverJson:off
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createVoiceSession,
  type VoiceSessionCallbacks,
  type VoiceSessionOptions,
} from "./realtimeSession";
import {
  createLiveTranscriptContext,
  liveAppendChunks,
  parseLiveTranscript,
  trimLiveHistory,
} from "./liveProtocol";
import { mergeLiveVoiceUsage } from "./liveUsageStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(
  callbacks: Partial<VoiceSessionCallbacks> = {},
  options: Partial<VoiceSessionOptions> = {},
) {
  const listeners = new Map<string, (event: { data: string }) => void>();
  /** A capture of one microphone; its "ended" handlers can be fired by the test. */
  const capture = (deviceId: string) => {
    const ended: Array<() => void> = [];
    const track = {
      enabled: true,
      stop: vi.fn(),
      getSettings: () => ({ deviceId }),
      addEventListener: vi.fn((name: string, fn: () => void) => {
        if (name === "ended") ended.push(fn);
      }),
      end: () => ended.forEach((fn) => fn()),
    };
    return { track, stream: { getTracks: () => [track], getAudioTracks: () => [track] } };
  };
  const { track, stream } = capture("mic-a");
  const captures: Array<ReturnType<typeof capture>> = [];
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
    addTrack: vi.fn(() => sender),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    createDataChannel: () => channel,
    createOffer: async () => ({ type: "offer", sdp: "offer" }),
    setLocalDescription: async () => undefined,
    setRemoteDescription: vi.fn(async (_description: RTCSessionDescriptionInit) => {
      negotiated.resolve();
    }),
  };
  const sender = { replaceTrack: vi.fn(async (_track: unknown) => undefined) };
  // The first capture is `stream`; later ones (microphone switches) are new.
  const getUserMedia = vi.fn(async (constraints?: MediaStreamConstraints) => {
    if (captures.length === 0) {
      captures.push({ track, stream });
      return stream;
    }
    const audio = constraints?.audio as MediaTrackConstraints | undefined;
    const exact = (audio?.deviceId as ConstrainDOMStringParameters | undefined)?.exact;
    const next = capture(typeof exact === "string" ? exact : "mic-default");
    captures.push(next);
    return next.stream;
  });
  const devices: Array<Pick<MediaDeviceInfo, "deviceId" | "groupId" | "kind" | "label">> = [
    { deviceId: "default", groupId: "g-a", kind: "audioinput", label: "Default - Mic A" },
    { deviceId: "mic-a", groupId: "g-a", kind: "audioinput", label: "Mic A" },
  ];
  const deviceListeners = new Set<() => void>();
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia,
      enumerateDevices: vi.fn(async () => devices),
      addEventListener: (name: string, fn: () => void) => {
        if (name === "devicechange") deviceListeners.add(fn);
      },
      removeEventListener: (name: string, fn: () => void) => {
        if (name === "devicechange") deviceListeners.delete(fn);
      },
    },
  });
  vi.stubGlobal(
    "AudioContext",
    class {
      resume = async () => undefined;
      close = async () => undefined;
      createAnalyser = () => ({
        fftSize: 256,
        getByteTimeDomainData: (array: Uint8Array) => array.fill(128),
      });
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
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
      ...options,
    },
    { onToolCall: async () => undefined, ...callbacks },
  );
  const event = (value: object) => listeners.get("message")?.({ data: JSON.stringify(value) });
  return {
    session,
    event,
    channel,
    peer,
    sender,
    captures,
    devices,
    /** The system's microphones changed. */
    deviceChange: () => deviceListeners.forEach((fn) => fn()),
    listensForDevices: () => deviceListeners.size > 0,
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

describe("GPT-Live routes and mute", () => {
  it("opens the chosen microphone, and the default when that one is gone", async () => {
    const chosen = fixture({}, { microphoneId: "mic-b" });
    await chosen.ready();
    expect(chosen.getUserMedia.mock.calls[0]?.[0]).toMatchObject({
      audio: { deviceId: { exact: "mic-b" } },
    });

    const gone = fixture({}, { microphoneId: "mic-b" });
    gone.getUserMedia.mockImplementationOnce(async () => {
      throw Object.assign(new Error("gone"), { name: "OverconstrainedError" });
    });
    await gone.ready();
    expect(gone.getUserMedia).toHaveBeenCalledTimes(2);
    expect(gone.getUserMedia.mock.calls[1]?.[0]?.audio).not.toHaveProperty("deviceId");
  });

  it("switches microphones mid-session without dropping it", async () => {
    const f = fixture();
    await f.ready();
    f.session.setMicrophone?.("mic-b");
    await vi.waitFor(() => expect(f.sender.replaceTrack).toHaveBeenCalledOnce());
    const next = f.captures[1]!;
    expect(f.sender.replaceTrack).toHaveBeenCalledWith(next.track);
    expect(next.track.enabled).toBe(true);
    expect(f.track.stop).toHaveBeenCalled();
    expect(f.session.state).not.toBe("idle");
  });

  it("keeps a muted session muted on the new microphone", async () => {
    const f = fixture();
    await f.ready();
    f.session.setMuted?.(true);
    f.session.setMicrophone?.("mic-b");
    await vi.waitFor(() => expect(f.sender.replaceTrack).toHaveBeenCalledOnce());
    expect(f.captures[1]!.track.enabled).toBe(false);
  });

  it("follows the system default when it changes, and only then", async () => {
    const f = fixture();
    await f.ready();
    expect(f.listensForDevices()).toBe(true);
    // A device came and went, but the default is still Mic A.
    f.devices.push({ deviceId: "mic-c", groupId: "g-c", kind: "audioinput", label: "Mic C" });
    f.deviceChange();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sender.replaceTrack).not.toHaveBeenCalled();
    // AirPods connect and become the default.
    f.devices[0] = {
      deviceId: "default",
      groupId: "g-c",
      kind: "audioinput",
      label: "Default - Mic C",
    };
    f.deviceChange();
    await vi.waitFor(() => expect(f.sender.replaceTrack).toHaveBeenCalledOnce());
    f.session.stop();
    f.event({ type: "session.closed", usage: { seconds: 1 } });
    expect(f.listensForDevices()).toBe(false);
  });

  it("moves to another microphone when the one in use is unplugged", async () => {
    const onError = vi.fn();
    const f = fixture({ onError });
    await f.ready();
    f.track.end();
    await vi.waitFor(() => expect(f.sender.replaceTrack).toHaveBeenCalledOnce());
    expect(onError).not.toHaveBeenCalled();
    expect(f.session.state).not.toBe("idle");
  });

  it("ends the session when no microphone is left", async () => {
    const onError = vi.fn();
    const f = fixture({ onError });
    await f.ready();
    f.getUserMedia.mockImplementation(async () => {
      throw Object.assign(new Error("none"), { name: "NotFoundError" });
    });
    f.track.end();
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        "The microphone disconnected. Reconnect it and start voice again.",
      ),
    );
  });

  it("applies the answer with the final line break its trimmed result dropped", async () => {
    const f = fixture();
    await f.ready();
    expect(f.peer.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "answer\r\n" });
  });

  it("keeps the orchestrator's routes and body when no alternate routes are given", async () => {
    const f = fixture({}, { recentHistory: [{ role: "user", text: "earlier" }] });
    await f.ready();
    const [url, init] = f.fetchMock.mock.calls[0]!;
    expect(url).toBe("https://environment.example/api/orchestrator/live/session");
    expect(JSON.parse(String(init.body))).toEqual({
      sdp: "offer",
      history: [{ role: "user", text: "earlier" }],
    });
    f.session.stop();
    f.event({ type: "session.closed", usage: { seconds: 1 } });
    expect(f.fetchMock.mock.calls.at(-1)?.[0]).toBe(
      "https://environment.example/api/orchestrator/live/session/release",
    );
  });

  it("sends cookies only when no bearer token authenticates the requests", async () => {
    const withToken = fixture();
    await withToken.ready();
    withToken.session.stop();
    withToken.event({ type: "session.closed", usage: { seconds: 1 } });
    for (const [, init] of withToken.fetchMock.mock.calls) {
      expect(init.credentials).toBe("omit");
      expect(init.headers).toMatchObject({ authorization: "Bearer fixture-token" });
    }

    const sameOrigin = fixture({}, { bearerToken: null });
    await sameOrigin.ready();
    const [, init] = sameOrigin.fetchMock.mock.calls[0]!;
    expect(init.credentials).toBe("include");
    expect(init.headers).not.toHaveProperty("authorization");
  });

  it("sends agent calls to their own routes with the awaited start body", async () => {
    const placed = deferred<{ callId: string }>();
    const startBody = vi.fn(async () => {
      const call = await placed.promise;
      return { callId: call.callId, history: [{ role: "assistant", text: "Last reply" }] };
    });
    const f = fixture(
      {},
      {
        live: {
          sessionPath: "/api/agents/call/session",
          releasePath: "/api/agents/call/session/release",
          delegationPath: "/api/agents/call/delegation",
          startBody,
        },
      },
    );
    const starting = f.session.start();
    // Asked for at once, so placing the call overlaps opening the microphone.
    await vi.advanceTimersByTimeAsync(0);
    expect(startBody).toHaveBeenCalledOnce();
    expect(f.fetchMock).not.toHaveBeenCalled();
    placed.resolve({ callId: "call-1" });
    await f.negotiating;
    f.event({ type: "session.started" });
    await starting;
    const [url, init] = f.fetchMock.mock.calls[0]!;
    expect(url).toBe("https://environment.example/api/agents/call/session");
    // The bearer authenticates; cookies would fail the host's wildcard CORS.
    expect(init.credentials).toBe("omit");
    expect(init.headers).toMatchObject({ authorization: "Bearer fixture-token" });
    expect(JSON.parse(String(init.body))).toEqual({
      sdp: "offer",
      history: [{ role: "assistant", text: "Last reply" }],
      callId: "call-1",
    });
    f.event({
      type: "session.input_transcript.delta",
      delta: "Ship it",
      start_ms: 0,
      end_ms: 500,
    });
    f.event({ type: "session.delegation.created", delegation: { target: "client", id: "d1" } });
    await vi.advanceTimersByTimeAsync(350);
    await f.workRequest.promise;
    expect(f.fetchMock.mock.calls.at(-1)?.[0]).toBe(
      "https://environment.example/api/agents/call/delegation",
    );
    f.session.stop();
    f.event({ type: "session.closed", usage: { seconds: 3 } });
    expect(f.fetchMock.mock.calls.at(-1)?.[0]).toBe(
      "https://environment.example/api/agents/call/session/release",
    );
  });

  it("fails the start, without creating a session, when the start body rejects", async () => {
    const errors = vi.fn();
    const f = fixture(
      { onError: errors },
      {
        live: {
          sessionPath: "/session",
          releasePath: "/release",
          delegationPath: "/delegation",
          startBody: async () => {
            throw new Error("The call could not be placed.");
          },
        },
      },
    );
    await f.session.start();
    expect(errors).toHaveBeenCalledWith("The call could not be placed.");
    expect(f.fetchMock).not.toHaveBeenCalled();
    expect(f.session.state).toBe("error");
    expect(f.track.stop).toHaveBeenCalled();
  });

  it("holds any caller's history to the start request's limits", async () => {
    const history = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      text: index === 29 ? "x".repeat(5_000) : `line ${index}`,
    }));
    const f = fixture(
      {},
      {
        live: {
          sessionPath: "/api/agents/call/session",
          releasePath: "/api/agents/call/session/release",
          delegationPath: "/api/agents/call/delegation",
          startBody: () => ({ callId: "call-1", history }),
        },
      },
    );
    await f.ready();
    const body = JSON.parse(String(f.fetchMock.mock.calls[0]![1].body)) as {
      callId: string;
      history: Array<{ role: string; text: string }>;
    };
    expect(body.callId).toBe("call-1");
    expect(body.history).toHaveLength(24);
    expect(body.history[0]).toEqual({ role: "user", text: "line 6" });
    expect(body.history.at(-1)?.text).toBe("x".repeat(4_000));
    expect(body.history.every((entry) => entry.text.length <= 4_000)).toBe(true);
  });

  it("mutes the microphone and tells GPT-Live, including a mute chosen before startup", async () => {
    const f = fixture();
    const starting = f.session.start();
    f.session.setMuted?.(true);
    await f.negotiating;
    f.event({ type: "session.started" });
    await starting;
    expect(f.track.enabled).toBe(false);
    f.session.setMuted?.(false);
    expect(f.track.enabled).toBe(true);
    f.session.setMuted?.(false);
    expect(f.channel.send.mock.calls.map(([raw]) => JSON.parse(raw).type)).toEqual([
      "session.input_audio.mute",
      "session.input_audio.unmute",
    ]);
  });
});

describe("GPT-Live session liveness", () => {
  const callRoutes = {
    sessionPath: "/api/agents/call/session",
    releasePath: "/api/agents/call/session/release",
    delegationPath: "/api/agents/call/delegation",
    heartbeat: { path: "/api/agents/call/session/heartbeat", everySeconds: 15 },
  };
  /** Answers heartbeats with `status`; everything else as the fixture does. */
  function answerHeartbeats(f: ReturnType<typeof fixture>, status: () => number) {
    const original = f.fetchMock.getMockImplementation()!;
    f.fetchMock.mockImplementation(async (url: string, init: RequestInit) =>
      url.endsWith("/heartbeat") ? new Response(null, { status: status() }) : original(url, init),
    );
  }
  const urls = (f: ReturnType<typeof fixture>) => f.fetchMock.mock.calls.map(([url]) => url);

  it("renews a leased session, and ends it when the host no longer holds it", async () => {
    const gone = vi.fn();
    const lostConnection = vi.fn();
    const f = fixture(
      { onSessionGone: gone, onConnectionLost: lostConnection },
      { live: callRoutes },
    );
    let heartbeatStatus = 204;
    answerHeartbeats(f, () => heartbeatStatus);
    await f.ready();
    await vi.advanceTimersByTimeAsync(15_000);
    const beat = f.fetchMock.mock.calls.find(([url]) => url.endsWith("/heartbeat"))!;
    expect(beat[0]).toBe("https://environment.example/api/agents/call/session/heartbeat");
    expect(JSON.parse(String(beat[1].body))).toEqual({ sessionId: "session-opaque" });
    expect(gone).not.toHaveBeenCalled();

    heartbeatStatus = 409;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(gone).toHaveBeenCalledOnce();
    expect(lostConnection).not.toHaveBeenCalled();
    expect(f.peer.close).toHaveBeenCalledOnce();
    expect(f.track.stop).toHaveBeenCalled();
    expect(f.session.state).toBe("idle");
    // The host has nothing left to free, and the beats stop.
    expect(urls(f).some((url) => url.endsWith("/release"))).toBe(false);
    const beats = urls(f).filter((url) => url.endsWith("/heartbeat")).length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(urls(f).filter((url) => url.endsWith("/heartbeat"))).toHaveLength(beats);
  });

  it("ends a leased session whose delegation the host refuses with 409", async () => {
    const gone = vi.fn();
    const errors = vi.fn();
    const f = fixture({ onSessionGone: gone, onError: errors }, { live: callRoutes });
    const original = f.fetchMock.getMockImplementation()!;
    f.fetchMock.mockImplementation(async (url: string, init: RequestInit) =>
      url.endsWith("/delegation")
        ? new Response("This call has ended.", { status: 409 })
        : original(url, init),
    );
    await f.ready();
    f.event({
      type: "session.input_transcript.delta",
      delta: "Run the tests",
      start_ms: 0,
      end_ms: 500,
    });
    f.event({ type: "session.delegation.created", delegation: { target: "client", id: "d1" } });
    await vi.advanceTimersByTimeAsync(350);
    expect(gone).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
    expect(f.peer.close).toHaveBeenCalledOnce();
  });

  it("reports a leased session's refused start (the call was taken elsewhere) apart from errors", async () => {
    const refused = vi.fn();
    const errors = vi.fn();
    const f = fixture({ onStartRefused: refused, onError: errors }, { live: callRoutes });
    const original = f.fetchMock.getMockImplementation()!;
    f.fetchMock.mockImplementation(async (url: string, init: RequestInit) =>
      url.endsWith("/api/agents/call/session")
        ? new Response("Answered on Mac", { status: 409 })
        : original(url, init),
    );
    await f.session.start();
    expect(refused).toHaveBeenCalledWith("Answered on Mac");
    expect(errors).not.toHaveBeenCalled();
    expect(f.session.state).toBe("idle");
    expect(f.track.stop).toHaveBeenCalled();
    expect(urls(f).some((url) => url.endsWith("/release"))).toBe(false);
  });

  it("fails the orchestrator's refused start as an error", async () => {
    const refused = vi.fn();
    const errors = vi.fn();
    const f = fixture({ onStartRefused: refused, onError: errors });
    f.fetchMock.mockImplementation(async () => new Response("Voice is off.", { status: 409 }));
    await f.session.start();
    expect(refused).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith("Voice is off.");
    expect(f.session.state).toBe("error");
  });

  it("keeps the orchestrator's behaviour: no heartbeat, and a refused delegation is spoken as an error", async () => {
    const gone = vi.fn();
    const errors = vi.fn();
    const f = fixture({ onSessionGone: gone, onError: errors });
    const original = f.fetchMock.getMockImplementation()!;
    f.fetchMock.mockImplementation(async (url: string, init: RequestInit) =>
      url.endsWith("/delegation")
        ? new Response("The orchestrator is disabled.", { status: 409 })
        : original(url, init),
    );
    await f.ready();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(urls(f).some((url) => url.endsWith("/heartbeat"))).toBe(false);
    f.event({
      type: "session.input_transcript.delta",
      delta: "Check my mail",
      start_ms: 0,
      end_ms: 500,
    });
    f.event({ type: "session.delegation.created", delegation: { target: "client", id: "d1" } });
    await vi.advanceTimersByTimeAsync(350);
    expect(errors).toHaveBeenCalledWith("The orchestrator is disabled.");
    expect(gone).not.toHaveBeenCalled();
    expect(f.peer.close).not.toHaveBeenCalled();
  });

  it.each([
    ["the orchestrator", {}],
    ["an agent call", { live: callRoutes }],
  ])(
    "releases %s's host session when the page goes away, once",
    async (_name, options: Partial<VoiceSessionOptions>) => {
      const page = new EventTarget();
      vi.stubGlobal("window", page);
      const f = fixture({}, options);
      answerHeartbeats(f, () => 204);
      await f.ready();
      page.dispatchEvent(new Event("pagehide"));
      const releases = f.fetchMock.mock.calls.filter(([url]) => url.endsWith("/release"));
      expect(releases).toHaveLength(1);
      expect(releases[0]![1]).toMatchObject({ keepalive: true, method: "POST" });
      expect(JSON.parse(String(releases[0]![1].body))).toEqual({ sessionId: "session-opaque" });
      // Tearing down afterwards (or another pagehide) does not release twice.
      f.session.stop();
      f.event({ type: "session.closed", usage: { seconds: 1 } });
      page.dispatchEvent(new Event("pagehide"));
      expect(urls(f).filter((url) => url.endsWith("/release"))).toHaveLength(1);
    },
  );

  it("stops listening for the page going away once the session ends", async () => {
    const page = new EventTarget();
    const remove = vi.spyOn(page, "removeEventListener");
    vi.stubGlobal("window", page);
    const f = fixture();
    await f.ready();
    f.session.stop();
    f.event({ type: "session.closed", usage: { seconds: 1 } });
    expect(remove).toHaveBeenCalledWith("pagehide", expect.any(Function));
  });
});

describe("delegations that find nothing new", () => {
  const callRoutes = {
    sessionPath: "/api/agents/call/session",
    releasePath: "/api/agents/call/session/release",
    delegationPath: "/api/agents/call/delegation",
    heartbeat: { path: "/api/agents/call/session/heartbeat", everySeconds: 15 },
  };
  /** The host's quiet answer: the chat got no new words from this delegation. */
  const quiet = { delegationId: "work", status: "completed", text: "" };
  /** Answers each delegation with the next scripted work events; returns the request bodies. */
  function scriptDelegations(f: ReturnType<typeof fixture>, answers: Array<Array<object>>) {
    const bodies: Array<Record<string, unknown>> = [];
    const original = f.fetchMock.getMockImplementation()!;
    f.fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (!url.endsWith("/delegation")) return original(url, init);
      bodies.push(JSON.parse(String(init.body)));
      const events = answers.shift() ?? [];
      return new Response(events.map((event) => JSON.stringify(event) + "\n").join(""));
    });
    return bodies;
  }
  const sent = (f: ReturnType<typeof fixture>) =>
    f.channel.send.mock.calls.map(([raw]) => JSON.parse(raw) as Record<string, unknown>);
  const said = (text: string, delegationId: string) =>
    expect.objectContaining({
      type: "session.commentary.append",
      delegation_id: delegationId,
      content: text,
    });

  it("asks again with the same id and sequence once the person's trailing words settle", async () => {
    const working = vi.fn();
    const f = fixture({ onWorkingChange: working }, { live: callRoutes });
    const bodies = scriptDelegations(f, [
      [quiet],
      [{ delegationId: "work", status: "completed", text: "Running the tests now." }],
    ]);
    await f.ready();
    f.event({ type: "session.input_transcript.delta", delta: "Thanks.", start_ms: 0, end_ms: 400 });
    f.event({ type: "session.delegation.created", delegation: { target: "client", id: "d1" } });
    await vi.advanceTimersByTimeAsync(350);
    expect(bodies).toHaveLength(1);
    expect(working).toHaveBeenLastCalledWith(false);
    // The words GPT-Live delegated for arrive after the delegation did.
    f.event({
      type: "session.input_transcript.delta",
      delta: " Now run the tests too.",
      start_ms: 500,
      end_ms: 1_400,
    });
    await vi.advanceTimersByTimeAsync(799);
    expect(bodies).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({
      sessionId: "session-opaque",
      delegationId: "d1",
      sequence: 1,
    });
    expect(String(bodies[1]!.context)).toContain("Now run the tests too.");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent(f)).toContainEqual(said("Running the tests now.", "d1"));
  });

  it("closes the delegation with a quiet note when asking again still finds nothing", async () => {
    const f = fixture({}, { live: callRoutes });
    const bodies = scriptDelegations(f, [[quiet], [quiet]]);
    await f.ready();
    f.event({ type: "session.input_transcript.delta", delta: "Thanks.", start_ms: 0, end_ms: 400 });
    // The caption has settled before the delegation: nothing more is coming.
    await vi.advanceTimersByTimeAsync(900);
    f.event({ type: "session.delegation.created", delegation: { target: "client", id: "d1" } });
    await vi.advanceTimersByTimeAsync(350);
    expect(bodies).toHaveLength(1);
    // Asked again once the wait for trailing words runs out.
    await vi.advanceTimersByTimeAsync(1_499);
    expect(bodies).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ delegationId: "d1", sequence: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent(f)).toContainEqual({
      type: "session.thinking.append",
      event_id: expect.any(String),
      delegation_id: "d1",
      content: "Nothing new reached my chat for that.",
    });
    expect(sent(f).some((event) => event.type === "session.commentary.append")).toBe(false);
    // Once only.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bodies).toHaveLength(2);
  });

  it("waits for the person's first words when the delegation arrives before them", async () => {
    const f = fixture({}, { live: callRoutes });
    const bodies = scriptDelegations(f, [
      [{ delegationId: "work", status: "completed", text: "Running the tests now." }],
    ]);
    await f.ready();
    f.event({ type: "session.delegation.created", delegation: { target: "client", id: "d1" } });
    await vi.advanceTimersByTimeAsync(350);
    expect(bodies).toHaveLength(0);
    f.event({
      type: "session.input_transcript.delta",
      delta: "Run the tests.",
      start_ms: 0,
      end_ms: 900,
    });
    // Sent once the caption settles, not asked to be repeated.
    await vi.advanceTimersByTimeAsync(799);
    expect(bodies).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(bodies).toEqual([expect.objectContaining({ delegationId: "d1", sequence: 1 })]);
    expect(String(bodies[0]!.context)).toContain("Run the tests.");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent(f)).toContainEqual(said("Running the tests now.", "d1"));
    expect(sent(f)).not.toContainEqual(
      expect.objectContaining({ content: expect.stringContaining("Ask the user to repeat") }),
    );
  });

  it("asks the person to repeat once when their words never arrive", async () => {
    const f = fixture({}, { live: callRoutes });
    const bodies = scriptDelegations(f, []);
    await f.ready();
    f.event({ type: "session.delegation.created", delegation: { target: "client", id: "d1" } });
    await vi.advanceTimersByTimeAsync(350 + 1_499);
    expect(sent(f)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const repeat = said(
      "The transcript is not available yet. Ask the user to repeat the request before starting work.",
      "d1",
    );
    expect(sent(f)).toEqual([repeat]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent(f)).toEqual([repeat]);
    expect(bodies).toHaveLength(0);
  });

  it("does not ask again for a delegation a newer one replaced", async () => {
    const f = fixture({}, { live: callRoutes });
    const bodies = scriptDelegations(f, [
      [quiet],
      [{ delegationId: "work", status: "completed", text: "Done." }],
    ]);
    await f.ready();
    f.event({ type: "session.input_transcript.delta", delta: "Thanks.", start_ms: 0, end_ms: 400 });
    await vi.advanceTimersByTimeAsync(900);
    f.event({ type: "session.delegation.created", delegation: { target: "client", id: "d1" } });
    await vi.advanceTimersByTimeAsync(350);
    f.event({ type: "session.delegation.created", delegation: { target: "client", id: "d2" } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(bodies.map((body) => body.delegationId)).toEqual(["d1", "d2"]);
    expect(sent(f)).toContainEqual(said("Done.", "d2"));
  });
});

describe("Live transcript and usage protocol", () => {
  it("keeps the newest opening history within the host's byte budget", () => {
    // Three-byte characters: 2,500 of them is 7,500 bytes, over the budget.
    const wide = "語".repeat(2_500);
    expect(
      trimLiveHistory([
        { role: "user", text: "first" },
        { role: "assistant", text: wide },
        { role: "user", text: "latest" },
      ]),
    ).toEqual([
      { role: "user", text: "first" },
      { role: "user", text: "latest" },
    ]);
  });
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
