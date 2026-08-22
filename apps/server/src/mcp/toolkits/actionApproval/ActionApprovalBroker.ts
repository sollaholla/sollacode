import {
  type ApprovalRequestId,
  type ProviderUserInputAnswers,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type ActionApprovalBrokerResolution = "accepted" | "duplicate" | "not_owned";

export interface ActionApprovalRegistration {
  readonly answers: Effect.Effect<ProviderUserInputAnswers>;
}

type PendingApproval = {
  readonly state: "pending";
  readonly threadId: ThreadId;
  readonly deferred: Deferred.Deferred<ProviderUserInputAnswers>;
};

type RetiredApproval = {
  readonly state: "retired";
  readonly threadId: ThreadId;
};

type BrokerEntry = PendingApproval | RetiredApproval;

const MAX_RETIRED_APPROVALS = 256;

export class ActionApprovalBroker extends Context.Service<
  ActionApprovalBroker,
  {
    readonly register: (input: {
      readonly threadId: ThreadId;
      readonly requestId: ApprovalRequestId;
    }) => Effect.Effect<ActionApprovalRegistration>;
    readonly resolve: (input: {
      readonly threadId: ThreadId;
      readonly requestId: ApprovalRequestId;
      readonly answers: ProviderUserInputAnswers;
    }) => Effect.Effect<ActionApprovalBrokerResolution>;
    readonly retire: (input: {
      readonly threadId: ThreadId;
      readonly requestId: ApprovalRequestId;
    }) => Effect.Effect<void>;
  }
>()("t3/mcp/toolkits/actionApproval/ActionApprovalBroker") {}

const make = Effect.fn("ActionApprovalBroker.make")(function* () {
  const entries = new Map<ApprovalRequestId, BrokerEntry>();

  const pruneRetired = () => {
    let retiredCount = 0;
    for (const entry of entries.values()) {
      if (entry.state === "retired") retiredCount += 1;
    }
    for (const [requestId, entry] of entries) {
      if (retiredCount <= MAX_RETIRED_APPROVALS) break;
      if (entry.state !== "retired") continue;
      entries.delete(requestId);
      retiredCount -= 1;
    }
  };

  const register: ActionApprovalBroker["Service"]["register"] = Effect.fn(
    "ActionApprovalBroker.register",
  )(function* (input) {
    const deferred = yield* Deferred.make<ProviderUserInputAnswers>();
    yield* Effect.sync(() => {
      if (entries.has(input.requestId)) {
        throw new Error(`Action approval request '${input.requestId}' is already registered.`);
      }
      entries.set(input.requestId, {
        state: "pending",
        threadId: input.threadId,
        deferred,
      });
      pruneRetired();
    });
    return { answers: Deferred.await(deferred) };
  });

  const resolve: ActionApprovalBroker["Service"]["resolve"] = Effect.fn(
    "ActionApprovalBroker.resolve",
  )(function* (input) {
    const entry = entries.get(input.requestId);
    if (!entry || entry.threadId !== input.threadId) return "not_owned" as const;
    if (entry.state === "retired") return "duplicate" as const;

    entries.set(input.requestId, {
      state: "retired",
      threadId: input.threadId,
    });
    pruneRetired();
    yield* Deferred.succeed(entry.deferred, input.answers);
    return "accepted" as const;
  }, Effect.uninterruptible);

  const retire: ActionApprovalBroker["Service"]["retire"] = Effect.fn(
    "ActionApprovalBroker.retire",
  )(function* (input) {
    yield* Effect.sync(() => {
      const entry = entries.get(input.requestId);
      if (!entry || entry.threadId !== input.threadId) return;
      entries.set(input.requestId, {
        state: "retired",
        threadId: input.threadId,
      });
      pruneRetired();
    });
  });

  return ActionApprovalBroker.of({ register, resolve, retire });
});

export const layer = Layer.effect(ActionApprovalBroker, make());
