import { expect, it } from "@effect/vitest";
import { type OrchestrationCommand, ThreadId, TurnId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ActionApprovalPrompt from "./prompt.ts";
import type { ActionApprovalInput } from "./types.ts";

const input: ActionApprovalInput = {
  actionKind: "send_email",
  summary: "Send email to pat@example.com",
  preview: "To: pat@example.com\nSubject: Status\n\nThe work is complete.",
};
const threadId = ThreadId.make("thread-action-approval");
const turnId = TurnId.make("turn-action-approval");

const makeHarness = Effect.fn("ActionApprovalPromptTest.makeHarness")(function* () {
  const commands: OrchestrationCommand[] = [];
  const engineLayer = Layer.succeed(
    OrchestrationEngineService,
    OrchestrationEngineService.of({
      readEvents: () => Stream.empty,
      readThreadEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
        }).pipe(Effect.as({ sequence: commands.length })),
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
  const layer = ActionApprovalPrompt.makeLayer().pipe(
    Layer.provideMerge(engineLayer),
    Layer.provideMerge(cryptoLayer),
  );
  return { commands, layer };
});

it.effect("persists a durable approval prompt and returns pending without blocking MCP", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* Effect.gen(function* () {
      const prompt = yield* ActionApprovalPrompt.ActionApprovalPrompt;
      const outcome = yield* prompt.request(input, { threadId, turnId });
      expect(outcome.status).toBe("pending");
      if (outcome.status !== "pending") return;
      expect(outcome.requestId).toMatch(/^action-approval:/);

      const requested = harness.commands.find(
        (command): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "user-input.requested",
      );
      expect(requested).toBeDefined();
      if (requested === undefined) return;
      const payload = requested.activity.payload as {
        readonly requestId: string;
        readonly questions: ReadonlyArray<{ readonly id: string; readonly options: unknown }>;
        readonly actionApproval: ActionApprovalInput;
      };

      expect(requested.activity.turnId).toBeNull();
      expect(payload.requestId).toBe(outcome.requestId);
      expect(payload.actionApproval).toEqual(input);
      expect(payload.questions).toMatchObject([
        {
          id: "t3_action_approval",
          options: [{ label: "Approve" }],
        },
      ]);
      expect(
        harness.commands
          .filter((command) => command.type === "thread.activity.append")
          .map((command) => command.activity.kind),
      ).toEqual(["user-input.requested"]);
      const interrupt = harness.commands.find(
        (command): command is Extract<OrchestrationCommand, { type: "thread.turn.interrupt" }> =>
          command.type === "thread.turn.interrupt",
      );
      expect(interrupt).toMatchObject({ threadId, turnId });
    }).pipe(Effect.provide(harness.layer));
  }),
);
