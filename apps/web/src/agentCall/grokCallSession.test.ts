// @effect-diagnostics preferSchemaOverJson:off
import {
  AGENT_CALL_DELEGATION_PATH,
  AGENT_CALL_GROK_SESSION_PATH,
  AGENT_CALL_SESSION_HEARTBEAT_PATH,
  AGENT_CALL_SESSION_RELEASE_PATH,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { VoiceSessionCallbacks, VoiceSessionOptions } from "../orchestrator/realtimeSession";
import { createFakeAudioGraph } from "../orchestrator/testing/fakeAudioGraph";

const mocks = vi.hoisted(() => {
  const inner = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    announce: vi.fn((_text: string) => true),
    endAfterReply: vi.fn(),
    hush: vi.fn(),
    setMuted: vi.fn(),
    instruct: vi.fn(),
    state: "listening" as string,
  };
  return {
    inner,
    created: [] as Array<{ options: VoiceSessionOptions; callbacks: VoiceSessionCallbacks }>,
  };
});

vi.mock("../orchestrator/realtimeSession", () => ({
  createVoiceSession: (options: VoiceSessionOptions, callbacks: VoiceSessionCallbacks) => {
    mocks.created.push({ options, callbacks });
    return mocks.inner;
  },
}));

import { createGrokCallSession, GROK_CALL_TOOLS, grokCallReply } from "./grokCallSession";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fixture(options: { readonly startStatus?: number; readonly phoneLine?: boolean } = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const work = deferred<ReadableStreamDefaultController<Uint8Array>>();
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: JSON.parse(String(init.body)) });
    if (path === AGENT_CALL_GROK_SESSION_PATH) {
      if (options.startStatus)
        return new Response("Answered on iPhone", { status: options.startStatus });
      return Response.json({
        sessionId: "grok-call-1",
        clientSecret: "xai-secret",
        model: "grok-voice-latest",
        voice: "eve",
        agentName: "Gregg",
        instructions: "You are Gregg.",
      });
    }
    if (path === AGENT_CALL_DELEGATION_PATH)
      return new Response(
        new ReadableStream<Uint8Array>({ start: (controller) => work.resolve(controller) }),
      );
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal("fetch", fetchMock);
  const callbacks = {
    onToolCall: async () => undefined,
    onWorkingChange: vi.fn(),
    onStartRefused: vi.fn(),
    onTranscript: vi.fn(),
    onError: vi.fn(),
  } satisfies VoiceSessionCallbacks;
  const session = createGrokCallSession(
    {
      httpBaseUrl: "https://host.example",
      bearerToken: "token",
      authority: "read-only",
      confirmDestructiveActions: true,
      language: "en",
      phoneLine: options.phoneLine ?? false,
      cuePolicy: () => ({ enabled: true, volume: 1 }),
      live: {
        sessionPath: AGENT_CALL_GROK_SESSION_PATH,
        releasePath: AGENT_CALL_SESSION_RELEASE_PATH,
        delegationPath: AGENT_CALL_DELEGATION_PATH,
        startBody: async () => ({ callId: "call-1", history: [] }),
        heartbeat: { path: AGENT_CALL_SESSION_HEARTBEAT_PATH, everySeconds: 15 },
      },
    },
    callbacks,
  );
  const created = mocks.created.at(-1)!;
  const start = () => created.options.realtimeCall!.start();
  const send = (event: object) =>
    work.promise.then((controller) =>
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`)),
    );
  return { session, created, callbacks, calls, start, send, work };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.created.length = 0;
  vi.clearAllMocks();
  mocks.inner.state = "listening";
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Grok call session", () => {
  it("claims the call on the host's Grok route and opens with its secret, instructions and one tool", async () => {
    const f = fixture();
    expect(f.created.options.model).toBeUndefined();
    expect(f.created.options.live).toBeUndefined();
    // No orchestrator state tones on a phone call.
    expect(f.created.options.cuePolicy?.()).toEqual({ enabled: false, volume: 0 });
    const opened = await f.start();
    expect(f.calls[0]).toEqual({
      path: AGENT_CALL_GROK_SESSION_PATH,
      body: { callId: "call-1", history: [] },
    });
    expect(opened).toEqual({
      value: "xai-secret",
      model: "grok-voice-latest",
      voice: "eve",
      instructions: "You are Gregg.",
      tools: GROK_CALL_TOOLS,
    });
    expect(GROK_CALL_TOOLS.map((tool) => tool.name)).toEqual(["start_work"]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.calls.at(-1)).toEqual({
      path: AGENT_CALL_SESSION_HEARTBEAT_PATH,
      body: { sessionId: "grok-call-1" },
    });
  });

  it("hands what was said to the chat and speaks its reply when it lands", async () => {
    const f = fixture();
    await f.start();
    f.created.callbacks.onTranscript?.({ role: "user", text: "Is the deploy green?" });
    expect(f.callbacks.onTranscript).toHaveBeenCalledWith({
      role: "user",
      text: "Is the deploy green?",
    });
    const output = await f.created.callbacks.onToolCall({ name: "start_work", args: {} });
    expect(output).toEqual({ status: "You're working on it now." });
    await vi.advanceTimersByTimeAsync(0);
    const delegation = f.calls.find((call) => call.path === AGENT_CALL_DELEGATION_PATH)!;
    expect(delegation.body).toMatchObject({
      sessionId: "grok-call-1",
      delegationId: "grok-call-1:1",
      sequence: 1,
    });
    expect(String(delegation.body.context)).toMatch(
      /user \[\d+-\d+ms\]: {2}Is the deploy green\?/u,
    );
    expect(f.callbacks.onWorkingChange).toHaveBeenLastCalledWith(true);

    await f.send({ delegationId: "work", status: "running", text: "Checking the dashboard." });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.inner.announce).not.toHaveBeenCalled();
    await f.send({ delegationId: "work", status: "completed", text: "It's green." });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.inner.announce).toHaveBeenCalledWith(grokCallReply("It's green."));
    expect(f.callbacks.onWorkingChange).toHaveBeenLastCalledWith(false);
  });

  it("hangs up once both sides have said goodbye", async () => {
    const f = fixture();
    await f.start();
    f.created.callbacks.onTranscript?.({ role: "user", text: "Thanks, bye!" });
    expect(mocks.inner.endAfterReply).not.toHaveBeenCalled();
    f.created.callbacks.onTranscript?.({ role: "assistant", text: "Bye, talk soon!" });
    expect(mocks.inner.endAfterReply).toHaveBeenCalledOnce();
  });

  it("treats the host refusing the claim as a refusal, not a fault", async () => {
    const f = fixture({ startStatus: 409 });
    await expect(f.start()).rejects.toThrow("Answered on iPhone");
    expect(f.callbacks.onStartRefused).toHaveBeenCalledWith("Answered on iPhone");
  });

  it("frees the host's session when it stops, once", async () => {
    const f = fixture();
    await f.start();
    f.session.stop();
    f.session.stop();
    const releases = f.calls.filter((call) => call.path === AGENT_CALL_SESSION_RELEASE_PATH);
    expect(releases).toEqual([
      { path: AGENT_CALL_SESSION_RELEASE_PATH, body: { sessionId: "grok-call-1" } },
    ]);
    expect(mocks.inner.stop).toHaveBeenCalled();
  });

  it("frees the host's session when the voice ends itself", async () => {
    const f = fixture();
    await f.start();
    f.created.callbacks.onStateChange?.("idle");
    expect(f.calls.some((call) => call.path === AGENT_CALL_SESSION_RELEASE_PATH)).toBe(true);
  });

  it("plays the voice down the phone line when the line is on", () => {
    expect(fixture().created.options.realtimeCall?.playbackDestination).toBeUndefined();
    const f = fixture({ phoneLine: true });
    const graph = createFakeAudioGraph();
    const destination = f.created.options.realtimeCall!.playbackDestination!(graph.context);
    expect(destination).toBe(graph.ofKind("biquad")[0]);
    // One line per session, however many times the playback asks.
    f.created.options.realtimeCall!.playbackDestination!(graph.context);
    expect(graph.ofKind("compressor")).toHaveLength(1);
  });
});
