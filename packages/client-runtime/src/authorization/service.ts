import { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { environmentMismatchError, mapRemoteEnvironmentError } from "../connection/errors.ts";
import type { ConnectionAttemptError, PreparedHttpAuthorization } from "../connection/model.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import {
  issueRelayedWebSocketTicket,
  renewRemoteCredential,
  resolveRemoteWebSocketConnectionUrl,
} from "./remote.ts";

export interface AuthorizedRemoteEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly socketUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization;
}

export interface AuthorizedRelayedEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly socketUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
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
    /**
     * An environment behind another host's relay. `bearerToken` is the
     * credential for that host, or null where the host's cookie authenticates.
     * The relay renews its own credential for the far environment, so there is
     * nothing to renew here.
     */
    readonly authorizeRelayed: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsUrl: string;
      readonly bearerToken: string | null;
    }) => Effect.Effect<AuthorizedRelayedEnvironment, ConnectionAttemptError>;
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

  const authorizeRelayed = Effect.fn("clientRuntime.connection.remote.authorizeRelayed")(
    function* (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsUrl: string;
      readonly bearerToken: string | null;
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
      const issued = yield* issueRelayedWebSocketTicket({
        httpBaseUrl: input.httpBaseUrl,
        bearerToken: input.bearerToken,
      }).pipe(
        Effect.mapError(mapRemoteEnvironmentError),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      const socketUrl = new URL(input.wsUrl);
      socketUrl.searchParams.set("wsTicket", issued.ticket);
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: input.httpBaseUrl,
        socketUrl: socketUrl.toString(),
        httpAuthorization:
          input.bearerToken === null ? null : { _tag: "Bearer" as const, token: input.bearerToken },
      };
    },
  );

  return RemoteEnvironmentAuthorization.of({ authorizeBearer, authorizeRelayed });
});

export const layer = Layer.effect(RemoteEnvironmentAuthorization, make);
