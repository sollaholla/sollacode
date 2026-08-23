import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { DISCONNECTED_GRACE_MS } from "./reconnect";
import { CONTINUATION_GRACE_MS } from "./endOfSpeech";

import {
  ASSISTANT_AUDIO_GRACE_MS,
  createVoiceSession,
  isAssistantAudible,
  PLAYBACK_DRAIN_GRACE_MS,
  type VoiceSessionOptions,
  type VoiceSessionState,
} from "./realtimeSession";
import { GROK_UTTERANCE_SETTLE_MS } from "./utteranceCoalesce";

/**
 * Lifecycle tests for the voice session.
 *
 * `start()` awaits a token fetch, a microphone grant, and SDP negotiation. A
 * stop landing inside any of those windows used to be outrun by the
 * continuation, which went on to open a microphone and a peer connection that
 * nothing held a handle to — a hot mic with no off switch. These tests pin
 * that down, and the in-band error handling that used to kill live sessions.
 *
 * The suite runs in the node environment, so every browser global the session
 * touches is stubbed here.
 */

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Lets a pending microtask chain drain before the test asserts. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeTrack() {
  // `enabled` is real: the session mutes the track until the server confirms
  // the session configuration, so the mock has to carry the flag. So is
  // `muted` and its events — the platform sets those, not the page, and the
  // session watches them to notice a phone locking the microphone away.
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  return {
    stop: vi.fn(),
    kind: "audio",
    enabled: true,
    muted: false,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    },
    fire: (type: string) => {
      for (const listener of listeners.get(type) ?? []) listener({});
    },
  };
}

