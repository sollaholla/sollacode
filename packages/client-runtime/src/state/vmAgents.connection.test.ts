import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  VmAgentId,
  VmId,
  WS_METHODS,
  type VmAgentStreamEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createVmAgentEnvironmentAtoms } from "./vmAgents.ts";

it.effect(
  "retains the agent registry across a lost session and accepts the next authoritative snapshot",
  () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("offline-agents");
      const events = yield* Queue.unbounded<VmAgentStreamEvent>();
      const closed = yield* Queue.unbounded<void>();
      const client = {
        [WS_METHODS.vmAgentSubscribe]: () =>
          Stream.fromQueue(events).pipe(Stream.ensuring(Queue.offer(closed, undefined))),
      } as unknown as WsRpcProtocolClient;
      const session: RpcSession = {
        client,
        initialConfig: Effect.never,
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      };
      const sessions = yield* SubscriptionRef.make(Option.some(session));
      const supervisor = EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: "Host",
          httpBaseUrl: "https://host.test",
          wsBaseUrl: "wss://host.test",
        }),
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: sessions,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const registryService: Pick<EnvironmentRegistry["Service"], "followStream"> = {
        followStream: (_id, stream) =>
          stream.pipe(Stream.provideService(EnvironmentSupervisor, supervisor)),
      };
      const runtime = Atom.runtime(
        Layer.succeed(EnvironmentRegistry, registryService as EnvironmentRegistry["Service"]),
      );
      const atoms = createVmAgentEnvironmentAtoms(runtime);
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const atom = atoms.agents({ environmentId, input: {} });
      yield* AtomRegistry.mount(registry, atom);
      const scout = {
        vmAgentId: VmAgentId.make("scout"),
        vmId: VmId.make("vm"),
        threadId: ThreadId.make("thread"),
        name: "Scout",
        handle: "scout",
        purpose: "Test",
        icon: null,
        status: "running" as const,
        controlMode: "agent" as const,
        guestIp: null,
        lastError: null,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z",
      };
      yield* Queue.offer(events, { type: "snapshot", agents: [scout] });
      const initial = yield* AtomRegistry.getResult(registry, atom);
      expect(initial.agents).toEqual([scout]);
      yield* SubscriptionRef.set(sessions, Option.none());
      yield* Queue.take(closed);
      expect(Option.getOrThrow(AsyncResult.value(registry.get(atom))).agents).toEqual([scout]);
      yield* SubscriptionRef.set(sessions, Option.some({ ...session }));
      const stopped = { ...scout, status: "stopped" as const };
      yield* Queue.offer(events, { type: "snapshot", agents: [stopped] });
      const refreshed = yield* AtomRegistry.toStreamResult(registry, atom).pipe(
        Stream.filter((value) => value.agents[0]?.status === "stopped"),
        Stream.runHead,
      );
      expect(Option.getOrThrow(refreshed).agents).toEqual([stopped]);
      yield* Queue.offer(events, { type: "snapshot", agents: [] });
      const empty = yield* AtomRegistry.toStreamResult(registry, atom).pipe(
        Stream.filter((value) => value.agents.length === 0),
        Stream.runHead,
      );
      expect(Option.getOrThrow(empty).agents).toEqual([]);
    }),
);
