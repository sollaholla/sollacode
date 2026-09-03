/**
 * VmManager - owns the Agent Stack registry: named agents, their identity, and
 * the live registry stream.
 *
 * Historically this also booted a per-agent hidden browser VM the agent drove
 * through `vm_computer`. That surface is gone: agents work in their chat
 * thread's collaborative preview browser, whose per-thread profile keeps their
 * logins. What remains here is identity plus registry streaming; the "Vm"
 * naming survives in ids and tables for continuity.
 */
import {
  ThreadId,
  VmAgent,
  type VmAgentIcon,
  type VmAgentStatus,
  VmAgentId,
  VmAgentNameConflictError,
  VmAgentNotFoundError,
  VmAgentStreamEvent,
  VmId,
  toVmAgentHandle,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { VmAgentStore } from "../persistence/Services/VmAgents.ts";

type AgentListener = (event: VmAgentStreamEvent) => Effect.Effect<void>;

export interface VmManagerShape {
  readonly create: (input: {
    readonly name: string;
    readonly purpose: string;
    /** Outlined glyph chosen at creation; omitted when the first run should pick it. */
    readonly icon?: VmAgentIcon | null | undefined;
    /** The agent's dedicated chat thread, created by the caller (or null). */
    readonly threadId: ThreadId | null;
  }) => Effect.Effect<VmAgent, VmAgentNameConflictError>;

  /** Removes the agent and returns its chat thread id so the caller can delete it. */
  readonly deleteAgent: (
    vmAgentId: VmAgentId,
  ) => Effect.Effect<ThreadId | null, VmAgentNotFoundError>;

  /** Set or clear the agent's glyph; the registry stream re-broadcasts. */
  readonly setIcon: (
    vmAgentId: VmAgentId,
    icon: VmAgentIcon | null,
  ) => Effect.Effect<VmAgent, VmAgentNotFoundError>;

  /**
   * Switch the agent on (`running`) or off (`stopped`); the registry stream
   * re-broadcasts. Callers own the side effects: interrupting a running turn
   * on stop, waking the task scheduler on start.
   */
  readonly setStatus: (
    vmAgentId: VmAgentId,
    status: Extract<VmAgentStatus, "running" | "stopped">,
  ) => Effect.Effect<VmAgent, VmAgentNotFoundError>;

  /** Subscribe to the registry: a full snapshot initially and on every change. */
  readonly subscribeAgents: (listener: AgentListener) => Effect.Effect<() => void>;
}

export class VmManager extends Context.Service<VmManager, VmManagerShape>()("t3/vm/VmManager") {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const make = Effect.gen(function* () {
  const store = yield* VmAgentStore;

  const agentListeners = new Set<AgentListener>();

  const publishAgentEvent = (event: VmAgentStreamEvent) =>
    Effect.gen(function* () {
      for (const listener of agentListeners) {
        yield* listener(event).pipe(Effect.ignoreCause({ log: true }));
      }
    });

  // The registry always broadcasts a full snapshot on change. Agent counts are
  // tiny, and a self-contained snapshot means every client's latest stream value
  // is the complete list — no client-side delta reduction required.
  const publishAgents = () =>
    Effect.gen(function* () {
      const agents = yield* store.list().pipe(Effect.orDie);
      yield* publishAgentEvent({ type: "snapshot", agents });
    });

  const requireAgent = (vmAgentId: VmAgentId) =>
    store.getById(vmAgentId).pipe(
      Effect.orDie,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new VmAgentNotFoundError({ vmAgentId })),
          onSome: (agent) => Effect.succeed(agent),
        }),
      ),
    );

  const create: VmManagerShape["create"] = (input) =>
    Effect.gen(function* () {
      const handleBase = toVmAgentHandle(input.name);
      const handle =
        handleBase.length > 0 ? handleBase : `agent-${NodeCrypto.randomUUID().slice(0, 8)}`;
      const nameLower = input.name.toLowerCase();

      const byName = yield* store.getByNameLower(nameLower).pipe(Effect.orDie);
      const byHandle = yield* store.getByHandle(handle).pipe(Effect.orDie);
      if (Option.isSome(byName) || Option.isSome(byHandle)) {
        return yield* new VmAgentNameConflictError({ name: input.name, handle });
      }

      const vmAgentId = VmAgentId.make(NodeCrypto.randomUUID());
      const createdAt = yield* nowIso;

      const agent: VmAgent = {
        vmAgentId,
        name: input.name,
        handle,
        purpose: input.purpose,
        icon: input.icon ?? null,
        // Vestigial identity column (NOT NULL UNIQUE) from the VM era.
        vmId: VmId.make(`vm-${NodeCrypto.randomUUID()}`),
        threadId: input.threadId,
        // With no VM to boot, an agent is ready the moment it exists.
        status: "running",
        controlMode: "agent",
        guestIp: null,
        lastError: null,
        createdAt,
        updatedAt: createdAt,
      };

      yield* store.insert(agent).pipe(Effect.orDie);
      yield* publishAgents();

      return agent;
    });

  const deleteAgent: VmManagerShape["deleteAgent"] = (vmAgentId) =>
    Effect.gen(function* () {
      const agent = yield* requireAgent(vmAgentId);
      yield* store.deleteById(vmAgentId).pipe(Effect.orDie);
      yield* publishAgents();
      // The caller (ws handler) deletes the chat thread; it owns orchestration.
      return agent.threadId;
    });

  const setIcon: VmManagerShape["setIcon"] = (vmAgentId, icon) =>
    Effect.gen(function* () {
      const agent = yield* requireAgent(vmAgentId);
      const updatedAt = yield* nowIso;
      yield* store.updateIcon({ vmAgentId, icon, updatedAt }).pipe(Effect.orDie);
      yield* publishAgents();
      return { ...agent, icon, updatedAt };
    });

  const setStatus: VmManagerShape["setStatus"] = (vmAgentId, status) =>
    Effect.gen(function* () {
      const agent = yield* requireAgent(vmAgentId);
      if (agent.status === status) return agent;
      const updatedAt = yield* nowIso;
      yield* store.updateStatus({ vmAgentId, status, updatedAt }).pipe(Effect.orDie);
      yield* publishAgents();
      return { ...agent, status, lastError: null, updatedAt };
    });

  const addAgentListener = (listener: AgentListener) =>
    Effect.sync(() => {
      agentListeners.add(listener);
      return () => {
        agentListeners.delete(listener);
      };
    });

  const subscribeAgents: VmManagerShape["subscribeAgents"] = (listener) => {
    let unsubscribe: (() => void) | null = null;
    return Effect.gen(function* () {
      const buffered: VmAgentStreamEvent[] = [];
      let deliverLive = false;
      unsubscribe = yield* addAgentListener((event) => {
        if (!deliverLive) {
          buffered.push(event);
          return Effect.void;
        }
        return listener(event);
      });
      const agents = yield* store.list().pipe(Effect.orDie);
      yield* listener({ type: "snapshot", agents });
      for (const event of buffered) {
        yield* listener(event);
      }
      deliverLive = true;
      return () => {
        unsubscribe?.();
        unsubscribe = null;
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.flatMap(
          Effect.sync(() => {
            unsubscribe?.();
            unsubscribe = null;
          }),
          () => Effect.failCause(cause),
        ),
      ),
    );
  };

  return {
    create,
    deleteAgent,
    setIcon,
    setStatus,
    subscribeAgents,
  } satisfies VmManagerShape;
});

export const VmManagerLive = Layer.effect(VmManager, make);
