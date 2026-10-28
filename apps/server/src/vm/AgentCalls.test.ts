import { assert, it } from "@effect/vitest";
import {
  AGENT_CALL_HEARTBEAT_SECONDS,
  AGENT_CALL_LEASE_SECONDS,
  AGENT_CALL_RING_SECONDS,
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  VmAgentId,
  VmId,
  type VmAgent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { VmAgentStore } from "../persistence/Services/VmAgents.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  AGENT_CALL_AUTOMATIC_COOLDOWN_MS,
  AGENT_CALL_ENDED_RETENTION_MS,
  AGENT_CALL_OUTGOING_RING_SECONDS,
  describeClientDevice,
  make,
} from "./AgentCalls.ts";

const vmAgentId = VmAgentId.make("agent-scout");
const otherAgentId = VmAgentId.make("agent-other");
const iso = "2026-10-28T12:00:00.000Z";
const agentFor = (id: VmAgentId): VmAgent => ({
  vmAgentId: id,
  name: "Scout",
  handle: id,
  purpose: "Watch the dashboards",
  vmId: VmId.make(`vm-${id}`),
  threadId: ThreadId.make(`thread-${id}`),
  status: "running",
  controlMode: "agent",
  icon: null,
  guestIp: null,
  lastError: null,
  createdAt: iso,
  updatedAt: iso,
});

function fixture(options: { readonly agentCalls?: boolean; readonly key?: boolean } = {}) {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    orchestrator: {
      ...DEFAULT_SERVER_SETTINGS.orchestrator,
      agentCalls: options.agentCalls ?? true,
    },
  };
  return Layer.mergeAll(
    Layer.mock(ServerSettingsService)({ getSettings: Effect.succeed(settings) }),
    Layer.mock(ServerSecretStore)({
      get: (name) =>
        Effect.succeed(
          (options.key ?? true) && name === "orchestrator-openai-api-key"
            ? Option.some(new TextEncoder().encode("sk-fixture"))
            : Option.none(),
        ),
    }),
    Layer.mock(VmAgentStore)({
      getById: (id) => Effect.succeed(Option.some(agentFor(id))),
    }),
  );
}

const withCalls = <A, E>(
  options: Parameters<typeof fixture>[0],
  body: (calls: Effect.Success<typeof make>) => Effect.Effect<A, E>,
) => make.pipe(Effect.flatMap(body), Effect.provide(fixture(options)), Effect.scoped);

const statusOf = (calls: Effect.Success<typeof make>, callId: string) =>
  calls.snapshot.pipe(
    Effect.map((snapshot) => snapshot.calls.find((call) => call.callId === callId)?.status),
  );

