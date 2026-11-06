import {
  AgentCallId,
  EnvironmentId,
  ThreadId,
  VmAgentId,
  type AgentCall,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addableCallRoster,
  agentCallKey,
  agentCallSessionEnd,
  agentCallMood,
  agentCallStatusText,
  callElapsedSeconds,
  describeAgentCallElsewhere,
  endedAgentCallTitle,
  formatCallDuration,
  hostSettledCallOutcome,
  incomingCallOpening,
  isRingingOut,
  latestCaption,
  outgoingCallGreeting,
  nextRingBurstDelay,
  nextRingExpiry,
  openAgentCallElsewhere,
  ringAlerts,
  ringingCallForDevice,
  sameCallParticipants,
  shouldNotifyIncomingCall,
  trackRingingCalls,
} from "./agentCallLogic";

const environmentId = EnvironmentId.make("host-1");
const otherEnvironmentId = EnvironmentId.make("host-2");
const now = Date.parse("2026-10-28T12:00:00.000Z");

function call(id: string, overrides: Partial<AgentCall> = {}): AgentCall {
  return {
    callId: AgentCallId.make(id),
    vmAgentId: VmAgentId.make("agent-1"),
    direction: "incoming",
    reason: "blocker",
    topic: "Sign in to the bank",
    status: "ringing",
    answeredBy: null,
    createdAt: "2026-10-28T11:59:50.000Z",
    answeredAt: null,
    endedAt: null,
    expiresAt: "2026-10-28T12:00:30.000Z",
    ...overrides,
  };
}

describe("agentCallMood", () => {
  it("follows the stages of the call", () => {
    expect(agentCallMood({ phase: "placing", sessionState: "idle" })).toBe("waiting");
    expect(agentCallMood({ phase: "connecting", sessionState: "connecting" })).toBe("waiting");
    expect(agentCallMood({ phase: "failed", sessionState: "error" })).toBe("blocked");
    expect(agentCallMood({ phase: "ended", sessionState: "idle" })).toBe("idle");
  });

  it("holds still while people talk, so the orb never flickers with speech", () => {
    expect(agentCallMood({ phase: "live", sessionState: "speaking" })).toBe("idle");
    expect(agentCallMood({ phase: "live", sessionState: "listening" })).toBe("idle");
  });
});

describe("call timer and status", () => {
  it("formats like a phone's call timer", () => {
    expect(formatCallDuration(0)).toBe("00:00");
    expect(formatCallDuration(42.9)).toBe("00:42");
    expect(formatCallDuration(133)).toBe("02:13");
    expect(formatCallDuration(3_723)).toBe("1:02:03");
    expect(formatCallDuration(-5)).toBe("00:00");
    expect(formatCallDuration(Number.NaN)).toBe("00:00");
  });

  it("counts whole seconds from the start of the conversation", () => {
    expect(callElapsedSeconds(null, now)).toBeNull();
    expect(callElapsedSeconds(now - 42_600, now)).toBe(42);
    // A clock a little behind the host's never shows negative time.
    expect(callElapsedSeconds(now + 1_000, now)).toBe(0);
  });

  it("says calling, ringing, the timer, or how it ended", () => {
    const status = (
      phase: Parameters<typeof agentCallStatusText>[0]["phase"],
      direction: "outgoing" | "incoming" = "outgoing",
      elapsedSeconds: number | null = null,
      error: string | null = null,
    ) => agentCallStatusText({ phase, direction, elapsedSeconds, error });
    expect(status("placing")).toBe("Calling…");
    expect(status("connecting")).toBe("Ringing…");
    expect(status("connecting", "incoming")).toBe("Connecting…");
    expect(status("live", "outgoing", 42)).toBe("00:42");
    expect(status("live")).toBe("Connected");
    expect(status("ended")).toBe("Call ended");
    expect(status("failed")).toBe("Call failed");
    expect(status("failed", "incoming", null, "Answered on iPhone")).toBe("Answered on iPhone");
    expect(
      agentCallStatusText({
        phase: "live",
        direction: "outgoing",
        elapsedSeconds: 42,
        error: null,
        transferringTo: "Gregg",
      }),
    ).toBe("Transferring to Gregg…");
    expect(endedAgentCallTitle("missed")).toBe("Missed call");
    expect(endedAgentCallTitle("declined")).toBe("Call declined");
    expect(endedAgentCallTitle(null)).toBe("This call has ended");
  });

  it("captions the newest non-empty line", () => {
    expect(latestCaption([])).toBeNull();
    expect(
      latestCaption([
        { role: "user", text: "Can you check?" },
        { role: "assistant", text: "Sure, one moment." },
        { role: "user", text: "  " },
      ]),
    ).toEqual({ role: "assistant", text: "Sure, one moment." });
  });
});

