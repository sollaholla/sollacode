/**
 * VmAgentStore - persistence for the Agent Stack registry.
 *
 * Owns the `vm_agents` table: one row per named autonomous agent and its bound
 * VM. Deliberately separate from thread projections — agents are their own
 * feature. Mention routing resolves `@handle` through {@link getByHandle}.
 *
 * @module VmAgentStore
 */
import { IsoDateTime, VmAgent, VmAgentId, VmControlMode, VmAgentStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const UpdateVmAgentRuntimeInput = Schema.Struct({
  vmAgentId: VmAgentId,
  status: VmAgentStatus,
  guestIp: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type UpdateVmAgentRuntimeInput = typeof UpdateVmAgentRuntimeInput.Type;

export const UpdateVmAgentControlModeInput = Schema.Struct({
  vmAgentId: VmAgentId,
  controlMode: VmControlMode,
  updatedAt: IsoDateTime,
});
export type UpdateVmAgentControlModeInput = typeof UpdateVmAgentControlModeInput.Type;

export interface VmAgentStoreShape {
  /** Insert a new agent row. The unique name/handle indexes reject duplicates. */
  readonly insert: (agent: VmAgent) => Effect.Effect<void, ProjectionRepositoryError>;

  /** All agents, ascending by creation time. */
  readonly list: () => Effect.Effect<ReadonlyArray<VmAgent>, ProjectionRepositoryError>;

  readonly getById: (
    vmAgentId: VmAgentId,
  ) => Effect.Effect<Option.Option<VmAgent>, ProjectionRepositoryError>;

  /** Resolve a mention handle to an agent (used by `@handle` routing). */
  readonly getByHandle: (
    handle: string,
  ) => Effect.Effect<Option.Option<VmAgent>, ProjectionRepositoryError>;

  /** Case-insensitive name lookup for conflict detection. */
  readonly getByNameLower: (
    nameLower: string,
  ) => Effect.Effect<Option.Option<VmAgent>, ProjectionRepositoryError>;

  /** Resolve an agent by its dedicated chat thread (used to inject VM-agent identity). */
  readonly getByThreadId: (
    threadId: string,
  ) => Effect.Effect<Option.Option<VmAgent>, ProjectionRepositoryError>;

  readonly updateRuntime: (
    input: UpdateVmAgentRuntimeInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly updateControlMode: (
    input: UpdateVmAgentControlModeInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly deleteById: (vmAgentId: VmAgentId) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class VmAgentStore extends Context.Service<VmAgentStore, VmAgentStoreShape>()(
  "t3/persistence/Services/VmAgents/VmAgentStore",
) {}
