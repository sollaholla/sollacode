// @vitest-environment happy-dom

import {
  AGENT_CALL_DELEGATION_PATH,
  AGENT_CALL_HEARTBEAT_SECONDS,
  AGENT_CALL_NATIVE_MESSAGE_TYPE,
  AGENT_CALL_SESSION_HEARTBEAT_PATH,
  AGENT_CALL_SESSION_PATH,
  AGENT_CALL_SESSION_RELEASE_PATH,
  AgentCallId,
  ThreadId,
  VmAgentId,
  type AgentCall,
  type AgentCallParticipant,
  type AgentCallRosterEntry,
  type VmAgent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { VoiceSessionCallbacks, VoiceSessionOptions } from "~/orchestrator/realtimeSession";

const mocks = vi.hoisted(() => {
  const tokens = {
    place: Symbol.for("agent-call-place"),
    decline: Symbol.for("agent-call-decline"),
    end: Symbol.for("agent-call-end"),
    roster: Symbol.for("agent-call-roster"),
    add: Symbol.for("agent-call-add-participant"),
    remove: Symbol.for("agent-call-remove-participant"),
  };
  const session = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    announce: vi.fn(() => true),
    endAfterReply: vi.fn(),
    hush: vi.fn(),
    setMuted: vi.fn(),
    setMicrophone: vi.fn(),
    instruct: vi.fn((_text: string) => undefined),
    state: "idle" as string,
  };
  const ringtoneStop = vi.fn();
  const ringbackStop = vi.fn();
  const roster = { entries: [] as Array<unknown> };
  return {
    tokens,
    session,
    ringtoneStop,
    ringbackStop,
    roster,
    calls: [] as Array<unknown>,
    agent: null as unknown,
    /** The host's agent registry. */
    agents: [] as Array<{ readonly vmAgentId: string }>,
    placeCall: vi.fn(async () => ({ _tag: "Success" as const, value: undefined })),
    declineCall: vi.fn(async () => ({ _tag: "Success" as const, value: undefined })),
    endCall: vi.fn(async (_request: unknown) => ({ _tag: "Success" as const, value: undefined })),
    callRoster: vi.fn(async (_request: unknown) => ({ _tag: "Success" as const, value: roster })),
    addCallParticipant: vi.fn(
      async (_request: unknown): Promise<unknown> => ({ _tag: "Success", value: undefined }),
    ),
    removeCallParticipant: vi.fn(
      async (_request: unknown): Promise<unknown> => ({ _tag: "Success", value: undefined }),
    ),
    createLiveVoiceSession: vi.fn((_options: unknown, _callbacks: unknown) => session),
    startRingtone: vi.fn((_input: unknown) => ({ stop: ringtoneStop })),
    startRingback: vi.fn((_input: unknown) => ({ stop: ringbackStop })),
    playHangUpTone: vi.fn((_volume: number) => undefined),
    navigate: vi.fn(),
    closeCallNotifications: vi.fn(),
    params: { environmentId: "host-1", callId: "call-1" },
    search: {} as Record<string, unknown>,
    connected: true,
    /** Settles when the host's connection is ready (or gives up). */
    connecting: Promise.resolve() as Promise<void>,
  };
});

vi.mock("~/state/vmAgents", () => ({
  vmAgentEnvironment: {
    placeCall: mocks.tokens.place,
    declineCall: mocks.tokens.decline,
    endCall: mocks.tokens.end,
    callRoster: mocks.tokens.roster,
    addCallParticipant: mocks.tokens.add,
    removeCallParticipant: mocks.tokens.remove,
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    new Map<unknown, unknown>([
      [mocks.tokens.place, mocks.placeCall],
      [mocks.tokens.decline, mocks.declineCall],
      [mocks.tokens.end, mocks.endCall],
      [mocks.tokens.roster, mocks.callRoster],
      [mocks.tokens.add, mocks.addCallParticipant],
      [mocks.tokens.remove, mocks.removeCallParticipant],
    ]).get(command),
}));

vi.mock("~/agentCall/agentCallData", () => ({
  useEnvironmentAgentCalls: () => mocks.calls,
  useAgentRecord: (_environmentId: unknown, vmAgentId: string | null) =>
    mocks.agents.find((agent) => agent.vmAgentId === vmAgentId) ?? mocks.agent,
  useEnvironmentAgents: () => mocks.agents,
}));

vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: "host-1" }] }),
  usePrimaryEnvironmentId: () => "host-1",
}));