describe("ringingCallForDevice", () => {
  const ring = (
    environments: Parameters<typeof ringingCallForDevice>[0]["environments"],
    overrides: Partial<Omit<Parameters<typeof ringingCallForDevice>[0], "environments">> = {},
  ) =>
    ringingCallForDevice({
      environments,
      activeCallKey: null,
      dismissed: new Set(),
      now,
      ...overrides,
    });

  it("rings for the newest incoming ringing call on any host", () => {
    const older = call("older", { createdAt: "2026-10-28T11:59:40.000Z" });
    const newer = call("newer", { createdAt: "2026-10-28T11:59:55.000Z" });
    expect(
      ring([
        { environmentId, calls: [older] },
        { environmentId: otherEnvironmentId, calls: [newer] },
      ]),
    ).toEqual({ environmentId: otherEnvironmentId, call: newer });
  });

  it("never rings for outgoing calls, answered or finished calls, or expired rings", () => {
    expect(
      ring([
        {
          environmentId,
          calls: [
            call("outgoing", { direction: "outgoing", reason: "user" }),
            call("answered", { status: "active", expiresAt: null }),
            call("missed", { status: "missed" }),
            call("expired", { expiresAt: "2026-10-28T11:59:59.000Z" }),
          ],
        },
      ]),
    ).toBeNull();
  });

  it("skips the call this device is on and calls declined here", () => {
    const first = call("first");
    const second = call("second", { createdAt: "2026-10-28T11:59:55.000Z" });
    const calls = [{ environmentId, calls: [first, second] }];
    expect(ring(calls, { activeCallKey: agentCallKey(environmentId, "second") })?.call).toBe(first);
    expect(
      ring(calls, {
        dismissed: new Set([agentCallKey(environmentId, "second")]),
      })?.call,
    ).toBe(first);
    // The same call id on another host is a different call.
    expect(
      ring([{ environmentId: otherEnvironmentId, calls: [second] }], {
        dismissed: new Set([agentCallKey(environmentId, "second")]),
      })?.call,
    ).toBe(second);
  });

  it("reports when the next ring runs out so the sheet can close on time", () => {
    expect(
      nextRingExpiry(
        [
          {
            environmentId,
            calls: [
              call("a", { expiresAt: "2026-10-28T12:00:30.000Z" }),
              call("b", { expiresAt: "2026-10-28T12:00:10.000Z" }),
              call("c", { status: "active", expiresAt: null }),
            ],
          },
        ],
        now,
      ),
    ).toBe(Date.parse("2026-10-28T12:00:10.000Z"));
    expect(nextRingExpiry([], now)).toBeNull();
  });
});

describe("ringtone decisions", () => {
  const on = { enabled: true, volume: 0.8 };

  it("rings and buzzes only while ringing and not already on a call", () => {
    expect(ringAlerts({ ringing: true, onCall: false, policy: on })).toEqual({
      tone: true,
      vibrate: true,
    });
    expect(ringAlerts({ ringing: true, onCall: true, policy: on })).toEqual({
      tone: false,
      vibrate: false,
    });
    expect(ringAlerts({ ringing: false, onCall: false, policy: on })).toEqual({
      tone: false,
      vibrate: false,
    });
  });

  it("follows the sound-cue switch and volume for the tone, not the vibration", () => {
    expect(
      ringAlerts({ ringing: true, onCall: false, policy: { enabled: false, volume: 1 } }),
    ).toEqual({ tone: false, vibrate: true });
    expect(
      ringAlerts({ ringing: true, onCall: false, policy: { enabled: true, volume: 0 } }),
    ).toEqual({ tone: false, vibrate: true });
  });

  it("schedules two seconds on, four off, and stops before the ring expires", () => {
    const startedAt = now;
    expect(nextRingBurstDelay({ startedAt, now, expiresAt: null })).toBe(0);
    expect(nextRingBurstDelay({ startedAt, now: now + 2_000, expiresAt: null })).toBe(4_000);
    expect(nextRingBurstDelay({ startedAt, now: now + 6_000, expiresAt: null })).toBe(0);
    expect(nextRingBurstDelay({ startedAt, now: now + 7_500, expiresAt: null })).toBe(4_500);
    expect(nextRingBurstDelay({ startedAt, now: now + 2_000, expiresAt: now + 5_000 })).toBeNull();
    expect(nextRingBurstDelay({ startedAt, now: now + 2_000, expiresAt: now + 7_000 })).toBe(4_000);
  });
});

