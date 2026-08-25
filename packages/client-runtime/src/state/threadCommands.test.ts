import {
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createAtomCommandScheduler, type AtomCommandResult } from "./runtime.ts";
import { createThreadEnvironmentAtoms, threadControlCommandConcurrency } from "./threadCommands.ts";

describe("thread control command scheduling", () => {
  it("dispatches Stop without waiting for a hung command in the thread's serial lane", async () => {
    const scheduler = createAtomCommandScheduler();
    const registry = AtomRegistry.make();
    const target = {
      environmentId: "environment-1",
      input: { threadId: "thread-1" },
    };
    const serialConcurrency = {
      mode: "serial" as const,
      key: ({ environmentId, input }: typeof target) =>
        JSON.stringify([environmentId, input.threadId]),
    };
    let releaseHungCommand: (() => void) | undefined;
    const hungCommand = scheduler.schedule(
      registry,
      serialConcurrency,
      target,
      () =>
        new Promise<AtomCommandResult<string, never>>((resolve) => {
          releaseHungCommand = () => resolve(AsyncResult.success("released"));
        }),
    );

    const stop = scheduler.schedule(registry, threadControlCommandConcurrency, target, async () =>
      AsyncResult.success("stopped"),
    );

    await expect(stop).resolves.toMatchObject({ _tag: "Success", value: "stopped" });
    releaseHungCommand?.();
    await hungCommand;
    registry.dispose();
  });

  it("wires the real interrupt command outside a hung start-turn lane", async () => {
    const environmentId = EnvironmentId.make("environment-1");
    const threadId = ThreadId.make("thread-1");
    const turnStarted = await Effect.runPromise(Deferred.make<void>());
    const releaseTurn = await Effect.runPromise(Deferred.make<void>());
    const dispatched: ClientOrchestrationCommand[] = [];
    const client = {
      [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) => {
        dispatched.push(command);
        return command.type === "thread.turn.start"
          ? Deferred.succeed(turnStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseTurn)),
              Effect.as({ sequence: dispatched.length }),
            )
          : Effect.succeed({ sequence: dispatched.length });
      },
    } as unknown as WsRpcProtocolClient;
    const target = new PrimaryConnectionTarget({
      environmentId,
      label: "Test environment",
      httpBaseUrl: "https://environment.example.test",
      wsBaseUrl: "wss://environment.example.test",
    });
    const session: RpcSession = {
      client,
      initialConfig: Effect.never,
      ready: Effect.void,
      probe: Effect.void,
      closed: Effect.never,
    };
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target,
      state: await Effect.runPromise(SubscriptionRef.make(AVAILABLE_CONNECTION_STATE)),
      session: await Effect.runPromise(SubscriptionRef.make(Option.some(session))),
      prepared: await Effect.runPromise(SubscriptionRef.make(Option.none<PreparedConnection>())),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
    const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
      run: (_environmentId, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
    const deferredStore = Persistence.DeferredThreadCommandStore.of({
      list: () => Effect.succeed([]),
      enqueue: () => Effect.void,
      remove: () => Effect.void,
      clear: () => Effect.void,
    });
    const crypto = Crypto.make({
      randomBytes: (size) => new Uint8Array(size),
      digest: (_algorithm, data) => Effect.succeed(data),
    });
    const runtime = Atom.runtime(
      Layer.mergeAll(
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
        Layer.succeed(Persistence.DeferredThreadCommandStore, deferredStore),
        Layer.succeed(Crypto.Crypto, crypto),
      ),
    );
    const atoms = createThreadEnvironmentAtoms(runtime);
    const registry = AtomRegistry.make();
    const createdAt = "2026-08-25T00:00:00.000Z";

    const hungTurn = atoms.startTurn.run(registry, {
      environmentId,
      input: {
        commandId: CommandId.make("command-start"),
        threadId,
        message: {
          messageId: MessageId.make("message-start"),
          role: "user",
          text: "Keep working",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt,
      },
    });
    await Effect.runPromise(Deferred.await(turnStarted).pipe(Effect.timeout("2 seconds")));

    const interruptResult = await atoms.interruptTurn.run(registry, {
      environmentId,
      input: {
        commandId: CommandId.make("command-interrupt"),
        threadId,
        createdAt,
      },
    });

    expect(interruptResult).toMatchObject({ _tag: "Success" });
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.turn.start",
      "thread.turn.interrupt",
    ]);

    await Effect.runPromise(Deferred.succeed(releaseTurn, undefined));
    await hungTurn;
    registry.dispose();
  });
});
