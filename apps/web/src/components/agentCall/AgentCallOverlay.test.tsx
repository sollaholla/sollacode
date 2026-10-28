// @vitest-environment happy-dom

import {
  AGENT_CALL_DELEGATION_PATH,
  AGENT_CALL_HEARTBEAT_SECONDS,
  AGENT_CALL_NATIVE_MESSAGE_TYPE,
  AGENT_CALL_SESSION_HEARTBEAT_PATH,
  AGENT_CALL_SESSION_PATH,
  AGENT_CALL_SESSION_RELEASE_PATH,
  AgentCallId,
  VmAgentId,
  type AgentCall,
  type VmAgent,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { VoiceSessionCallbacks, VoiceSessionOptions } from "~/orchestrator/realtimeSession";

const mocks = vi.hoisted(() => {
  const tokens = {
    place: Symbol.for("agent-call-place"),
    decline: Symbol.for("agent-call-decline"),
    end: Symbol.for("agent-call-end"),
  };
  const session = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    announce: vi.fn(() => true),
    endAfterReply: vi.fn(),
    hush: vi.fn(),
    setMuted: vi.fn(),
    state: "idle" as string,
  };
  const ringtoneStop = vi.fn();
  return {
    tokens,
    session,
    ringtoneStop,
    calls: [] as Array<unknown>,
    agent: null as unknown,
    placeCall: vi.fn(async () => ({ _tag: "Success" as const, value: undefined })),
    declineCall: vi.fn(async () => ({ _tag: "Success" as const, value: undefined })),
    endCall: vi.fn(async (_request: unknown) => ({ _tag: "Success" as const, value: undefined })),
    createLiveVoiceSession: vi.fn((_options: unknown, _callbacks: unknown) => session),
    startRingtone: vi.fn((_input: unknown) => ({ stop: ringtoneStop })),
    navigate: vi.fn(),
    closeCallNotifications: vi.fn(),
    params: { environmentId: "host-1", callId: "call-1" },
    search: {} as Record<string, unknown>,
    connected: true,
  };
});

vi.mock("~/state/vmAgents", () => ({
  vmAgentEnvironment: {
    placeCall: mocks.tokens.place,
    declineCall: mocks.tokens.decline,
    endCall: mocks.tokens.end,
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === mocks.tokens.place
      ? mocks.placeCall
      : command === mocks.tokens.decline
        ? mocks.declineCall
        : mocks.endCall,
}));

vi.mock("~/agentCall/agentCallData", () => ({
  useEnvironmentAgentCalls: () => mocks.calls,
  useAgentRecord: () => mocks.agent,
}));

vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: "host-1" }] }),
  usePrimaryEnvironmentId: () => "host-1",
}));

vi.mock("~/state/session", () => ({
  readPreparedConnection: () =>
    mocks.connected ? { httpBaseUrl: "https://host.example", httpAuthorization: null } : null,
}));

vi.mock("~/orchestrator/OrchestratorSessionProvider", () => ({
  useOrchestratorSessionContext: () => null,
}));

vi.mock("~/orchestrator/useOrchestratorSession", () => ({
  fetchRecentThreadHistory: async () => [{ role: "assistant", text: "Earlier reply" }],
}));

vi.mock("~/orchestrator/liveSession", () => ({
  createLiveVoiceSession: mocks.createLiveVoiceSession,
}));

vi.mock("~/agentCall/ringtone", () => ({ startRingtone: mocks.startRingtone }));

vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => ({ soundCues: true, soundCueVolume: 80 }),
}));

vi.mock("~/browser/webPush", () => ({
  isBrowserPushEnabled: () => false,
  closeCallNotifications: mocks.closeCallNotifications,
}));

vi.mock("~/components/agents/AgentGlyph", () => ({
  AgentGlyph: (props: { readonly mood?: string }) => (
    <img alt="" data-testid="agent-glyph" data-mood={props.mood ?? "idle"} />
  ),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useLocation: (options: {
    readonly select: (location: { pathname: string; search: object }) => unknown;
  }) => options.select({ pathname: "/", search: {} }),
  useParams: (options?: { readonly select?: (params: object) => unknown }) =>
    options?.select ? options.select(mocks.params) : mocks.params,
  useSearch: () => mocks.search,
  useRouter: () => ({ history: { back: vi.fn() } }),
  useCanGoBack: () => false,
}));

