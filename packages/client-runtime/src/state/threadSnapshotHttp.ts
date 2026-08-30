import type {
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadHistoryPage,
  OrchestrationThreadHistoryPageInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";
import { HttpClient } from "effect/unstable/http";

import type { PreparedConnection } from "../connection/model.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand } from "./runtime.ts";

// Bounded so a pathologically slow endpoint cannot block the (cheaper) socket
// fallback for long. The cached thread renders while this runs, so the wait only
// delays the transition to live data on the first open, not the initial paint.
const DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS = 6_000;

/**
 * Load a thread's detail snapshot over HTTP instead of embedding it in the
 * WebSocket subscription's first frame. The response is gzip-compressible by
 * the transport and keeps the (potentially multi-KB) snapshot off the socket.
 */
export const fetchEnvironmentThreadSnapshot = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadSnapshot",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(
    input.prepared.httpBaseUrl,
    `/api/orchestration/threads/${input.threadId}`,
  );
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(input.prepared.httpAuthorization);
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.orchestration.threadSnapshot({
        params: { threadId: input.threadId },
        headers,
      }),
    ),
  );
});

export type FetchEnvironmentThreadSnapshotError = RemoteEnvironmentRequestError;

export const fetchEnvironmentThreadHistoryPage = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadHistoryPage",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly page: OrchestrationThreadHistoryPageInput;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(
    input.prepared.httpBaseUrl,
    `/api/orchestration/threads/${input.threadId}/history`,
  );
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(input.prepared.httpAuthorization);
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.orchestration.threadHistory({
        params: { threadId: input.threadId },
        query: input.page,
        headers,
      }),
    ),
  );
});

/**
 * Loads a thread's detail snapshot over HTTP, returning `Option.none()` when it
 * cannot be loaded (so the caller falls back to the socket-embedded snapshot).
 * Decouples the thread state machine from the underlying HTTP + DPoP details and
 * keeps them out of test contexts.
 */
export class ThreadSnapshotLoader extends Context.Service<
  ThreadSnapshotLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>>;
    readonly loadHistory?: (
      prepared: PreparedConnection,
      threadId: ThreadId,
      input: OrchestrationThreadHistoryPageInput,
    ) => Effect.Effect<Option.Option<OrchestrationThreadHistoryPage>>;
  }
>()("@t3tools/client-runtime/state/threadSnapshotHttp/ThreadSnapshotLoader") {}

export const threadSnapshotLoaderLayer: Layer.Layer<
  ThreadSnapshotLoader,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  ThreadSnapshotLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    return ThreadSnapshotLoader.of({
      load: (prepared: PreparedConnection, threadId: ThreadId) =>
        fetchEnvironmentThreadSnapshot({ prepared, threadId }).pipe(
          Effect.map(Option.some<OrchestrationThreadDetailSnapshot>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          // A genuinely missing thread (404) is expected — the socket
          // subscription is the source of truth for thread existence and will
          // surface the deletion — so don't treat it as an error worth warning
          // about; just defer to the socket path.
          Effect.catchTags({
            EnvironmentResourceNotFoundError: () =>
              Effect.logDebug(
                "Thread snapshot not found over HTTP; deferring to the socket subscription.",
              ).pipe(
                Effect.annotateLogs({ threadId }),
                Effect.as(Option.none<OrchestrationThreadDetailSnapshot>()),
              ),
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "Could not load the thread snapshot over HTTP; using the socket snapshot instead.",
            ).pipe(
              Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
              Effect.as(Option.none<OrchestrationThreadDetailSnapshot>()),
            ),
          ),
        ),
      loadHistory: (
        prepared: PreparedConnection,
        threadId: ThreadId,
        input: OrchestrationThreadHistoryPageInput,
      ) =>
        fetchEnvironmentThreadHistoryPage({ prepared, threadId, page: input }).pipe(
          Effect.map(Option.some<OrchestrationThreadHistoryPage>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not load older thread history over HTTP.").pipe(
              Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
              Effect.as(Option.none<OrchestrationThreadHistoryPage>()),
            ),
          ),
        ),
    });
  }),
);

export function createEnvironmentThreadHistoryCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | ThreadSnapshotLoader | R, E>,
) {
  return createEnvironmentCommand(runtime, {
    label: "environment-data:commands:thread:load-history",
    concurrency: {
      mode: "serial" as const,
      key: ({ environmentId, input }) => `${environmentId}:${input.threadId}`,
    },
    execute: (input: {
      readonly threadId: ThreadId;
      readonly page: OrchestrationThreadHistoryPageInput;
    }) =>
      Effect.gen(function* () {
        const supervisor = yield* EnvironmentSupervisor;
        const loader = yield* ThreadSnapshotLoader;
        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared) || loader.loadHistory === undefined) {
          return Option.none<OrchestrationThreadHistoryPage>();
        }
        return yield* loader.loadHistory(prepared.value, input.threadId, input.page);
      }),
  });
}
