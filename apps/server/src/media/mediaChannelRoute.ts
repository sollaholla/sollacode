import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import type { MediaRelay } from "./MediaRelay.ts";

/**
 * Media is already compressed; deflating it again costs CPU on both ends of
 * every hop for nothing. Removing the offer before the upgrade makes this one
 * socket decline permessage-deflate while `/ws` keeps negotiating it. Node's
 * request headers are a plain object; on any other runtime this is a no-op.
 */
function declinePerMessageDeflate(request: HttpServerRequest.HttpServerRequest): void {
  const source = request.source as { headers?: Record<string, unknown> } | null;
  if (source?.headers && typeof source.headers === "object") {
    delete source.headers["sec-websocket-extensions"];
  }
}

/**
 * `GET /ws/media?ticket=…`: redeems the ticket, then hands the upgraded socket
 * to the relay for its lifetime. Anything without a live ticket is refused
 * before the upgrade.
 */
export const mediaChannelRouteHandler = (relay: MediaRelay["Service"]) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const ticket = Option.isSome(url) ? url.value.searchParams.get("ticket") : null;
    const grant = ticket ? yield* relay.redeemTicket(ticket) : null;
    if (!grant) {
      return HttpServerResponse.text("The media ticket is missing, used, or expired.", {
        status: 401,
      });
    }
    declinePerMessageDeflate(request);
    const socket = yield* Effect.orDie(request.upgrade);
    yield* relay.serve(grant, socket);
    return HttpServerResponse.empty();
  });