vi.mock("~/components/agentCall/AgentCallButton", () => ({
  AGENT_CALL_NEEDS_KEY_HINT: "Add an OpenAI key",
  useAgentCallsAvailable: () => true,
}));

import { AgentCallProvider } from "~/agentCall/AgentCallProvider";
import { AgentCallOverlay } from "./AgentCallOverlay";
import { AgentCallRoute } from "./AgentCallRoute";

const ringingCall: AgentCall = {
  callId: AgentCallId.make("call-1"),
  vmAgentId: VmAgentId.make("agent-1"),
  direction: "incoming",
  reason: "approval",
  topic: "The deploy needs your approval",
  status: "ringing",
  answeredBy: null,
  createdAt: new Date(Date.now() - 2_000).toISOString(),
  answeredAt: null,
  endedAt: null,
  expiresAt: new Date(Date.now() + 40_000).toISOString(),
};

const nova = {
  vmAgentId: VmAgentId.make("agent-1"),
  name: "Nova",
  avatarColor: 2,
  threadId: "thread-1",
} as unknown as VmAgent;

let container: HTMLDivElement;
let root: Root;

function render(options: { readonly route?: boolean } = {}) {
  act(() => {
    root.render(
      <AgentCallProvider>
        {options.route ? <AgentCallRoute /> : null}
        <AgentCallOverlay />
      </AgentCallProvider>,
    );
  });
}

/** The callbacks the provider handed the (mocked) GPT-Live session. */
function sessionCallbacks(): VoiceSessionCallbacks {
  return mocks.createLiveVoiceSession.mock.calls.at(-1)![1] as VoiceSessionCallbacks;
}

/** Replaces the host's snapshot, as its call stream would. */
function hostReports(calls: ReadonlyArray<AgentCall>) {
  mocks.calls = [...calls];
  render();
}

async function answer() {
  await act(async () => {
    button("Answer").click();
  });
}

/** The session failing to start: its error, then the state change. */
async function failSession(message: string) {
  mocks.session.state = "error";
  await act(async () => {
    sessionCallbacks().onError?.(message);
    sessionCallbacks().onStateChange?.("error");
  });
}

const activeCall: AgentCall = {
  ...ringingCall,
  status: "active",
  answeredBy: "iPhone",
  answeredAt: new Date().toISOString(),
  expiresAt: null,
};

/** The host accepted this device's claim: its session reported usage. */
async function claimed() {
  await act(async () => {
    sessionCallbacks().onLiveUsage?.({ sessionId: "session-1", seconds: 0, finalized: false });
  });
}

/** Every end this device sent the host. */
function endsSent() {
  return mocks.endCall.mock.calls.map(([request]) => request);
}

function button(label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`No "${label}" button`);
  return found;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.calls = [ringingCall];
  mocks.agent = nova;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mocks.session.state = "idle";
  mocks.search = {};
  mocks.connected = true;
  delete (window as { ReactNativeWebView?: unknown }).ReactNativeWebView;
});

