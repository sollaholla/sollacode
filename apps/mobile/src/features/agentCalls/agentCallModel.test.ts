import {
  AGENT_CALL_NATIVE_MESSAGE_TYPE,
  type AgentCall,
  type AgentCallNativeMessage,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildOrchestratorUrl } from "../orchestrator/orchestratorUrl";
import {
  agentCallBlockedReason,
  agentCallKey,
  agentCallPage,
  applyAgentCallNativeMessage,
  callsToEndOnLeave,
  createAgentCallKeySet,
  initialAgentCallScreenHold,
  isCallHeldHere,
  openCallForAgent,
  parseAgentCallNativeMessage,
  RING_HAPTIC_BURST_MS,
  RING_HAPTIC_PERIOD_MS,
  resolveAgentCallScreenAction,
  ringRemainingMs,
  selectIncomingCallToPresent,
  shouldEndCallOnLeave,
  startRingingHaptics,
} from "./agentCallModel";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");

function makeCall(overrides: Partial<AgentCall> = {}): AgentCall {
  return {
    callId: "call-1",
    vmAgentId: "agent-1",
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
  } as AgentCall;
}

describe("agentCallPage", () => {
  it("loads the web call page embedded, under the environment's base path", () => {
    const page = agentCallPage("env-1", "call-1");
    expect(
      buildOrchestratorUrl("https://relay.example.com/solla/", page.routePath, page.query),
    ).toBe("https://relay.example.com/solla/call/env-1/call-1?embedded=1");
  });

  it("keeps ids that need escaping inside their own path segment", () => {
    const page = agentCallPage("env/1", "call 1");
    expect(buildOrchestratorUrl("http://mac.local:3773", page.routePath, page.query)).toBe(
      "http://mac.local:3773/call/env%2F1/call%201?embedded=1",
    );
  });
});

