import * as NodeCrypto from "node:crypto";
import {
  AGENT_CALL_LEASE_SECONDS,
  AGENT_CALL_RING_SECONDS,
  type AgentCall,
  AgentCallError,
  AgentCallId,
  type AgentCallReason,
  type AgentCallsSnapshot,
  type AuthClientMetadata,
  type AuthSessionId,
  type VmAgentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import type * as SessionStore from "../auth/SessionStore.ts";
import { resolveOrchestratorApiKey } from "../orchestrator/OrchestratorCredentials.ts";
import { VmAgentStore } from "../persistence/Services/VmAgents.ts";
import { ServerSettingsService } from "../serverSettings.ts";

/** An outgoing call that never opens voice stops "ringing" on its device. */
export const AGENT_CALL_OUTGOING_RING_SECONDS = 30;
/** Automatic rings (blockers, questions, approvals) per agent, at most one per window. */
export const AGENT_CALL_AUTOMATIC_COOLDOWN_MS = 10 * 60_000;
/** agent_workspace `call_user` rings per agent per hour. */
export const AGENT_CALL_REQUESTS_PER_HOUR = 3;
/** Ended calls stay in the snapshot this long so every device can show how they ended. */
export const AGENT_CALL_ENDED_RETENTION_MS = 3 * 60_000;
/**
 * Backstop for a call whose device keeps renewing its lease but never hangs
 * up; the lease (AGENT_CALL_LEASE_SECONDS) ends a call whose device went away.
 */
export const AGENT_CALL_MAX_ACTIVE_MS = 2 * 60 * 60_000;
/** The inbox entry a missed call leaves; the call's own push already announced it. */
export const MISSED_CALL_NOTIFICATION_PREFIX = "missed-call:";
const HOUR_MS = 60 * 60_000;
const LEASE_MS = AGENT_CALL_LEASE_SECONDS * 1_000;
const RUNG_KEY_RETENTION_MS = 24 * HOUR_MS;
const MAX_ENDED_CALLS = 50;

/** Why an agent rings the person; `user` is reserved for calls the person places. */
export type AgentCallRingReason = Exclude<AgentCallReason, "user">;

export type AgentCallRingOutcome =
  | { readonly status: "ringing"; readonly call: AgentCall }
  | {
      readonly status:
        | "disabled"
        | "busy"
        | "already-ringing"
        | "duplicate"
        | "cooldown"
        | "rate-limited";
    };

/** One state change of one call; `previous` is null when the call was created. */
export interface AgentCallTransition {
  readonly previous: AgentCall | null;
  readonly call: AgentCall;
}

export interface AgentCallsShape {
  readonly snapshot: Effect.Effect<AgentCallsSnapshot>;
  /** The current snapshot first, then one per change. */
  readonly changes: Stream.Stream<AgentCallsSnapshot>;
  /** Every state change, for the reactor that pushes and records missed calls. */
  readonly transitions: Stream.Stream<AgentCallTransition>;
  readonly get: (callId: AgentCallId) => Effect.Effect<Option.Option<AgentCall>>;
  /** The person calls an agent from `deviceLabel`. */
  readonly place: (input: {
    readonly vmAgentId: VmAgentId;
    readonly deviceLabel: string;
  }) => Effect.Effect<AgentCall, AgentCallError>;
  /**
   * The agent rings the person. Gated on "Agents can call me" and an OpenAI
   * key, one open call per agent, one ring per `key`, a cooldown between
   * automatic rings and an hourly cap on explicit ones.
   */
  readonly ring: (input: {
    readonly vmAgentId: VmAgentId;
    readonly reason: AgentCallRingReason;
    readonly topic: string | null;
    readonly key: string;
  }) => Effect.Effect<AgentCallRingOutcome>;
  /**
   * Compare-and-set ringing → active. A second claimant learns who answered.
   * Starts the call's lease: it ends unless `renew` runs at least every
   * AGENT_CALL_LEASE_SECONDS.
   */
  readonly claim: (
    callId: AgentCallId,
    deviceLabel: string,
  ) => Effect.Effect<AgentCall, AgentCallError>;
  /** Extends an active call's lease; false when the call is no longer active. */
  readonly renew: (callId: AgentCallId) => Effect.Effect<boolean>;
  /** Ringing → declined. Idempotent; anything else is left alone. */
  readonly decline: (callId: AgentCallId) => Effect.Effect<void>;
  /**
   * Ringing or active → ended. Idempotent. `ifRinging` ends it only while it
   * still rings: a device that never connected cancels without hanging up a
   * call another device answered.
   */
  readonly end: (
    callId: AgentCallId,
    options?: { readonly ifRinging?: boolean },
  ) => Effect.Effect<void>;
  /** Ringing or active → failed: voice could not start. */
  readonly fail: (callId: AgentCallId) => Effect.Effect<void>;
  /** Ends every ringing or active call of an agent, for when the agent is deleted. */
  readonly endForAgent: (vmAgentId: VmAgentId) => Effect.Effect<void>;
  /** The trigger behind a ringing call resolved before anyone answered. */
  readonly cancelByKey: (key: string) => Effect.Effect<void>;
}

export class AgentCalls extends Context.Service<AgentCalls, AgentCallsShape>()(
  "t3/vm/AgentCalls",
) {}

/** How a device names itself on "Answered on <label>". */
export function describeClientDevice(client: AuthClientMetadata | undefined): string {
  const label = client?.label?.trim();
  if (label) return label.slice(0, 200);
  const browser = client?.browser?.trim();
  const os = client?.os?.trim();
  if (browser && os) return `${browser} on ${os}`.slice(0, 200);
  if (browser || os) return (browser || os || "").slice(0, 200);
  switch (client?.deviceType) {
    case "mobile":
      return "a phone";
    case "tablet":
      return "a tablet";
    case "desktop":
      return "a computer";
    default:
      return "another device";
  }
}

/** The label of an authenticated session's device; never fails. */
export const sessionDeviceLabel = (
  sessions: SessionStore.SessionStore["Service"],
  sessionId: AuthSessionId,
) =>
  sessions.listActive().pipe(
    Effect.map((active) =>
      describeClientDevice(active.find((session) => session.sessionId === sessionId)?.client),
    ),
    Effect.orElseSucceed(() => describeClientDevice(undefined)),
  );

const isOpen = (call: AgentCall) => call.status === "ringing" || call.status === "active";
const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const secrets = yield* ServerSecretStore;
  const agents = yield* VmAgentStore;
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  /** `leaseUntil`: epoch ms an active call ends at unless its device renews it. */
  const records = new Map<
    string,
    { call: AgentCall; key: string | null; leaseUntil: number | null }
  >();
  const rungKeys = new Map<string, number>();
  const lastRingAt = new Map<string, number>();
  const requestRings = new Map<string, ReadonlyArray<number>>();
  const toSnapshot = (): AgentCallsSnapshot => ({
    type: "snapshot",
    calls: [...records.values()]
      .map((record) => record.call)
      .toReversed()
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt)),
  });
  const snapshotRef = yield* SubscriptionRef.make(toSnapshot());
  const transitions = yield* PubSub.unbounded<AgentCallTransition>();
  const nowMs = Effect.map(DateTime.now, DateTime.toEpochMillis);
  const openAiKeyConfigured = resolveOrchestratorApiKey("openai").pipe(
    Effect.provideService(ServerSecretStore, secrets),
    Effect.map(Option.isSome),
  );
  // Fails closed: unreadable settings ring nobody.
  const ringingAllowed = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    return settings.orchestrator.agentCalls && (yield* openAiKeyConfigured);
  }).pipe(Effect.orElseSucceed(() => false));

  const after = (delayMs: number, effect: Effect.Effect<void>) =>
    Effect.sleep(Duration.millis(Math.max(0, delayMs))).pipe(
      Effect.andThen(effect),
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  const prune = (callId: AgentCallId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const record = records.get(callId);
        if (!record || isOpen(record.call)) return;
        records.delete(callId);
        yield* SubscriptionRef.set(snapshotRef, toSnapshot());
      }),
    );

  /** Writes one call change and announces it; callers hold the lock. */
  const commit = Effect.fnUntraced(function* (
    previous: AgentCall | null,
    call: AgentCall,
    key: string | null,
    leaseUntil: number | null = null,
  ) {
    records.set(call.callId, { call, key, leaseUntil });
    if (!isOpen(call)) {
      const ended = [...records.values()].filter((record) => !isOpen(record.call));
      for (const record of ended.slice(0, Math.max(0, ended.length - MAX_ENDED_CALLS)))
        records.delete(record.call.callId);
      yield* after(AGENT_CALL_ENDED_RETENTION_MS, prune(call.callId));
    }
    yield* SubscriptionRef.set(snapshotRef, toSnapshot());
    yield* PubSub.publish(transitions, { previous, call });
  });

  /** Moves a call to a terminal status when `from` allows it; callers hold the lock. */
  const settle = Effect.fnUntraced(function* (
    callId: AgentCallId,
    from: ReadonlyArray<AgentCall["status"]>,
    status: "declined" | "missed" | "ended" | "failed",
  ) {
    const record = records.get(callId);
    if (!record || !from.includes(record.call.status)) return;
    const now = yield* nowMs;
    yield* commit(
      record.call,
      { ...record.call, status, endedAt: isoAt(now), expiresAt: null },
      record.key,
    );
  });
  const settleLocked = (
    callId: AgentCallId,
    from: ReadonlyArray<AgentCall["status"]>,
    status: "declined" | "missed" | "ended" | "failed",
  ) => lock.withPermits(1)(settle(callId, from, status));

  /**
   * Ends an active call whose lease lapsed (its device crashed, lost the
   * network or was closed without hanging up); otherwise checks again when the
   * renewed lease would lapse. One check is pending per active call.
   */
  const expireLease = (callId: AgentCallId): Effect.Effect<void> =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const record = records.get(callId);
          if (!record || record.call.status !== "active" || record.leaseUntil === null) return null;
          const now = yield* nowMs;
          if (now < record.leaseUntil) return record.leaseUntil - now;
          yield* settle(callId, ["active"], "ended");
          return null;
        }),
      )
      .pipe(
        Effect.flatMap((remainingMs) =>
          remainingMs === null
            ? Effect.void
            : after(
                remainingMs,
                Effect.suspend(() => expireLease(callId)),
              ),
        ),
      );

  const renew: AgentCallsShape["renew"] = (callId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const record = records.get(callId);
        if (!record || record.call.status !== "active") return false;
        records.set(callId, { ...record, leaseUntil: (yield* nowMs) + LEASE_MS });
        return true;
      }),
    );

  const openCallFor = (vmAgentId: VmAgentId) =>
    [...records.values()].find(
      (record) => record.call.vmAgentId === vmAgentId && isOpen(record.call),
    )?.call;

  const place: AgentCallsShape["place"] = Effect.fn("AgentCalls.place")(function* (input) {
    const agent = yield* agents
      .getById(input.vmAgentId)
      .pipe(Effect.mapError(() => new AgentCallError({ detail: "Could not look up that agent." })));
    if (Option.isNone(agent) || agent.value.threadId === null)
      return yield* new AgentCallError({ detail: "That agent has no chat to call." });
    if (!(yield* openAiKeyConfigured.pipe(Effect.orElseSucceed(() => false))))
      return yield* new AgentCallError({
        detail: "Add an OpenAI key in Settings → Orchestrator to call agents.",
      });
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const open = openCallFor(input.vmAgentId);
        if (open)
          return yield* new AgentCallError({
            detail:
              open.direction === "incoming" && open.status === "ringing"
                ? `${agent.value.name} is calling you. Answer that call instead.`
                : `You're already on a call with ${agent.value.name}.`,
          });
        const now = yield* nowMs;
        const call: AgentCall = {
          callId: AgentCallId.make(NodeCrypto.randomUUID()),
          vmAgentId: input.vmAgentId,
          direction: "outgoing",
          reason: "user",
          topic: null,
          status: "ringing",
          answeredBy: input.deviceLabel.slice(0, 200),
          createdAt: isoAt(now),
          answeredAt: null,
          endedAt: null,
          expiresAt: isoAt(now + AGENT_CALL_OUTGOING_RING_SECONDS * 1_000),
        };
        yield* commit(null, call, null);
        yield* after(
          AGENT_CALL_OUTGOING_RING_SECONDS * 1_000,
          settleLocked(call.callId, ["ringing"], "failed"),
        );
        return call;
      }),
    );
  });

  const ring: AgentCallsShape["ring"] = Effect.fn("AgentCalls.ring")(function* (input) {
    if (!(yield* ringingAllowed)) return { status: "disabled" } as const;
    return yield* lock.withPermits(1)(
      Effect.gen(function* (): Effect.fn.Return<AgentCallRingOutcome> {
        const now = yield* nowMs;
        for (const [key, at] of rungKeys)
          if (now - at > RUNG_KEY_RETENTION_MS) rungKeys.delete(key);
        const open = openCallFor(input.vmAgentId);
        if (open) return { status: open.status === "active" ? "busy" : "already-ringing" };
        if (rungKeys.has(input.key)) return { status: "duplicate" };
        if (input.reason === "request") {
          const recent = (requestRings.get(input.vmAgentId) ?? []).filter(
            (at) => now - at < HOUR_MS,
          );
          if (recent.length >= AGENT_CALL_REQUESTS_PER_HOUR) return { status: "rate-limited" };
          requestRings.set(input.vmAgentId, [...recent, now]);
        } else {
          const last = lastRingAt.get(input.vmAgentId);
          if (last !== undefined && now - last < AGENT_CALL_AUTOMATIC_COOLDOWN_MS)
            return { status: "cooldown" };
        }
        rungKeys.set(input.key, now);
        lastRingAt.set(input.vmAgentId, now);
        const call: AgentCall = {
          callId: AgentCallId.make(NodeCrypto.randomUUID()),
          vmAgentId: input.vmAgentId,
          direction: "incoming",
          reason: input.reason,
          topic: input.topic?.trim().slice(0, 500) || null,
          status: "ringing",
          answeredBy: null,
          createdAt: isoAt(now),
          answeredAt: null,
          endedAt: null,
          expiresAt: isoAt(now + AGENT_CALL_RING_SECONDS * 1_000),
        };
        yield* commit(null, call, input.key);
        yield* after(
          AGENT_CALL_RING_SECONDS * 1_000,
          settleLocked(call.callId, ["ringing"], "missed"),
        );
        return { status: "ringing", call };
      }),
    );
  });

  const claim: AgentCallsShape["claim"] = Effect.fn("AgentCalls.claim")(
    function* (callId, deviceLabel) {
      const record = records.get(callId);
      if (!record) return yield* new AgentCallError({ detail: "This call has ended." });
      const call = record.call;
      switch (call.status) {
        case "active":
          return yield* new AgentCallError({
            detail: `Answered on ${call.answeredBy ?? describeClientDevice(undefined)}`,
          });
        case "declined":
          return yield* new AgentCallError({ detail: "This call was declined." });
        case "missed":
          return yield* new AgentCallError({ detail: "This call was missed." });
        case "ended":
        case "failed":
          return yield* new AgentCallError({ detail: "This call has ended." });
        case "ringing":
          break;
      }
      const now = yield* nowMs;
      const answered: AgentCall = {
        ...call,
        status: "active",
        answeredBy: deviceLabel.slice(0, 200),
        answeredAt: isoAt(now),
        expiresAt: null,
      };
      yield* commit(call, answered, record.key, now + LEASE_MS);
      yield* after(LEASE_MS, expireLease(callId));
      yield* after(AGENT_CALL_MAX_ACTIVE_MS, settleLocked(callId, ["active"], "ended"));
      return answered;
    },
    (effect) => lock.withPermits(1)(effect),
  );

  const cancelByKey: AgentCallsShape["cancelByKey"] = (key) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const ringing = [...records.values()].filter(
          (record) => record.key === key && record.call.status === "ringing",
        );
        for (const record of ringing) yield* settle(record.call.callId, ["ringing"], "ended");
      }),
    );

  const endForAgent: AgentCallsShape["endForAgent"] = (vmAgentId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const open = [...records.values()].filter(
          (record) => record.call.vmAgentId === vmAgentId && isOpen(record.call),
        );
        for (const record of open)
          yield* settle(record.call.callId, ["ringing", "active"], "ended");
      }),
    );

  return AgentCalls.of({
    snapshot: SubscriptionRef.get(snapshotRef),
    changes: SubscriptionRef.changes(snapshotRef),
    transitions: Stream.fromPubSub(transitions),
    get: (callId) => Effect.sync(() => Option.fromUndefinedOr(records.get(callId)?.call)),
    place,
    ring,
    claim,
    renew,
    decline: (callId) => settleLocked(callId, ["ringing"], "declined"),
    end: (callId, options) =>
      settleLocked(callId, options?.ifRinging ? ["ringing"] : ["ringing", "active"], "ended"),
    fail: (callId) => settleLocked(callId, ["ringing", "active"], "failed"),
    endForAgent,
    cancelByKey,
  });
});

export const layer = Layer.effect(AgentCalls, make);
