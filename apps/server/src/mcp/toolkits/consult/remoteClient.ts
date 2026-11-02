import type { RelayedEnvironmentSource } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";

import { RelayedEnvironments } from "../../../relay/RelayedEnvironments.ts";
import { renewRelayCredential, relayUpstreamUrl } from "../../../relay/relayRoute.ts";
import {
  REMOTE_CONSULT_PATH,
  type RemoteConsultRequest,
  RemoteConsultResponse,
  WorkspaceConsultFailedError,
} from "./types.ts";

const decodeResponse = Schema.decodeUnknownEffect(RemoteConsultResponse);
const isFailedError = Schema.is(WorkspaceConsultFailedError);

const refusedDetail = (status: number): string => {
  switch (status) {
    case 401:
      return "this computer's connection to it has expired. Reconnect it in Settings → Connections.";
    case 403:
      return "this computer's connection to it is not allowed to message its chats.";
    case 404:
      return "it runs a version of Solla Code that cannot take messages from other computers. It needs updating first.";
    default:
      return `it answered with status ${status}.`;
  }
};

/**
 * Sends one `workspace_consult` call to a connected computer, signed with the
 * credential this host's desktop app shared, and returns that computer's own
 * answer or refusal. Any other failure says what went wrong; for a question it
 * also warns that it may already have landed, since only the far side knows.
 */
export const callConnectedComputer = Effect.fn("WorkspaceConsult.callConnectedComputer")(function* (
  source: RelayedEnvironmentSource,
  request: RemoteConsultRequest,
  timeoutMs: number,
) {
  const http = yield* HttpClient.HttpClient;
  const relays = yield* RelayedEnvironments;
  const operation = `reaching ${source.label}`;
  const unanswered = (detail: string) =>
    new WorkspaceConsultFailedError({
      operation,
      detail:
        request.input.action === "ask"
          ? `${detail} The question may already have been delivered, so check read_thread before asking again.`
          : detail,
    });

  const url = relayUpstreamUrl(source.httpBaseUrl, REMOTE_CONSULT_PATH, "", "http");
  const send = (bearerToken: string) =>
    http.execute(
      HttpClientRequest.post(url, {
        headers: { authorization: `Bearer ${bearerToken}` },
        body: HttpBody.jsonUnsafe(request),
      }),
    );

  const exchange = Effect.gen(function* () {
    let response = yield* send(source.bearerToken);
    // Refused before it was read, so sending it again cannot deliver it twice.
    if (response.status === 401) {
      const renewed = yield* renewRelayCredential(source.httpBaseUrl, source.bearerToken).pipe(
        Effect.option,
      );
      if (Option.isSome(renewed)) {
        yield* relays.renewToken(source.environmentId, source.bearerToken, renewed.value);
        response = yield* send(renewed.value);
      }
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new WorkspaceConsultFailedError({
        operation,
        detail: refusedDetail(response.status),
      });
    }
    return yield* decodeResponse(yield* response.json).pipe(
      Effect.mapError(
        () =>
          new WorkspaceConsultFailedError({
            operation,
            detail: "it answered in a form this version does not understand.",
          }),
      ),
    );
  });

  const answer = yield* exchange.pipe(
    Effect.catchIf(
      (error) => !isFailedError(error),
      () => Effect.fail(unanswered("it could not be reached.")),
    ),
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(unanswered(`it did not answer within ${Math.round(timeoutMs / 1000)} s.`)),
        onSome: Effect.succeed,
      }),
    ),
  );
  if (answer.ok) return answer.result;
  return yield* answer.error;
});
