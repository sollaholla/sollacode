import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId } from "./baseSchemas.ts";

/**
 * An environment this host can reach and passes through to its own clients.
 * A phone connected to a Mac sees the Windows machine the Mac's desktop app
 * added, through the Mac, without pairing with Windows itself.
 */
export const RelayedEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
});
export type RelayedEnvironment = typeof RelayedEnvironment.Type;

export const RelayedEnvironmentList = Schema.Struct({
  environments: Schema.Array(RelayedEnvironment),
});
export type RelayedEnvironmentList = typeof RelayedEnvironmentList.Type;

/**
 * One saved connection the host's own desktop app shares. The credential stays
 * on the host: clients reach the environment through the host's relay route,
 * which signs each request with it.
 */
export const RelayedEnvironmentSource = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  httpBaseUrl: Schema.String,
  bearerToken: Schema.String,
});
export type RelayedEnvironmentSource = typeof RelayedEnvironmentSource.Type;

/** Replaces every environment the host shares. */
export const RelayedEnvironmentsPublishInput = Schema.Struct({
  environments: Schema.Array(RelayedEnvironmentSource),
});
export type RelayedEnvironmentsPublishInput = typeof RelayedEnvironmentsPublishInput.Type;

const REMOTE_THREAD_ID_PREFIX = "remote:";

/**
 * How a chat on another computer is named on this one, wherever a thread id is
 * recorded: a message's sender, or the chat that opened a thread. Being a
 * different id means it can never pass for a local chat, the orchestrator
 * included, so a message from another computer is always "another chat" to the
 * approval rules.
 *
 * `upstreamDepth` is how many chats the request had already passed through when
 * it left that computer, which keeps the relay limit counting across computers.
 */
export const makeRemoteThreadId = (
  environmentId: EnvironmentId,
  threadId: ThreadId,
  upstreamDepth = 0,
): ThreadId =>
  ThreadId.make(
    `${REMOTE_THREAD_ID_PREFIX}${encodeURIComponent(environmentId)}:${upstreamDepth}:${threadId}`,
  );

/** The computer and chat behind a {@link makeRemoteThreadId}, or null for a local thread id. */
export const parseRemoteThreadId = (
  id: string,
): {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly upstreamDepth: number;
} | null => {
  if (!id.startsWith(REMOTE_THREAD_ID_PREFIX)) return null;
  const match = /^([^:]+):(\d+):(.+)$/su.exec(id.slice(REMOTE_THREAD_ID_PREFIX.length));
  if (match === null) return null;
  const [, environmentId, upstreamDepth, threadId] = match;
  if (environmentId === undefined || upstreamDepth === undefined || threadId === undefined) {
    return null;
  }
  return {
    environmentId: EnvironmentId.make(decodeURIComponent(environmentId)),
    threadId: ThreadId.make(threadId),
    upstreamDepth: Number(upstreamDepth),
  };
};
