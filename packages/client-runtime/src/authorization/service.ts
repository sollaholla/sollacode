import { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { environmentMismatchError, mapRemoteEnvironmentError } from "../connection/errors.ts";
import type { ConnectionAttemptError, PreparedHttpAuthorization } from "../connection/model.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { renewRemoteCredential, resolveRemoteWebSocketConnectionUrl } from "./remote.ts";

export interface AuthorizedRemoteEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly socketUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization;
}

export class RemoteEnvironmentAuthorization extends Context.Service<
  RemoteEnvironmentAuthorization,
  {
    readonly authorizeBearer: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
      /**
       * When the offered credential is past its life but still inside the
       * environment's grace window, renew succeeds and this callback persists
       * the replacement before the websocket ticket is issued.
       */
      readonly onCredentialRenewed?: (
        credential: string,
      ) => Effect.Effect<void, ConnectionAttemptError>;
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/authorization/service/RemoteEnvironmentAuthorization") {}

const fetchDescriptor = Effect.fn("clientRuntime.connection.remote.fetchDescriptor")(function* (
  httpBaseUrl: string,
) {
  return yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
    Effect.mapError(mapRemoteEnvironmentError),
  );
});

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;

  const authorizeBearer = Effect.fn("clientRuntime.connection.remote.authorizeBearer")(
    function* (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
      readonly onCredentialRenewed?: (
        credential: string,
      ) => Effect.Effect<void, ConnectionAttemptError>;
    }) {
      const descriptor = yield* fetchDescriptor(input.httpBaseUrl).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      if (descriptor.environmentId !== input.expectedEnvironmentId) {
        return yield* environmentMismatchError({
          expected: input.expectedEnvironmentId,
          actual: descriptor.environmentId,
        });
      }
      const issueSocket = (bearerToken: string) =>
        resolveRemoteWebSocketConnectionUrl({
          wsBaseUrl: input.wsBaseUrl,
          httpBaseUrl: input.httpBaseUrl,
          bearerToken,
        }).pipe(
          Effect.mapError(mapRemoteEnvironmentError),
          Effect.provideService(HttpClient.HttpClient, httpClient),
        );

      const authorized = yield* issueSocket(input.bearerToken).pipe(
        Effect.map((socketUrl) => ({ bearerToken: input.bearerToken, socketUrl })),
        Effect.catchIf(
          (error) =>
            error._tag === "ConnectionBlockedError" &&
            error.reason === "authentication" &&
            input.onCredentialRenewed !== undefined,
          (authError) =>
            Effect.gen(function* () {
              // Device was paired once; within the grace window a reconnect is
              // enough to mint a fresh credential. Outside it, renew fails and
              // the original "pair again" error stands.
              const renewed = yield* renewRemoteCredential({
                httpBaseUrl: input.httpBaseUrl,
                credential: input.bearerToken,
              }).pipe(
                Effect.provideService(HttpClient.HttpClient, httpClient),
                Effect.mapError(() => authError),
              );
              yield* input.onCredentialRenewed!(renewed.credential);
              const socketUrl = yield* issueSocket(renewed.credential);
              return { bearerToken: renewed.credential, socketUrl };
            }),
        ),
      );

      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: input.httpBaseUrl,
        socketUrl: authorized.socketUrl,
        httpAuthorization: {
          _tag: "Bearer" as const,
          token: authorized.bearerToken,
        },
      };
    },
  );

  return RemoteEnvironmentAuthorization.of({ authorizeBearer });
});

export const layer = Layer.effect(RemoteEnvironmentAuthorization, make);
