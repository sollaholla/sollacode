import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const seedReadModel = Effect.gen(function* () {
  const now = "2026-01-01T00:00:00.000Z";
  const initial = createEmptyReadModel(now);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: asEventId("evt-project-create"),
    aggregateKind: "project",
    aggregateId: asProjectId("project-delete"),
    type: "project.created",
    occurredAt: now,
    commandId: asCommandId("cmd-project-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project-create"),
    metadata: {},
    payload: {
      projectId: asProjectId("project-delete"),
      title: "Project Delete",
      workspaceRoot: "/tmp/project-delete",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });

  const withFirstThread = yield* projectEvent(withProject, {
    sequence: 2,
    eventId: asEventId("evt-thread-create-1"),
    aggregateKind: "thread",
    aggregateId: asThreadId("thread-delete-1"),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-create-1"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create-1"),
    metadata: {},
    payload: {
      threadId: asThreadId("thread-delete-1"),
      projectId: asProjectId("project-delete"),
      title: "Thread Delete 1",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });

  return yield* projectEvent(withFirstThread, {
    sequence: 3,
    eventId: asEventId("evt-thread-create-2"),
    aggregateKind: "thread",
    aggregateId: asThreadId("thread-delete-2"),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-create-2"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create-2"),
    metadata: {},
    payload: {
      threadId: asThreadId("thread-delete-2"),
      projectId: asProjectId("project-delete"),
      title: "Thread Delete 2",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
});

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;
type TypedPlannedEvent = OrchestrationEvent extends infer Event
  ? Event extends OrchestrationEvent
    ? Omit<Event, "sequence">
    : never
  : never;

function normalizeDeleteEvent(event: PlannedEvent | ReadonlyArray<PlannedEvent>) {
  const events = Array.isArray(event) ? event : [event];
  return events.map((entry) => {
    switch (entry.type) {
      case "thread.deleted":
        return {
          type: entry.type,
          aggregateKind: entry.aggregateKind,
          aggregateId: entry.aggregateId,
          commandId: entry.commandId,
          correlationId: entry.correlationId,
          payload: {
            threadId: entry.payload.threadId,
          },
        };
      case "project.deleted":
        return {
          type: entry.type,
          aggregateKind: entry.aggregateKind,
          aggregateId: entry.aggregateId,
          commandId: entry.commandId,
          correlationId: entry.correlationId,
          payload: {
            projectId: entry.payload.projectId,
          },
        };
      default:
        return entry;
    }
  });
}

function singleEventOfType<T extends TypedPlannedEvent["type"]>(
  event: unknown,
  type: T,
): Extract<TypedPlannedEvent, { readonly type: T }> {
  expect(Array.isArray(event)).toBe(false);
  expect((event as { readonly type: unknown }).type).toBe(type);
  return event as Extract<TypedPlannedEvent, { readonly type: T }>;
}

it.layer(NodeServices.layer)("decider deletion flows", (it) => {
  it.effect("rejects deleting a non-empty project without force", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.delete",
            commandId: asCommandId("cmd-project-delete-no-force"),
            projectId: asProjectId("project-delete"),
          },
          readModel,
        }),
      );
      expect(error.message).toContain("cannot be deleted without force=true");
    }),
  );

  it.effect("reuses thread.delete semantics when force-deleting a non-empty project", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const projectDeleteCommand: Extract<OrchestrationCommand, { type: "project.delete" }> = {
        type: "project.delete",
        commandId: asCommandId("cmd-project-delete-force"),
        projectId: asProjectId("project-delete"),
        force: true,
      };

      const forcedResult = yield* decideOrchestrationCommand({
        command: projectDeleteCommand,
        readModel,
      });
      const forcedEvents = Array.isArray(forcedResult) ? forcedResult : [forcedResult];

      expect(forcedEvents.map((event) => event.type)).toEqual([
        "thread.deleted",
        "thread.deleted",
        "project.deleted",
      ]);

      let sequentialReadModel = readModel;
      let nextSequence = readModel.snapshotSequence;
      const sequentialEvents: PlannedEvent[] = [];
      for (const nextCommand of [
        {
          type: "thread.delete",
          commandId: projectDeleteCommand.commandId,
          threadId: asThreadId("thread-delete-1"),
        },
        {
          type: "thread.delete",
          commandId: projectDeleteCommand.commandId,
          threadId: asThreadId("thread-delete-2"),
        },
        {
          type: "project.delete",
          commandId: projectDeleteCommand.commandId,
          projectId: asProjectId("project-delete"),
        },
      ] satisfies ReadonlyArray<OrchestrationCommand>) {
        const decided = yield* decideOrchestrationCommand({
          command: nextCommand,
          readModel: sequentialReadModel,
        });
        const nextEvents = Array.isArray(decided) ? decided : [decided];
        sequentialEvents.push(...nextEvents);
        for (const nextEvent of nextEvents) {
          nextSequence += 1;
          sequentialReadModel = yield* projectEvent(sequentialReadModel, {
            ...nextEvent,
            sequence: nextSequence,
          });
        }
      }

      expect(normalizeDeleteEvent(forcedResult)).toEqual(normalizeDeleteEvent(sequentialEvents));
    }),
  );

  it.effect(
    "rejects turns on deleted threads but lets explicit side-chat promotion restore one",
    () =>
      Effect.gen(function* () {
        const readModel = yield* seedReadModel;
        const sideChatId = asThreadId("thread-side-chat-deleted");
        const fork = singleEventOfType(
          yield* decideOrchestrationCommand({
            command: {
              type: "thread.fork",
              commandId: asCommandId("cmd-side-chat-fork"),
              threadId: sideChatId,
              sourceThreadId: asThreadId("thread-delete-1"),
              title: "Temporary side chat",
              isSideChat: true,
              createdAt: "2026-01-01T00:00:01.000Z",
            },
            readModel,
          }),
          "thread.forked",
        );
        const forkedReadModel = yield* projectEvent(readModel, { ...fork, sequence: 4 });
        const deleted = singleEventOfType(
          yield* decideOrchestrationCommand({
            command: {
              type: "thread.delete",
              commandId: asCommandId("cmd-side-chat-delete"),
              threadId: sideChatId,
            },
            readModel: forkedReadModel,
          }),
          "thread.deleted",
        );
        const deletedReadModel = yield* projectEvent(forkedReadModel, {
          ...deleted,
          sequence: 5,
        });

        const turnError = yield* Effect.flip(
          decideOrchestrationCommand({
            command: {
              type: "thread.turn.start",
              commandId: asCommandId("cmd-deleted-side-chat-turn"),
              threadId: sideChatId,
              message: {
                messageId: MessageId.make("message-deleted-side-chat"),
                role: "user",
                text: "This must not be accepted",
                attachments: [],
              },
              runtimeMode: "full-access",
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              createdAt: "2026-01-01T00:00:02.000Z",
            },
            readModel: deletedReadModel,
          }),
        );
        expect(turnError.message).toContain("already deleted");

        const promoted = singleEventOfType(
          yield* decideOrchestrationCommand({
            command: {
              type: "thread.meta.update",
              commandId: asCommandId("cmd-deleted-side-chat-promote"),
              threadId: sideChatId,
              isSideChat: false,
            },
            readModel: deletedReadModel,
          }),
          "thread.meta-updated",
        );
        const restoredReadModel = yield* projectEvent(deletedReadModel, {
          ...promoted,
          sequence: 6,
        });
        expect(restoredReadModel.threads.find((thread) => thread.id === sideChatId)).toMatchObject({
          isSideChat: false,
          sideChatParentThreadId: null,
          deletedAt: null,
        });
      }),
  );

  it.effect("lets a side chat create a sibling only under its existing owning parent", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const mainThreadId = asThreadId("thread-delete-1");
      const unrelatedThreadId = asThreadId("thread-delete-2");
      const sideChatId = asThreadId("thread-side-chat-source");
      const sideChatFork = singleEventOfType(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.fork",
            commandId: asCommandId("cmd-side-chat-source"),
            threadId: sideChatId,
            sourceThreadId: mainThreadId,
            isSideChat: true,
            createdAt: "2026-01-01T00:00:01.000Z",
          },
          readModel,
        }),
        "thread.forked",
      );
      const withSideChat = yield* projectEvent(readModel, {
        ...sideChatFork,
        sequence: 4,
      });

      const siblingFork = singleEventOfType(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.fork",
            commandId: asCommandId("cmd-side-chat-sibling"),
            threadId: asThreadId("thread-side-chat-sibling"),
            sourceThreadId: sideChatId,
            createdByThreadId: sideChatId,
            browserProfileThreadId: mainThreadId,
            isSideChat: true,
            sideChatParentThreadId: mainThreadId,
            createdAt: "2026-01-01T00:00:02.000Z",
          },
          readModel: withSideChat,
        }),
        "thread.forked",
      );
      expect(siblingFork.payload).toMatchObject({
        sourceThreadId: sideChatId,
        createdByThreadId: sideChatId,
        browserProfileThreadId: mainThreadId,
        isSideChat: true,
        sideChatParentThreadId: mainThreadId,
      });

      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.fork",
            commandId: asCommandId("cmd-side-chat-cross-family"),
            threadId: asThreadId("thread-side-chat-cross-family"),
            sourceThreadId: sideChatId,
            isSideChat: true,
            sideChatParentThreadId: unrelatedThreadId,
            createdAt: "2026-01-01T00:00:03.000Z",
          },
          readModel: withSideChat,
        }),
      );
      expect(error.message).toContain("is not the source chat's owning parent");
    }),
  );

  it.effect("projects provider and mode overrides atomically with a fork", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const fork = singleEventOfType(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.fork",
            commandId: asCommandId("cmd-cross-provider-fork"),
            threadId: asThreadId("thread-cross-provider-fork"),
            sourceThreadId: asThreadId("thread-delete-1"),
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-fable-5",
            },
            runtimeMode: "full-access",
            interactionMode: "agent",
            isSideChat: true,
            createdAt: "2026-01-01T00:00:04.000Z",
          },
          readModel,
        }),
        "thread.forked",
      );

      expect(fork.payload).toMatchObject({
        sourceThreadId: asThreadId("thread-delete-1"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-fable-5",
        },
        runtimeMode: "full-access",
        interactionMode: "agent",
      });
    }),
  );
});
