import {
  CheckpointRef,
  CommandId,
  MessageId,
  ORCHESTRATOR_THREAD_ID,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationProposedPlan,
  type OrchestrationReadModel,
  type ProviderInteractionMode,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { RESUME_PROMPT } from "@t3tools/shared/resumePrompt";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");

const plan = (
  id: string,
  createdAt: string,
  overrides: Partial<OrchestrationProposedPlan> = {},
): OrchestrationProposedPlan => ({
  id,
  turnId: TurnId.make(`turn-${id}`),
  planMarkdown: `# ${id}`,
  implementedAt: null,
  implementationThreadId: null,
  closedAt: null,
  createdAt,
  updatedAt: createdAt,
  ...overrides,
});

function makeReadModel(input: {
  readonly interactionMode: ProviderInteractionMode;
  readonly proposedPlans: ReadonlyArray<OrchestrationProposedPlan>;
  readonly checkpoints?: ReadonlyArray<OrchestrationCheckpointSummary>;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" },
        runtimeMode: "full-access",
        interactionMode: input.interactionMode,
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: input.proposedPlans,
        activities: [],
        checkpoints: input.checkpoints ?? [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const startTurn = (input: {
  readonly readModel: OrchestrationReadModel;
  readonly inputOrigin?: "agent-loop";
  readonly senderThreadId?: ThreadId;
  readonly text?: string;
  readonly sourcePlanId?: string;
}) =>
  decideOrchestrationCommand({
    command: {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start"),
      threadId: THREAD_ID,
      message: {
        messageId: MessageId.make("message-1"),
        role: "user",
        text: input.text ?? "Go ahead",
        ...(input.inputOrigin ? { inputOrigin: input.inputOrigin } : {}),
        ...(input.senderThreadId ? { senderThreadId: input.senderThreadId } : {}),
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      ...(input.sourcePlanId
        ? { sourceProposedPlan: { threadId: THREAD_ID, planId: input.sourcePlanId } }
        : {}),
      createdAt: NOW,
    },
    readModel: input.readModel,
  }).pipe(Effect.map((result) => (Array.isArray(result) ? result : [result])));

const upsertedPlans = (
  events: ReadonlyArray<{ readonly type: string; readonly payload: unknown }>,
) =>
  events.flatMap((event) =>
    event.type === "thread.proposed-plan-upserted"
      ? [(event.payload as { proposedPlan: OrchestrationProposedPlan }).proposedPlan]
      : [],
  );

it.layer(NodeServices.layer)("decider settles the plan a person answered", (it) => {
  it.effect("implements the waiting plan when a Build or Agent message answers it", () =>
    Effect.gen(function* () {
      // "Ok go ahead" in Agent mode, or switching modes and continuing: both
      // approved plans in the 2026-10-10 report, and neither was recorded.
      for (const interactionMode of ["default", "agent"] as const) {
        const events = yield* startTurn({
          readModel: makeReadModel({
            interactionMode,
            proposedPlans: [
              plan("plan-old", "2025-12-30T00:00:00.000Z"),
              plan("plan-waiting", "2025-12-31T00:00:00.000Z"),
            ],
          }),
        });
        const settled = upsertedPlans(events);
        // Only the newest plan is waiting; older ones are history already.
        expect(settled.map((entry) => entry.id)).toEqual(["plan-waiting"]);
        expect(settled[0]).toMatchObject({
          implementedAt: NOW,
          implementationThreadId: THREAD_ID,
          closedAt: null,
        });
        // The turn carries the plan, so clients show it as the work in progress.
        const turnStart = events.find((event) => event.type === "thread.turn-start-requested");
        expect(turnStart?.payload).toMatchObject({
          sourceProposedPlan: { threadId: THREAD_ID, planId: "plan-waiting" },
        });
      }
    }),
  );

  it.effect("keeps the plan waiting while the person refines it in Plan mode", () =>
    Effect.gen(function* () {
      const events = yield* startTurn({
        readModel: makeReadModel({
          interactionMode: "plan",
          proposedPlans: [plan("plan-waiting", "2025-12-31T00:00:00.000Z")],
        }),
      });
      expect(upsertedPlans(events)).toEqual([]);
    }),
  );

  it.effect("never lets housekeeping decide for the person", () =>
    Effect.gen(function* () {
      const events = yield* startTurn({
        inputOrigin: "agent-loop",
        readModel: makeReadModel({
          interactionMode: "agent",
          proposedPlans: [plan("plan-waiting", "2025-12-31T00:00:00.000Z")],
        }),
      });
      expect(upsertedPlans(events)).toEqual([]);
      const turnStart = events.find((event) => event.type === "thread.turn-start-requested");
      expect(turnStart?.payload).not.toHaveProperty("sourceProposedPlan");
    }),
  );

  it.effect("never lets another agent's question answer the plan", () =>
    Effect.gen(function* () {
      // workspace_consult puts a question to the thread on another agent's
      // behalf; only the person decides what happens to the plan.
      const events = yield* startTurn({
        senderThreadId: ThreadId.make("consulting-agent-thread"),
        readModel: makeReadModel({
          interactionMode: "default",
          proposedPlans: [plan("plan-waiting", "2025-12-31T00:00:00.000Z")],
        }),
      });
      expect(upsertedPlans(events)).toEqual([]);
      const turnStart = events.find((event) => event.type === "thread.turn-start-requested");
      expect(turnStart?.payload).not.toHaveProperty("sourceProposedPlan");
    }),
  );

  it.effect("never lets a resume answer the plan", () =>
    Effect.gen(function* () {
      // Startup resume and the Resume button ask the agent to pick up where it
      // left off; that is not the person approving what it proposed.
      const events = yield* startTurn({
        text: RESUME_PROMPT,
        readModel: makeReadModel({
          interactionMode: "default",
          proposedPlans: [plan("plan-waiting", "2025-12-31T00:00:00.000Z")],
        }),
      });
      expect(upsertedPlans(events)).toEqual([]);
    }),
  );

  it.effect("counts the orchestrator relaying the person as the person", () =>
    Effect.gen(function* () {
      const events = yield* startTurn({
        senderThreadId: ORCHESTRATOR_THREAD_ID,
        readModel: makeReadModel({
          interactionMode: "default",
          proposedPlans: [plan("plan-waiting", "2025-12-31T00:00:00.000Z")],
        }),
      });
      expect(upsertedPlans(events)).toMatchObject([
        { id: "plan-waiting", implementedAt: NOW, implementationThreadId: THREAD_ID },
      ]);
    }),
  );

  it.effect("leaves the plan Implement is acting on to be marked when its turn starts", () =>
    Effect.gen(function* () {
      const events = yield* startTurn({
        sourcePlanId: "plan-waiting",
        readModel: makeReadModel({
          interactionMode: "default",
          proposedPlans: [plan("plan-waiting", "2025-12-31T00:00:00.000Z")],
        }),
      });
      expect(upsertedPlans(events)).toEqual([]);
      const turnStart = events.find((event) => event.type === "thread.turn-start-requested");
      expect(turnStart?.payload).toMatchObject({
        sourceProposedPlan: { threadId: THREAD_ID, planId: "plan-waiting" },
      });
    }),
  );

  it.effect("closes the waiting plan when an older plan is implemented instead", () =>
    Effect.gen(function* () {
      const events = yield* startTurn({
        sourcePlanId: "plan-older",
        readModel: makeReadModel({
          interactionMode: "default",
          proposedPlans: [
            plan("plan-older", "2025-12-30T00:00:00.000Z"),
            plan("plan-waiting", "2025-12-31T00:00:00.000Z"),
          ],
        }),
      });
      const settled = upsertedPlans(events);
      expect(settled.map((entry) => entry.id)).toEqual(["plan-waiting"]);
      expect(settled[0]).toMatchObject({ closedAt: NOW, implementedAt: null });
    }),
  );

  it.effect("does nothing when the newest plan is already implemented", () =>
    Effect.gen(function* () {
      const events = yield* startTurn({
        readModel: makeReadModel({
          interactionMode: "default",
          proposedPlans: [
            plan("plan-old", "2025-12-30T00:00:00.000Z"),
            plan("plan-done", "2025-12-31T00:00:00.000Z", {
              implementedAt: "2025-12-31T01:00:00.000Z",
              implementationThreadId: THREAD_ID,
            }),
          ],
        }),
      });
      expect(upsertedPlans(events)).toEqual([]);
    }),
  );

  it.effect("reopens a plan when the turn that answered it is reverted", () =>
    Effect.gen(function* () {
      const checkpoint = (turn: string, count: number, completedAt: string) => ({
        turnId: TurnId.make(turn),
        checkpointTurnCount: count,
        checkpointRef: CheckpointRef.make(`ref-${turn}`),
        status: "ready" as const,
        files: [],
        assistantMessageId: null,
        completedAt,
      });
      const answeredAt = "2025-12-31T01:00:00.000Z";
      const events = yield* decideOrchestrationCommand({
        command: {
          type: "thread.revert.complete",
          commandId: CommandId.make("cmd-revert"),
          threadId: THREAD_ID,
          turnCount: 1,
          createdAt: NOW,
        },
        readModel: makeReadModel({
          interactionMode: "default",
          checkpoints: [
            checkpoint("turn-plan", 1, "2025-12-31T00:10:00.000Z"),
            checkpoint("turn-answer", 2, "2025-12-31T01:10:00.000Z"),
          ],
          proposedPlans: [
            // "Go ahead" in turn 2 built it; reverting turn 2 undoes that.
            plan("plan-built-here", "2025-12-31T00:05:00.000Z", {
              turnId: TurnId.make("turn-plan"),
              implementedAt: answeredAt,
              implementationThreadId: THREAD_ID,
            }),
            plan("plan-closed", "2025-12-31T00:04:00.000Z", {
              turnId: TurnId.make("turn-plan"),
              closedAt: answeredAt,
            }),
            // Built in another thread, which this revert does not touch.
            plan("plan-built-elsewhere", "2025-12-31T00:03:00.000Z", {
              turnId: TurnId.make("turn-plan"),
              implementedAt: answeredAt,
              implementationThreadId: ThreadId.make("thread-elsewhere"),
            }),
            // Answered by a turn that stays.
            plan("plan-kept", "2025-12-31T00:02:00.000Z", {
              turnId: TurnId.make("turn-plan"),
              implementedAt: "2025-12-31T00:06:00.000Z",
              implementationThreadId: THREAD_ID,
            }),
            // Proposed by the reverted turn: the revert removes it outright.
            plan("plan-reverted", "2025-12-31T01:05:00.000Z", {
              turnId: TurnId.make("turn-answer"),
            }),
          ],
        }),
      }).pipe(Effect.map((result) => (Array.isArray(result) ? result : [result])));

      expect(events[0]?.type).toBe("thread.reverted");
      expect(upsertedPlans(events)).toMatchObject([
        {
          id: "plan-built-here",
          implementedAt: null,
          implementationThreadId: null,
          closedAt: null,
        },
        { id: "plan-closed", implementedAt: null, closedAt: null },
      ]);
    }),
  );
});

const setPlanClosed = (input: {
  readonly readModel: OrchestrationReadModel;
  readonly planId: string;
  readonly closed: boolean;
}) =>
  decideOrchestrationCommand({
    command: {
      type: input.closed ? "thread.proposed-plan.close" : "thread.proposed-plan.reopen",
      commandId: CommandId.make("cmd-plan-close"),
      threadId: THREAD_ID,
      planId: input.planId,
      createdAt: NOW,
    },
    readModel: input.readModel,
  }).pipe(Effect.map((result) => (Array.isArray(result) ? result : [result])));

it.layer(NodeServices.layer)("a person closes a plan they will not answer", (it) => {
  it.effect("closes the waiting plan without a turn, and reopening makes it wait again", () =>
    Effect.gen(function* () {
      // A former side chat that cannot take messages kept its plan waiting
      // forever: closing is the only way to stop waiting on it.
      const waiting = plan("plan-waiting", "2025-12-31T00:00:00.000Z");
      const closeEvents = yield* setPlanClosed({
        readModel: makeReadModel({ interactionMode: "default", proposedPlans: [waiting] }),
        planId: "plan-waiting",
        closed: true,
      });
      expect(closeEvents.map((event) => event.type)).toEqual(["thread.proposed-plan-upserted"]);
      const [closed] = upsertedPlans(closeEvents);
      expect(closed).toMatchObject({ id: "plan-waiting", closedAt: NOW, implementedAt: null });

      const reopenEvents = yield* setPlanClosed({
        readModel: makeReadModel({ interactionMode: "default", proposedPlans: [closed!] }),
        planId: "plan-waiting",
        closed: false,
      });
      expect(upsertedPlans(reopenEvents)).toEqual([{ ...waiting, closedAt: null, updatedAt: NOW }]);
    }),
  );

  it.effect("treats a repeated close or reopen as already done", () =>
    Effect.gen(function* () {
      const alreadyClosed = makeReadModel({
        interactionMode: "default",
        proposedPlans: [
          plan("plan-closed", "2025-12-31T00:00:00.000Z", {
            closedAt: "2025-12-31T01:00:00.000Z",
          }),
        ],
      });
      expect(
        yield* setPlanClosed({ readModel: alreadyClosed, planId: "plan-closed", closed: true }),
      ).toEqual([]);
      const open = makeReadModel({
        interactionMode: "default",
        proposedPlans: [plan("plan-open", "2025-12-31T00:00:00.000Z")],
      });
      expect(yield* setPlanClosed({ readModel: open, planId: "plan-open", closed: false })).toEqual(
        [],
      );
    }),
  );

  it.effect("refuses a plan that was implemented or never existed", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel({
        interactionMode: "default",
        proposedPlans: [
          plan("plan-built", "2025-12-31T00:00:00.000Z", {
            implementedAt: "2025-12-31T01:00:00.000Z",
            implementationThreadId: THREAD_ID,
          }),
        ],
      });
      const built = yield* Effect.flip(
        setPlanClosed({ readModel, planId: "plan-built", closed: true }),
      );
      expect(built._tag).toBe("OrchestrationCommandInvariantError");
      const missing = yield* Effect.flip(
        setPlanClosed({ readModel, planId: "plan-missing", closed: true }),
      );
      expect(missing._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
