import {
  ApprovalRequestId,
  CommandId,
  EventId,
  type ThreadId,
  type TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import {
  ACTION_APPROVAL_CHOICE,
  ACTION_APPROVAL_REQUEST_ID_PREFIX,
  ACTION_APPROVAL_QUESTION_ID,
} from "@t3tools/shared/actionApproval";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import type { ActionApprovalInput } from "./types.ts";

export type ActionApprovalPromptOutcome =
  | { readonly status: "pending"; readonly requestId: ApprovalRequestId }
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

export const makeLayer = () =>
  Layer.effect(
    ActionApprovalPrompt,
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const orchestrationEngine = yield* OrchestrationEngineService;

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
        const requestId = ApprovalRequestId.make(
          yield* nextId(ACTION_APPROVAL_REQUEST_ID_PREFIX.slice(0, -1)),
        );
        yield* appendActivity({
          threadId: scope.threadId,
          // The response arrives after this MCP call and provider turn have
          // ended, so the durable request is intentionally not owned by either.
          turnId: null,
          kind: "user-input.requested",
          tone: "approval",
          summary: "Action approval requested",
          payload: {
            requestId,
            questions: [actionApprovalQuestion(input)],
            actionApproval: input,
          },
        });
        // Returning pending does not stop the provider turn. Without this the
        // agent retries the same approval until the user has answered it
        // several times. Interrupt after the card exists so the MCP result
        // can still leave; a fresh turn starts when the user answers.
        if (scope.turnId !== null) {
          const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
          yield* orchestrationEngine
            .dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.make(yield* nextId("server:action-approval:interrupt")),
              threadId: scope.threadId,
              turnId: scope.turnId,
              createdAt,
            })
            .pipe(Effect.orDie);
        }
        return { status: "pending" as const, requestId };
      });

      return ActionApprovalPrompt.of({ request });
    }),
  );

export const layer = makeLayer();