function makeStream(tracks: ReadonlyArray<ReturnType<typeof makeTrack>>) {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
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

function sentDataChannelTypes(dataChannel: ReturnType<typeof makeDataChannel>): string[] {
  return dataChannel.channel.send.mock.calls.map(
    (call) => JSON.parse(call[0] as string).type as string,
  );
}

function installPeerConnection(dataChannel: ReturnType<typeof makeDataChannel>) {
  const instances: Array<{ close: ReturnType<typeof vi.fn> }> = [];
  const constructor = vi.fn(function RTCPeerConnectionMock(this: Record<string, unknown>) {
    const instance = {
      ontrack: null,
      createDataChannel: vi.fn(() => dataChannel.channel),
      addTrack: vi.fn(),
      createOffer: vi.fn(async () => ({ type: "offer", sdp: "v=0" })),
      setLocalDescription: vi.fn(async () => undefined),
      setRemoteDescription: vi.fn(async () => undefined),
      close: vi.fn(),
    };
    Object.assign(this, instance);
    // The constructed object, not the template: the session assigns its own
    // handlers (ontrack, onconnectionstatechange) onto `this`, and a test that
    // wants to fire one has to reach the same object.
    instances.push(this as unknown as { close: ReturnType<typeof vi.fn> });
  });
  vi.stubGlobal("RTCPeerConnection", constructor);
  return { constructor, instances };
}

function installBrowserGlobals(input: {
  readonly tokenResponse: Promise<unknown>;
  readonly userMedia: Promise<MediaStream>;
}) {
  const getUserMedia = vi.fn(() => input.userMedia);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal(
    "Audio",
    vi.fn(function AudioMock(this: Record<string, unknown>) {
      this.autoplay = false;
      this.srcObject = null;
    }),
  );
  const fetchMock = vi.fn((url: string) =>
    url.includes("api.openai.com")
      ? Promise.resolve({ ok: true, text: async () => "v=0 answer" })
      : input.tokenResponse,
  );
  vi.stubGlobal("fetch", fetchMock);
  return { getUserMedia, fetchMock };
}

const TOKEN_RESPONSE = {
  ok: true,
  json: async () => ({ value: "ephemeral-secret", model: "gpt-realtime", voice: "marin" }),
};

const OPTIONS = {
  httpBaseUrl: "http://localhost:3773",
  bearerToken: null,
  authority: "full" as const,
  confirmDestructiveActions: true,
  language: "en",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("voice session cancellation", () => {
  it("acquires no microphone when stopped during the token fetch", async () => {
    const token = deferred<unknown>();
    const { getUserMedia } = installBrowserGlobals({
      tokenResponse: token.promise,
      userMedia: Promise.resolve(makeStream([makeTrack()])),
    });
    const peer = installPeerConnection(makeDataChannel());

    const states: VoiceSessionState[] = [];
    const session = createVoiceSession(OPTIONS, {
      onStateChange: (state) => states.push(state),
      onToolCall: async () => ({}),
    });

    const started = session.start();
    await flush();
    session.stop();
    token.resolve(TOKEN_RESPONSE);
    await started;

    // The continuation must not resume into building a live session.
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(peer.constructor).not.toHaveBeenCalled();
    expect(session.state).toBe("idle");
    // No error is reported: this was a deliberate stop, not a failure.
    expect(states).not.toContain("error");
  });

  it("releases a microphone granted after the session was stopped", async () => {
    const track = makeTrack();
    const media = deferred<MediaStream>();
    installBrowserGlobals({
      tokenResponse: Promise.resolve(TOKEN_RESPONSE),
      userMedia: media.promise,
    });
    const peer = installPeerConnection(makeDataChannel());

    const session = createVoiceSession(OPTIONS, { onToolCall: async () => ({}) });

    const started = session.start();
    await flush();
    session.stop();
    // The permission prompt resolves after the user already turned voice off.
    media.resolve(makeStream([track]));
    await started;

    expect(track.stop).toHaveBeenCalled();
    expect(peer.instances[0]?.close).toHaveBeenCalled();
    expect(session.state).toBe("idle");
  });

  it("runs a full start to a listening session when never stopped", async () => {
    const track = makeTrack();
    installBrowserGlobals({
      tokenResponse: Promise.resolve(TOKEN_RESPONSE),
      userMedia: Promise.resolve(makeStream([track])),
    });
    const dataChannel = makeDataChannel();
    installPeerConnection(dataChannel);

    const session = createVoiceSession(OPTIONS, { onToolCall: async () => ({}) });
    await session.start();

    dataChannel.channel.readyState = "open";
    dataChannel.fire("open", {});

    // Media is already flowing at this point — the track had to be in the SDP
    // offer — but the session is still on API defaults, with no language pin
    // and no instructions. A word spoken here came back in whatever language
    // the transcriber guessed, so the microphone is muted and the session is
    // not yet "listening".
    expect(track.enabled).toBe(false);
    expect(session.state).toBe("connecting");
    // The session config goes out on the wire exactly once, on channel open.
    expect(dataChannel.channel.send).toHaveBeenCalledTimes(1);

    dataChannel.fire("message", { data: JSON.stringify({ type: "session.updated" }) });
    expect(track.enabled).toBe(true);
    expect(session.state).toBe("listening");

    session.stop();
    expect(track.stop).toHaveBeenCalled();
    expect(session.state).toBe("idle");
  });
});

describe("session configuration gate", () => {
  it("opens the microphone anyway if the server never acknowledges the config", async () => {
    // The gate exists to stop a word being answered under API defaults. It must
    // not be able to strand the microphone shut if the ack never arrives.
    vi.useFakeTimers();
    try {
      const track = makeTrack();
      installBrowserGlobals({
        tokenResponse: Promise.resolve(TOKEN_RESPONSE),
        userMedia: Promise.resolve(makeStream([track])),
      });
      const dataChannel = makeDataChannel();
      installPeerConnection(dataChannel);

      const session = createVoiceSession(OPTIONS, { onToolCall: async () => ({}) });
      await vi.advanceTimersByTimeAsync(0);
      await session.start();

      dataChannel.channel.readyState = "open";
      dataChannel.fire("open", {});
      expect(track.enabled).toBe(false);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(track.enabled).toBe(true);
      expect(session.state).toBe("listening");

      session.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reopen the gate when the server acks twice", async () => {
    const track = makeTrack();
    installBrowserGlobals({
      tokenResponse: Promise.resolve(TOKEN_RESPONSE),
      userMedia: Promise.resolve(makeStream([track])),
    });
    const dataChannel = makeDataChannel();
    installPeerConnection(dataChannel);

    const states: VoiceSessionState[] = [];
    const session = createVoiceSession(OPTIONS, {
      onStateChange: (state) => states.push(state),
      onToolCall: async () => ({}),
    });
    await session.start();
    dataChannel.channel.readyState = "open";
    dataChannel.fire("open", {});

    const ack = { data: JSON.stringify({ type: "session.updated" }) };
    dataChannel.fire("message", ack);
    dataChannel.fire("message", ack);

    expect(states.filter((state) => state === "listening")).toHaveLength(1);
    session.stop();
  });
});

/** Boots a session to the point where the data channel is open. */
async function openSession(
  overrides: Partial<VoiceSessionOptions> = {},
  /** Lets a test hold a tool call open, which is its own state to be in. */
  onToolCall: (call: {
    name: string;
    args: Record<string, unknown>;
  }) => Promise<unknown> = async () => ({
    threads: [],
  }),
) {
  installBrowserGlobals({
    tokenResponse: Promise.resolve(TOKEN_RESPONSE),
    userMedia: Promise.resolve(makeStream([makeTrack()])),
  });
  const dataChannel = makeDataChannel();
  installPeerConnection(dataChannel);
  const transcripts: Array<{ role: string; text: string }> = [];
  const session = createVoiceSession(
    { ...OPTIONS, ...overrides },
    {
      onTranscript: (entry) => transcripts.push(entry),
      onToolCall,
    },
  );
  await session.start();
  dataChannel.channel.readyState = "open";
  dataChannel.fire("open", {});
  // The microphone stays muted until the server acknowledges the config.
  dataChannel.fire("message", { data: JSON.stringify({ type: "session.updated" }) });
  dataChannel.channel.send.mockClear();
  return { session, dataChannel, transcripts };
}

describe("ending by voice", () => {
  it("lets the goodbye finish before closing the microphone", async () => {
    const { session, dataChannel } = await openSession();
    const track = () => session.state;

    // A reply is in flight — the model is saying goodbye right now.
    dataChannel.fire("message", { data: JSON.stringify({ type: "response.created" }) });
    session.endAfterReply();

    // Still open: closing here would cut the farewell in half and read as a crash.
    expect(track()).not.toBe("idle");

    dataChannel.fire("message", { data: JSON.stringify({ type: "response.done" }) });
    expect(session.state).toBe("idle");
  });

  it("closes at once when nothing is being said", async () => {
    const { session } = await openSession();
    session.endAfterReply();
    expect(session.state).toBe("idle");
  });

  it("reports a spoken end distinctly from a silence timeout", async () => {
    const endedByVoice = vi.fn();
    const idleTimeout = vi.fn();
    installBrowserGlobals({
      tokenResponse: Promise.resolve(TOKEN_RESPONSE),
      userMedia: Promise.resolve(makeStream([makeTrack()])),
    });
    const dataChannel = makeDataChannel();
    installPeerConnection(dataChannel);
    const session = createVoiceSession(OPTIONS, {
      onToolCall: async () => ({}),
      onEndedByVoice: endedByVoice,
      onIdleTimeout: idleTimeout,
    });
    await session.start();
    dataChannel.channel.readyState = "open";
    dataChannel.fire("open", {});
    dataChannel.fire("message", { data: JSON.stringify({ type: "session.updated" }) });

    session.endAfterReply();

    // The two endings mean different things: one may reopen later, one may not.
    expect(endedByVoice).toHaveBeenCalledTimes(1);
    expect(idleTimeout).not.toHaveBeenCalled();
  });

  it("hush cuts off the reply but keeps listening", async () => {
    const { session, dataChannel } = await openSession();
    dataChannel.fire("message", { data: JSON.stringify({ type: "response.created" }) });
    dataChannel.channel.send.mockClear();

    session.hush();

    const sent = dataChannel.channel.send.mock.calls.map(
      (call: unknown[]) => JSON.parse(call[0] as string).type as string,
    );
    expect(sent).toContain("response.cancel");
    // Silenced, not ended — the user only asked it to stop talking.
    expect(session.state).toBe("listening");
  });

  it("hush on a silent session does nothing at all", async () => {
    const { session, dataChannel } = await openSession();
    dataChannel.channel.send.mockClear();
    session.hush();
    expect(dataChannel.channel.send).not.toHaveBeenCalled();
    expect(session.state).toBe("listening");
  });
});

describe("response gating", () => {
  const sentTypes = (dataChannel: ReturnType<typeof makeDataChannel>) =>
    dataChannel.channel.send.mock.calls.map(
      (call: unknown[]) => JSON.parse(call[0] as string).type as string,
    );

  const toolCall = (callId: string) => ({
    data: JSON.stringify({
      type: "response.function_call_arguments.done",
      call_id: callId,
      name: "list_threads",
      arguments: "{}",
    }),
  });

  it("asks for one reply after several tool calls in a turn", async () => {
    const { dataChannel } = await openSession();

    // The instructions demand list_threads before answering anything about
    // current state, so multi-tool turns are the norm. One response.create per
    // tool call is what made the orchestrator answer five times in a row.
    dataChannel.fire("message", toolCall("call-1"));
    dataChannel.fire("message", toolCall("call-2"));
    dataChannel.fire("message", toolCall("call-3"));
    await flush();

    const types = sentTypes(dataChannel);
    expect(types.filter((t) => t === "conversation.item.create")).toHaveLength(3);
    expect(types.filter((t) => t === "response.create")).toHaveLength(1);
  });

  it("executes a repeated provider tool-call id at most once", async () => {
    const onToolCall = vi.fn(async () => ({ applied: true }));
    const { dataChannel } = await openSession({}, onToolCall);

    // xAI can report one function call through both supported completion event
    // shapes. They carry the same call_id and are one side effect, not two.
    dataChannel.fire("message", toolCall("settings-call-1"));
    dataChannel.fire("message", {
      data: JSON.stringify({
        type: "response.output_item.done.function_call",
        call_id: "settings-call-1",
        name: "list_threads",
        arguments: "{}",
      }),
    });
    await flush();

    expect(onToolCall).toHaveBeenCalledTimes(1);
    const types = sentTypes(dataChannel);
    expect(types.filter((type) => type === "conversation.item.create")).toHaveLength(1);
    expect(types.filter((type) => type === "response.create")).toHaveLength(1);
  });

  it("holds a request made while a response is in flight, then sends one", async () => {
    const { dataChannel } = await openSession();

    dataChannel.fire("message", { data: JSON.stringify({ type: "response.created" }) });
    dataChannel.fire("message", toolCall("call-1"));
    dataChannel.fire("message", toolCall("call-2"));
    await flush();
    // A response is already speaking — nothing may be queued behind it yet.
    expect(sentTypes(dataChannel).filter((t) => t === "response.create")).toHaveLength(0);

    dataChannel.fire("message", { data: JSON.stringify({ type: "response.done" }) });
    await flush();
    // The two deferred requests coalesce into a single reply.
    expect(sentTypes(dataChannel).filter((t) => t === "response.create")).toHaveLength(1);
  });

  it("reopens the gate when a request is rejected instead of answered", async () => {
    const { dataChannel } = await openSession();

    dataChannel.fire("message", toolCall("call-1"));
    await flush();
    expect(sentTypes(dataChannel).filter((t) => t === "response.create")).toHaveLength(1);

    // A rejected request never produces response.created; without this reset
    // the gate would stay shut and the orchestrator would go permanently mute.
    dataChannel.fire("message", {
      data: JSON.stringify({ type: "error", error: { message: "rejected" } }),
    });
    dataChannel.fire("message", toolCall("call-2"));
    await flush();

    expect(sentTypes(dataChannel).filter((t) => t === "response.create")).toHaveLength(2);
  });

  it("drops hallucinated foreign transcripts before they reach the thread", async () => {
    const { dataChannel, transcripts } = await openSession();

    for (const transcript of ["나도", "Not the website."]) {
      dataChannel.fire("message", {
        data: JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          transcript,
        }),
      });
    }

    expect(transcripts).toEqual([{ role: "user", text: "Not the website." }]);
  });
});

describe("in-band realtime errors", () => {
  it("reports an error without killing a live session", async () => {
    installBrowserGlobals({
      tokenResponse: Promise.resolve(TOKEN_RESPONSE),
      userMedia: Promise.resolve(makeStream([makeTrack()])),
    });
    const dataChannel = makeDataChannel();
    installPeerConnection(dataChannel);

    const errors: string[] = [];
    const session = createVoiceSession(OPTIONS, {
      onError: (message) => errors.push(message),
      onToolCall: async () => ({}),
    });
    await session.start();
    dataChannel.channel.readyState = "open";
    dataChannel.fire("open", {});
    dataChannel.fire("message", { data: JSON.stringify({ type: "session.updated" }) });

    // The API reports benign conditions in band. The audio and data channels
    // stay live, so an in-band error must not latch the session terminal.
    dataChannel.fire("message", {
      data: JSON.stringify({
        type: "error",
        error: { message: "input frame was rejected" },
      }),
    });

    expect(errors).toEqual(["input frame was rejected"]);
    expect(session.state).toBe("listening");
  });

  it("answers a response collision with a cue instead of an error", async () => {
    // The user talked over a reply that was already generating. Nothing is
    // wrong and there is nothing to dismiss, so a red toast was the wrong
    // register entirely — it interrupts the conversation to report the
    // conversation.
    installBrowserGlobals({
      tokenResponse: Promise.resolve(TOKEN_RESPONSE),
      userMedia: Promise.resolve(makeStream([makeTrack()])),
    });
    const dataChannel = makeDataChannel();
    installPeerConnection(dataChannel);

    const errors: string[] = [];
    let noiseIgnored = 0;
    const session = createVoiceSession(OPTIONS, {
      onError: (message) => errors.push(message),
      onNoiseIgnored: () => {
        noiseIgnored += 1;
      },
      onToolCall: async () => ({}),
    });
    await session.start();
    dataChannel.channel.readyState = "open";
    dataChannel.fire("open", {});
    dataChannel.fire("message", { data: JSON.stringify({ type: "session.updated" }) });

    dataChannel.fire("message", {
      data: JSON.stringify({
        type: "error",
        error: {
          message:
            "Conversation already has an active response in progress: resp_abc. Wait until the response is finished before creating a new one.",
        },
      }),
    });

    expect(errors).toEqual([]);
    expect(noiseIgnored).toBe(1);
    expect(session.state).toBe("listening");
  });

  it("still fails the session when an error arrives before the channel opens", async () => {
    installBrowserGlobals({
      tokenResponse: Promise.resolve(TOKEN_RESPONSE),
      userMedia: Promise.resolve(makeStream([makeTrack()])),
    });
    const dataChannel = makeDataChannel();
    installPeerConnection(dataChannel);

    const session = createVoiceSession(OPTIONS, { onToolCall: async () => ({}) });
    await session.start();

    // Channel never opened: this is a genuine setup failure, not chatter on a
    // working session.
    dataChannel.fire("message", {
      data: JSON.stringify({ type: "error", error: { message: "invalid ephemeral token" } }),
    });

    expect(session.state).toBe("error");
  });
});

describe("never interrupting when asked not to", () => {
  it("ignores speech over the top when interruption is turned off", async () => {
    const { dataChannel } = await openSession({ interruptWhileSpeaking: false });
    dataChannel.fire("message", { data: JSON.stringify({ type: "response.created" }) });
    dataChannel.channel.send.mockClear();

    // Someone talking over it — normally the start of a barge-in judgement.
    dataChannel.fire("message", {
      data: JSON.stringify({ type: "input_audio_buffer.speech_started" }),
    });

    // Nothing is cancelled, and no judgement window was even opened.
    const sent = dataChannel.channel.send.mock.calls.map(
      (call: unknown[]) => JSON.parse(call[0] as string).type as string,
    );
    expect(sent).not.toContain("response.cancel");
  });

  it("still lets an explicit hush through, since that is not a barge-in", async () => {
    const { session, dataChannel } = await openSession({ interruptWhileSpeaking: false });
    dataChannel.fire("message", { data: JSON.stringify({ type: "response.created" }) });
    dataChannel.channel.send.mockClear();

    session.hush();

    const sent = dataChannel.channel.send.mock.calls.map(
      (call: unknown[]) => JSON.parse(call[0] as string).type as string,
    );
    expect(sent).toContain("response.cancel");
  });
});

describe("not repeating itself, and not cutting itself off", () => {
  const toolCallFrame = (callId: string) => ({
    data: JSON.stringify({
      type: "response.function_call_arguments.done",
      call_id: callId,
      name: "list_threads",
      arguments: "{}",
    }),
  });

  const sentTypesOf = (dataChannel: ReturnType<typeof makeDataChannel>) =>
    dataChannel.channel.send.mock.calls.map(
      (call: unknown[]) => JSON.parse(call[0] as string).type as string,
    );

  it("answers once for a turn that called several tools", async () => {
    // Two tools in one turn used to produce one reply when the batch finished
    // and an identical one from the flush afterwards — the repeated answer.
    const { dataChannel } = await openSession();

    dataChannel.fire("message", toolCallFrame("call-1"));
    dataChannel.fire("message", toolCallFrame("call-2"));
    await flush();

    dataChannel.fire("message", { data: JSON.stringify({ type: "response.created" }) });
    dataChannel.channel.send.mockClear();
    dataChannel.fire("message", { data: JSON.stringify({ type: "response.done" }) });

    expect(sentTypesOf(dataChannel).filter((type) => type === "response.create")).toHaveLength(0);
  });

  it("still replies to a tool the model called mid-response", async () => {
    // The flag must survive when the tool call happens *after* the response
    // began, which is the ordinary function-calling flow.
    const { dataChannel } = await openSession();

    dataChannel.fire("message", { data: JSON.stringify({ type: "response.created" }) });
    dataChannel.fire("message", toolCallFrame("call-1"));
    await flush();
    dataChannel.channel.send.mockClear();
    dataChannel.fire("message", { data: JSON.stringify({ type: "response.done" }) });

    expect(sentTypesOf(dataChannel)).toContain("response.create");
  });

  it("lets the audio finish before starting a queued announcement", async () => {
    const { session, dataChannel } = await openSession();

    // Speaking, with audio actually playing out.
    dataChannel.fire("message", { data: JSON.stringify({ type: "response.created" }) });
    dataChannel.fire("message", { data: JSON.stringify({ type: "output_audio_buffer.started" }) });
    // A thread finishes while it is mid-sentence.
    session.announce("A thread finished.");
    dataChannel.channel.send.mockClear();

    // The server finished *generating*, but the user is still hearing it.
    dataChannel.fire("message", { data: JSON.stringify({ type: "response.done" }) });
    expect(sentTypesOf(dataChannel)).not.toContain("response.create");

    // Once the buffer drains, the queued announcement goes out.
    dataChannel.fire("message", { data: JSON.stringify({ type: "output_audio_buffer.stopped" }) });
    expect(sentTypesOf(dataChannel)).toContain("response.create");
  });

  it("queues an internal event that lands while a tool call is running", async () => {
    // The gap between the response that made a tool call finishing and the
    // reply to its output: no response is active and none is requested, so an
    // event arriving here used to fire a response.create straight into the
    // middle of the agent's work. Two responses then raced, which is how the
    // same answer came out twice.
    const { session, dataChannel } = await openSession({}, () => new Promise(() => {}));

    dataChannel.fire("message", { data: JSON.stringify({ type: "response.created" }) });
    dataChannel.fire("message", toolCallFrame("call-1"));
    dataChannel.fire("message", { data: JSON.stringify({ type: "response.done" }) });
    await flush();
    dataChannel.channel.send.mockClear();

    session.announce("A thread finished.");

    expect(sentTypesOf(dataChannel)).not.toContain("response.create");
  });

  it("does not let a hung tool call wedge the session forever", async () => {
    // A tool call in flight now holds announcements back and keeps the waiting
    // tone running, so one request that never settles would silently freeze the
    // whole session. The ceiling is what stops that being possible.
    vi.useFakeTimers();
    try {
      const { session, dataChannel } = await openSession({}, () => new Promise(() => {}));

      dataChannel.fire("message", { data: JSON.stringify({ type: "response.created" }) });
      dataChannel.fire("message", toolCallFrame("call-1"));
      dataChannel.fire("message", { data: JSON.stringify({ type: "response.done" }) });
      await vi.advanceTimersByTimeAsync(0);
      dataChannel.channel.send.mockClear();

      session.announce("A thread finished.");
      expect(sentTypesOf(dataChannel)).not.toContain("response.create");

      // Past the ceiling: the call is abandoned, its failure is reported into
      // the conversation, and the queue drains.
      await vi.advanceTimersByTimeAsync(31_000);
      expect(sentTypesOf(dataChannel)).toContain("conversation.item.create");
      expect(sentTypesOf(dataChannel)).toContain("response.create");
    } finally {
      vi.useRealTimers();
    }
  });

  it("silences a reply it holds back, not just its generation", async () => {
    // Cancelling generation alone let the opening words of a held reply play
    // out anyway, and the reply that eventually answered the finished sentence
    // opened with the same words — the assistant saying "Checking that." twice,
    // once from a response nobody wanted.
    const { dataChannel } = await openSession();

    dataChannel.fire("message", { data: JSON.stringify({ type: "response.created" }) });
    dataChannel.channel.send.mockClear();
    // An utterance that trails off is held for a continuation.
    dataChannel.fire("message", {
      data: JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "so I was thinking maybe we could...",
      }),
    });

    const sent = sentTypesOf(dataChannel);
    expect(sent).toContain("response.cancel");
    expect(sent).toContain("output_audio_buffer.clear");
  });

  it("says a burst of events once, not once each", async () => {
    // Every event used to become its own spoken response the moment it landed,
    // so three transitions arriving together were three separate
    // interruptions.
    vi.useFakeTimers();
    try {
      const { session, dataChannel } = await openSession();
      dataChannel.channel.send.mockClear();

      session.announce("Rover finished.");
      session.announce("Vera wants approval.");
      session.announce("Atlas failed.");

      // Nothing yet: they are being gathered.
      expect(sentTypesOf(dataChannel)).not.toContain("response.create");

      await vi.advanceTimersByTimeAsync(1_500);

      const creates = sentTypesOf(dataChannel).filter((type) => type === "response.create");
      expect(creates).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deduplicates identical announcements before they reach the model", async () => {
    vi.useFakeTimers();
    try {
      const { session, dataChannel } = await openSession();
      dataChannel.channel.send.mockClear();

      session.announce("Rover finished.");
      session.announce("  rover   finished.  ");
      session.announce("Rover finished.");
      await vi.advanceTimersByTimeAsync(1_500);

      const sent = dataChannel.channel.send.mock.calls.map((call: unknown[]) => String(call[0]));
      const prompt = sent.find((frame) => frame.includes("Rover finished."));
      expect(prompt).toBeDefined();
      expect(prompt?.match(/Rover finished\./g)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps a notification burst and summarizes the overflow", async () => {
    vi.useFakeTimers();
    try {
      const { session, dataChannel } = await openSession();
      dataChannel.channel.send.mockClear();

      for (let index = 1; index <= 20; index += 1) {
        session.announce(`Thread ${index} finished.`);
      }
      await vi.advanceTimersByTimeAsync(1_500);

      const sent = dataChannel.channel.send.mock.calls.map((call: unknown[]) => String(call[0]));
      const prompt = sent.find((frame) => frame.includes("Thread 1 finished."));
      expect(prompt).toContain("Thread 8 finished.");
      expect(prompt).not.toContain("Thread 9 finished.");
      expect(prompt).toContain("12 additional updates arrived");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait for audio that was never playing", async () => {
    const { session, dataChannel } = await openSession();
    dataChannel.fire("message", { data: JSON.stringify({ type: "response.created" }) });
    session.announce("A thread finished.");
    dataChannel.channel.send.mockClear();

    dataChannel.fire("message", { data: JSON.stringify({ type: "response.done" }) });

    expect(sentTypesOf(dataChannel)).toContain("response.create");
  });
});

describe("not sending the assistant's own voice back to the server", () => {
  async function halfDuplexSession() {
    const track = makeTrack();
    installBrowserGlobals({
      tokenResponse: Promise.resolve(TOKEN_RESPONSE),
      userMedia: Promise.resolve(makeStream([track])),
    });
    const dataChannel = makeDataChannel();
    installPeerConnection(dataChannel);
    const session = createVoiceSession(
      { ...OPTIONS, interruptWhileSpeaking: false },
      { onToolCall: async () => ({}) },
    );
    await session.start();
    dataChannel.channel.readyState = "open";
    dataChannel.fire("open", {});
    dataChannel.fire("message", { data: JSON.stringify({ type: "session.updated" }) });
    return { session, dataChannel, track };
  }

  it("closes the microphone while the assistant speaks", async () => {
    // Every client-side filter can only judge the echo after it has already
    // been uploaded and turned into a user turn by the server. Not sending it
    // is the only thing that actually stops that.
    const { dataChannel, track } = await halfDuplexSession();
    expect(track.enabled).toBe(true);

    dataChannel.fire("message", { data: JSON.stringify({ type: "output_audio_buffer.started" }) });
    expect(track.enabled).toBe(false);

    dataChannel.fire("message", { data: JSON.stringify({ type: "output_audio_buffer.stopped" }) });
    expect(track.enabled).toBe(true);
  });

  it("reopens the microphone when a response ends without audio", async () => {
    const { dataChannel, track } = await halfDuplexSession();
    dataChannel.fire("message", { data: JSON.stringify({ type: "output_audio_buffer.started" }) });
    expect(track.enabled).toBe(false);

    // Some responses complete without a stop event for the buffer.
    dataChannel.fire("message", { data: JSON.stringify({ type: "output_audio_buffer.cleared" }) });
    expect(track.enabled).toBe(true);
  });

  it("leaves the microphone open when the user wants to interrupt", async () => {
    // Interruption by voice needs an open microphone, so this trade is only
    // made by someone who already gave that up.
    const { dataChannel, track } = await openSessionWithTrack();
    dataChannel.fire("message", { data: JSON.stringify({ type: "output_audio_buffer.started" }) });
    expect(track.enabled).toBe(true);
  });
});

async function openSessionWithTrack() {
  const track = makeTrack();
  installBrowserGlobals({
    tokenResponse: Promise.resolve(TOKEN_RESPONSE),
    userMedia: Promise.resolve(makeStream([track])),
  });
  const dataChannel = makeDataChannel();
  installPeerConnection(dataChannel);
  const session = createVoiceSession(OPTIONS, { onToolCall: async () => ({}) });
  await session.start();
  dataChannel.channel.readyState = "open";
  dataChannel.fire("open", {});
  dataChannel.fire("message", { data: JSON.stringify({ type: "session.updated" }) });
  return { session, dataChannel, track };
}

describe("echo-triggered duplicate responses", () => {
  /** Frames the session put on the wire, as parsed objects. */
  function sentFrameTypes(dataChannel: ReturnType<typeof makeDataChannel>): string[] {
    return dataChannel.channel.send.mock.calls.map(
      (call) => JSON.parse(call[0] as string).type as string,
    );
  }

  it("cancels a response that starts while the previous one is still speaking", async () => {
    // The mobile failure: the assistant's own voice reaches the microphone, the
    // server's turn detection fires, and `create_response: true` spawns a
    // second response over the top of the sentence still playing. It re-answers
    // the same question — which reads as the assistant rewording itself — and
    // its audio cuts the first one off.
    const { dataChannel } = await openSessionWithTrack();

    dataChannel.fire("message", { data: JSON.stringify({ type: "response.created" }) });
    dataChannel.fire("message", {
      data: JSON.stringify({ type: "output_audio_buffer.started" }),
    });
    dataChannel.fire("message", { data: JSON.stringify({ type: "response.done" }) });

    dataChannel.channel.send.mockClear();
    // Audio from the first response is still playing when the echo-triggered
    // second one begins.
    dataChannel.fire("message", { data: JSON.stringify({ type: "response.created" }) });

    const types = sentFrameTypes(dataChannel);
    expect(types).toContain("response.cancel");
    // Crucially NOT output_audio_buffer.clear: that would cut off the audio
    // this cancellation exists to protect.
    expect(types).not.toContain("output_audio_buffer.clear");
  });

  it("leaves a response alone once the speaker has finished", async () => {
    const { dataChannel } = await openSessionWithTrack();

    dataChannel.fire("message", { data: JSON.stringify({ type: "response.created" }) });
    dataChannel.fire("message", {
      data: JSON.stringify({ type: "output_audio_buffer.started" }),
    });
    dataChannel.fire("message", { data: JSON.stringify({ type: "response.done" }) });
    dataChannel.fire("message", {
      data: JSON.stringify({ type: "output_audio_buffer.stopped" }),
    });

    dataChannel.channel.send.mockClear();
    // Nothing is playing, so this is the user genuinely taking their turn.
    dataChannel.fire("message", { data: JSON.stringify({ type: "response.created" }) });

    expect(sentFrameTypes(dataChannel)).not.toContain("response.cancel");
  });
});

describe("knowing when the assistant is audible", () => {
  // This is the load-bearing signal behind both echo protections: closing the
  // microphone while the assistant speaks, and cancelling the duplicate
  // response its echo provokes. Keying it solely on `output_audio_buffer.started`
  // meant a browser that never sends that event disabled both silently — which
  // is exactly the shape of a bug that survives several rounds of fixing.
  it("trusts the server's buffer event when it arrives", () => {
    expect(isAssistantAudible({ bufferPlaying: true, lastAudibleAt: 0, nowMs: 10_000 })).toBe(true);
  });

  it("falls back to measured audio when the buffer event never comes", () => {
    expect(isAssistantAudible({ bufferPlaying: false, lastAudibleAt: 9_800, nowMs: 10_000 })).toBe(
      true,
    );
  });

  it("lets go once the assistant has been quiet past the grace window", () => {
    expect(
      isAssistantAudible({
        bufferPlaying: false,
        lastAudibleAt: 10_000 - ASSISTANT_AUDIO_GRACE_MS,
        nowMs: 10_000,
      }),
    ).toBe(false);
  });

  it("reports silence when the track has never been audible", () => {
    // No metering attached: this must reduce to the buffer event alone rather
    // than treating "never heard" as "heard at time zero", which would hold the
    // microphone shut for the whole session.
    expect(isAssistantAudible({ bufferPlaying: false, lastAudibleAt: 0, nowMs: 10_000 })).toBe(
      false,
    );
  });
});

/** Counting Web Audio stub, so cues are observable in the node environment. */
function installAudioContext() {
  const tones: number[] = [];
  vi.stubGlobal(
    "AudioContext",
    vi.fn(function AudioContextMock(this: Record<string, unknown>) {
      this.currentTime = 0;
      this.destination = {};
      this.createOscillator = () => ({
        frequency: { setValueAtTime: (value: number) => tones.push(value) },
        connect: () => undefined,
        start: () => undefined,
        stop: () => undefined,
      });
      this.createGain = () => ({
        gain: { setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined },
        connect: () => undefined,
      });
      this.resume = async () => undefined;
      this.close = async () => undefined;
    }),
  );
  return { tones };
}

describe("losing the connection", () => {
  it("reports a dropped transport so the owner can reconnect", async () => {
    // Wi-Fi loss is silent from the user's side: the microphone stays open and
    // they keep talking to something that cannot hear them. Surfacing it is
    // what makes an automatic reconnect possible at all.
    const track = makeTrack();
    installBrowserGlobals({
      tokenResponse: Promise.resolve(TOKEN_RESPONSE),
      userMedia: Promise.resolve(makeStream([track])),
    });
    const dataChannel = makeDataChannel();
    const peer = installPeerConnection(dataChannel);
    const onConnectionLost = vi.fn();

    const session = createVoiceSession(OPTIONS, { onToolCall: async () => ({}), onConnectionLost });
    await session.start();
    dataChannel.channel.readyState = "open";
    dataChannel.fire("open", {});
    dataChannel.fire("message", { data: JSON.stringify({ type: "session.updated" }) });

    const connection = peer.instances[0] as unknown as {
      connectionState?: string;
      onconnectionstatechange?: () => void;
    };
    // It has to have been up before it can drop.
    connection.connectionState = "connected";
    connection.onconnectionstatechange?.();
    connection.connectionState = "failed";
    connection.onconnectionstatechange?.();

    expect(onConnectionLost).toHaveBeenCalledTimes(1);
    // Torn down, not left half-alive with a hot microphone.
    expect(track.stop).toHaveBeenCalled();
    expect(session.state).toBe("idle");
  });

  it("does not kill a session that has not connected yet", async () => {
    // The reported bug: the orchestrator simply would not start. ICE reports
    // `disconnected` during setup on a phone — especially over a VPN — and this
    // handler treated it as death, tearing the session down mid-negotiation.
    // Worse, it did so by setting the stopped latch, so start()'s catch read
    // the failure as a user cancellation and reported nothing at all.
    const track = makeTrack();
    installBrowserGlobals({
      tokenResponse: Promise.resolve(TOKEN_RESPONSE),
      userMedia: Promise.resolve(makeStream([track])),
    });
    const dataChannel = makeDataChannel();
    const peer = installPeerConnection(dataChannel);
    const onConnectionLost = vi.fn();

    const session = createVoiceSession(OPTIONS, { onToolCall: async () => ({}), onConnectionLost });
    await session.start();

    const connection = peer.instances[0] as unknown as {
      connectionState?: string;
      onconnectionstatechange?: () => void;
    };
    for (const state of ["connecting", "disconnected", "failed"]) {
      connection.connectionState = state;
      connection.onconnectionstatechange?.();
    }

    expect(onConnectionLost).not.toHaveBeenCalled();
    expect(track.stop).not.toHaveBeenCalled();
    expect(session.state).not.toBe("idle");
  });

  it("gives a disconnect a chance to recover before calling it lost", async () => {
    vi.useFakeTimers();
    try {
      const track = makeTrack();
      installBrowserGlobals({
        tokenResponse: Promise.resolve(TOKEN_RESPONSE),
        userMedia: Promise.resolve(makeStream([track])),
      });
      const dataChannel = makeDataChannel();
      const peer = installPeerConnection(dataChannel);
      const onConnectionLost = vi.fn();

      const session = createVoiceSession(OPTIONS, {
        onToolCall: async () => ({}),
        onConnectionLost,
      });
      await session.start();
      dataChannel.channel.readyState = "open";
      dataChannel.fire("open", {});

      const connection = peer.instances[0] as unknown as {
        connectionState?: string;
        onconnectionstatechange?: () => void;
      };
      connection.connectionState = "connected";
      connection.onconnectionstatechange?.();

      connection.connectionState = "disconnected";
      connection.onconnectionstatechange?.();
      // Nothing yet — this is what an access-point handover looks like.
      expect(onConnectionLost).not.toHaveBeenCalled();

      connection.connectionState = "connected";
      connection.onconnectionstatechange?.();
      vi.advanceTimersByTime(DISCONNECTED_GRACE_MS * 2);
      expect(onConnectionLost).not.toHaveBeenCalled();

      // A drop that does not come back is still a drop.
      connection.connectionState = "disconnected";
      connection.onconnectionstatechange?.();
      vi.advanceTimersByTime(DISCONNECTED_GRACE_MS + 1);
      expect(onConnectionLost).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores healthy connection-state changes", async () => {
    const track = makeTrack();
    installBrowserGlobals({
      tokenResponse: Promise.resolve(TOKEN_RESPONSE),
      userMedia: Promise.resolve(makeStream([track])),
    });
    const dataChannel = makeDataChannel();
    const peer = installPeerConnection(dataChannel);
    const onConnectionLost = vi.fn();

    const session = createVoiceSession(OPTIONS, { onToolCall: async () => ({}), onConnectionLost });
    await session.start();
    dataChannel.channel.readyState = "open";
    dataChannel.fire("open", {});
    dataChannel.fire("message", { data: JSON.stringify({ type: "session.updated" }) });

    const connection = peer.instances[0] as unknown as {
      connectionState?: string;
      onconnectionstatechange?: () => void;
    };
    connection.connectionState = "connected";
    connection.onconnectionstatechange?.();

    expect(onConnectionLost).not.toHaveBeenCalled();
    expect(session.state).toBe("listening");
  });
});

describe("the first-word click", () => {
  it("fires once for an utterance, not once per word", async () => {
    const audio = installAudioContext();
    const { dataChannel } = await openSessionWithTrack();
    // The session-configured cue fires first; measure from after it.
    const before = audio.tones.length;

    dataChannel.fire("message", {
      data: JSON.stringify({ type: "input_audio_buffer.speech_started" }),
    });
    for (const delta of ["so", " what", " I want"]) {
      dataChannel.fire("message", {
        data: JSON.stringify({
          type: "conversation.item.input_audio_transcription.delta",
          delta,
        }),
      });
    }

    // One click for the whole utterance. A click per word would be a typewriter.
    expect(audio.tones.length - before).toBe(1);
  });

  it("clicks again for the next utterance", async () => {
    const audio = installAudioContext();
    const { dataChannel } = await openSessionWithTrack();
    const before = audio.tones.length;

    const speak = (delta: string) => {
      dataChannel.fire("message", {
        data: JSON.stringify({ type: "input_audio_buffer.speech_started" }),
      });
      dataChannel.fire("message", {
        data: JSON.stringify({
          type: "conversation.item.input_audio_transcription.delta",
          delta,
        }),
      });
    };
    speak("first");
    speak("second");

    expect(audio.tones.length - before).toBe(2);
  });

  it("does not click after the VAD has already closed the floor", async () => {
    // Grok often delivers the first transcript delta after speech_stopped.
    // A click then reads as "you cannot talk anymore".
    const audio = installAudioContext();
    const { dataChannel } = await openSessionWithTrack();
    const before = audio.tones.length;

    dataChannel.fire("message", {
      data: JSON.stringify({ type: "input_audio_buffer.speech_started" }),
    });
    dataChannel.fire("message", {
      data: JSON.stringify({ type: "input_audio_buffer.speech_stopped" }),
    });
    dataChannel.fire("message", {
      data: JSON.stringify({
        type: "conversation.item.input_audio_transcription.delta",
        delta: "hello",
      }),
    });

    expect(audio.tones.length - before).toBe(0);
  });

  it("still clicks when the provider never sends speech_started", async () => {
    // On OpenAI a first delta with no VAD open is still trustworthy proof of
    // hearing; the click stays. (Grok gets no click at all — see below.)
    const audio = installAudioContext();
    const { dataChannel } = await openSessionWithTrack();
    const before = audio.tones.length;

    dataChannel.fire("message", {
      data: JSON.stringify({
        type: "conversation.item.input_audio_transcription.delta",
        delta: "hello",
      }),
    });

    expect(audio.tones.length - before).toBe(1);
  });
});

describe("transcript acceptance", () => {
  it("plays one distinct acknowledgement after a finished utterance commits", async () => {
    const audio = installAudioContext();
    const { dataChannel } = await openSessionWithTrack();
    const before = audio.tones.length;

    dataChannel.fire("message", {
      data: JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "What is the status?",
      }),
    });

    // The working pulse is deliberately delayed, leaving only the falling
    // accepted contour on this beat.
    expect(audio.tones.slice(before)).toEqual([880, 660]);
  });

  it("stays silent during a continuation window and acknowledges when it closes", async () => {
    vi.useFakeTimers();
    try {
      const audio = installAudioContext();
      const { dataChannel } = await openSessionWithTrack();
      const before = audio.tones.length;
      dataChannel.channel.send.mockClear();

      dataChannel.fire("message", {
        data: JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          transcript: "I was thinking maybe we could...",
        }),
      });

      await vi.advanceTimersByTimeAsync(CONTINUATION_GRACE_MS - 1);
      expect(audio.tones.slice(before)).toEqual([]);
      expect(sentDataChannelTypes(dataChannel)).not.toContain("response.create");

      await vi.advanceTimersByTimeAsync(1);
      expect(audio.tones.slice(before)).toEqual([880, 660]);
      expect(sentDataChannelTypes(dataChannel)).toContain("response.create");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not acknowledge a held turn when the user resumes speaking", async () => {
    vi.useFakeTimers();
    try {
      const audio = installAudioContext();
      const { dataChannel } = await openSessionWithTrack();
      const before = audio.tones.length;

      dataChannel.fire("message", {
        data: JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          transcript: "There was one more thing...",
        }),
      });
      await vi.advanceTimersByTimeAsync(CONTINUATION_GRACE_MS / 2);
      dataChannel.fire("message", {
        data: JSON.stringify({ type: "input_audio_buffer.speech_started" }),
      });
      await vi.advanceTimersByTimeAsync(CONTINUATION_GRACE_MS);

      expect(audio.tones.slice(before)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("waiting that never ends", () => {
  /** As `openSessionWithTrack`, but half duplex and watching the working tone. */
  async function openWaitingSession() {
    const track = makeTrack();
    installBrowserGlobals({
      tokenResponse: Promise.resolve(TOKEN_RESPONSE),
      userMedia: Promise.resolve(makeStream([track])),
    });
    const dataChannel = makeDataChannel();
    installPeerConnection(dataChannel);
    const working: boolean[] = [];
    const session = createVoiceSession(
      { ...OPTIONS, interruptWhileSpeaking: false },
      { onToolCall: async () => ({}), onWorkingChange: (value) => working.push(value) },
    );
    await session.start();
    dataChannel.channel.readyState = "open";
    dataChannel.fire("open", {});
    dataChannel.fire("message", { data: JSON.stringify({ type: "session.updated" }) });
    return { session, dataChannel, track, working };
  }

  /** A finished sentence, so the turn is accepted rather than held. */
  const finishTurn = (dataChannel: ReturnType<typeof makeDataChannel>) => {
    dataChannel.fire("message", {
      data: JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "What is the status?",
      }),
    });
  };

  it("gives the floor back when the answer never comes, and says so", async () => {
    // Reported as minutes of beeping with no reply and no way out but stopping
    // and restarting: the tone is driven by flags only an incoming event can
    // clear, so a turn the server never answers pulses forever.
    vi.useFakeTimers();
    try {
      const audio = installAudioContext();
      const { session, dataChannel, track, working } = await openWaitingSession();
      finishTurn(dataChannel);
      expect(working.at(-1)).toBe(true);

      // Nothing arrives. Past the ceiling the wait is abandoned rather than
      // sounded indefinitely.
      await vi.advanceTimersByTimeAsync(46_000);

      expect(working.at(-1)).toBe(false);
      expect(track.enabled).toBe(true);
      expect(session.state).toBe("listening");
      // Abandonment is audible: from the user's ear "pulse, then silence" is
      // identical to "the answer is about to play". The dropped knock is what
      // makes the silence after it mean "the floor is yours".
      expect(audio.tones.slice(-2)).toEqual([340, 340]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting when the platform takes the microphone", async () => {
    // A phone locking or a call arriving mutes the capture track underneath the
    // page. Nothing is torn down, so the session looks healthy while the server
    // hears silence — and the user, who can still hear its output, gets the
    // waiting tone over a microphone that is not reaching anything.
    vi.useFakeTimers();
    try {
      const { dataChannel, track, working } = await openWaitingSession();
      finishTurn(dataChannel);
      expect(working.at(-1)).toBe(true);

      track.muted = true;
      track.fire("mute");
      await vi.advanceTimersByTimeAsync(1_500);

      expect(working.at(-1)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a mute short enough to be a device change", async () => {
    vi.useFakeTimers();
    try {
      const { dataChannel, track, working } = await openWaitingSession();
      finishTurn(dataChannel);

      track.muted = true;
      track.fire("mute");
      await vi.advanceTimersByTimeAsync(400);
      track.muted = false;
      track.fire("unmute");
      await vi.advanceTimersByTimeAsync(2_000);

      // Still waiting: the microphone came back before anything was reported.
      expect(working.at(-1)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a locked phone", () => {
  /**
   * A `document` the tests can hide, which node does not otherwise have.
   *
   * Deliberately real enough to dispatch: the session registers a
   * `visibilitychange` listener and the whole point of these tests is what
   * happens when it fires.
   */
  function installDocument() {
    const listeners = new Map<string, Array<() => void>>();
    const doc = {
      hidden: false,
      addEventListener: (type: string, listener: () => void) => {
        const existing = listeners.get(type) ?? [];
        existing.push(listener);
        listeners.set(type, existing);
      },
      removeEventListener: (type: string, listener: () => void) => {
        listeners.set(
          type,
          (listeners.get(type) ?? []).filter((entry) => entry !== listener),
        );
      },
    };
    vi.stubGlobal("document", doc);
    return {
      hide: () => {
        doc.hidden = true;
        for (const listener of listeners.get("visibilitychange") ?? []) listener();
      },
      show: () => {
        doc.hidden = false;
        for (const listener of listeners.get("visibilitychange") ?? []) listener();
      },
    };
  }

  async function openLockableSession(overrides: Partial<VoiceSessionOptions> = {}) {
    const track = makeTrack();
    installBrowserGlobals({
      tokenResponse: Promise.resolve(TOKEN_RESPONSE),
      userMedia: Promise.resolve(makeStream([track])),
    });
    const dataChannel = makeDataChannel();
    const peer = installPeerConnection(dataChannel);
    const onConnectionLost = vi.fn();
    const onIdleTimeout = vi.fn();
    const session = createVoiceSession(
      { ...OPTIONS, interruptWhileSpeaking: false, ...overrides },
      { onToolCall: async () => ({}), onConnectionLost, onIdleTimeout },
    );
    await session.start();
    dataChannel.channel.readyState = "open";
    dataChannel.fire("open", {});
    dataChannel.fire("message", { data: JSON.stringify({ type: "session.updated" }) });
    const connection = peer.instances[0] as unknown as {
      connectionState?: string;
      onconnectionstatechange?: () => void;
    };
    // It has to have been up before anything counts as a drop.
    connection.connectionState = "connected";
    connection.onconnectionstatechange?.();
    return { session, dataChannel, track, connection, onConnectionLost, onIdleTimeout };
  }

  it("does not time out on silence it cannot measure", async () => {
    // The regression: room tone is read off `requestAnimationFrame`, which a
    // locked phone stops, and the platform mutes the capture track as well. So
    // a live conversation and an abandoned one look identical from here, and
    // the watchdog resolved that tie by ending the session — which is exactly
    // "voice mode hangs and I can't talk to it".
    vi.useFakeTimers();
    try {
      const visibility = installDocument();
      const { session, onIdleTimeout } = await openLockableSession({ silenceTimeoutSeconds: 5 });

      visibility.hide();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(onIdleTimeout).not.toHaveBeenCalled();
      expect(session.state).not.toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still ends a session that really was abandoned, once the screen is back", async () => {
    // Deferred, not cancelled: the elapsed silence is kept, so unlocking a
    // phone that has been quiet for an hour ends the session immediately
    // rather than granting it a fresh timeout.
    vi.useFakeTimers();
    try {
      const visibility = installDocument();
      const { session, onIdleTimeout } = await openLockableSession({ silenceTimeoutSeconds: 5 });

      visibility.hide();
      await vi.advanceTimersByTimeAsync(30_000);
      visibility.show();
      await vi.advanceTimersByTimeAsync(2_500);

      expect(onIdleTimeout).toHaveBeenCalledTimes(1);
      expect(session.state).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not tear down a connection that is still re-establishing", async () => {
    // `disconnected` is transient by specification and is what an unlocking
    // phone reports for a second or two while ICE re-runs its checks. Reporting
    // a drop on sight of it killed sessions that were about to recover.
    vi.useFakeTimers();
    try {
      const visibility = installDocument();
      const { connection, onConnectionLost } = await openLockableSession();

      visibility.hide();
      connection.connectionState = "disconnected";
      visibility.show();

      expect(onConnectionLost).not.toHaveBeenCalled();

      // It comes back on its own, as it usually does.
      connection.connectionState = "connected";
      connection.onconnectionstatechange?.();
      await vi.advanceTimersByTimeAsync(DISCONNECTED_GRACE_MS * 2);

      expect(onConnectionLost).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a pre-background disconnect timer tear down a recovered session", async () => {
    vi.useFakeTimers();
    try {
      const visibility = installDocument();
      const { connection, onConnectionLost } = await openLockableSession();

      connection.connectionState = "disconnected";
      connection.onconnectionstatechange?.();
      visibility.hide();
      await vi.advanceTimersByTimeAsync(DISCONNECTED_GRACE_MS * 2);

      visibility.show();
      expect(onConnectionLost).not.toHaveBeenCalled();

      connection.connectionState = "connected";
      connection.onconnectionstatechange?.();
      await vi.advanceTimersByTimeAsync(DISCONNECTED_GRACE_MS * 2);
      expect(onConnectionLost).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not arm a disconnect timer for an event delivered while backgrounded", async () => {
    vi.useFakeTimers();
    try {
      const visibility = installDocument();
      const { connection, onConnectionLost } = await openLockableSession();

      visibility.hide();
      connection.connectionState = "disconnected";
      connection.onconnectionstatechange?.();
      await vi.advanceTimersByTimeAsync(DISCONNECTED_GRACE_MS * 2);

      expect(onConnectionLost).not.toHaveBeenCalled();

      visibility.show();
      connection.connectionState = "connected";
      connection.onconnectionstatechange?.();
      await vi.advanceTimersByTimeAsync(DISCONNECTED_GRACE_MS * 2);
      expect(onConnectionLost).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does report a connection that really died while the screen was off", async () => {
    const visibility = installDocument();
    const { connection, onConnectionLost } = await openLockableSession();

    visibility.hide();
    connection.connectionState = "failed";
    visibility.show();

    expect(onConnectionLost).toHaveBeenCalledTimes(1);
  });

  it("hands the microphone back before the page is suspended", async () => {
    // Half duplex closes the microphone while the assistant is audible, and the
    // decision to reopen it is made by the level meter — which stops when the
    // phone locks. Locking mid-answer left it closed with nothing running that
    // would ever open it again.
    const visibility = installDocument();
    const { dataChannel, track } = await openLockableSession();

    dataChannel.fire("message", { data: JSON.stringify({ type: "output_audio_buffer.started" }) });
    expect(track.enabled).toBe(false);
    dataChannel.fire("message", { data: JSON.stringify({ type: "output_audio_buffer.stopped" }) });

    // Simulate the meter having latched it closed on its last frame.
    track.enabled = false;
    visibility.hide();

    expect(track.enabled).toBe(true);
  });

  it("hands the microphone back when the page hides in the middle of an answer", async () => {
    const visibility = installDocument();
    const { dataChannel, track } = await openLockableSession();

    dataChannel.fire("message", { data: JSON.stringify({ type: "output_audio_buffer.started" }) });
    expect(track.enabled).toBe(false);

    visibility.hide();

    expect(track.enabled).toBe(true);
  });
});

const GROK_TOKEN_RESPONSE = {
  ok: true,
  json: async () => ({
    value: "xai-secret",
    model: "grok-voice-latest",
    voice: "eve",
    provider: "xai",
    transport: "websocket",
  }),
};

function installGrokVoiceGlobals(track: ReturnType<typeof makeTrack>) {
  const processors: Array<{
    onaudioprocess:
      | ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void)
      | null;
  }> = [];
  /** Cue tones scheduled on the shared context, so cues are observable here too. */
  const tones: number[] = [];
  const playbackSources: Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    /** Fires the source's `ended` event, as the platform does when it drains. */
    end: () => void;
  }> = [];
  vi.stubGlobal(
    "AudioContext",
    vi.fn(function AudioContextMock(this: Record<string, unknown>) {
      this.sampleRate = 24_000;
      this.currentTime = 0;
      this.destination = {};
      this.createMediaStreamSource = () => ({
        connect: () => undefined,
        disconnect: () => undefined,
      });
      this.createScriptProcessor = () => {
        const node = {
          connect: () => undefined,
          disconnect: () => undefined,
          onaudioprocess: null as
            | ((event: {
                inputBuffer: { getChannelData: (channel: number) => Float32Array };
              }) => void)
            | null,
        };
        processors.push(node);
        return node;
      };
      this.createGain = () => ({
        gain: {
          value: 0,
          setValueAtTime: () => undefined,
          linearRampToValueAtTime: () => undefined,
        },
        connect: () => undefined,
        disconnect: () => undefined,
      });
      this.createBuffer = (_channels: number, frameCount: number, sampleRate: number) => ({
        duration: frameCount / sampleRate,
        copyToChannel: () => undefined,
      });
      this.createBufferSource = () => {
        // `ended` is real here. The session returns to listening only when
        // every queued source has fired it, so a mock that silently swallowed
        // the listener made the whole drain path untestable — and the paths
        // that never reach it indistinguishable from the ones that do.
        const listeners: Array<() => void> = [];
        const source = {
          buffer: null,
          connect: () => undefined,
          addEventListener: (type: string, listener: () => void) => {
            if (type === "ended") listeners.push(listener);
          },
          start: vi.fn(),
          stop: vi.fn(),
          end: () => {
            for (const listener of [...listeners]) listener();
          },
        };
        playbackSources.push(source);
        return source;
      };
      this.createOscillator = () => ({
        frequency: { setValueAtTime: (value: number) => tones.push(value) },
        connect: () => undefined,
        start: () => undefined,
        stop: () => undefined,
      });
      this.resume = async () => undefined;
      this.close = async () => undefined;
    }),
  );

  type WsListener = (event: unknown) => void;
  const sockets: Array<{
    send: ReturnType<typeof vi.fn>;
    readyState: number;
    fire: (type: string, event: unknown) => void;
  }> = [];
  const WebSocketMock = vi.fn(function WebSocketMock(this: Record<string, unknown>) {
    const listeners = new Map<string, WsListener[]>();
    const fire = (type: string, event: unknown) => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    };
    this.readyState = 0;
    this.send = vi.fn();
    this.close = vi.fn();
    this.addEventListener = (type: string, listener: WsListener) => {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    };
    this.removeEventListener = (type: string, listener: WsListener) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((entry) => entry !== listener),
      );
    };
    this.fire = fire;
    sockets.push(this as (typeof sockets)[number]);
    queueMicrotask(() => {
      this.readyState = 1;
      fire("open", {});
    });
  });
  (WebSocketMock as unknown as { OPEN: number }).OPEN = 1;
  vi.stubGlobal("WebSocket", WebSocketMock);
  installBrowserGlobals({
    tokenResponse: Promise.resolve(GROK_TOKEN_RESPONSE),
    userMedia: Promise.resolve(makeStream([track])),
  });
  installPeerConnection(makeDataChannel());
  return { playbackSources, processors, sockets, tones };
}

function sentSocketTypes(socket: { send: ReturnType<typeof vi.fn> }): string[] {
  return socket.send.mock.calls.map((call) => JSON.parse(call[0] as string).type as string);
}

async function openGrokSession(
  track: ReturnType<typeof makeTrack> = makeTrack(),
  onTranscript?: (entry: { role: string; text: string }) => void,
  overrides: Partial<VoiceSessionOptions> = {},
) {
  const { playbackSources, processors, sockets, tones } = installGrokVoiceGlobals(track);
  const session = createVoiceSession(
    { ...OPTIONS, ...overrides },
    {
      onToolCall: async () => ({}),
      ...(onTranscript !== undefined ? { onTranscript } : {}),
    },
  );
  await session.start();
  const socket = sockets[0];
  if (socket === undefined) throw new Error("expected a Grok websocket");
  socket.fire("message", { data: JSON.stringify({ type: "session.updated" }) });
  socket.send.mockClear();
  return { session, socket, playbackSources, processors, track, tones };
}

describe("Grok Voice capture and turn close", () => {
  it("acknowledges one committed turn after repeated transcript frames settle", async () => {
    vi.useFakeTimers();
    try {
      const { socket, session, tones } = await openGrokSession();
      const before = tones.length;
      socket.fire("message", {
        data: JSON.stringify({
          type: "conversation.item.input_audio_transcription.updated",
          item_id: "utterance-1",
          transcript: "What is the status?",
        }),
      });
      socket.fire("message", {
        data: JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "utterance-1",
          transcript: "What is the status?",
        }),
      });

      expect(tones.slice(before)).toEqual([]);
      await vi.advanceTimersByTimeAsync(GROK_UTTERANCE_SETTLE_MS);
      expect(tones.slice(before)).toEqual([880, 660]);
      session.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops locally buffered Grok audio when a response is held", async () => {
    vi.useFakeTimers();
    try {
      const { playbackSources, session, socket } = await openGrokSession();
      socket.fire("message", { data: JSON.stringify({ type: "response.created" }) });
      socket.fire("message", {
        data: JSON.stringify({ type: "response.output_audio.delta", delta: "AAAAAA==" }),
      });
      const source = playbackSources[0];
      if (source === undefined) throw new Error("expected buffered Grok audio");

      socket.fire("message", {
        data: JSON.stringify({
          type: "conversation.item.input_audio_transcription.updated",
          transcript: "I was wondering...",
        }),
      });
      await vi.advanceTimersByTimeAsync(GROK_UTTERANCE_SETTLE_MS);

      expect(source.stop).toHaveBeenCalledOnce();
      session.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the microphone track live before the session is configured", async () => {
    // Muting the track under MediaStreamAudioSourceNode is how Chromium ends
    // up sending silence for the rest of the session while the orb says
    // "listening". Audio is withheld by the PCM gate, not the track.
    const track = makeTrack();
    installGrokVoiceGlobals(track);
    const session = createVoiceSession(OPTIONS, { onToolCall: async () => ({}) });
    await session.start();
    expect(track.enabled).toBe(true);
    expect(session.state).toBe("connecting");
    session.stop();
  });

  it("does not upload PCM until the session is configured", async () => {
    const track = makeTrack();
    const { processors, sockets } = installGrokVoiceGlobals(track);
    const session = createVoiceSession(OPTIONS, { onToolCall: async () => ({}) });
    await session.start();
    const socket = sockets[0];
    const processor = processors[0];
    if (socket === undefined || processor === undefined) throw new Error("expected Grok capture");
    processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(8).fill(0.2) },
    });
    expect(sentSocketTypes(socket)).not.toContain("input_audio_buffer.append");
    session.stop();
  });

  it("uploads PCM once the microphone is open", async () => {
    const { socket, processors, session } = await openGrokSession();
    const processor = processors[0];
    if (processor === undefined) throw new Error("expected Grok capture");
    processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(8).fill(0.2) },
    });
    expect(sentSocketTypes(socket)).toContain("input_audio_buffer.append");
    session.stop();
  });

  it("still uploads after a half-duplex mute, because the track stays live", async () => {
    const { socket, processors, session, track } = await openGrokSession(makeTrack(), undefined, {
      interruptWhileSpeaking: false,
    });
    socket.fire("message", { data: JSON.stringify({ type: "output_audio_buffer.started" }) });
    expect(track.enabled).toBe(true);
    const processor = processors[0];
    if (processor === undefined) throw new Error("expected Grok capture");
    processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(8).fill(0.2) },
    });
    expect(sentSocketTypes(socket)).not.toContain("input_audio_buffer.append");
    socket.fire("message", { data: JSON.stringify({ type: "output_audio_buffer.stopped" }) });
    socket.send.mockClear();
    processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(8).fill(0.2) },
    });
    expect(sentSocketTypes(socket)).toContain("input_audio_buffer.append");
    session.stop();
  });

  it("commits a Grok transcript that arrives after speech_stopped", async () => {
    vi.useFakeTimers();
    try {
      const transcripts: Array<{ role: string; text: string }> = [];
      const { socket, session } = await openGrokSession(makeTrack(), (entry) =>
        transcripts.push(entry),
      );
      socket.fire("message", {
        data: JSON.stringify({ type: "input_audio_buffer.speech_started" }),
      });
      socket.fire("message", {
        data: JSON.stringify({ type: "input_audio_buffer.speech_stopped" }),
      });
      socket.fire("message", {
        data: JSON.stringify({
          type: "conversation.item.input_audio_transcription.updated",
          transcript: "What is the status?",
        }),
      });
      expect(transcripts).toEqual([]);
      await vi.advanceTimersByTimeAsync(GROK_UTTERANCE_SETTLE_MS);
      expect(transcripts).toEqual([{ role: "user", text: "What is the status?" }]);
      session.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers speech and asks for a reply when Grok never opens a VAD turn", async () => {
    vi.useFakeTimers();
    try {
      const transcripts: Array<{ role: string; text: string }> = [];
      const { socket, session } = await openGrokSession(makeTrack(), (entry) =>
        transcripts.push(entry),
      );
      socket.fire("message", {
        data: JSON.stringify({
          type: "conversation.item.input_audio_transcription.updated",
          transcript: "What is the status?",
        }),
      });
      await vi.advanceTimersByTimeAsync(GROK_UTTERANCE_SETTLE_MS);
      expect(transcripts).toEqual([{ role: "user", text: "What is the status?" }]);
      expect(sentSocketTypes(socket)).toContain("response.create");
      session.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("plays no first-word click on Grok, where event order makes it a coin flip", async () => {
    // Grok often delivers the first transcript delta after speech_stopped, so
    // the click fired on some utterances and not others depending on ordering
    // alone. A confirmation that is intermittent teaches nothing; on xai it is
    // off entirely and the accepted cue carries the turn instead.
    const { socket, session, tones } = await openGrokSession();
    const before = tones.length;
    socket.fire("message", { data: JSON.stringify({ type: "input_audio_buffer.speech_started" }) });
    socket.fire("message", {
      data: JSON.stringify({
        type: "conversation.item.input_audio_transcription.updated",
        transcript: "hello",
      }),
    });
    expect(tones.length - before).toBe(0);
    session.stop();
  });
});

describe("returning from speaking", () => {
  /** Plays one chunk of assistant audio and asserts the session is speaking. */
  const beginSpeaking = (
    socket: { fire: (type: string, event: unknown) => void },
    session: { readonly state: VoiceSessionState },
  ) => {
    socket.fire("message", { data: JSON.stringify({ type: "response.created" }) });
    socket.fire("message", {
      data: JSON.stringify({ type: "response.output_audio.delta", delta: "AAAAAA==" }),
    });
    expect(session.state).toBe("speaking");
  };

  it("returns to listening once the queued audio has played out", async () => {
    const { socket, session, playbackSources } = await openGrokSession();
    beginSpeaking(socket, session);
    socket.fire("message", { data: JSON.stringify({ type: "response.output_audio.done" }) });
    socket.fire("message", { data: JSON.stringify({ type: "response.done" }) });

    // Still speaking: the server has finished generating, but the user has not
    // finished hearing it.
    expect(session.state).toBe("speaking");
    playbackSources[0]?.end();
    expect(session.state).toBe("listening");
  });

  it("returns to listening when the audio-done frame never arrives", async () => {
    // A response that ends without one — cancelled, errored, or simply dropped
    // — used to leave the queue waiting to be told no more audio was coming.
    // It drained to empty and the session sat on "Speaking" for good.
    const { socket, session, playbackSources } = await openGrokSession();
    beginSpeaking(socket, session);
    socket.fire("message", { data: JSON.stringify({ type: "response.done" }) });

    playbackSources[0]?.end();
    expect(session.state).toBe("listening");
  });

  it("returns to listening when a stray delta lands after the audio-done frame", async () => {
    // Each delta clears the done flag so a second response can reuse the queue.
    // One arriving after this response's done frame left the flag clear with
    // nothing left to set it again.
    const { socket, session, playbackSources } = await openGrokSession();
    beginSpeaking(socket, session);
    socket.fire("message", { data: JSON.stringify({ type: "response.output_audio.done" }) });
    socket.fire("message", {
      data: JSON.stringify({ type: "response.output_audio.delta", delta: "AAAAAA==" }),
    });
    socket.fire("message", { data: JSON.stringify({ type: "response.done" }) });

    for (const source of playbackSources) source.end();
    expect(session.state).toBe("listening");
  });

  it("gives up on playback that stops draining, and hears the user again", async () => {
    // The phone locked, took a call, or changed output route: the AudioContext
    // is suspended, so buffers scheduled into it never reach their end time and
    // never report `ended`. Nothing else reopens the microphone, so this is the
    // shape the user sees — "Speaking", deaf, with the reply long finished.
    vi.useFakeTimers();
    try {
      const { socket, session, processors } = await openGrokSession(makeTrack(), undefined, {
        interruptWhileSpeaking: false,
      });
      const processor = processors[0];
      if (processor === undefined) throw new Error("expected Grok capture");
      const speak = () =>
        processor.onaudioprocess?.({
          inputBuffer: { getChannelData: () => new Float32Array(8).fill(0.2) },
        });

      beginSpeaking(socket, session);
      socket.fire("message", { data: JSON.stringify({ type: "response.output_audio.done" }) });
      // Half duplex stops uploading capture for the duration of the reply.
      socket.send.mockClear();
      speak();
      expect(sentSocketTypes(socket)).not.toContain("input_audio_buffer.append");

      // No source ever fires `ended`.
      await vi.advanceTimersByTimeAsync(PLAYBACK_DRAIN_GRACE_MS + 1_000);

      expect(session.state).toBe("listening");
      socket.send.mockClear();
      speak();
      expect(sentSocketTypes(socket)).toContain("input_audio_buffer.append");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cut playback short while chunks are still arriving", async () => {
    // The deadline is a last resort. A reply that keeps streaming must keep
    // pushing it out, or the watchdog becomes the thing that truncates replies.
    vi.useFakeTimers();
    try {
      const { socket, session } = await openGrokSession();
      beginSpeaking(socket, session);

      for (let chunk = 0; chunk < 5; chunk += 1) {
        await vi.advanceTimersByTimeAsync(PLAYBACK_DRAIN_GRACE_MS - 200);
        // Checked in the gap, before the next chunk: a delta re-enters
        // "speaking" by itself, so asserting after one would hide a deadline
        // that had already fired and dropped the session back to listening.
        expect(session.state).toBe("speaking");
        socket.fire("message", {
          data: JSON.stringify({ type: "response.output_audio.delta", delta: "AAAAAA==" }),
        });
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