vi.mock("~/state/session", () => ({
  awaitPreparedConnection: async () => {
    await mocks.connecting;
    return mocks.connected
      ? { httpBaseUrl: "https://host.example", httpAuthorization: null }
      : null;
  },
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

vi.mock("~/agentCall/ringtone", () => ({
  startRingtone: mocks.startRingtone,
  startRingback: mocks.startRingback,
  playHangUpTone: mocks.playHangUpTone,
}));

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
  mocks.agents = [];
  mocks.roster.entries = [];
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
  mocks.connecting = Promise.resolve();
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

describe("hang-up sound", () => {
  it("plays when a connected call ends, from either side, and not for a ring that never connected", async () => {
    render();
    await answer();
    expect(mocks.playHangUpTone).not.toHaveBeenCalled();
    await claimed();
    await act(async () => {
      mocks.session.state = "listening";
      sessionCallbacks().onStateChange?.("listening");
    });
    await act(async () => {
      button("End").click();
    });
    expect(mocks.playHangUpTone).toHaveBeenCalledOnce();
  });

  it("stays quiet when an answer fails before it connects", async () => {
    render();
    await answer();
    await failSession("Microphone access was denied.");
    expect(mocks.playHangUpTone).not.toHaveBeenCalled();
  });
});

describe("microphone choice", () => {
  it("offers the microphones on Mute and moves the call to the one chosen", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: {
        enumerateDevices: async () => [
          { deviceId: "default", groupId: "g-mac", kind: "audioinput", label: "Default - Mac" },
          { deviceId: "mac", groupId: "g-mac", kind: "audioinput", label: "Mac" },
          { deviceId: "air", groupId: "g-air", kind: "audioinput", label: "AirPods" },
        ],
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    });
    render();
    await answer();
    await claimed();
    await act(async () => {
      button("Choose microphone").click();
    });
    const airPods = await vi.waitFor(() => {
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
        (element) => element.textContent?.includes("AirPods"),
      );
      if (!item) throw new Error("AirPods not offered");
      return item;
    });
    expect(document.body.textContent).toContain("Mac, follows your system");
    await act(async () => {
      airPods.click();
    });
    expect(mocks.session.setMicrophone).toHaveBeenCalledWith("air");
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

  it("waits for a host that is still connecting before opening voice", async () => {
    let ready = () => {};
    mocks.connecting = new Promise<void>((resolve) => {
      ready = resolve;
    });
    render();
    await answer();
    expect(mocks.createLiveVoiceSession).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("This host is not connected.");
    await act(async () => {
      ready();
    });
    expect(mocks.createLiveVoiceSession).toHaveBeenCalledOnce();
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

describe("calling an agent", () => {
  it("rings out until the agent picks up, then the agent says hello", async () => {
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
    expect(mocks.startRingback).toHaveBeenCalledOnce();
    expect(mocks.ringbackStop).not.toHaveBeenCalled();
    const options = mocks.createLiveVoiceSession.mock.calls.at(-1)![0] as VoiceSessionOptions;
    await act(async () => {
      await options.live?.startBody?.();
    });
    await act(async () => {
      mocks.session.state = "listening";
      sessionCallbacks().onStateChange?.("listening");
    });
    expect(mocks.ringbackStop).toHaveBeenCalledOnce();
    expect(mocks.session.announce).toHaveBeenCalledWith(
      expect.stringContaining('one short, casual hello such as "Hey, what\'s up?"'),
    );
    expect(mocks.startRingback).toHaveBeenCalledOnce();
  });

  it("never rings out for a call the agent placed", async () => {
    await goLive();
    expect(mocks.startRingback).not.toHaveBeenCalled();
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
    mocks.calls = [
      {
        ...activeCall,
        participants: [{ threadId: ThreadId.make("thread-2"), title: "Gregg", vmAgentId: null }],
      },
    ];
    render({ route: true });
    expect(container.textContent).toContain("Answered on iPhone. Also on the call: Gregg.");
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

const greggEntry: AgentCallRosterEntry = {
  name: "Gregg",
  threadId: ThreadId.make("thread-2"),
  vmAgentId: VmAgentId.make("agent-2"),
};
const notesEntry: AgentCallRosterEntry = {
  name: "Release notes",
  threadId: ThreadId.make("thread-3"),
  vmAgentId: null,
};
const participantFor = (entry: AgentCallRosterEntry): AgentCallParticipant => ({
  threadId: entry.threadId,
  title: entry.name,
  vmAgentId: entry.vmAgentId,
});

/** Answers the ringing call, has the host give it to this device, and connects voice. */
async function goLive(options: { readonly route?: boolean } = {}) {
  render(options);
  await answer();
  await claimed();
  hostReports([activeCall]);
  await act(async () => {
    mocks.session.state = "listening";
    sessionCallbacks().onStateChange?.("listening");
  });
  // The roster, asked for once the call is live.
  await act(async () => undefined);
}

/** The voice finished saying something. */
async function voiceSays(text: string) {
  await act(async () => {
    sessionCallbacks().onTranscript?.({ role: "assistant", text });
  });
}

function callScreenText() {
  return container.querySelector('[data-testid="agent-call-screen"]')?.textContent ?? "";
}

describe("transfer by voice", () => {
  it("moves the call to the agent the voice names: a quiet plain end, then a call to them", async () => {
    const postMessage = vi.fn();
    Object.defineProperty(window, "ReactNativeWebView", {
      configurable: true,
      value: { postMessage },
    });
    mocks.search = { embedded: "1" };
    const gregg = { ...nova, vmAgentId: greggEntry.vmAgentId, name: "Gregg", threadId: "thread-2" };
    mocks.agents = [nova, gregg] as Array<VmAgent>;
    mocks.roster.entries = [greggEntry, notesEntry];
    const transferred: AgentCall = {
      ...ringingCall,
      callId: AgentCallId.make("call-2"),
      vmAgentId: greggEntry.vmAgentId!,
      direction: "outgoing",
      reason: "user",
      topic: null,
    };
    mocks.placeCall.mockResolvedValueOnce({ _tag: "Success", value: transferred } as never);
    await goLive({ route: true });
    await act(async () => button("Mute").click());
    mocks.session.setMuted.mockClear();
    expect(mocks.callRoster).toHaveBeenCalledWith({
      environmentId: "host-1",
      input: { callId: "call-1" },
    });

    await voiceSays("Sure thing. Transferring you to Greg.");
    expect(mocks.session.endAfterReply).toHaveBeenCalledOnce();
    expect(callScreenText()).toContain("Transferring to Gregg…");
    expect(mocks.endCall).not.toHaveBeenCalled();

    // The voice's last words are out: its session closes itself.
    await act(async () => {
      mocks.session.state = "idle";
      sessionCallbacks().onStateChange?.("idle");
    });
    expect(endsSent()).toEqual([{ environmentId: "host-1", input: { callId: "call-1" } }]);
    expect(mocks.playHangUpTone).not.toHaveBeenCalled();
    expect(callScreenText()).not.toContain("Call ended");
    expect(callScreenText()).toContain("Gregg");
    expect(callScreenText()).toContain("Calling…");

    expect(mocks.createLiveVoiceSession).toHaveBeenCalledTimes(2);
    expect(mocks.session.setMuted).toHaveBeenCalledWith(true);
    const options = mocks.createLiveVoiceSession.mock.calls[1]![0] as VoiceSessionOptions;
    await act(async () => {
      await expect(options.live?.startBody?.()).resolves.toMatchObject({ callId: "call-2" });
    });
    expect(mocks.placeCall).toHaveBeenCalledWith({
      environmentId: "host-1",
      input: { vmAgentId: "agent-2" },
    });
    const posted = postMessage.mock.calls.map(
      ([raw]) => JSON.parse(String(raw)) as Record<string, unknown>,
    );
    expect(posted.map((message) => `${String(message.event)}:${String(message.callId)}`)).toEqual([
      "held:call-1",
      "connected:call-1",
      "released:call-1",
      "held:call-2",
    ]);
    // The release says where the call went, so the phone app waits for it.
    expect(posted[2]?.detail).toBe("transfer:agent-2");
    // The page the person was on follows them to the new call.
    render({ route: true });
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/call/$environmentId/$callId",
      params: { environmentId: "host-1", callId: "call-2" },
      search: true,
      replace: true,
    });
  });

  it("reports a transfer the host refused against the old call, so the phone app shows why", async () => {
    const postMessage = vi.fn();
    Object.defineProperty(window, "ReactNativeWebView", {
      configurable: true,
      value: { postMessage },
    });
    mocks.search = { embedded: "1" };
    mocks.roster.entries = [greggEntry];
    mocks.placeCall.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("You're already on a call with Gregg.")),
    } as never);
    await goLive({ route: true });
    await voiceSays("Transferring you to Gregg.");
    await act(async () => {
      mocks.session.state = "idle";
      sessionCallbacks().onStateChange?.("idle");
    });
    const options = mocks.createLiveVoiceSession.mock.calls[1]![0] as VoiceSessionOptions;
    await act(async () => {
      await expect(options.live?.startBody?.()).rejects.toThrow();
    });
    const messages = () =>
      postMessage.mock.calls.map(([raw]) => JSON.parse(String(raw)) as Record<string, unknown>);
    // Said as soon as the host refuses, before the new session gives up
    // opening the microphone: the phone app's screen is about to close.
    expect(
      messages().map((message) => `${String(message.event)}:${String(message.callId)}`),
    ).toEqual(["held:call-1", "connected:call-1", "released:call-1", "failed:call-1"]);
    expect(messages().at(-1)?.detail).toBe("You're already on a call with Gregg.");
    // The new session fails as its start does; saying so again changes nothing.
    await act(async () => {
      mocks.session.state = "error";
      sessionCallbacks().onStateChange?.("error");
    });
    expect(messages().at(-1)).toMatchObject({
      event: "failed",
      callId: "call-1",
      detail: "You're already on a call with Gregg.",
    });
  });

  it("an End from another device while the transfer is announced ends the call there", async () => {
    mocks.roster.entries = [greggEntry];
    await goLive();
    await voiceSays("Transferring you to Gregg.");
    expect(callScreenText()).toContain("Transferring to Gregg…");

    // Another device ends the call before this one's voice finishes.
    hostReports([{ ...activeCall, status: "ended", endedAt: new Date().toISOString() }]);
    await act(async () => {
      mocks.session.state = "idle";
      sessionCallbacks().onStateChange?.("idle");
    });
    expect(mocks.placeCall).not.toHaveBeenCalled();
    expect(mocks.createLiveVoiceSession).toHaveBeenCalledOnce();
    expect(callScreenText()).toContain("Call ended");
    expect(callScreenText()).not.toContain("Transferring to");
  });

  it("does nothing for a name that is not an agent on the roster", async () => {
    mocks.roster.entries = [greggEntry, notesEntry];
    await goLive();
    await voiceSays("Transferring you to Release notes.");
    await voiceSays("Transferring you to Morgan.");
    expect(mocks.session.endAfterReply).not.toHaveBeenCalled();
    expect(callScreenText()).not.toContain("Transferring to");
  });
});

describe("people on the call", () => {
  it("teaches the voice who it can transfer to or add once the roster arrives", async () => {
    mocks.roster.entries = [greggEntry, notesEntry];
    await goLive();
    const taught = mocks.session.instruct.mock.calls.map(([text]) => text);
    // One append each, the phrases before the names.
    expect(taught).toHaveLength(5);
    expect(taught[0]).toContain("'Transferring you to <Name>.'");
    expect(taught).toContain("Your transfer list: Gregg.");
    expect(taught.at(-1)).toBe("Your call list: Gregg, Release notes.");
  });

  it("teaches nothing when there is no one to name, or the host can't say", async () => {
    await goLive();
    expect(mocks.callRoster).toHaveBeenCalledOnce();
    expect(mocks.session.instruct).not.toHaveBeenCalled();
  });

  it("adds and removes whoever the voice names, and tells the voice once who joined or left", async () => {
    mocks.roster.entries = [greggEntry, notesEntry];
    await goLive();
    // Past teaching the roster (see above).
    mocks.session.instruct.mockClear();

    await voiceSays("Okay, adding release notes to the call.");
    expect(mocks.addCallParticipant).toHaveBeenCalledWith({
      environmentId: "host-1",
      input: { callId: "call-1", threadId: "thread-3" },
    });
    expect(mocks.session.instruct).not.toHaveBeenCalled();
    hostReports([{ ...activeCall, participants: [participantFor(notesEntry)] }]);
    expect(mocks.session.instruct).toHaveBeenCalledOnce();
    expect(mocks.session.instruct.mock.calls[0]![0]).toMatch(/^Release notes joined the call\./u);
    // The same snapshot again says nothing new.
    hostReports([{ ...activeCall, participants: [participantFor(notesEntry)] }]);
    expect(mocks.session.instruct).toHaveBeenCalledOnce();

    await voiceSays("Removing Release notes from the call.");
    expect(mocks.removeCallParticipant).toHaveBeenCalledWith({
      environmentId: "host-1",
      input: { callId: "call-1", threadId: "thread-3" },
    });
    hostReports([{ ...activeCall, participants: [] }]);
    expect(mocks.session.instruct).toHaveBeenLastCalledWith("Release notes left the call.");
    expect(mocks.session.instruct).toHaveBeenCalledTimes(2);
  });

  it("does nothing when the voice only sounds like it is adding someone", async () => {
    mocks.roster.entries = [greggEntry, notesEntry];
    await goLive();
    mocks.session.instruct.mockClear();
    await voiceSays("Gregg says the fetch fails, so he's adding a timeout to the call.");
    await voiceSays("Gregg says he wrapped the fetch, adding logging to the call.");
    expect(mocks.addCallParticipant).not.toHaveBeenCalled();
    expect(mocks.session.instruct).not.toHaveBeenCalled();
    expect(callScreenText()).not.toContain("call list");
  });

  it("adds everyone the voice names at once, and says who it couldn't find", async () => {
    const nova: AgentCallRosterEntry = {
      name: "Nova Bright",
      threadId: ThreadId.make("thread-4"),
      vmAgentId: VmAgentId.make("agent-4"),
    };
    mocks.roster.entries = [greggEntry, notesEntry, nova];
    await goLive();
    mocks.session.instruct.mockClear();
    const added = () =>
      mocks.addCallParticipant.mock.calls.map(
        ([request]) => (request as { input: { threadId: string } }).input.threadId,
      );

    await voiceSays("Sure. Adding Gregg to the call. Adding the release notes chat to the call.");
    expect(added()).toEqual(["thread-2", "thread-3"]);
    await voiceSays("Adding Gregg and Nova Bright to the call.");
    expect(added()).toEqual(["thread-2", "thread-3", "thread-2", "thread-4"]);
    expect(mocks.session.instruct).not.toHaveBeenCalled();

    // A name nobody on the list has: shown, and the voice is told to put it
    // right, even when someone else in the same phrase was added.
    await voiceSays("Okay, adding Release notes and Morgan to the call.");
    expect(added()).toHaveLength(5);
    expect(callScreenText()).toContain("No one called Morgan is on the call list.");
    expect(mocks.session.instruct).toHaveBeenCalledWith(
      "No one called Morgan is on the call list. Tell the person now, and ask who they meant.",
    );
  });

  it("shows why adding someone failed on the call screen", async () => {
    mocks.roster.entries = [greggEntry];
    mocks.addCallParticipant.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("Gregg's chat was archived.")),
    });
    await goLive();
    await voiceSays("Adding Gregg to the call.");
    expect(callScreenText()).toContain("Gregg's chat was archived.");
    expect(mocks.session.instruct).toHaveBeenCalledWith(
      "Gregg's chat was archived. Tell the person if they ask.",
    );
  });

  it("lists who else is on the call, takes them off, and adds from the roster", async () => {
    mocks.roster.entries = [greggEntry, notesEntry];
    await goLive();
    hostReports([{ ...activeCall, participants: [participantFor(greggEntry)] }]);
    expect(container.querySelector('[aria-label="Also on the call"]')?.textContent).toContain(
      "Gregg",
    );

    await act(async () => {
      button("Remove Gregg from the call").click();
    });
    expect(mocks.removeCallParticipant).toHaveBeenCalledWith({
      environmentId: "host-1",
      input: { callId: "call-1", threadId: "thread-2" },
    });

    await act(async () => {
      button("Add someone to the call").click();
    });
    const offered = await vi.waitFor(() => {
      const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      if (items.length === 0) throw new Error("No one offered");
      return items;
    });
    // Gregg is already on the call.
    expect(offered.map((item) => item.textContent)).toEqual(["Release notes"]);
    await act(async () => {
      offered[0]!.click();
    });
    expect(mocks.addCallParticipant).toHaveBeenCalledWith({
      environmentId: "host-1",
      input: { callId: "call-1", threadId: "thread-3" },
    });
  });

  it("says when there is no one else to add, and stops adding at the limit", async () => {
    mocks.roster.entries = [greggEntry];
    await goLive();
    hostReports([{ ...activeCall, participants: [participantFor(greggEntry)] }]);
    await act(async () => {
      button("Add someone to the call").click();
    });
    await vi.waitFor(() => {
      if (!document.body.textContent?.includes("No one else to add")) throw new Error("Not shown");
    });

    const full = ["a", "b", "c", "d"].map((id) => ({
      threadId: ThreadId.make(`thread-${id}`),
      title: `Chat ${id}`,
      vmAgentId: null,
    }));
    hostReports([{ ...activeCall, participants: full }]);
    const add = button("Add someone to the call");
    expect(add.disabled || add.hasAttribute("data-disabled")).toBe(true);
  });

  it("shows +N on the minimised call", async () => {
    await goLive();
    hostReports([{ ...activeCall, participants: [participantFor(notesEntry)] }]);
    await act(async () => {
      button("Minimise call").click();
    });
    const pill = container.querySelector('[data-testid="agent-call-pill"]');
    expect(pill?.textContent).toContain("+1");
    expect(button("Return to the call with Nova and 1 other")).toBeTruthy();
  });
});
