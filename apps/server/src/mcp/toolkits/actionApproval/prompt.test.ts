import { expect, it } from "@effect/vitest";
import { ApprovalRequestId, type OrchestrationCommand, ThreadId, TurnId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ActionApprovalBroker from "./ActionApprovalBroker.ts";
import * as ActionApprovalPrompt from "./prompt.ts";
import type { ActionApprovalInput } from "./types.ts";

const input: ActionApprovalInput = {
  actionKind: "send_email",
  summary: "Send email to pat@example.com",
  preview: "To: pat@example.com\nSubject: Status\n\nThe work is complete.",
};
const threadId = ThreadId.make("thread-action-approval");
const turnId = TurnId.make("turn-action-approval");

const makeHarness = Effect.fn("ActionApprovalPromptTest.makeHarness")(function* (
  timeout: Duration.Input,
) {
  const commands: OrchestrationCommand[] = [];
  const requestAppended =
    yield* Deferred.make<Extract<OrchestrationCommand, { type: "thread.activity.append" }>>();
  const engineLayer = Layer.succeed(
    OrchestrationEngineService,
    OrchestrationEngineService.of({
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
        }).pipe(
          Effect.andThen(
            command.type === "thread.activity.append" &&
              command.activity.kind === "user-input.requested"
              ? Deferred.succeed(requestAppended, command).pipe(Effect.ignore)
              : Effect.void,
          ),
          Effect.as({ sequence: commands.length }),
        ),
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
  );
  let seed = 0;
  const cryptoLayer = Layer.succeed(
    Crypto.Crypto,
    Crypto.make({
      randomBytes: (size) =>
        Uint8Array.from({ length: size }, () => {
          seed += 1;
          return seed % 256;
        }),
      digest: (_algorithm, data) => Effect.succeed(data),
    }),
  );
  const layer = ActionApprovalPrompt.makeLayer({ timeout }).pipe(
    Layer.provideMerge(ActionApprovalBroker.layer),
    Layer.provideMerge(engineLayer),
    Layer.provideMerge(cryptoLayer),
  );
  return { commands, layer, requestAppended };
});

it.effect("persists a thread-native approval prompt and returns the phone response", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(Duration.minutes(1));
    yield* Effect.gen(function* () {
      const prompt = yield* ActionApprovalPrompt.ActionApprovalPrompt;
      const broker = yield* ActionApprovalBroker.ActionApprovalBroker;
      const approvalFiber = yield* Effect.forkChild(prompt.request(input, { threadId, turnId }), {
        startImmediately: true,
      });
      const requested = yield* Deferred.await(harness.requestAppended);
      const payload = requested.activity.payload as {
        readonly requestId: ApprovalRequestId;
        readonly questions: ReadonlyArray<{ readonly id: string; readonly options: unknown }>;
      };

      expect(requested.activity.turnId).toBe(turnId);
      expect(payload.questions).toMatchObject([
        {
          id: "t3_action_approval",
          options: [{ label: "Approve" }],
        },
      ]);
      expect(
        yield* broker.resolve({
          threadId,
          requestId: payload.requestId,
          answers: { t3_action_approval: "Approve" },
        }),
      ).toBe("accepted");
      expect(yield* Fiber.join(approvalFiber)).toEqual({ status: "approved" });
      expect(
        harness.commands
          .filter((command) => command.type === "thread.activity.append")
          .map((command) => command.activity.kind),
      ).toEqual(["user-input.requested", "user-input.resolved"]);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("returns typed corrections through the same durable prompt", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(Duration.minutes(1));
    yield* Effect.gen(function* () {
      const prompt = yield* ActionApprovalPrompt.ActionApprovalPrompt;
      const broker = yield* ActionApprovalBroker.ActionApprovalBroker;
      const approvalFiber = yield* Effect.forkChild(prompt.request(input, { threadId, turnId }), {
        startImmediately: true,
      });
      const requested = yield* Deferred.await(harness.requestAppended);
      const requestId = (requested.activity.payload as { readonly requestId: ApprovalRequestId })
        .requestId;
      yield* broker.resolve({
        threadId,
        requestId,
        answers: { t3_action_approval: "Use a more specific subject." },
      });
      expect(yield* Fiber.join(approvalFiber)).toEqual({
        status: "changes_requested",
        feedback: "Use a more specific subject.",
      });
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("closes the visible prompt instead of waiting forever", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(Duration.seconds(30));
    yield* Effect.gen(function* () {
      const prompt = yield* ActionApprovalPrompt.ActionApprovalPrompt;
      const approvalFiber = yield* Effect.forkChild(prompt.request(input, { threadId, turnId }), {
        startImmediately: true,
      });
      yield* Deferred.await(harness.requestAppended);
      yield* TestClock.adjust(Duration.seconds(30));
      expect(yield* Fiber.join(approvalFiber)).toEqual({ status: "cancelled" });
      expect(
        harness.commands
          .filter((command) => command.type === "thread.activity.append")
          .map((command) => command.activity.kind),
      ).toEqual(["user-input.requested", "user-input.resolved"]);
    }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));
  }),
);