describe("incoming agent call", () => {
  it("rings with Answer and Decline, and Decline declines it on the host", async () => {
    render();
    const sheet = container.querySelector('[data-testid="agent-call-incoming"]');
    expect(sheet?.textContent).toContain("Nova is calling");
    expect(sheet?.textContent).toContain("The deploy needs your approval");
    expect(sheet?.textContent).toContain("Needs your approval");
    expect(button("Answer")).toBeTruthy();
    expect(mocks.startRingtone).toHaveBeenCalledWith(
      expect.objectContaining({ tone: true, vibrate: true }),
    );

    await act(async () => {
      button("Decline").click();
    });

    expect(mocks.declineCall).toHaveBeenCalledWith({
      environmentId: "host-1",
      input: { callId: "call-1" },
    });
    expect(container.querySelector('[data-testid="agent-call-incoming"]')).toBeNull();
    expect(mocks.ringtoneStop).toHaveBeenCalled();
    expect(mocks.createLiveVoiceSession).not.toHaveBeenCalled();
  });

  it("answers on the call's own GPT-Live routes, and End before connecting cancels the ring", async () => {
    render();
    await act(async () => {
      button("Answer").click();
    });

    expect(mocks.createLiveVoiceSession).toHaveBeenCalledOnce();
    const options = mocks.createLiveVoiceSession.mock.calls[0]![0] as VoiceSessionOptions;
    expect(options.httpBaseUrl).toBe("https://host.example");
    expect(options.live).toMatchObject({
      sessionPath: AGENT_CALL_SESSION_PATH,
      releasePath: AGENT_CALL_SESSION_RELEASE_PATH,
      delegationPath: AGENT_CALL_DELEGATION_PATH,
    });
    await expect(options.live?.startBody?.()).resolves.toEqual({
      callId: "call-1",
      history: [{ role: "assistant", text: "Earlier reply" }],
    });
    expect(mocks.session.start).toHaveBeenCalledOnce();

    // The ringing sheet gives way to the call screen.
    expect(container.querySelector('[data-testid="agent-call-incoming"]')).toBeNull();
    const screen = container.querySelector('[data-testid="agent-call-screen"]');
    expect(screen?.textContent).toContain("Nova");
    expect(screen?.textContent).toContain("Connecting…");
    expect(container.querySelector('[data-testid="agent-glyph"]')?.getAttribute("data-mood")).toBe(
      "waiting",
    );

    await act(async () => {
      button("End").click();
    });
    expect(mocks.session.stop).toHaveBeenCalled();
    // Never claimed here: ends the call only while it still rings.
    expect(endsSent()).toEqual([
      { environmentId: "host-1", input: { callId: "call-1", ifRinging: true } },
    ]);
    expect(container.textContent).toContain("Call ended");
    // The host's snapshot still has it ringing until the cancel lands.
    expect(mocks.calls).toEqual([ringingCall]);
    expect(container.querySelector('[data-testid="agent-call-incoming"]')).toBeNull();
    expect(mocks.startRingtone).toHaveBeenCalledOnce();
  });

  it("hangs up a call this device holds through the host", async () => {
    render();
    await answer();
    await claimed();
    await act(async () => {
      button("End").click();
    });
    expect(endsSent()).toEqual([{ environmentId: "host-1", input: { callId: "call-1" } }]);
  });
});

describe("who ends a call on the host", () => {
  it("never hangs up a call another device answered while this one was connecting", async () => {
    render();
    await answer();
    // The laptop answered first; this device's start has not come back.
    hostReports([activeCall]);
    await act(async () => {
      button("End").click();
    });
    expect(mocks.session.stop).toHaveBeenCalled();
    expect(endsSent()).toEqual([
      { environmentId: "host-1", input: { callId: "call-1", ifRinging: true } },
    ]);
  });

  it("leaves a joined call alone when the host refuses the claim", async () => {
    mocks.calls = [{ ...ringingCall, direction: "outgoing", reason: "user", topic: null }];
    render({ route: true });
    await act(async () => {
      button("Join").click();
    });
    expect(mocks.createLiveVoiceSession).toHaveBeenCalledOnce();
    await act(async () => {
      sessionCallbacks().onStartRefused?.("Answered on Mac");
    });
    expect(mocks.session.stop).toHaveBeenCalled();
    expect(mocks.endCall).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Answered on Mac");
  });

  it("leaves an answer alone when this host is not connected", async () => {
    mocks.connected = false;
    render();
    await answer();
    expect(mocks.createLiveVoiceSession).not.toHaveBeenCalled();
    expect(mocks.endCall).not.toHaveBeenCalled();
    expect(container.textContent).toContain("This host is not connected.");
  });

  it("cancels the ring of a call it placed that failed to connect, and nothing after a refused start", async () => {
    const ended: AgentCall = { ...activeCall, status: "ended", endedAt: new Date().toISOString() };
    const placed: AgentCall = {
      ...ringingCall,
      callId: AgentCallId.make("call-9"),
      direction: "outgoing",
      reason: "user",
    };
    mocks.calls = [ended];
    mocks.placeCall
      .mockResolvedValueOnce({ _tag: "Success", value: placed } as never)
      .mockResolvedValueOnce({ _tag: "Success", value: placed } as never);
    const place = async () => {
      await act(async () => {
        button("Call back").click();
      });
      const options = mocks.createLiveVoiceSession.mock.calls.at(-1)![0] as VoiceSessionOptions;
      await act(async () => {
        await options.live?.startBody?.();
      });
    };
    render({ route: true });
    await place();
    await failSession("Microphone access was denied.");
    expect(endsSent()).toEqual([
      { environmentId: "host-1", input: { callId: "call-9", ifRinging: true } },
    ]);

    mocks.endCall.mockClear();
    mocks.session.state = "idle";
    await act(async () => {
      button("Close").click();
    });
    await place();
    await act(async () => {
      sessionCallbacks().onStartRefused?.("Answered on iPhone");
    });
    expect(mocks.endCall).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Answered on iPhone");
  });
});

