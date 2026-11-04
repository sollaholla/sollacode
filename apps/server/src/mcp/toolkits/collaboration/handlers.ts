import {
  CommandId,
  MessageId,
  ThreadId,
  type ModelSelection,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { VmAgentCollaborationStore } from "../../../persistence/Services/VmAgentCollaborations.ts";
import { VmAgentStore } from "../../../persistence/Services/VmAgents.ts";
import { resolveOwningVmAgent } from "../../../vm/owningAgent.ts";
import * as ThreadHistoryQuery from "../history/ThreadHistoryQuery.ts";
import { relatedChatSummary, resolveRelatedChats } from "./relationships.ts";
import { ThreadCollaborationToolkit } from "./tools.ts";
import {
  ThreadCollaborationCapabilityUnavailableError,
  ThreadCollaborationModelUnavailableError,
  ThreadCollaborationOperationFailedError,
  ThreadCollaborationRefusedError,
  ThreadCollaborationScopeError,
  ThreadCollaborationThreadNotFoundError,
  type RelatedChatSummary,
} from "./types.ts";

/** When each chat last messaged a related chat, for the rate limit. */
type RelatedMessageLog = Map<ThreadId, ReadonlyArray<number>>;

/**
 * Two chats in Agent mode can answer each other forever, and each message
 * starts a turn, so sending is capped the same as a workspace_consult ask.
 */
const MAX_RELATED_MESSAGES_PER_WINDOW = 20;
const RELATED_MESSAGE_WINDOW_MS = 10 * 60_000;

const modelSelectionsEqual = (left: ModelSelection, right: ModelSelection): boolean =>
  left.instanceId === right.instanceId &&
  left.model === right.model &&
  JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null);

const toOperationError = (operation: string, threadId: ThreadId) =>
  new ThreadCollaborationOperationFailedError({ operation, threadId });