describe("shouldNotifyIncomingCall", () => {
  const base = {
    hidden: true,
    focused: false,
    desktop: false,
    pushEnabled: false,
    permission: "granted" as const,
    alreadyShown: false,
  };

  it("notifies only when the ringing sheet cannot be seen", () => {
    expect(shouldNotifyIncomingCall(base)).toBe(true);
    expect(shouldNotifyIncomingCall({ ...base, hidden: false })).toBe(false);
    // A desktop window behind other windows is visible but unseen.
    expect(shouldNotifyIncomingCall({ ...base, hidden: false, desktop: true })).toBe(true);
    expect(shouldNotifyIncomingCall({ ...base, hidden: false, desktop: true, focused: true })).toBe(
      false,
    );
  });

  it("leaves it to push when push is on, and never notifies twice or without permission", () => {
    expect(shouldNotifyIncomingCall({ ...base, pushEnabled: true })).toBe(false);
    expect(shouldNotifyIncomingCall({ ...base, alreadyShown: true })).toBe(false);
    expect(shouldNotifyIncomingCall({ ...base, permission: "default" })).toBe(false);
    expect(shouldNotifyIncomingCall({ ...base, permission: "unsupported" })).toBe(false);
  });
});

describe("incomingCallOpening", () => {
  it("opens with who is calling and why", () => {
    expect(incomingCallOpening({ agentName: "Nova", topic: "the deploy needs approval" })).toBe(
      "Open the call: greet the person, say you're Nova, and that you're calling because: the deploy needs approval. Then ask how they'd like to proceed.",
    );
    expect(incomingCallOpening({ agentName: "Nova", topic: null })).toContain(
      "calling because: you need the person's input.",
    );
  });
});

describe("isRingingOut", () => {
  it("rings out on a call the person placed, until the agent picks up", () => {
    expect(isRingingOut({ direction: "outgoing", phase: "placing" })).toBe(true);
    expect(isRingingOut({ direction: "outgoing", phase: "connecting" })).toBe(true);
    expect(isRingingOut({ direction: "outgoing", phase: "live" })).toBe(false);
    expect(isRingingOut({ direction: "outgoing", phase: "failed" })).toBe(false);
    // An agent's call already rang here; answering it connects without ringback.
    expect(isRingingOut({ direction: "incoming", phase: "connecting" })).toBe(false);
    expect(isRingingOut(null)).toBe(false);
  });
});

describe("outgoingCallGreeting", () => {
  it("picks up a call the person placed with a short hello", () => {
    expect(outgoingCallGreeting({ agentName: "Gregg" })).toBe(
      'Pick up the call as Gregg: one short, casual hello such as "Hey, what\'s up?", then let the person talk.',
    );
  });
});

describe("hostSettledCallOutcome", () => {
  it("says how the host settled this device's open call, keeping a known reason", () => {
    expect(hostSettledCallOutcome("ended", null)).toEqual({ phase: "ended", error: null });
    expect(hostSettledCallOutcome("failed", "GPT-Live could not start.")).toEqual({
      phase: "failed",
      error: "GPT-Live could not start.",
    });
    expect(hostSettledCallOutcome("failed", null)).toEqual({
      phase: "failed",
      error: "The call could not connect.",
    });
    expect(hostSettledCallOutcome("missed", null).phase).toBe("failed");
    expect(hostSettledCallOutcome("missed", null).error).not.toBe("Call ended");
    expect(hostSettledCallOutcome("declined", null)).toEqual({
      phase: "failed",
      error: "The call was declined on another device.",
    });
  });
});