describe("call liveness", () => {
  it("renews the call's lease while it runs", async () => {
    render();
    await answer();
    const options = mocks.createLiveVoiceSession.mock.calls[0]![0] as VoiceSessionOptions;
    expect(options.live?.heartbeat).toEqual({
      path: AGENT_CALL_SESSION_HEARTBEAT_PATH,
      everySeconds: AGENT_CALL_HEARTBEAT_SECONDS,
    });
  });

  it("ends the call as dropped when the host refuses its session, without hanging up there", async () => {
    render();
    await answer();
    await act(async () => {
      sessionCallbacks().onSessionGone?.();
    });
    expect(mocks.session.stop).toHaveBeenCalled();
    expect(mocks.endCall).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="agent-call-screen"]')?.textContent).toContain(
      "The call dropped.",
    );
  });

  it("stops the call when the host forgets it (a restart)", async () => {
    render();
    await answer();
    hostReports([activeCall]);
    expect(mocks.session.stop).not.toHaveBeenCalled();
    hostReports([]);
    expect(mocks.session.stop).toHaveBeenCalled();
    expect(mocks.endCall).not.toHaveBeenCalled();
    expect(container.textContent).toContain("The call dropped.");
  });

  it("waits for a placed call to reach the host's snapshot before judging it", async () => {
    const ended: AgentCall = { ...activeCall, status: "ended", endedAt: new Date().toISOString() };
    const placed: AgentCall = {
      ...ringingCall,
      callId: AgentCallId.make("call-9"),
      direction: "outgoing",
      reason: "user",
    };
    mocks.calls = [ended];
    mocks.placeCall.mockResolvedValueOnce({ _tag: "Success", value: placed } as never);
    render({ route: true });
    await act(async () => {
      button("Call back").click();
    });
    const options = mocks.createLiveVoiceSession.mock.calls[0]![0] as VoiceSessionOptions;
    await act(async () => {
      await options.live?.startBody?.();
    });
    // Placed, but the host's snapshot has not caught up yet: nothing to judge.
    hostReports([ended]);
    expect(mocks.session.stop).not.toHaveBeenCalled();
    hostReports([placed, ended]);
    hostReports([ended]);
    expect(mocks.session.stop).toHaveBeenCalled();
    expect(container.textContent).toContain("The call dropped.");
  });

  it("shows a host-side failure with its reason, not as an ordinary hang-up", async () => {
    render();
    await answer();
    hostReports([activeCall]);
    hostReports([{ ...activeCall, status: "failed", endedAt: new Date().toISOString() }]);
    expect(mocks.session.stop).toHaveBeenCalled();
    const screen = container.querySelector('[data-testid="agent-call-screen"]');
    expect(screen?.textContent).toContain("The call could not connect.");
    expect(screen?.textContent).not.toContain("Call ended");
  });

  it("clears a call's notifications once it stops ringing", () => {
    render();
    expect(mocks.closeCallNotifications).not.toHaveBeenCalled();
    hostReports([activeCall]);
    expect(mocks.closeCallNotifications).toHaveBeenCalledWith("call-1");
  });

  it("does not ring again over a failed answer", async () => {
    render();
    expect(mocks.startRingtone).toHaveBeenCalledOnce();
    await answer();
    await failSession("Microphone access was denied.");
    // The host still has it ringing for the other devices.
    hostReports([ringingCall]);
    expect(container.querySelector('[data-testid="agent-call-incoming"]')).toBeNull();
    expect(container.textContent).toContain("Microphone access was denied.");
    expect(mocks.startRingtone).toHaveBeenCalledOnce();
    expect(mocks.endCall).not.toHaveBeenCalled();
    // Closing the error does not bring the ring back either.
    await act(async () => {
      button("Close").click();
    });
    expect(container.querySelector('[data-testid="agent-call-incoming"]')).toBeNull();
    expect(mocks.startRingtone).toHaveBeenCalledOnce();
  });

  it("fails, without ringing again, an answer whose session closed itself before connecting", async () => {
    render();
    await answer();
    // The microphone went away while connecting: the session reports why,
    // then closes itself to idle rather than to an error.
    await act(async () => {
      sessionCallbacks().onError?.(
        "The microphone disconnected. Reconnect it and start voice again.",
      );
      sessionCallbacks().onStateChange?.("idle");
    });
    expect(mocks.session.stop).toHaveBeenCalled();
    // The host still has it ringing for the other devices.
    hostReports([ringingCall]);
    expect(container.querySelector('[data-testid="agent-call-incoming"]')).toBeNull();
    expect(mocks.startRingtone).toHaveBeenCalledOnce();
    expect(mocks.endCall).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="agent-call-screen"]')?.textContent).toContain(
      "The microphone disconnected.",
    );
  });
});

