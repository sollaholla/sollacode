import { expect, it } from "@effect/vitest";
import { ApprovalRequestId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as ActionApprovalBroker from "./ActionApprovalBroker.ts";

const threadId = ThreadId.make("thread-action-approval-broker");
const otherThreadId = ThreadId.make("thread-action-approval-broker-other");
const requestId = ApprovalRequestId.make("action-approval-broker-request");

it.effect("delivers one response to its owning thread and absorbs duplicate submissions", () =>
  Effect.gen(function* () {
    const broker = yield* ActionApprovalBroker.ActionApprovalBroker;
    const registration = yield* broker.register({ threadId, requestId });
    const answersFiber = yield* Effect.forkChild(registration.answers, {
      startImmediately: true,
    });

    expect(
      yield* broker.resolve({
        threadId: otherThreadId,
        requestId,
        answers: { t3_action_approval: "Approve" },
      }),
    ).toBe("not_owned");
    expect(
      yield* broker.resolve({
        threadId,
        requestId,
        answers: { t3_action_approval: "Approve" },
      }),
    ).toBe("accepted");
    expect(yield* Fiber.join(answersFiber)).toEqual({ t3_action_approval: "Approve" });
    expect(
      yield* broker.resolve({
        threadId,
        requestId,
        answers: { t3_action_approval: "Approve" },
      }),
    ).toBe("duplicate");
  }).pipe(Effect.provide(ActionApprovalBroker.layer)),
);

it.effect("retires an abandoned request so a late phone response cannot reach the provider", () =>
  Effect.gen(function* () {
    const broker = yield* ActionApprovalBroker.ActionApprovalBroker;
    yield* broker.register({ threadId, requestId });
    yield* broker.retire({ threadId, requestId });
    expect(
      yield* broker.resolve({
        threadId,
        requestId,
        answers: { t3_action_approval: "Approve" },
      }),
    ).toBe("duplicate");
  }).pipe(Effect.provide(ActionApprovalBroker.layer)),
);