export const handleThreadCollaboration = Effect.fn("ThreadCollaboration.handle")(function* (
  input: import("./types.ts").ThreadCollaborationInput,
  relatedMessageLog: RelatedMessageLog,
) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("collaboration")) {
    return yield* new ThreadCollaborationCapabilityUnavailableError({
      threadId: invocation.threadId,
    });
  }

  const projection = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const providerRegistry = yield* ProviderRegistry;
  const history = yield* ThreadHistoryQuery.ThreadHistoryQuery;
  const crypto = yield* Crypto.Crypto;
  const agentCollaboration = yield* VmAgentCollaborationStore;
  const agents = yield* VmAgentStore;

  const readFamily = Effect.fn("ThreadCollaboration.readFamily")(function* () {
    const snapshot = yield* projection
      .getShellSnapshot()
      .pipe(Effect.mapError(() => toOperationError("reading related chats", invocation.threadId)));
    const family = resolveRelatedChats(snapshot.threads, invocation.threadId);
    if (!family) {
      return yield* new ThreadCollaborationThreadNotFoundError({
        threadId: invocation.threadId,
      });
    }
    return family;
  });

  const validateModel = Effect.fn("ThreadCollaboration.validateModel")(function* (
    selection: ModelSelection,
    requireKnownModel: boolean,
  ) {
    const providers = yield* providerRegistry.getProviders;
    const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
    if (
      !provider ||
      provider.enabled !== true ||
      provider.installed !== true ||
      provider.availability === "unavailable"
    ) {
      return yield* new ThreadCollaborationModelUnavailableError({
        instanceId: selection.instanceId,
        model: selection.model,
        reason: "provider_unavailable",
      });
    }
    if (
      requireKnownModel &&
      provider.models.length > 0 &&
      !provider.models.some((model) => model.slug === selection.model)
    ) {
      return yield* new ThreadCollaborationModelUnavailableError({
        instanceId: selection.instanceId,
        model: selection.model,
        reason: "model_unavailable",
      });
    }
  });

  const dispatch = (command: OrchestrationCommand, operation: string, threadId: ThreadId) =>
    engine.dispatch(command).pipe(Effect.mapError(() => toOperationError(operation, threadId)));

  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(() => toOperationError("generating command identifiers", invocation.threadId)),
  );
  const nowDateTime = yield* DateTime.now;
  const now = DateTime.formatIso(nowDateTime);
  const nowMs = DateTime.toEpochMillis(nowDateTime);

  switch (input.action) {
    case "set_model": {
      const family = yield* readFamily();
      yield* validateModel(input.modelSelection, true);
      if (!modelSelectionsEqual(family.caller.modelSelection, input.modelSelection)) {
        yield* dispatch(
          {
            type: "thread.meta.update",
            commandId: CommandId.make(yield* randomId),
            threadId: invocation.threadId,
            modelSelection: input.modelSelection,
          },
          "updating the calling chat model",
          invocation.threadId,
        );
      }
      if (input.runtimeMode !== undefined && input.runtimeMode !== family.caller.runtimeMode) {
        yield* dispatch(
          {
            type: "thread.runtime-mode.set",
            commandId: CommandId.make(yield* randomId),
            threadId: invocation.threadId,
            runtimeMode: input.runtimeMode,
            createdAt: now,
          },
          "updating the calling chat access mode",
          invocation.threadId,
        );
      }
      if (
        input.interactionMode !== undefined &&
        input.interactionMode !== family.caller.interactionMode
      ) {
        yield* dispatch(
          {
            type: "thread.interaction-mode.set",
            commandId: CommandId.make(yield* randomId),
            threadId: invocation.threadId,
            interactionMode: input.interactionMode,
            createdAt: now,
          },
          "updating the calling chat interaction mode",
          invocation.threadId,
        );
      }
      return {
        action: "set_model" as const,
        threadId: invocation.threadId,
        previousModelSelection: family.caller.modelSelection,
        modelSelection: input.modelSelection,
        previousRuntimeMode: family.caller.runtimeMode,
        runtimeMode: input.runtimeMode ?? family.caller.runtimeMode,
        previousInteractionMode: family.caller.interactionMode,
        interactionMode: input.interactionMode ?? family.caller.interactionMode,
        effectiveOn: "next_turn" as const,
      };
    }

    case "create_side_chat": {
      // Custom agents fork side chats like any other chat; the side chat
      // inherits the agent's browser and consulting rights (see
      // resolveOwningVmAgent). Bounded delegated workers stay on
      // agent_collaboration.delegate and may not fork further.
      const delegated = yield* agentCollaboration
        .hasActiveTargetThread(invocation.threadId)
        .pipe(
          Effect.mapError(() =>
            toOperationError("checking delegated-worker depth", invocation.threadId),
          ),
        );
      if (delegated) {
        return yield* toOperationError(
          "delegated workers cannot create side chats",
          invocation.threadId,
        );
      }
      const family = yield* readFamily();
      const source = family.caller;
      const owningParentThreadId =
        source.isSideChat === true ? (source.sideChatParentThreadId ?? source.id) : source.id;
      const modelSelection = input.modelSelection ?? source.modelSelection;
      const runtimeMode = input.runtimeMode ?? source.runtimeMode;
      const interactionMode = input.interactionMode ?? "agent";
      const title = input.title ?? "Side task";
      yield* validateModel(modelSelection, input.modelSelection !== undefined);
      const sideChatThreadId = ThreadId.make(yield* randomId);

      yield* dispatch(
        {
          type: "thread.fork",
          commandId: CommandId.make(yield* randomId),
          threadId: sideChatThreadId,
          sourceThreadId: source.id,
          title,
          createdByThreadId: source.id,
          browserProfileThreadId: source.browserProfileThreadId ?? source.id,
          modelSelection,
          runtimeMode,
          interactionMode,
          isSideChat: true,
          sideChatParentThreadId: owningParentThreadId,
          createdAt: now,
        },
        "creating the side chat",
        sideChatThreadId,
      );
      yield* dispatch(
        {
          type: "thread.turn.start",
          commandId: CommandId.make(yield* randomId),
          threadId: sideChatThreadId,
          message: {
            messageId: MessageId.make(yield* randomId),
            role: "user",
            senderThreadId: invocation.threadId,
            senderThreadTitle: source.title,
            text: input.task,
            attachments: [],
          },
          modelSelection,
          titleSeed: title,
          runtimeMode,
          interactionMode,
          createdAt: now,
        },
        "starting the side task",
        sideChatThreadId,
      );

      const projectedRead = yield* Effect.option(projection.getThreadShellById(sideChatThreadId));
      const projectedSideChat = Option.isSome(projectedRead)
        ? Option.getOrUndefined(projectedRead.value)
        : undefined;
      const sideChat: RelatedChatSummary = projectedSideChat
        ? {
            ...relatedChatSummary(source, projectedSideChat, nowMs),
            modelSelection,
            runtimeMode,
            interactionMode,
            latestTurnState: "running",
            isWorking: true,
          }
        : {
            threadId: sideChatThreadId,
            title,
            relationship: owningParentThreadId === source.id ? "child" : "sibling",
            isSideChat: true,
            parentThreadId: owningParentThreadId,
            modelSelection,
            runtimeMode,
            interactionMode,
            sessionStatus: null,
            activeTurnId: null,
            latestTurnState: "running",
            isWorking: true,
            updatedAt: now,
          };
      return {
        action: "create_side_chat" as const,
        sourceThreadId: source.id,
        sideChat,
        taskSubmitted: true,
      };
    }

    case "list_related_chats": {
      const family = yield* readFamily();
      return {
        action: "list_related_chats" as const,
        callerThreadId: invocation.threadId,
        relatedChats: family.related.map((thread) =>
          relatedChatSummary(family.caller, thread, nowMs),
        ),
      };
    }

    case "query_related_chat": {
      const family = yield* readFamily();
      const target = family.related.find((thread) => thread.id === input.threadId);
      if (!target) {
        return yield* new ThreadCollaborationScopeError({
          requestedThreadId: input.threadId,
          authorizedThreadId: invocation.threadId,
        });
      }
      const queryResult = yield* history
        .query({
          ...input.history,
          threadId: target.id,
          resolvedThreadIdFromInvocation: target.id === invocation.threadId,
        })
        .pipe(Effect.mapError(() => toOperationError("querying related chat history", target.id)));
      return {
        action: "query_related_chat" as const,
        callerThreadId: invocation.threadId,
        target: relatedChatSummary(family.caller, target, nowMs),
        history: queryResult,
      };
    }

    case "message_related_chat": {
      const family = yield* readFamily();
      const target = family.related.find((thread) => thread.id === input.threadId);
      if (!target || target.archivedAt !== null) {
        return yield* new ThreadCollaborationScopeError({
          requestedThreadId: input.threadId,
          authorizedThreadId: invocation.threadId,
        });
      }
      if (target.id === invocation.threadId) {
        return yield* new ThreadCollaborationRefusedError({
          reason: "That is this chat. Name its parent or a side chat from list_related_chats.",
        });
      }
      // A stopped agent stays idle until the person starts it.
      const targetAgent = yield* resolveOwningVmAgent({
        threadId: target.id,
        getAgentByThreadId: agents.getByThreadId,
        getThreadShellById: projection.getThreadShellById,
      }).pipe(Effect.mapError(() => toOperationError("checking the chat's agent", target.id)));
      if (
        Option.isSome(targetAgent) &&
        (targetAgent.value.status === "stopped" || targetAgent.value.status === "stopping")
      ) {
        return yield* new ThreadCollaborationRefusedError({
          reason: `${targetAgent.value.name} is stopped, so it cannot be messaged. The person can start it again from its chat.`,
        });
      }
      const recent = (relatedMessageLog.get(invocation.threadId) ?? []).filter(
        (at) => nowMs - at < RELATED_MESSAGE_WINDOW_MS,
      );
      if (recent.length >= MAX_RELATED_MESSAGES_PER_WINDOW) {
        return yield* new ThreadCollaborationRefusedError({
          reason: `This chat has sent related chats ${recent.length} messages in the last 10 minutes. Wait a few minutes before sending another.`,
        });
      }
      for (const [threadId, times] of relatedMessageLog) {
        if (times.every((at) => nowMs - at >= RELATED_MESSAGE_WINDOW_MS)) {
          relatedMessageLog.delete(threadId);
        }
      }
      relatedMessageLog.set(invocation.threadId, [...recent, nowMs]);

      // The sender is what approvals read: a message inside the family counts
      // as whatever started the sending chat's work (see getTurnTrigger).
      yield* dispatch(
        {
          type: "thread.turn.start",
          commandId: CommandId.make(yield* randomId),
          threadId: target.id,
          message: {
            messageId: MessageId.make(yield* randomId),
            role: "user",
            senderThreadId: invocation.threadId,
            senderThreadTitle: family.caller.title,
            text: input.message,
            attachments: [],
          },
          runtimeMode: target.runtimeMode,
          interactionMode: target.interactionMode,
          createdAt: now,
        },
        "sending the message",
        target.id,
      );
      return {
        action: "message_related_chat" as const,
        callerThreadId: invocation.threadId,
        target: relatedChatSummary(family.caller, target, nowMs),
        delivered: true,
      };
    }
  }
});

export const ThreadCollaborationToolkitHandlersLive = ThreadCollaborationToolkit.toLayer(
  Effect.sync(() => {
    const relatedMessageLog: RelatedMessageLog = new Map();
    return {
      thread_collaboration: (input: import("./types.ts").ThreadCollaborationInput) =>
        handleThreadCollaboration(input, relatedMessageLog),
    } satisfies Parameters<typeof ThreadCollaborationToolkit.toLayer>[0];
  }),
);

export const __testing = {
  modelSelectionsEqual,
};