describe("trackRingingCalls", () => {
  it("reports calls that stopped ringing, but not those of a host that went quiet", () => {
    const first = trackRingingCalls(new Map(), [
      { environmentId, calls: [call("a"), call("b")] },
      { environmentId: otherEnvironmentId, calls: [call("c")] },
    ]);
    expect(first.stopped).toEqual([]);
    expect(first.ringing.size).toBe(3);

    const second = trackRingingCalls(first.ringing, [
      // Answered somewhere, and dropped from the snapshot.
      { environmentId, calls: [call("a", { status: "active" })] },
      // host-2 has no snapshot right now.
    ]);
    expect(second.stopped).toEqual([
      { environmentId, callId: "a" },
      { environmentId, callId: "b" },
    ]);
    expect([...second.ringing.values()]).toEqual([
      { environmentId: otherEnvironmentId, callId: "c" },
    ]);

    const third = trackRingingCalls(second.ringing, [
      { environmentId: otherEnvironmentId, calls: [call("c", { status: "missed" })] },
    ]);
    expect(third.stopped).toEqual([{ environmentId: otherEnvironmentId, callId: "c" }]);
    expect(third.ringing.size).toBe(0);
  });
});

describe("calls held elsewhere", () => {
  it("finds the agent's open call, wherever it is, and ignores finished ones", () => {
    const calls = [
      call("old", { status: "ended" }),
      call("other-agent", { vmAgentId: VmAgentId.make("agent-2"), status: "active" }),
      call("live", { status: "active", answeredBy: "iPhone" }),
    ];
    expect(openAgentCallElsewhere(calls, "agent-1")?.callId).toBe("live");
    expect(openAgentCallElsewhere(calls, "agent-3")).toBeNull();
    expect(openAgentCallElsewhere(null, "agent-1")).toBeNull();
  });

  it("describes it", () => {
    expect(
      describeAgentCallElsewhere(call("a", { status: "active", answeredBy: "iPhone" }), "Nova"),
    ).toBe("On a call with Nova on iPhone");
    expect(describeAgentCallElsewhere(call("a", { status: "active" }), "Nova")).toBe(
      "On a call with Nova on another device",
    );
    expect(describeAgentCallElsewhere(call("a"), "Nova")).toBe("Nova is calling");
    expect(
      describeAgentCallElsewhere(call("a", { direction: "outgoing", answeredBy: "Mac" }), "Nova"),
    ).toBe("Calling Nova from Mac");
  });
});

describe("people on a call", () => {
  const thread = (id: string) => ThreadId.make(id);
  const roster = [
    { name: "Notes", threadId: thread("t-notes"), vmAgentId: null },
    { name: "Gregg", threadId: thread("t-gregg"), vmAgentId: VmAgentId.make("agent-2") },
    { name: "Nova", threadId: thread("t-nova"), vmAgentId: VmAgentId.make("agent-1") },
    { name: "Ivy", threadId: thread("t-ivy"), vmAgentId: VmAgentId.make("agent-3") },
  ];

  it("offers the roster less whoever is on the call, agents first", () => {
    const addable = addableCallRoster({
      roster,
      participants: [{ threadId: thread("t-ivy"), title: "Ivy", vmAgentId: null }],
      ownThreadId: "t-nova",
    });
    expect(addable.agents.map((entry) => entry.name)).toEqual(["Gregg"]);
    expect(addable.chats.map((entry) => entry.name)).toEqual(["Notes"]);
  });

  it("treats a snapshot listing the same people as unchanged", () => {
    const gregg = { threadId: thread("t-gregg"), title: "Gregg", vmAgentId: null };
    expect(sameCallParticipants([gregg], [{ ...gregg }])).toBe(true);
    expect(sameCallParticipants([gregg], [{ ...gregg, title: "Greg" }])).toBe(false);
    expect(sameCallParticipants([gregg], [])).toBe(false);
  });
});

describe("agentCallSessionEnd", () => {
  const base = { sessionFailed: false, claimed: true, connected: true, error: null };

  it("ends normally only a call that was accepted and connected", () => {
    expect(agentCallSessionEnd(base)).toEqual({ phase: "ended", error: null });
  });

  it("fails a call the host accepted but that closed before it connected", () => {
    expect(agentCallSessionEnd({ ...base, connected: false })).toEqual({
      phase: "failed",
      error: "The call could not connect.",
    });
  });

  it("keeps the reason the session reported", () => {
    expect(
      agentCallSessionEnd({ ...base, claimed: false, connected: false, error: "No key" }),
    ).toEqual({ phase: "failed", error: "No key" });
    expect(agentCallSessionEnd({ ...base, sessionFailed: true, error: "Lost" })).toEqual({
      phase: "failed",
      error: "Lost",
    });
  });
});
