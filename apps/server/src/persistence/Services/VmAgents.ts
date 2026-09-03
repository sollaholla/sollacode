/**
 * VmAgentStore - persistence for the Agent Stack registry.
 *
 * Owns the `vm_agents` table: one row per named autonomous agent. Deliberately
 * separate from thread projections — agents are their own feature. Mention
 * routing resolves `@handle` through {@link getByHandle}.
 *
 * @module VmAgentStore
 */
import { VmAgent, VmAgentId, type VmAgentIcon, type VmAgentStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../Errors.ts";

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

  /** Resolve an agent by its dedicated chat thread (used to inject agent identity). */
  readonly getByThreadId: (
    threadId: string,
  ) => Effect.Effect<Option.Option<VmAgent>, ProjectionRepositoryError>;

  readonly deleteById: (vmAgentId: VmAgentId) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Set (or clear) the agent's outlined glyph and bump `updated_at`. */
  readonly updateIcon: (input: {
    readonly vmAgentId: VmAgentId;
    readonly icon: VmAgentIcon | null;
    readonly updatedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Switch the agent's lifecycle status (start/stop) and bump `updated_at`. */
  readonly updateStatus: (input: {
    readonly vmAgentId: VmAgentId;
    readonly status: VmAgentStatus;
    readonly updatedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class VmAgentStore extends Context.Service<VmAgentStore, VmAgentStoreShape>()(
  "t3/persistence/Services/VmAgents/VmAgentStore",
) {}
