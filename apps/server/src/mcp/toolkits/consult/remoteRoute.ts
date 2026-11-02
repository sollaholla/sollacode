import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";

import { authenticateRawRouteWithScope } from "../../../http.ts";
import { type ConsultAskLog, handleRemoteConsult } from "./handlers.ts";
import { REMOTE_CONSULT_PATH, RemoteConsultRequest, RemoteConsultResponse } from "./types.ts";

const decodeRequest = Schema.decodeUnknownEffect(RemoteConsultRequest);
const encodeResponse = Schema.encodeSync(RemoteConsultResponse);

/** Asks from other computers, for as long as this server runs. */
const remoteAskLog: ConsultAskLog = new Map();

/**
 * Where another computer's server sends a `workspace_consult` call for one of
 * its chats. Any client with this scope can already send a chat a message;
 * this adds nothing beyond saying who it is from, and that is recorded as
 * another chat, never as the person.
 */
export const remoteConsultRouteLayer = HttpRouter.add(
  "POST",
  REMOTE_CONSULT_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const decoded = yield* request.json.pipe(Effect.flatMap(decodeRequest), Effect.option);
    if (decoded._tag === "None") {
      return HttpServerResponse.text("That is not a consult request.", { status: 400 });
    }
    const response: RemoteConsultResponse = yield* handleRemoteConsult(
      decoded.value,
      remoteAskLog,
    ).pipe(
      Effect.map((result) => ({ ok: true as const, result })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
    );
    return HttpServerResponse.jsonUnsafe(encodeResponse(response));
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);
