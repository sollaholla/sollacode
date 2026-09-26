import { OrchestrationDispatchCommandError, type CommandId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";

/** Run inside the serialized command gate, before any bootstrap side effects. */
export const replayOrBootstrapTurn = Effect.fn("BootstrapReplay.dispatch")(function* <E, R>(
  commandId: CommandId,
  bootstrap: Effect.Effect<{ readonly sequence: number }, E, R>,
) {
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const existing = yield* receipts.getByCommandId({ commandId }).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationDispatchCommandError({
          message: "Could not check whether this message was already delivered.",
          cause,
        }),
    ),
  );
  if (Option.isNone(existing)) return yield* bootstrap;
  if (existing.value.status === "accepted") return { sequence: existing.value.resultSequence };
  return yield* new OrchestrationDispatchCommandError({
    message: existing.value.error || "This message was previously rejected.",
  });
});
