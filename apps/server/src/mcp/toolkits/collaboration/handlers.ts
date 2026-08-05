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
import * as ThreadHistoryQuery from "../history/ThreadHistoryQuery.ts";
import { relatedChatSummary, resolveRelatedChats } from "./relationships.ts";
import { ThreadCollaborationToolkit } from "./tools.ts";
import {
  ThreadCollaborationCapabilityUnavailableError,
  ThreadCollaborationModelUnavailableError,
  ThreadCollaborationOperationFailedError,
  ThreadCollaborationScopeError,
  ThreadCollaborationThreadNotFoundError,
  type RelatedChatSummary,
} from "./types.ts";

const modelSelectionsEqual = (left: ModelSelection, right: ModelSelection): boolean =>
  left.instanceId === right.instanceId &&
  left.model === right.model &&
  JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null);

const toOperationError = (operation: string, threadId: ThreadId) =>
  new ThreadCollaborationOperationFailedError({ operation, threadId });

export const handleThreadCollaboration = Effect.fn("ThreadCollaboration.handle")(function* (
  input: import("./types.ts").ThreadCollaborationInput,
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
  const now = DateTime.formatIso(yield* DateTime.now);

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
      return {
        action: "set_model" as const,
        threadId: invocation.threadId,
        previousModelSelection: family.caller.modelSelection,
        modelSelection: input.modelSelection,
        effectiveOn: "next_turn" as const,
      };
    }

    case "create_side_chat": {
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
            ...relatedChatSummary(source, projectedSideChat),
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
        relatedChats: family.related.map((thread) => relatedChatSummary(family.caller, thread)),
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
        target: relatedChatSummary(family.caller, target),
        history: queryResult,
      };
    }
  }
});

const handlers = {
  thread_collaboration: handleThreadCollaboration,
} satisfies Parameters<typeof ThreadCollaborationToolkit.toLayer>[0];

export const ThreadCollaborationToolkitHandlersLive = ThreadCollaborationToolkit.toLayer(handlers);

export const __testing = {
  modelSelectionsEqual,
};