describe("selectIncomingCallToPresent", () => {
  const nothingPresented = () => false;

  it("presents an agent's ringing call", () => {
    const call = makeCall();
    expect(
      selectIncomingCallToPresent({
        environmentId: "env-1",
        calls: [call],
        alreadyPresented: nothingPresented,
        nowMs: NOW,
      }),
    ).toBe(call);
  });

  it("ignores calls the person placed, calls no longer ringing, and expired rings", () => {
    expect(
      selectIncomingCallToPresent({
        environmentId: "env-1",
        calls: [
          makeCall({ callId: "outgoing" as AgentCall["callId"], direction: "outgoing" }),
          makeCall({ callId: "active" as AgentCall["callId"], status: "active" }),
          makeCall({ callId: "missed" as AgentCall["callId"], status: "missed" }),
          makeCall({
            callId: "stale" as AgentCall["callId"],
            expiresAt: "2026-10-28T11:59:59.000Z",
          }),
        ],
        alreadyPresented: nothingPresented,
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it("does not present the same call twice, but moves on to the next one", () => {
    const presented = createAgentCallKeySet();
    presented.add(agentCallKey("env-1", "call-1"));
    const second = makeCall({ callId: "call-2" as AgentCall["callId"] });
    expect(
      selectIncomingCallToPresent({
        environmentId: "env-1",
        calls: [makeCall(), second],
        alreadyPresented: presented.has,
        nowMs: NOW,
      }),
    ).toBe(second);
  });

  it("keys presented calls per host, since call ids are only unique on one", () => {
    const presented = createAgentCallKeySet();
    presented.add(agentCallKey("env-1", "call-1"));
    expect(
      selectIncomingCallToPresent({
        environmentId: "env-2",
        calls: [makeCall()],
        alreadyPresented: presented.has,
        nowMs: NOW,
      }),
    ).not.toBeNull();
  });
});

describe("resolveAgentCallScreenAction", () => {
  const settled = { heldHere: false, failed: false } as const;

  it("does nothing on the first look, so an ended call shows how it ended", () => {
    expect(
      resolveAgentCallScreenAction({ ...settled, previousStatus: null, status: "missed" }),
    ).toBe("stay");
  });

  it("closes when a ring stops without this phone taking it", () => {
    for (const status of ["declined", "missed", "ended"] as const) {
      expect(resolveAgentCallScreenAction({ ...settled, previousStatus: "ringing", status })).toBe(
        "dismiss",
      );
    }
  });

  it("waits for the page before closing on a ring that went live elsewhere", () => {
    expect(
      resolveAgentCallScreenAction({ ...settled, previousStatus: "ringing", status: "active" }),
    ).toBe("await-hold");
  });

  it("stays on a call this phone answered or placed when its ring connects or is declined", () => {
    for (const status of ["active", "declined"] as const) {
      expect(
        resolveAgentCallScreenAction({
          previousStatus: "ringing",
          status,
          heldHere: true,
          failed: false,
        }),
      ).toBe("stay");
    }
  });

  it("lingers on Call ended when this phone hangs up before the call connects", () => {
    expect(
      resolveAgentCallScreenAction({
        previousStatus: "ringing",
        status: "ended",
        heldHere: true,
        failed: false,
      }),
    ).toBe("dismiss-soon");
    // A failure the page reported still stays, whatever the host says next.
    expect(
      resolveAgentCallScreenAction({
        previousStatus: "ringing",
        status: "ended",
        heldHere: true,
        failed: true,
      }),
    ).toBe("stay");
  });

  it("lingers on Call ended after a call this phone held, then closes", () => {
    expect(
      resolveAgentCallScreenAction({
        previousStatus: "active",
        status: "ended",
        heldHere: true,
        failed: false,
      }),
    ).toBe("dismiss-soon");
  });

  it("closes when a call another device held ends", () => {
    expect(
      resolveAgentCallScreenAction({ ...settled, previousStatus: "active", status: "ended" }),
    ).toBe("dismiss");
  });

  it("keeps a failure on screen so its reason can be read", () => {
    expect(
      resolveAgentCallScreenAction({
        previousStatus: "ringing",
        status: "failed",
        heldHere: true,
        failed: false,
      }),
    ).toBe("stay");
    expect(
      resolveAgentCallScreenAction({
        previousStatus: "active",
        status: "failed",
        heldHere: true,
        failed: false,
      }),
    ).toBe("stay");
    // The page reported a failure, so the host's ending doesn't close it.
    expect(
      resolveAgentCallScreenAction({
        previousStatus: "active",
        status: "ended",
        heldHere: true,
        failed: true,
      }),
    ).toBe("stay");
    expect(
      resolveAgentCallScreenAction({
        previousStatus: "ringing",
        status: "missed",
        heldHere: false,
        failed: true,
      }),
    ).toBe("stay");
  });
});

describe("parseAgentCallNativeMessage", () => {
  const post = (message: unknown) => JSON.stringify(message);

  it("reads the page's held, connected, released and failed messages", () => {
    expect(
      parseAgentCallNativeMessage(
        post({ type: AGENT_CALL_NATIVE_MESSAGE_TYPE, event: "held", callId: "call-1" }),
      ),
    ).toEqual({ type: AGENT_CALL_NATIVE_MESSAGE_TYPE, event: "held", callId: "call-1" });
    expect(
      parseAgentCallNativeMessage(
        post({ type: AGENT_CALL_NATIVE_MESSAGE_TYPE, event: "connected", callId: "call-1" }),
      ),
    ).toEqual({ type: AGENT_CALL_NATIVE_MESSAGE_TYPE, event: "connected", callId: "call-1" });
    expect(
      parseAgentCallNativeMessage(
        post({
          type: AGENT_CALL_NATIVE_MESSAGE_TYPE,
          event: "failed",
          callId: " call-1 ",
          detail: "  The call dropped.  ",
        }),
      ),
    ).toEqual({
      type: AGENT_CALL_NATIVE_MESSAGE_TYPE,
      event: "failed",
      callId: "call-1",
      detail: "The call dropped.",
    });
  });

  it("ignores anything else the page posts", () => {
    for (const data of [
      "not json",
      "null",
      "[]",
      post({ type: "something-else", event: "held", callId: "call-1" }),
      post({ type: AGENT_CALL_NATIVE_MESSAGE_TYPE, event: "answered", callId: "call-1" }),
      post({ type: AGENT_CALL_NATIVE_MESSAGE_TYPE, event: "held", callId: "  " }),
      post({ type: AGENT_CALL_NATIVE_MESSAGE_TYPE, event: "held", callId: 42 }),
      post({ type: AGENT_CALL_NATIVE_MESSAGE_TYPE, event: "held", callId: "x".repeat(129) }),
      post({
        type: AGENT_CALL_NATIVE_MESSAGE_TYPE,
        event: "failed",
        callId: "call-1",
        detail: "x".repeat(5_000),
      }),
    ]) {
      expect(parseAgentCallNativeMessage(data)).toBeNull();
    }
  });

  it("drops a blank detail and bounds a long one", () => {
    expect(
      parseAgentCallNativeMessage(
        post({ type: AGENT_CALL_NATIVE_MESSAGE_TYPE, event: "released", callId: "c", detail: " " }),
      ),
    ).toEqual({ type: AGENT_CALL_NATIVE_MESSAGE_TYPE, event: "released", callId: "c" });
    expect(
      parseAgentCallNativeMessage(
        post({
          type: AGENT_CALL_NATIVE_MESSAGE_TYPE,
          event: "failed",
          callId: "c",
          detail: "x".repeat(900),
        }),
      )?.detail,
    ).toHaveLength(500);
  });
});

describe("agent call screen hold", () => {
  const message = (
    event: AgentCallNativeMessage["event"],
    callId: string,
    detail?: string,
  ): AgentCallNativeMessage => ({
    type: AGENT_CALL_NATIVE_MESSAGE_TYPE,
    event,
    callId,
    ...(detail === undefined ? {} : { detail }),
  });
  const end = (callId: string) => ({ callId, ifRinging: false });
  const cancel = (callId: string) => ({ callId, ifRinging: true });
  const placedRinging = () => makeCall({ direction: "outgoing", status: "ringing" });
  const placedActive = () =>
    makeCall({ direction: "outgoing", status: "active", answeredBy: "Mac" });

  it("holds nothing it was not told about, however the call was answered", () => {
    const hold = initialAgentCallScreenHold({ callId: "call-1", placedHere: false });
    expect(isCallHeldHere(hold, "call-1", "active")).toBe(false);
    expect(callsToEndOnLeave({ hold, findCall: () => makeCall({ status: "active" }) })).toEqual([]);
  });

  it("only cancels the ring of a call this phone placed", () => {
    const hold = initialAgentCallScreenHold({ callId: "call-1", placedHere: true });
    expect(isCallHeldHere(hold, "call-1", "ringing")).toBe(true);
    expect(callsToEndOnLeave({ hold, findCall: placedRinging })).toEqual([cancel("call-1")]);
    // Not in the host's snapshot yet: the host decides whether it still rings.
    expect(callsToEndOnLeave({ hold, findCall: () => null })).toEqual([cancel("call-1")]);
  });

  it("lets a placed call go once another device answers it", () => {
    const hold = initialAgentCallScreenHold({ callId: "call-1", placedHere: true });
    // Live without the page holding it: not this phone's, so the screen waits
    // for the page and then closes, and leaving hangs nothing up.
    expect(isCallHeldHere(hold, "call-1", "active")).toBe(false);
    expect(
      resolveAgentCallScreenAction({
        previousStatus: "ringing",
        status: "active",
        heldHere: isCallHeldHere(hold, "call-1", "active"),
        failed: false,
      }),
    ).toBe("await-hold");
    expect(callsToEndOnLeave({ hold, findCall: placedActive })).toEqual([]);
  });

  it("never hangs up a placed call the page lost to another device", () => {
    let hold = initialAgentCallScreenHold({ callId: "call-1", placedHere: true });
    hold = applyAgentCallNativeMessage(hold, message("held", "call-1"));
    hold = applyAgentCallNativeMessage(hold, message("failed", "call-1", "Answered on Mac"));
    expect(callsToEndOnLeave({ hold, findCall: placedActive })).toEqual([]);
  });

  it("only cancels a placed call the page joined until the host connects it", () => {
    let hold = initialAgentCallScreenHold({ callId: "call-1", placedHere: true });
    hold = applyAgentCallNativeMessage(hold, message("held", "call-1"));
    // The page joined, but its claim may not have reached the host: another
    // device's Join can land first, and the snapshot can't tell them apart.
    expect(callsToEndOnLeave({ hold, findCall: placedRinging })).toEqual([cancel("call-1")]);
    expect(callsToEndOnLeave({ hold, findCall: placedActive })).toEqual([]);

    hold = applyAgentCallNativeMessage(hold, message("connected", "call-1"));
    expect(callsToEndOnLeave({ hold, findCall: placedActive })).toEqual([end("call-1")]);
  });

  it("leaves an agent's ring the page answered ringing when the screen closes", () => {
    let hold = initialAgentCallScreenHold({ callId: "call-1", placedHere: false });
    hold = applyAgentCallNativeMessage(hold, message("held", "call-1"));
    expect(callsToEndOnLeave({ hold, findCall: () => makeCall() })).toEqual([]);
  });

  it("holds a call once the page says so, and lets go when it is released", () => {
    let hold = initialAgentCallScreenHold({ callId: "call-1", placedHere: false });
    hold = applyAgentCallNativeMessage(hold, message("held", "call-1"));
    expect(isCallHeldHere(hold, "call-1", "active")).toBe(true);
    // Answered here but not connected yet: live means another device won it.
    expect(callsToEndOnLeave({ hold, findCall: () => makeCall({ status: "active" }) })).toEqual([]);
    hold = applyAgentCallNativeMessage(hold, message("connected", "call-1"));
    expect(callsToEndOnLeave({ hold, findCall: () => makeCall({ status: "active" }) })).toEqual([
      end("call-1"),
    ]);

    hold = applyAgentCallNativeMessage(hold, message("released", "call-1"));
    expect(callsToEndOnLeave({ hold, findCall: () => makeCall({ status: "active" }) })).toEqual([]);
    // Still this phone's call, so its ending lingers on screen.
    expect(isCallHeldHere(hold, "call-1", "ended")).toBe(true);
  });

  it("follows the page to another call and hangs up every call it holds", () => {
    let hold = initialAgentCallScreenHold({ callId: "call-1", placedHere: false });
    hold = applyAgentCallNativeMessage(hold, message("connected", "call-1"));
    hold = applyAgentCallNativeMessage(hold, message("held", "call-2"));
    hold = applyAgentCallNativeMessage(hold, message("connected", "call-2"));
    expect(hold.callId).toBe("call-2");
    expect(callsToEndOnLeave({ hold, findCall: () => makeCall({ status: "active" }) })).toEqual([
      end("call-1"),
      end("call-2"),
    ]);
  });

  it("hangs up a connected call the host's snapshot doesn't show yet", () => {
    let hold = initialAgentCallScreenHold({ callId: "call-1", placedHere: false });
    hold = applyAgentCallNativeMessage(hold, message("held", "call-2"));
    // Not connected: the host decides whether it still rings.
    expect(callsToEndOnLeave({ hold, findCall: () => null })).toEqual([cancel("call-2")]);
    hold = applyAgentCallNativeMessage(hold, message("connected", "call-2"));
    expect(callsToEndOnLeave({ hold, findCall: () => null })).toEqual([end("call-2")]);
  });

  it("never hangs up a connected call once the page fails or releases it", () => {
    let hold = initialAgentCallScreenHold({ callId: "call-1", placedHere: false });
    hold = applyAgentCallNativeMessage(hold, message("connected", "call-1"));
    expect(isCallHeldHere(hold, "call-1", "active")).toBe(true);
    hold = applyAgentCallNativeMessage(hold, message("failed", "call-1", "The call dropped."));
    expect(callsToEndOnLeave({ hold, findCall: () => makeCall({ status: "active" }) })).toEqual([]);
    hold = applyAgentCallNativeMessage(hold, message("connected", "call-1"));
    hold = applyAgentCallNativeMessage(hold, message("released", "call-1"));
    expect(hold.connected.size).toBe(0);
  });

  it("keeps a failure on screen and never hangs up a call it failed to take", () => {
    let hold = initialAgentCallScreenHold({ callId: "call-1", placedHere: false });
    hold = applyAgentCallNativeMessage(hold, message("held", "call-1"));
    hold = applyAgentCallNativeMessage(hold, message("failed", "call-1", "Answered on Mac"));
    expect(hold.failure).toBe("Answered on Mac");
    // Another device has it now; leaving must not cut that call.
    expect(callsToEndOnLeave({ hold, findCall: () => makeCall({ status: "active" }) })).toEqual([]);

    hold = applyAgentCallNativeMessage(hold, message("failed", "call-1"));
    expect(hold.failure).toBe("The call failed.");

    // A new call clears it.
    hold = applyAgentCallNativeMessage(hold, message("held", "call-3"));
    expect(hold.failure).toBeNull();
    expect(hold.callId).toBe("call-3");
  });

  it("ignores a release for a call it never held", () => {
    const hold = initialAgentCallScreenHold({ callId: "call-1", placedHere: false });
    expect(applyAgentCallNativeMessage(hold, message("released", "call-9"))).toBe(hold);
  });
});

describe("openCallForAgent", () => {
  const agentId = "agent-1";

  it("opens the agent's live call, or its ring, instead of placing another", () => {
    const active = makeCall({ status: "active", answeredBy: "Mac" });
    expect(openCallForAgent([active], agentId)).toBe(active);
    const ringing = makeCall();
    expect(openCallForAgent([ringing], agentId)).toBe(ringing);
  });

  it("leaves another device's unconnected call, other agents and finished calls alone", () => {
    expect(
      openCallForAgent(
        [
          makeCall({ direction: "outgoing", reason: "user" }),
          makeCall({ status: "active", vmAgentId: "agent-2" as AgentCall["vmAgentId"] }),
          makeCall({ status: "ended" }),
        ],
        agentId,
      ),
    ).toBeNull();
    expect(openCallForAgent(null, agentId)).toBeNull();
  });
});

describe("shouldEndCallOnLeave", () => {
  it("hangs up a live call this phone holds", () => {
    expect(shouldEndCallOnLeave({ call: makeCall({ status: "active" }), heldHere: true })).toBe(
      true,
    );
  });

  it("cancels an outgoing call this phone placed that has not connected", () => {
    expect(
      shouldEndCallOnLeave({ call: makeCall({ direction: "outgoing" }), heldHere: true }),
    ).toBe(true);
  });

  it("leaves an agent's ring ringing on the person's other devices", () => {
    expect(shouldEndCallOnLeave({ call: makeCall(), heldHere: true })).toBe(false);
  });

  it("never ends a call another device holds, or one already over", () => {
    expect(shouldEndCallOnLeave({ call: makeCall({ status: "active" }), heldHere: false })).toBe(
      false,
    );
    expect(shouldEndCallOnLeave({ call: makeCall({ status: "ended" }), heldHere: true })).toBe(
      false,
    );
    expect(shouldEndCallOnLeave({ call: null, heldHere: true })).toBe(false);
  });
});

describe("ringRemainingMs", () => {
  const ring = (overrides: Partial<Parameters<typeof ringRemainingMs>[0]> = {}) =>
    ringRemainingMs({
      call: makeCall(),
      appActive: true,
      answeredHere: false,
      failed: false,
      nowMs: NOW,
      ...overrides,
    });

  it("buzzes for an agent's ringing call until it expires", () => {
    expect(ring()).toBe(30_000);
  });

  it("stops at expiry even when the snapshot still says ringing", () => {
    expect(ring({ nowMs: NOW + 30_000 })).toBeNull();
    expect(ring({ nowMs: NOW + 45_000 })).toBeNull();
  });

  it("stops as soon as the page answers, before the host sees the answer", () => {
    expect(ring({ answeredHere: true })).toBeNull();
    // A retry after a failed answer clears the failure but stays quiet.
    let hold = initialAgentCallScreenHold({ callId: "call-1", placedHere: false });
    for (const event of ["held", "failed", "held"] as const) {
      hold = applyAgentCallNativeMessage(hold, {
        type: AGENT_CALL_NATIVE_MESSAGE_TYPE,
        event,
        callId: "call-1",
      });
    }
    expect(hold.failure).toBeNull();
    expect(ring({ answeredHere: hold.heldEver.has(hold.callId), failed: false })).toBeNull();
  });

  it("is quiet in the background, after a failed answer, and for other calls", () => {
    expect(ring({ appActive: false })).toBeNull();
    expect(ring({ failed: true })).toBeNull();
    expect(ring({ call: makeCall({ direction: "outgoing" }) })).toBeNull();
    expect(ring({ call: makeCall({ status: "active" }) })).toBeNull();
    expect(ring({ call: null })).toBeNull();
  });
});

describe("createAgentCallKeySet", () => {
  it("forgets the oldest keys past its limit", () => {
    const keys = createAgentCallKeySet(2);
    keys.add("a");
    keys.add("b");
    keys.add("c");
    expect(keys.has("a")).toBe(false);
    expect(keys.has("b")).toBe(true);
    expect(keys.has("c")).toBe(true);
  });
});

describe("agentCallBlockedReason", () => {
  it("explains a missing OpenAI key, and does not block while settings are unknown", () => {
    expect(agentCallBlockedReason(false)).toContain("OpenAI key");
    expect(agentCallBlockedReason(true)).toBeNull();
    expect(agentCallBlockedReason(undefined)).toBeNull();
  });
});

describe("startRingingHaptics", () => {
  function manualTimers() {
    let now = 0;
    let nextId = 0;
    const pending = new Map<number, { readonly at: number; readonly run: () => void }>();
    return {
      timers: {
        setTimeout: (run: () => void, ms: number) => {
          nextId += 1;
          pending.set(nextId, { at: now + ms, run });
          return nextId;
        },
        clearTimeout: (handle: unknown) => {
          pending.delete(handle as number);
        },
      },
      advanceTo(target: number) {
        for (;;) {
          const due = [...pending.entries()]
            .filter(([, timer]) => timer.at <= target)
            .sort(([, left], [, right]) => left.at - right.at)[0];
          if (due === undefined) break;
          pending.delete(due[0]);
          now = due[1].at;
          due[1].run();
        }
        now = target;
      },
      pendingCount: () => pending.size,
    };
  }

  it("taps in bursts every ring period until stopped", () => {
    const clock = manualTimers();
    let taps = 0;
    const stop = startRingingHaptics(
      () => {
        taps += 1;
      },
      { timers: clock.timers },
    );

    clock.advanceTo(RING_HAPTIC_PERIOD_MS - 1);
    expect(taps).toBe(RING_HAPTIC_BURST_MS.length);
    clock.advanceTo(RING_HAPTIC_PERIOD_MS * 2 - 1);
    expect(taps).toBe(RING_HAPTIC_BURST_MS.length * 2);

    stop();
    expect(clock.pendingCount()).toBe(0);
    clock.advanceTo(RING_HAPTIC_PERIOD_MS * 5);
    expect(taps).toBe(RING_HAPTIC_BURST_MS.length * 2);
  });

  it("stops by itself once the ring's time is up", () => {
    const clock = manualTimers();
    let taps = 0;
    startRingingHaptics(
      () => {
        taps += 1;
      },
      { timers: clock.timers, stopAfterMs: RING_HAPTIC_PERIOD_MS + 200 },
    );

    clock.advanceTo(RING_HAPTIC_PERIOD_MS * 4);
    // The first burst, and the second up to its stop: taps at 0 and 160 ms.
    expect(taps).toBe(RING_HAPTIC_BURST_MS.length + 2);
    expect(clock.pendingCount()).toBe(0);
  });
});