it.effect("the first device to answer takes the call; a second learns where it was answered", () =>
  withCalls({}, (calls) =>
    Effect.gen(function* () {
      const rung = yield* calls.ring({
        vmAgentId,
        reason: "blocker",
        topic: "Sign in to Google",
        key: "blocker:one",
      });
      assert.strictEqual(rung.status, "ringing");
      if (rung.status !== "ringing") return;
      assert.strictEqual(rung.call.direction, "incoming");
      assert.strictEqual(rung.call.topic, "Sign in to Google");
      assert.isNotNull(rung.call.expiresAt);

      const [first, second] = yield* Effect.all(
        [
          Effect.result(calls.claim(rung.call.callId, "Sol's iPhone")),
          Effect.result(calls.claim(rung.call.callId, "Office Mac")),
        ],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(first._tag, "Success");
      assert.strictEqual(second._tag, "Failure");
      if (first._tag === "Success") {
        assert.strictEqual(first.success.status, "active");
        assert.strictEqual(first.success.answeredBy, "Sol's iPhone");
        assert.isNull(first.success.expiresAt);
      }
      if (second._tag === "Failure")
        assert.strictEqual(second.failure.detail, "Answered on Sol's iPhone");

      // An open call blocks a second ring for the same agent.
      const busy = yield* calls.ring({
        vmAgentId,
        reason: "request",
        topic: null,
        key: "request:two",
      });
      assert.strictEqual(busy.status, "busy");

      yield* calls.end(rung.call.callId);
      yield* calls.end(rung.call.callId);
      yield* calls.decline(rung.call.callId);
      assert.strictEqual(yield* statusOf(calls, rung.call.callId), "ended");
      const ended = yield* Effect.flip(calls.claim(rung.call.callId, "Office Mac"));
      assert.strictEqual(ended.detail, "This call has ended.");
    }),
  ),
);

it.effect("an unanswered ring is missed when the ring window closes", () =>
  withCalls({}, (calls) =>
    Effect.gen(function* () {
      const rung = yield* calls.ring({
        vmAgentId,
        reason: "question",
        topic: "Which account?",
        key: "input:thread:request",
      });
      if (rung.status !== "ringing") return assert.fail(rung.status);
      yield* TestClock.adjust(`${AGENT_CALL_RING_SECONDS - 1} seconds`);
      assert.strictEqual(yield* statusOf(calls, rung.call.callId), "ringing");
      yield* TestClock.adjust("1 second");
      const missed = (yield* calls.get(rung.call.callId)).pipe(Option.getOrUndefined);
      assert.strictEqual(missed?.status, "missed");
      assert.isNotNull(missed?.endedAt);
      assert.isNull(missed?.expiresAt);
      // Too late to answer.
      assert.strictEqual(
        (yield* Effect.flip(calls.claim(rung.call.callId, "Office Mac"))).detail,
        "This call was missed.",
      );
    }),
  ),
);

it.effect("an outgoing call that never opens voice fails, and ended calls prune later", () =>
  withCalls({}, (calls) =>
    Effect.gen(function* () {
      const placed = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
      assert.strictEqual(placed.direction, "outgoing");
      assert.strictEqual(placed.reason, "user");
      assert.strictEqual(placed.answeredBy, "Office Mac");
      assert.strictEqual(
        (yield* Effect.flip(calls.place({ vmAgentId, deviceLabel: "Office Mac" }))).detail,
        "You're already on a call with Scout.",
      );
      yield* TestClock.adjust(`${AGENT_CALL_OUTGOING_RING_SECONDS} seconds`);
      assert.strictEqual(yield* statusOf(calls, placed.callId), "failed");
      yield* TestClock.adjust(`${AGENT_CALL_ENDED_RETENTION_MS} millis`);
      assert.deepStrictEqual((yield* calls.snapshot).calls, []);
    }),
  ),
);

it.effect("an answered call ends when its device stops renewing the lease", () =>
  withCalls({}, (calls) =>
    Effect.gen(function* () {
      const placed = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
      // Only an active call has a lease.
      assert.isFalse(yield* calls.renew(placed.callId));
      yield* calls.claim(placed.callId, "Office Mac");
      // Heartbeats keep it going well past one lease.
      for (let beat = 0; beat < 4; beat++) {
        yield* TestClock.adjust(`${AGENT_CALL_HEARTBEAT_SECONDS} seconds`);
        assert.isTrue(yield* calls.renew(placed.callId));
      }
      assert.strictEqual(yield* statusOf(calls, placed.callId), "active");
      // The device goes away: the call ends once the last renewal lapses.
      yield* TestClock.adjust(`${AGENT_CALL_LEASE_SECONDS - 1} seconds`);
      assert.strictEqual(yield* statusOf(calls, placed.callId), "active");
      yield* TestClock.adjust("1 second");
      const ended = Option.getOrUndefined(yield* calls.get(placed.callId));
      assert.strictEqual(ended?.status, "ended");
      assert.isNotNull(ended?.endedAt);
      assert.isFalse(yield* calls.renew(placed.callId));
    }),
  ),
);

it.effect("automatic rings honour a per-agent cooldown and ring each trigger once", () =>
  withCalls({}, (calls) =>
    Effect.gen(function* () {
      const first = yield* calls.ring({
        vmAgentId,
        reason: "blocker",
        topic: null,
        key: "blocker:one",
      });
      if (first.status !== "ringing") return assert.fail(first.status);
      yield* calls.decline(first.call.callId);
      yield* calls.decline(first.call.callId);
      assert.strictEqual(yield* statusOf(calls, first.call.callId), "declined");

      const tooSoon = yield* calls.ring({
        vmAgentId,
        reason: "approval",
        topic: null,
        key: "approval:thread:two",
      });
      assert.strictEqual(tooSoon.status, "cooldown");
      // Another agent has its own cooldown.
      const other = yield* calls.ring({
        vmAgentId: otherAgentId,
        reason: "approval",
        topic: null,
        key: "approval:thread:three",
      });
      assert.strictEqual(other.status, "ringing");

      yield* TestClock.adjust(`${AGENT_CALL_AUTOMATIC_COOLDOWN_MS} millis`);
      const repeat = yield* calls.ring({
        vmAgentId,
        reason: "blocker",
        topic: null,
        key: "blocker:one",
      });
      assert.strictEqual(repeat.status, "duplicate");
      const later = yield* calls.ring({
        vmAgentId,
        reason: "approval",
        topic: null,
        key: "approval:thread:two",
      });
      assert.strictEqual(later.status, "ringing");
    }),
  ),
);

it.effect("call_user skips the cooldown but is capped per hour", () =>
  withCalls({}, (calls) =>
    Effect.gen(function* () {
      for (let index = 0; index < 3; index++) {
        const rung = yield* calls.ring({
          vmAgentId,
          reason: "request",
          topic: "Quick question",
          key: `request:${index}`,
        });
        if (rung.status !== "ringing") return assert.fail(rung.status);
        yield* calls.decline(rung.call.callId);
      }
      const capped = yield* calls.ring({
        vmAgentId,
        reason: "request",
        topic: null,
        key: "request:3",
      });
      assert.strictEqual(capped.status, "rate-limited");
      yield* TestClock.adjust("1 hour");
      const allowed = yield* calls.ring({
        vmAgentId,
        reason: "request",
        topic: null,
        key: "request:4",
      });
      assert.strictEqual(allowed.status, "ringing");
    }),
  ),
);

it.effect("a resolved trigger ends its ringing call but never an answered one", () =>
  withCalls({}, (calls) =>
    Effect.gen(function* () {
      const rung = yield* calls.ring({
        vmAgentId,
        reason: "blocker",
        topic: null,
        key: "blocker:one",
      });
      if (rung.status !== "ringing") return assert.fail(rung.status);
      yield* calls.cancelByKey("blocker:one");
      assert.strictEqual(yield* statusOf(calls, rung.call.callId), "ended");

      const answered = yield* calls.ring({
        vmAgentId: otherAgentId,
        reason: "blocker",
        topic: null,
        key: "blocker:two",
      });
      if (answered.status !== "ringing") return assert.fail(answered.status);
      yield* calls.claim(answered.call.callId, "Office Mac");
      yield* calls.cancelByKey("blocker:two");
      assert.strictEqual(yield* statusOf(calls, answered.call.callId), "active");
      yield* calls.fail(answered.call.callId);
      assert.strictEqual(yield* statusOf(calls, answered.call.callId), "failed");
    }),
  ),
);

it.effect("a cancel only ends a call that is still ringing", () =>
  withCalls({}, (calls) =>
    Effect.gen(function* () {
      const ringing = yield* calls.place({ vmAgentId, deviceLabel: "Sol's iPhone" });
      yield* calls.end(ringing.callId, { ifRinging: true });
      assert.strictEqual(yield* statusOf(calls, ringing.callId), "ended");

      // Answered on another device: a device that never connected leaves it alone.
      const answered = yield* calls.place({ vmAgentId, deviceLabel: "Sol's iPhone" });
      yield* calls.claim(answered.callId, "Office Mac");
      yield* calls.end(answered.callId, { ifRinging: true });
      assert.strictEqual(yield* statusOf(calls, answered.callId), "active");
      yield* calls.end(answered.callId);
      assert.strictEqual(yield* statusOf(calls, answered.callId), "ended");
    }),
  ),
);

it.effect("deleting an agent ends its ringing and active calls, not other agents'", () =>
  withCalls({}, (calls) =>
    Effect.gen(function* () {
      const active = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
      yield* calls.claim(active.callId, "Office Mac");
      const other = yield* calls.ring({
        vmAgentId: otherAgentId,
        reason: "blocker",
        topic: null,
        key: "blocker:other",
      });
      if (other.status !== "ringing") return assert.fail(other.status);
      yield* calls.endForAgent(vmAgentId);
      assert.strictEqual(yield* statusOf(calls, active.callId), "ended");
      assert.strictEqual(yield* statusOf(calls, other.call.callId), "ringing");

      yield* calls.endForAgent(otherAgentId);
      assert.strictEqual(yield* statusOf(calls, other.call.callId), "ended");
    }),
  ),
);

it.effect("nothing rings with calls turned off or without an OpenAI key", () =>
  Effect.gen(function* () {
    const ring = { vmAgentId, reason: "blocker" as const, topic: null, key: "blocker:one" };
    const off = yield* withCalls({ agentCalls: false }, (calls) => calls.ring(ring));
    assert.strictEqual(off.status, "disabled");
    const keyless = yield* withCalls({ key: false }, (calls) =>
      Effect.gen(function* () {
        const outcome = yield* calls.ring(ring);
        const placed = yield* Effect.flip(calls.place({ vmAgentId, deviceLabel: "Office Mac" }));
        return { outcome, placed };
      }),
    );
    assert.strictEqual(keyless.outcome.status, "disabled");
    assert.include(keyless.placed.detail, "OpenAI key");
  }),
);

it("names devices by label, then browser and OS, then kind", () => {
  assert.strictEqual(
    describeClientDevice({ label: "Sol's iPhone", deviceType: "mobile" }),
    "Sol's iPhone",
  );
  assert.strictEqual(
    describeClientDevice({ browser: "Safari", os: "iOS", deviceType: "mobile" }),
    "Safari on iOS",
  );
  assert.strictEqual(describeClientDevice({ deviceType: "tablet" }), "a tablet");
  assert.strictEqual(describeClientDevice(undefined), "another device");
});
