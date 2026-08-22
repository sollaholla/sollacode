/**
 * VmManager - owns the Agent Stack: named agents, their VM lifecycle, the live
 * registry stream, and per-agent screen streams.
 *
 * Agents are their own feature (not threads). The manager holds identity and
 * streaming; a {@link VmProvider} performs the VM mechanics, so the whole path
 * is testable against the mock provider.
 */
import {
  ThreadId,
  VmAgent,
  type VmAgentInput,
  VmAgentId,
  VmAgentNameConflictError,
  VmAgentNotFoundError,
  VmControlMode,
  VmId,
  VmProviderError,
  VmScreenControlEvent,
  VmScreenStreamEvent,
  VmAgentStreamEvent,
  VmUserControlActiveError,
  toVmAgentHandle,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

import { VmAgentStore } from "../persistence/Services/VmAgents.ts";
import { VmProvider, type VmCapturedFrame } from "./VmProvider.ts";

/** ~7 fps: smooth enough for a live desktop, cheap enough for several agents. */
const FRAME_INTERVAL = "150 millis";

type AgentListener = (event: VmAgentStreamEvent) => Effect.Effect<void>;
type ScreenListener = (event: VmScreenStreamEvent) => Effect.Effect<void>;

export interface VmManagerShape {
  readonly create: (input: {
    readonly name: string;
    readonly purpose: string;
    /** The agent's dedicated chat thread, created by the caller (or null). */
    readonly threadId: ThreadId | null;
  }) => Effect.Effect<VmAgent, VmAgentNameConflictError>;

  /** Removes the agent and returns its chat thread id so the caller can delete it. */
  readonly deleteAgent: (
    vmAgentId: VmAgentId,
  ) => Effect.Effect<ThreadId | null, VmAgentNotFoundError>;

  readonly start: (vmAgentId: VmAgentId) => Effect.Effect<VmAgent, VmAgentNotFoundError>;

  /** Boot the VM if needed and wait until it is actually ready for agent work. */
  readonly ensureRunning: (
    vmAgentId: VmAgentId,
  ) => Effect.Effect<VmAgent, VmAgentNotFoundError | VmProviderError>;

  readonly stop: (vmAgentId: VmAgentId) => Effect.Effect<VmAgent, VmAgentNotFoundError>;

  readonly setControlMode: (input: {
    readonly vmAgentId: VmAgentId;
    readonly controlMode: VmControlMode;
  }) => Effect.Effect<VmAgent, VmAgentNotFoundError>;

  /**
   * Forward one user input event to the guest. Accepted only while the user
   * holds control (takeover); silently ignored otherwise so a released-control
   * race can never drive the agent's machine.
   */
  readonly sendInput: (input: {
    readonly vmAgentId: VmAgentId;
    readonly input: VmAgentInput;
  }) => Effect.Effect<void, VmAgentNotFoundError>;

  /**
   * Capture the agent's own screen for its perception (the `vm_computer`
   * screenshot action). Refused while the user holds control (takeover), so the
   * agent cannot photograph the screen while the user types a password.
   */
  readonly agentScreenshot: (
    vmAgentId: VmAgentId,
  ) => Effect.Effect<
    VmCapturedFrame,
    VmAgentNotFoundError | VmUserControlActiveError | VmProviderError
  >;

  /**
   * Inject one input event on the agent's own behalf (the `vm_computer`
   * click/type/etc actions). Refused while the user holds control.
   */
  readonly agentInput: (
    vmAgentId: VmAgentId,
    input: VmAgentInput,
  ) => Effect.Effect<void, VmAgentNotFoundError | VmUserControlActiveError | VmProviderError>;

  /** Subscribe to the registry: a full snapshot initially and on every change. */
  readonly subscribeAgents: (listener: AgentListener) => Effect.Effect<() => void>;

  /** Subscribe to one agent's screen: current control mode, then live frames. */
  readonly subscribeScreen: (
    vmAgentId: VmAgentId,
    listener: ScreenListener,
  ) => Effect.Effect<() => void, VmAgentNotFoundError>;
}

export class VmManager extends Context.Service<VmManager, VmManagerShape>()("t3/vm/VmManager") {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const make = Effect.gen(function* () {
  const provider = yield* VmProvider;
  const store = yield* VmAgentStore;

  const agentListeners = new Set<AgentListener>();
  const screenListeners = new Map<string, Set<ScreenListener>>();
  const pumps = new Map<string, Fiber.Fiber<unknown, unknown>>();
  const bootFibers = new Map<
    string,
    Fiber.Fiber<VmAgent, VmAgentNotFoundError | VmProviderError>
  >();
  // Synchronous reservation so two near-simultaneous subscribers can't each
  // start a pump for the same agent.
  const pumpStarting = new Set<string>();
  const controlModes = new Map<string, VmControlMode>();
  // Which VMs are booted. A frame pump only runs while a VM is running *and*
  // has at least one screen subscriber — capturing frames nobody watches is
  // wasted work (and, in tests, a stray always-on fiber).
  const runningVms = new Set<string>();

  const workerScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void));

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

  const publishScreenEvent = (vmAgentId: string, event: VmScreenStreamEvent) =>
    Effect.gen(function* () {
      const listeners = screenListeners.get(vmAgentId);
      if (!listeners) return;
      for (const listener of listeners) {
        yield* listener(event).pipe(Effect.ignoreCause({ log: true }));
      }
    });

  const stopPump = (vmAgentId: string) =>
    Effect.gen(function* () {
      const fiber = pumps.get(vmAgentId);
      if (fiber) {
        pumps.delete(vmAgentId);
        yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
      }
    });

  const startPump = (vmAgentId: VmAgentId, vmId: VmId) =>
    Effect.gen(function* () {
      let sequence = 0;
      const captureOnce = provider.capture(vmId).pipe(
        Effect.flatMap((frame) =>
          Effect.flatMap(nowIso, (capturedAt) => {
            sequence += 1;
            return publishScreenEvent(vmAgentId, {
              type: "frame",
              sequence,
              width: frame.width,
              height: frame.height,
              format: frame.format,
              data: frame.data,
              capturedAt,
              ...(frame.cursor ? { cursor: frame.cursor } : {}),
            });
          }),
        ),
        Effect.catch(() => Effect.void),
      );
      // Self-terminating loop: it checks — synchronously, before any await — that
      // the VM is still running and still watched, and stops (removing itself
      // from `pumps`) otherwise. So a sync `unsubscribe()` that only removes a
      // listener is enough to wind the pump down within one frame interval.
      const loop: Effect.Effect<void> = Effect.suspend(() => {
        const listeners = screenListeners.get(vmAgentId);
        if (!runningVms.has(vmAgentId) || !listeners || listeners.size === 0) {
          pumps.delete(vmAgentId);
          return Effect.void;
        }
        return captureOnce.pipe(
          Effect.flatMap(() => Effect.sleep(FRAME_INTERVAL)),
          Effect.flatMap(() => loop),
        );
      });
      const fiber = yield* loop.pipe(Effect.forkIn(workerScope));
      pumps.set(vmAgentId, fiber);
    });

  // Start a pump only when it is both warranted (VM running) and wanted (a
  // screen subscriber exists), and not already running or starting.
  const ensurePump = (vmAgentId: VmAgentId, vmId: VmId) =>
    Effect.gen(function* () {
      if (pumps.has(vmAgentId) || pumpStarting.has(vmAgentId)) return;
      if (!runningVms.has(vmAgentId)) return;
      const listeners = screenListeners.get(vmAgentId);
      if (!listeners || listeners.size === 0) return;
      pumpStarting.add(vmAgentId);
      yield* startPump(vmAgentId, vmId).pipe(
        Effect.ensuring(Effect.sync(() => pumpStarting.delete(vmAgentId))),
      );
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

  const persistRuntime = (
    vmAgentId: VmAgentId,
    status: VmAgent["status"],
    guestIp: string | null,
    lastError: string | null,
  ) =>
    Effect.gen(function* () {
      const updatedAt = yield* nowIso;
      yield* store
        .updateRuntime({ vmAgentId, status, guestIp, lastError, updatedAt })
        .pipe(Effect.orDie);
      const agent = yield* requireAgent(vmAgentId);
      yield* publishAgents();
      return agent;
    });

  // Boot a freshly-created or stopped VM, streaming the state transitions live.
  const boot = (vmAgentId: VmAgentId, vmId: VmId) =>
    Effect.gen(function* () {
      yield* persistRuntime(vmAgentId, "starting", null, null);
      return yield* provider.start(vmId).pipe(
        Effect.matchEffect({
          onSuccess: (result) =>
            Effect.gen(function* () {
              runningVms.add(vmAgentId);
              const agent = yield* persistRuntime(vmAgentId, "running", result.guestIp, null);
              // If a viewer subscribed while the VM was booting, begin streaming now.
              yield* ensurePump(vmAgentId, vmId);
              return agent;
            }),
          onFailure: (error) =>
            Effect.gen(function* () {
              runningVms.delete(vmAgentId);
              yield* persistRuntime(vmAgentId, "failed", null, error.message);
              return yield* error;
            }),
        }),
      );
    });

  const launchBoot = (vmAgentId: VmAgentId, vmId: VmId) =>
    Effect.gen(function* () {
      const existing = bootFibers.get(vmAgentId);
      if (existing) return existing;
      const fiber = yield* boot(vmAgentId, vmId).pipe(Effect.forkIn(workerScope));
      bootFibers.set(vmAgentId, fiber);
      yield* Fiber.await(fiber).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (bootFibers.get(vmAgentId) === fiber) bootFibers.delete(vmAgentId);
          }),
        ),
        Effect.forkIn(workerScope),
      );
      return fiber;
    });

  const interruptBoot = (vmAgentId: VmAgentId) =>
    Effect.gen(function* () {
      const fiber = bootFibers.get(vmAgentId);
      bootFibers.delete(vmAgentId);
      if (fiber) yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
    });

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
      const vmId = VmId.make(`vm-${NodeCrypto.randomUUID()}`);
      const createdAt = yield* nowIso;
      const threadId = input.threadId;

      // Provisioning failure is surfaced as a failed agent, not a hard error:
      // the row still exists so the user can retry or delete it.
      const provisioned = yield* provider.create({ vmId, agentName: input.name }).pipe(
        Effect.as({ status: "provisioning" as const, lastError: null as string | null }),
        Effect.catch((error) =>
          Effect.succeed({ status: "failed" as const, lastError: error.message }),
        ),
      );

      const agent: VmAgent = {
        vmAgentId,
        name: input.name,
        handle,
        purpose: input.purpose,
        vmId,
        threadId,
        status: provisioned.status,
        controlMode: "agent",
        guestIp: null,
        lastError: provisioned.lastError,
        createdAt,
        updatedAt: createdAt,
      };

      yield* store.insert(agent).pipe(Effect.orDie);
      controlModes.set(vmAgentId, "agent");
      yield* publishAgents();

      if (agent.status !== "failed") {
        yield* launchBoot(vmAgentId, vmId);
      }

      return agent;
    });

  const start: VmManagerShape["start"] = (vmAgentId) =>
    Effect.gen(function* () {
      const agent = yield* requireAgent(vmAgentId);
      yield* launchBoot(vmAgentId, agent.vmId);
      return agent;
    });

  const ensureRunning: VmManagerShape["ensureRunning"] = (vmAgentId) =>
    Effect.gen(function* () {
      const agent = yield* requireAgent(vmAgentId);
      if (agent.status === "running" && runningVms.has(vmAgentId)) return agent;
      const fiber = yield* launchBoot(vmAgentId, agent.vmId);
      return yield* Fiber.join(fiber);
    });

  const stop: VmManagerShape["stop"] = (vmAgentId) =>
    Effect.gen(function* () {
      const agent = yield* requireAgent(vmAgentId);
      runningVms.delete(vmAgentId);
      yield* interruptBoot(vmAgentId);
      yield* stopPump(vmAgentId);
      yield* persistRuntime(vmAgentId, "stopping", null, null);
      yield* provider.stop(agent.vmId).pipe(Effect.catch(() => Effect.void));
      return yield* persistRuntime(vmAgentId, "stopped", null, null);
    });

  const deleteAgent: VmManagerShape["deleteAgent"] = (vmAgentId) =>
    Effect.gen(function* () {
      const agent = yield* requireAgent(vmAgentId);
      runningVms.delete(vmAgentId);
      yield* interruptBoot(vmAgentId);
      yield* stopPump(vmAgentId);
      yield* provider.stop(agent.vmId).pipe(Effect.catch(() => Effect.void));
      yield* provider.delete(agent.vmId).pipe(Effect.catch(() => Effect.void));
      yield* store.deleteById(vmAgentId).pipe(Effect.orDie);
      controlModes.delete(vmAgentId);
      screenListeners.delete(vmAgentId);
      yield* publishAgents();
      // The caller (ws handler) deletes the chat thread; it owns orchestration.
      return agent.threadId;
    });

  const setControlMode: VmManagerShape["setControlMode"] = (input) =>
    Effect.gen(function* () {
      yield* requireAgent(input.vmAgentId);
      const updatedAt = yield* nowIso;
      yield* store
        .updateControlMode({
          vmAgentId: input.vmAgentId,
          controlMode: input.controlMode,
          updatedAt,
        })
        .pipe(Effect.orDie);
      controlModes.set(input.vmAgentId, input.controlMode);
      const controlEvent: VmScreenControlEvent = {
        type: "control",
        controlMode: input.controlMode,
      };
      yield* publishScreenEvent(input.vmAgentId, controlEvent);
      const agent = yield* requireAgent(input.vmAgentId);
      yield* publishAgents();
      return agent;
    });

  const sendInput: VmManagerShape["sendInput"] = (input) =>
    Effect.gen(function* () {
      const agent = yield* requireAgent(input.vmAgentId);
      const mode = controlModes.get(input.vmAgentId) ?? agent.controlMode;
      if (mode !== "user") return;
      // Best-effort: a transient guest/input failure must not surface as a hard
      // RPC error on a high-frequency stream of pointer moves.
      yield* provider.input(agent.vmId, input.input).pipe(Effect.catch(() => Effect.void));
    });

  // The agent may act only while it actually holds control. If the user has
  // taken over, the agent's eyes and hands are suspended — it must wait.
  const requireAgentControl = (vmAgentId: VmAgentId) =>
    Effect.gen(function* () {
      const agent = yield* requireAgent(vmAgentId);
      const mode = controlModes.get(vmAgentId) ?? agent.controlMode;
      if (mode === "user") {
        return yield* new VmUserControlActiveError({ vmAgentId });
      }
      return agent;
    });

  const agentScreenshot: VmManagerShape["agentScreenshot"] = (vmAgentId) =>
    Effect.gen(function* () {
      const agent = yield* requireAgentControl(vmAgentId);
      return yield* provider.capture(agent.vmId);
    });

  const agentInput: VmManagerShape["agentInput"] = (vmAgentId, input) =>
    Effect.gen(function* () {
      const agent = yield* requireAgentControl(vmAgentId);
      yield* provider.input(agent.vmId, input);
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

  const subscribeScreen: VmManagerShape["subscribeScreen"] = (vmAgentId, listener) =>
    Effect.gen(function* () {
      const agent = yield* requireAgent(vmAgentId);
      let listeners = screenListeners.get(vmAgentId);
      if (!listeners) {
        listeners = new Set();
        screenListeners.set(vmAgentId, listeners);
      }
      listeners.add(listener);
      // Open with the current control mode so a late joiner renders the takeover
      // banner correctly before any frame arrives.
      const controlMode = controlModes.get(vmAgentId) ?? "agent";
      yield* listener({ type: "control", controlMode });
      // Begin (or keep) streaming while this viewer is attached.
      yield* ensurePump(vmAgentId, agent.vmId);
      return () => {
        listeners?.delete(listener);
      };
    });

  // Startup reconciliation. The provider and `runningVms` live only in memory,
  // so after a process restart an agent persisted as "running" has no backing
  // VM: its frame pump can never start and the live view hangs forever on
  // "waiting for the first frame". Re-seed control modes for every agent and
  // re-boot any that should be running so the VM comes back and frames resume.
  const reconcile = Effect.gen(function* () {
    const agents = yield* store.list().pipe(Effect.orDie);
    for (const agent of agents) {
      controlModes.set(agent.vmAgentId, agent.controlMode);
      if (agent.status === "running" || agent.status === "starting") {
        yield* launchBoot(agent.vmAgentId, agent.vmId);
      }
    }
  });
  yield* reconcile.pipe(
    Effect.catchCause((cause) => Effect.logWarning("vm.manager.reconcile-failed", { cause })),
    Effect.forkIn(workerScope),
  );

  return {
    create,
    deleteAgent,
    start,
    ensureRunning,
    stop,
    setControlMode,
    sendInput,
    agentScreenshot,
    agentInput,
    subscribeAgents,
    subscribeScreen,
  } satisfies VmManagerShape;
});

export const VmManagerLive = Layer.effect(VmManager, make);