describe("call page", () => {
  it("offers its own silent Answer for a ring the overlay stopped ringing here", async () => {
    render({ route: true });
    // The overlay rings it, so the page adds no second sheet.
    expect(container.querySelectorAll('[data-testid="agent-call-incoming"]')).toHaveLength(1);
    render();
    await answer();
    await failSession("Microphone access was denied.");
    await act(async () => {
      button("Close").click();
    });
    // Still ringing on the host: the page lets this device try again, silently.
    render({ route: true });
    expect(container.querySelectorAll('[data-testid="agent-call-incoming"]')).toHaveLength(1);
    expect(mocks.startRingtone).toHaveBeenCalledOnce();
    await answer();
    expect(mocks.createLiveVoiceSession).toHaveBeenCalledTimes(2);
  });

  it("ends a call held on another device", async () => {
    mocks.calls = [activeCall];
    render({ route: true });
    expect(container.textContent).toContain("Answered on iPhone.");
    await act(async () => {
      button("End call").click();
    });
    expect(mocks.endCall).toHaveBeenCalledWith({
      environmentId: "host-1",
      input: { callId: "call-1" },
    });
  });

  it("offers Call back for a finished call, except inside the phone app's call screen", () => {
    mocks.calls = [{ ...activeCall, status: "ended", endedAt: new Date().toISOString() }];
    render({ route: true });
    expect(container.querySelector('button[aria-label="Call back"]')).not.toBeNull();
    mocks.search = { embedded: "1" };
    render({ route: true });
    expect(container.querySelector('button[aria-label="Call back"]')).toBeNull();
  });
});

describe("inside the phone app", () => {
  function phoneApp() {
    const postMessage = vi.fn();
    Object.defineProperty(window, "ReactNativeWebView", {
      configurable: true,
      value: { postMessage },
    });
    mocks.search = { embedded: "1" };
    return {
      messages: () =>
        postMessage.mock.calls.map(([raw]) => JSON.parse(String(raw)) as Record<string, unknown>),
    };
  }

  it("never rings: the native app owns incoming calls", () => {
    phoneApp();
    render();
    expect(container.querySelector('[data-testid="agent-call-incoming"]')).toBeNull();
    expect(mocks.startRingtone).not.toHaveBeenCalled();
  });

  it("answers its own call from the call page and tells the native screen it holds it", async () => {
    const app = phoneApp();
    render({ route: true });
    // The page's own Answer, silent: the native screen buzzes.
    expect(container.querySelectorAll('[data-testid="agent-call-incoming"]')).toHaveLength(1);
    expect(mocks.startRingtone).not.toHaveBeenCalled();
    await answer();
    expect(app.messages()).toEqual([
      { type: AGENT_CALL_NATIVE_MESSAGE_TYPE, event: "held", callId: "call-1" },
    ]);
    await act(async () => {
      button("End").click();
    });
    expect(app.messages().at(-1)).toEqual({
      type: AGENT_CALL_NATIVE_MESSAGE_TYPE,
      event: "released",
      callId: "call-1",
    });
  });

  it("tells the native screen once the host gives it the call", async () => {
    const app = phoneApp();
    render({ route: true });
    await answer();
    await claimed();
    await claimed();
    expect(app.messages()).toEqual([
      { type: AGENT_CALL_NATIVE_MESSAGE_TYPE, event: "held", callId: "call-1" },
      { type: AGENT_CALL_NATIVE_MESSAGE_TYPE, event: "connected", callId: "call-1" },
    ]);
  });

  it("reports a failure with its reason", async () => {
    const app = phoneApp();
    render({ route: true });
    await answer();
    await failSession("Answered on Mac");
    expect(app.messages().at(-1)).toEqual({
      type: AGENT_CALL_NATIVE_MESSAGE_TYPE,
      event: "failed",
      callId: "call-1",
      detail: "Answered on Mac",
    });
  });
});
