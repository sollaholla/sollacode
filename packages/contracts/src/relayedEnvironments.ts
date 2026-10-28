import * as Schema from "effect/Schema";

import { EnvironmentId } from "./baseSchemas.ts";

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
