import {
  ApprovalRequestId,
  CommandId,
  EventId,
  type ProviderUserInputAnswers,
  type ThreadId,
  type TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import {
  ACTION_APPROVAL_CHOICE,
  ACTION_APPROVAL_QUESTION_ID,
} from "@t3tools/shared/actionApproval";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ActionApprovalBroker from "./ActionApprovalBroker.ts";
import type { ActionApprovalInput } from "./types.ts";

const ActionApprovalResponse = Schema.Struct({
  [ACTION_APPROVAL_QUESTION_ID]: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20_000),
  ),
});

const DEFAULT_APPROVAL_TIMEOUT = Duration.minutes(30);

export type ActionApprovalPromptOutcome =
  | { readonly status: "approved" }
  | { readonly status: "changes_requested"; readonly feedback: string }
  | { readonly status: "cancelled" }
  | { readonly status: "unsupported" };

export interface ActionApprovalPromptScope {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
}

export class ActionApprovalPrompt extends Context.Service<
  ActionApprovalPrompt,
  {
    readonly request: (
      input: ActionApprovalInput,
      scope: ActionApprovalPromptScope,
    ) => Effect.Effect<ActionApprovalPromptOutcome>;
  }
>()("t3/mcp/toolkits/actionApproval/prompt/ActionApprovalPrompt") {}

const actionLabel = (actionKind: ActionApprovalInput["actionKind"]): string =>
  actionKind.replaceAll("_", " ");

export function actionApprovalMessage(input: ActionApprovalInput): string {
  return [
    `Review this proposed ${actionLabel(input.actionKind)}:`,
    "",
    input.summary,
    "",
    input.preview,
    "",
    "Choose Approve to continue exactly as shown, or type corrections in the composer.",
  ].join("\n");
}

export function actionApprovalQuestion(input: ActionApprovalInput): UserInputQuestion {
  return {
    id: ACTION_APPROVAL_QUESTION_ID,
    header: "Approval",
    question: actionApprovalMessage(input),
    options: [
      {
        label: ACTION_APPROVAL_CHOICE,
        description: "Continue with the action exactly as shown.",
      },
    ],
    multiSelect: false,
  };
}

function outcomeFromAnswers(answers: ProviderUserInputAnswers): ActionApprovalPromptOutcome {
  const decoded = Schema.decodeUnknownOption(ActionApprovalResponse)(answers);
  if (Option.isNone(decoded)) return { status: "cancelled" };
  const answer = decoded.value[ACTION_APPROVAL_QUESTION_ID].trim();
  return answer.toLowerCase() === ACTION_APPROVAL_CHOICE.toLowerCase()
    ? { status: "approved" }
    : { status: "changes_requested", feedback: answer };
}

export const makeLayer = (options?: { readonly timeout?: Duration.Input }) =>
  Layer.effect(
    ActionApprovalPrompt,
    Effect.gen(function* () {
      const broker = yield* ActionApprovalBroker.ActionApprovalBroker;
      const crypto = yield* Crypto.Crypto;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const timeout = options?.timeout ?? DEFAULT_APPROVAL_TIMEOUT;

      const nextId = Effect.fn("ActionApprovalPrompt.nextId")(function* (prefix: string) {
        const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        return `${prefix}:${uuid}`;
      });

      const appendActivity = Effect.fn("ActionApprovalPrompt.appendActivity")(function* (input: {
        readonly threadId: ThreadId;
        readonly turnId: TurnId | null;
        readonly kind: "user-input.requested" | "user-input.resolved";
        readonly tone: "approval" | "info";
        readonly summary: string;
        readonly payload: Readonly<Record<string, unknown>>;
      }) {
        const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        const commandId = CommandId.make(yield* nextId(`server:action-approval:${input.kind}`));
        const eventId = EventId.make(yield* nextId(`action-approval:${input.kind}`));
        yield* orchestrationEngine
          .dispatch({
            type: "thread.activity.append",
            commandId,
            threadId: input.threadId,
            activity: {
              id: eventId,
              tone: input.tone,
              kind: input.kind,
              summary: input.summary,
              payload: input.payload,
              turnId: input.turnId,
              createdAt,
            },
            createdAt,
          })
          .pipe(Effect.orDie);
      });

      const request: ActionApprovalPrompt["Service"]["request"] = Effect.fn(
        "ActionApprovalPrompt.request",
      )(function* (input, scope) {
        const requestId = ApprovalRequestId.make(yield* nextId("action-approval"));
        const registration = yield* broker.register({
          threadId: scope.threadId,
          requestId,
        });
        let requestVisible = false;
        let resolutionAnswers: ProviderUserInputAnswers = {};

        const waitForAnswer = Effect.gen(function* () {
          yield* appendActivity({
            threadId: scope.threadId,
            turnId: scope.turnId,
            kind: "user-input.requested",
            tone: "approval",
            summary: "Action approval requested",
            payload: {
              requestId,
              questions: [actionApprovalQuestion(input)],
            },
          });
          requestVisible = true;

          const response = yield* registration.answers.pipe(Effect.timeoutOption(timeout));
          if (Option.isNone(response)) return { status: "cancelled" } as const;
          resolutionAnswers = response.value;
          return outcomeFromAnswers(response.value);
        });

        const closePrompt = Effect.gen(function* () {
          yield* broker.retire({ threadId: scope.threadId, requestId });
          if (!requestVisible) return;
          yield* appendActivity({
            threadId: scope.threadId,
            turnId: scope.turnId,
            kind: "user-input.resolved",
            tone: "info",
            summary: "Action approval closed",
            payload: {
              requestId,
              answers: resolutionAnswers,
            },
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("failed to close action approval prompt", {
              threadId: scope.threadId,
              requestId,
              cause: Cause.pretty(cause),
            }),
          ),
        );

        return yield* waitForAnswer.pipe(Effect.ensuring(closePrompt));
      });

      return ActionApprovalPrompt.of({ request });
    }),
  );

export const layer = makeLayer();
