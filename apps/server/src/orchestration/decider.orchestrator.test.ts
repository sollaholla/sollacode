import {
  AGENT_BUILDER_THREAD_ID,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ORCHESTRATOR_PROJECT_ID,
  ORCHESTRATOR_THREAD_ID,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);

const NOW = "2026-01-01T00:00:00.000Z";

/**
 * Seeds the orchestrator project + thread, plus one ordinary thread inside the
 * orchestrator project. The ordinary thread exists so the forced-project-delete
 * case has something it *could* legitimately cascade to — proving the guard
 * rejects the whole command rather than merely skipping the orchestrator row.
 */
const seedReadModel = Effect.gen(function* () {
  const initial = createEmptyReadModel(NOW);

  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: asEventId("evt-orchestrator-project"),
    aggregateKind: "project",
    aggregateId: ORCHESTRATOR_PROJECT_ID,
    type: "project.created",
    occurredAt: NOW,
    commandId: asCommandId("cmd-orchestrator-project"),
    causationEventId: null,
    correlationId: asCommandId("cmd-orchestrator-project"),
    metadata: {},
    payload: {
      projectId: ORCHESTRATOR_PROJECT_ID,
      title: "Orchestrator",
      workspaceRoot: "/tmp/orchestrator",
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  });

  const withOrchestrator = yield* projectEvent(withProject, {
    sequence: 2,
    eventId: asEventId("evt-orchestrator-thread"),
    aggregateKind: "thread",
    aggregateId: ORCHESTRATOR_THREAD_ID,
    type: "thread.created",
    occurredAt: NOW,
    commandId: asCommandId("cmd-orchestrator-thread"),
    causationEventId: null,
    correlationId: asCommandId("cmd-orchestrator-thread"),
    metadata: {},
    payload: {
      threadId: ORCHESTRATOR_THREAD_ID,
      projectId: ORCHESTRATOR_PROJECT_ID,
      title: "Orchestrator",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });

  return yield* projectEvent(withOrchestrator, {
    sequence: 3,
    eventId: asEventId("evt-ordinary-thread"),
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-ordinary"),
    type: "thread.created",
    occurredAt: NOW,
    commandId: asCommandId("cmd-ordinary-thread"),
    causationEventId: null,
    correlationId: asCommandId("cmd-ordinary-thread"),
    metadata: {},
    payload: {
      threadId: ThreadId.make("thread-ordinary"),
      projectId: ORCHESTRATOR_PROJECT_ID,
      title: "Ordinary",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
});

it.layer(NodeServices.layer)("orchestrator thread is permanent", (it) => {
  it.effect("refuses to delete the orchestrator thread", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.delete",
            commandId: asCommandId("cmd-delete-orchestrator"),
            threadId: ORCHESTRATOR_THREAD_ID,
          },
          readModel,
        }),
      );
      expect(error.message).toContain("cannot be deleted");
    }),
  );

  it.effect("refuses to delete or archive the singleton Agent Builder thread", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      // Same burn hazard as the orchestrator: a soft-deleted row would make
      // the reserved id unrecreatable forever.
      const deleteError = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.delete",
            commandId: asCommandId("cmd-delete-agent-builder"),
            threadId: AGENT_BUILDER_THREAD_ID,
          },
          readModel,
        }),
      );
      expect(deleteError.message).toContain("Agent Builder thread cannot be deleted");
      const archiveError = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.archive",
            commandId: asCommandId("cmd-archive-agent-builder"),
            threadId: AGENT_BUILDER_THREAD_ID,
          },
          readModel,
        }),
      );
      expect(archiveError.message).toContain("Agent Builder thread cannot be archived");
    }),
  );

  it.effect("refuses to archive the orchestrator thread", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.archive",
            commandId: asCommandId("cmd-archive-orchestrator"),
            threadId: ORCHESTRATOR_THREAD_ID,
          },
          readModel,
        }),
      );
      // Archiving emits thread-removed on the shell stream just like deletion,
      // so it has to be refused too or the orchestrator disappears client-side.
      expect(error.message).toContain("cannot be archived");
    }),
  );

  it.effect("refuses to delete the orchestrator project even with force", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.delete",
            commandId: asCommandId("cmd-delete-orchestrator-project"),
            projectId: ORCHESTRATOR_PROJECT_ID,
            force: true,
          },
          readModel,
        }),
      );
      // A forced project delete synthesizes thread.delete for every active
      // thread it owns; the guard must stop the cascade being built at all.
      expect(error.message).toContain("orchestrator project cannot be deleted");
    }),
  );

  it.effect("still deletes ordinary threads and projects", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;

      const deleted = yield* decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: asCommandId("cmd-delete-ordinary"),
          threadId: ThreadId.make("thread-ordinary"),
        },
        readModel,
      });
      expect(Array.isArray(deleted)).toBe(false);
      expect((deleted as { readonly type: string }).type).toBe("thread.deleted");

      const projectError = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.delete",
            commandId: asCommandId("cmd-delete-missing-project"),
            projectId: ProjectId.make("project-not-here"),
          },
          readModel,
        }),
      );
      // Reaches the normal invariant rather than the orchestrator guard.
      expect(projectError.message).not.toContain("orchestrator project");
    }),
  );
});

it.layer(NodeServices.layer)("voice transcript recording", (it) => {
  it.effect("records spoken turns as turn-less message events", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const events = yield* decideOrchestrationCommand({
        command: {
          type: "thread.voice-transcript.record",
          commandId: asCommandId("cmd-voice-transcript"),
          threadId: ORCHESTRATOR_THREAD_ID,
          entries: [
            { messageId: MessageId.make("voice-user-1"), role: "user", text: "how is rover?" },
            {
              messageId: MessageId.make("voice-assistant-1"),
              role: "assistant",
              text: "Rover is still building.",
            },
          ],
          createdAt: NOW,
        },
        readModel,
      });

      const list = (Array.isArray(events) ? events : [events]) as ReadonlyArray<
        Omit<OrchestrationEvent, "sequence">
      >;
      expect(list).toHaveLength(2);
      for (const event of list) {
        expect(event.type).toBe("thread.message-sent");
        const payload = event.payload as {
          turnId: unknown;
          streaming: boolean;
          voiceTranscript?: boolean;
          inputOrigin?: string;
          role: string;
        };
        // No turn: nothing here may settle a turn, start provider work, or
        // reach the agent continuation gate — those all key on a turn id.
        expect(payload.turnId).toBeNull();
        expect(payload.streaming).toBe(false);
        expect(payload.voiceTranscript).toBe(true);
        // Only the user side carries the dictation badge origin.
        expect(payload.inputOrigin).toBe(payload.role === "user" ? "transcription" : undefined);
      }
    }),
  );

  it.effect("refuses to record voice transcripts on ordinary threads", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.voice-transcript.record",
            commandId: asCommandId("cmd-voice-transcript-ordinary"),
            threadId: ThreadId.make("thread-ordinary"),
            entries: [{ messageId: MessageId.make("voice-user-2"), role: "user", text: "hello" }],
            createdAt: NOW,
          },
          readModel,
        }),
      );
      // Any thread could otherwise grow provider-less messages through this
      // command; the surface stays scoped to the one thread that speaks.
      expect(error.message).toContain("orchestrator thread");
    }),
  );
});
