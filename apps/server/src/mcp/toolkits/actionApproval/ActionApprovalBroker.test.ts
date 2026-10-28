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

it.effect("reuses one open fingerprint so a retry does not mint a second request", () =>
  Effect.gen(function* () {
    const broker = yield* ActionApprovalBroker.ActionApprovalBroker;
    yield* broker.rememberOpen({
      threadId,
      requestId,
      fingerprint: "send_email\nSend email to pat@example.com\npreview",
    });
    expect(
      yield* broker.findOpen({
        threadId,
        fingerprint: "send_email\nSend email to pat@example.com\npreview",
      }),
    ).toBe(requestId);
    yield* broker.retire({ threadId, requestId });
    expect(
      yield* broker.findOpen({
        threadId,
        fingerprint: "send_email\nSend email to pat@example.com\npreview",
      }),
    ).toBeNull();
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

it.effect("remembers an approved proposal once, for the work it was asked in", () =>
  Effect.gen(function* () {
    const broker = yield* ActionApprovalBroker.ActionApprovalBroker;
    const fingerprint = "send_email\nSend email to pat@example.com\npreview";
    const workStartedAt = "2026-08-21T12:00:00.000Z";
    yield* broker.rememberOpen({ threadId, requestId, fingerprint, workStartedAt });
    expect(yield* broker.wasApproved({ threadId, fingerprint, workStartedAt })).toBe(false);

    // Another thread's answer does not settle it.
    yield* broker.resolve({
      threadId: otherThreadId,
      requestId,
      answers: { t3_action_approval: "Approve" },
    });
    expect(yield* broker.findOpen({ threadId, fingerprint })).toBe(requestId);

    expect(
      yield* broker.resolve({ threadId, requestId, answers: { t3_action_approval: "Approve" } }),
    ).toBe("not_owned");
    expect(yield* broker.findOpen({ threadId, fingerprint })).toBeNull();
    expect(
      yield* broker.wasApproved({
        threadId,
        fingerprint,
        workStartedAt: "2026-08-21T12:05:00.000Z",
      }),
    ).toBe(false);
    expect(yield* broker.wasApproved({ threadId: otherThreadId, fingerprint, workStartedAt })).toBe(
      false,
    );
    expect(yield* broker.wasApproved({ threadId, fingerprint, workStartedAt })).toBe(true);
    // One approval covers one re-request: the next repeat asks again.
    expect(yield* broker.wasApproved({ threadId, fingerprint, workStartedAt })).toBe(false);
  }).pipe(Effect.provide(ActionApprovalBroker.layer)),
);

it.effect("closes an answered proposal without approving corrections or cancellations", () =>
  Effect.gen(function* () {
    const broker = yield* ActionApprovalBroker.ActionApprovalBroker;
    const workStartedAt = "2026-08-21T12:00:00.000Z";
    const corrected = ApprovalRequestId.make("action-approval-broker-corrected");
    const cancelled = ApprovalRequestId.make("action-approval-broker-cancelled");
    yield* broker.rememberOpen({
      threadId,
      requestId: corrected,
      fingerprint: "corrected",
      workStartedAt,
    });
    yield* broker.rememberOpen({
      threadId,
      requestId: cancelled,
      fingerprint: "cancelled",
      workStartedAt,
    });
    yield* broker.resolve({
      threadId,
      requestId: corrected,
      answers: { t3_action_approval: "Use the work account." },
    });
    yield* broker.resolve({ threadId, requestId: cancelled, answers: {} });

    for (const fingerprint of ["corrected", "cancelled"]) {
      expect(yield* broker.findOpen({ threadId, fingerprint })).toBeNull();
      expect(yield* broker.wasApproved({ threadId, fingerprint, workStartedAt })).toBe(false);
    }
  }).pipe(Effect.provide(ActionApprovalBroker.layer)),
);
