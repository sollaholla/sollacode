import {
  ApprovalRequestId,
  CommandId,
  EventId,
  type ThreadId,
  type TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import {
  CREDENTIAL_DECLINE_CHOICE,
  CREDENTIAL_REQUEST_ID_PREFIX,
  CREDENTIAL_REQUEST_QUESTION_ID,
  CREDENTIAL_SIGNED_IN_CHOICE,
  credentialRequestSiteName,
  type CredentialRequest,
} from "@t3tools/shared/credentialRequest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";

export interface CredentialRequestPromptScope {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
}

export class CredentialRequestPrompt extends Context.Service<
  CredentialRequestPrompt,
  {
    readonly request: (
      input: CredentialRequest,
      scope: CredentialRequestPromptScope,
    ) => Effect.Effect<ApprovalRequestId>;
  }
>()("t3/mcp/toolkits/credentialRequest/prompt/CredentialRequestPrompt") {}

/**
 * The card as a plain question, which is what clients without the form and the
 * sidebar's waiting label read. Clients drop a question with no options, so
 * every mode carries at least the way to say no.
 */
export function credentialRequestQuestion(input: CredentialRequest): UserInputQuestion {
  const site = credentialRequestSiteName(input.origin);
  if (input.mode === "person") {
    return {
      id: CREDENTIAL_REQUEST_QUESTION_ID,
      header: "Sign-in needed",
      question: `Please finish signing in to ${site} on its browser tab. The agent has stopped and will not touch the page until you answer. It says: ${input.reason}`,
      options: [
        {
          label: CREDENTIAL_SIGNED_IN_CHOICE,
          description: "The agent carries on from the signed-in page.",
        },
        {
          label: CREDENTIAL_DECLINE_CHOICE,
          description: "The agent carries on without signing in.",
        },
      ],
      multiSelect: false,
    };
  }
  if (input.mode === "passkey") {
    return {
      id: CREDENTIAL_REQUEST_QUESTION_ID,
      header: "Passkey needed",
      question: `${site} wants a passkey. Solla can hold one for this site, encrypted on your computer. It says: ${input.reason}`,
      options: [
        {
          label: CREDENTIAL_DECLINE_CHOICE,
          description: "The agent carries on without a passkey.",
        },
      ],
      multiSelect: false,
    };
  }
  const wanted = input.mode === "code" ? "a code" : "a login";
  return {
    id: CREDENTIAL_REQUEST_QUESTION_ID,
    header: "Sign-in needed",
    question: `The agent needs ${wanted} for ${site}. It says: ${input.reason}`,
    options: [
      {
        label: CREDENTIAL_DECLINE_CHOICE,
        description: "The agent carries on without signing in.",
      },
    ],
    multiSelect: false,
  };
}

export const makeLayer = () =>
  Layer.effect(
    CredentialRequestPrompt,
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const nextId = Effect.fn("CredentialRequestPrompt.nextId")(function* (prefix: string) {
        return `${prefix}:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`;
      });

      const request: CredentialRequestPrompt["Service"]["request"] = Effect.fn(
        "CredentialRequestPrompt.request",
      )(function* (input, scope) {
        const requestId = ApprovalRequestId.make(
          yield* nextId(CREDENTIAL_REQUEST_ID_PREFIX.slice(0, -1)),
        );
        const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        yield* orchestrationEngine
          .dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(yield* nextId("server:credential-request:requested")),
            threadId: scope.threadId,
            activity: {
              id: EventId.make(yield* nextId("credential-request:requested")),
              tone: "approval",
              kind: "user-input.requested",
              summary: "Sign-in requested",
              payload: {
                requestId,
                questions: [credentialRequestQuestion(input)],
                credentialRequest: input,
              },
              // The answer arrives after this call and its turn have ended, so
              // the request is intentionally owned by neither.
              turnId: null,
              createdAt,
            },
            createdAt,
          })
          .pipe(Effect.orDie);
        // Returning pending does not stop the provider turn, and an agent left
        // running would keep driving the page the person is meant to use.
        if (scope.turnId !== null) {
          yield* orchestrationEngine
            .dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.make(yield* nextId("server:credential-request:interrupt")),
              threadId: scope.threadId,
              turnId: scope.turnId,
              createdAt,
            })
            .pipe(Effect.orDie);
        }
        return requestId;
      });

      return CredentialRequestPrompt.of({ request });
    }),
  );

export const layer = makeLayer();
