/**
 * PreviewSessionStore - persistence for collaborative-browser tabs.
 *
 * The PreviewManager owns live session state in memory; this store is its
 * durability: every open tab has a row, rehydrated at boot so tabs (and the
 * pages they were on) survive a server or app restart.
 *
 * @module PreviewSessionStore
 */
import { PreviewSessionSnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const PersistedPreviewSession = Schema.Struct({
  threadId: Schema.String,
  tabId: Schema.String,
  snapshot: PreviewSessionSnapshot,
  updatedAt: Schema.String,
});
export type PersistedPreviewSession = typeof PersistedPreviewSession.Type;

export interface PreviewSessionStoreShape {
  /** Insert or refresh the row for `(threadId, tabId)`. */
  readonly upsert: (
    session: PersistedPreviewSession,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly deleteSession: (input: {
    readonly threadId: string;
    readonly tabId: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * All persisted tabs, oldest update first. Rows whose snapshot no longer
   * decodes against the current contract are dropped (and deleted) rather
   * than surfaced.
   */
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<PersistedPreviewSession>,
    ProjectionRepositoryError
  >;
}

export class PreviewSessionStore extends Context.Service<
  PreviewSessionStore,
  PreviewSessionStoreShape
>()("t3/persistence/Services/PreviewSessions/PreviewSessionStore") {}
