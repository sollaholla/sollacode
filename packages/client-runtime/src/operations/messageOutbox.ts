import * as Schema from "effect/Schema";
import {
  CommandId,
  VmAgentBlockerResolveInput,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { DeferredThreadCommandStore } from "../platform/persistence.ts";
import type { StartThreadTurnInput } from "./commands.ts";
import {
  notifyDeferredThreadCommands,
  rememberedThreadShell,
} from "./deferredThreadCommandState.ts";

const decodeAfterReply = Schema.decodeUnknownSync(VmAgentBlockerResolveInput);

export type EnqueueThreadTurnInput = StartThreadTurnInput & {
  readonly afterReply?: VmAgentBlockerResolveInput;
  readonly metadata?: {
    readonly title?: string;
    readonly branch?: string;
    readonly worktreePath?: string | null;
  };
};

/** The composer may release its draft only after this durable write succeeds. */
export const enqueueThreadTurn = Effect.fn("MessageOutbox.enqueue")(function* (
  input: EnqueueThreadTurnInput,
) {
  const store = yield* DeferredThreadCommandStore;
  const { target } = yield* EnvironmentSupervisor;
  const { metadata, afterReply, ...turn } = input;
  const commandId = input.commandId ?? CommandId.make(`send:${input.message.messageId}`);
  const createdAt = input.createdAt ?? DateTime.formatIso(yield* DateTime.now);
  const command = { ...turn, type: "thread.turn.start" as const, commandId, createdAt };
  const before: ClientOrchestrationCommand[] = [];
  // Creation carries these settings in its bootstrap. Existing threads need
  // the same updates the composer previously sent before its turn request.
  if (!input.bootstrap?.createThread) {
    if (input.modelSelection || metadata)
      before.push({
        type: "thread.meta.update",
        commandId: CommandId.make(`${commandId}:metadata`),
        threadId: input.threadId,
        ...metadata,
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      });
    before.push({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make(`${commandId}:runtime`),
      threadId: input.threadId,
      runtimeMode: input.runtimeMode,
      createdAt,
    });
    before.push({
      type: "thread.interaction-mode.set",
      commandId: CommandId.make(`${commandId}:interaction`),
      threadId: input.threadId,
      interactionMode: input.interactionMode,
      createdAt,
    });
  }
  const thread = rememberedThreadShell(target.environmentId, input.threadId);
  const existing = (yield* store.list(target.environmentId)).find(
    (entry) => entry.command.commandId === commandId,
  );
  if (!existing) {
    yield* store.enqueue(target.environmentId, {
      command,
      before,
      ...(afterReply ? { afterReply: decodeAfterReply(afterReply) } : {}),
      enqueuedAt: createdAt,
      ...(thread ? { thread } : {}),
    });
    notifyDeferredThreadCommands(target.environmentId);
  }
  return { commandId, messageId: input.message.messageId };
}, Effect.uninterruptible);

export const updateOutboxMessage = Effect.fn("MessageOutbox.update")(function* (input: {
  readonly commandId: CommandId;
  readonly threadId: string;
  readonly action: "retry" | "discard" | "acknowledge";
}) {
  const store = yield* DeferredThreadCommandStore;
  const { target } = yield* EnvironmentSupervisor;
  const entry = (yield* store.list(target.environmentId)).find(
    (entry) =>
      entry.command.commandId === input.commandId && entry.command.threadId === input.threadId,
  );
  if (
    entry?.command.type === "thread.turn.start" &&
    input.action === "acknowledge" &&
    entry.accepted
  ) {
    yield* store.remove(target.environmentId, input.commandId);
    notifyDeferredThreadCommands(target.environmentId);
    return;
  }
  // Only rejected messages can be discarded; an unacknowledged request may
  // already have reached the server and is unsafe to call cancelled.
  if (!entry || entry.command.type !== "thread.turn.start" || !entry.error) return;
  if (input.action === "discard") yield* store.remove(target.environmentId, input.commandId);
  else {
    const { error: _, ...pending } = entry;
    yield* store.enqueue(target.environmentId, pending);
  }
  notifyDeferredThreadCommands(target.environmentId);
});
