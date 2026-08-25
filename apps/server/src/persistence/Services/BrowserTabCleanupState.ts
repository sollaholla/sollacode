import { IsoDateTime, NonNegativeInt, ThreadId, TurnId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const BrowserTabCleanupState = Schema.Struct({
  threadId: ThreadId,
  tabIds: Schema.Array(Schema.String),
  lastProcessedTurnId: Schema.NullOr(TurnId),
  lastProcessedStartSequence: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type BrowserTabCleanupState = typeof BrowserTabCleanupState.Type;

export const BrowserTabCleanupTurnReceipt = Schema.Struct({
  startSequence: NonNegativeInt,
  threadId: ThreadId,
  turnId: TurnId,
  createdAt: IsoDateTime,
  processedAt: Schema.NullOr(IsoDateTime),
});
export type BrowserTabCleanupTurnReceipt = typeof BrowserTabCleanupTurnReceipt.Type;

export interface RegisterBrowserTabCleanupTurnInput {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly tabIds: ReadonlyArray<string>;
  readonly createdAt: string;
}

export interface PrepareBrowserTabCleanupCompletionInput {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly currentTabIds: ReadonlyArray<string>;
  readonly observedAt: string;
}

export type BrowserTabCleanupCompletionPreparation =
  | { readonly _tag: "Ready"; readonly baseline: BrowserTabCleanupState }
  | { readonly _tag: "Seeded" }
  | { readonly _tag: "AlreadyProcessed" }
  | { readonly _tag: "Stale" };

export interface CommitBrowserTabCleanupCompletionInput {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  /** The tab set observed when the reminder decision was made. */
  readonly tabIds: ReadonlyArray<string>;
  readonly processedAt: string;
}

export interface BrowserTabCleanupStateStoreShape {
  readonly getByThreadId: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<BrowserTabCleanupState>, ProjectionRepositoryError>;
  /** Records accepted turn order and establishes the first known tab baseline atomically. */
  readonly registerTurn: (
    input: RegisterBrowserTabCleanupTurnInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /**
   * Inspects a completion before reminder planning.
   *
   * Missing receipts seed state without prompting. Processed and older receipts
   * are durably suppressed. A Ready receipt stays unprocessed so a failed
   * follow-up dispatch can be retried with its deterministic command id.
   */
  readonly prepareCompletion: (
    input: PrepareBrowserTabCleanupCompletionInput,
  ) => Effect.Effect<BrowserTabCleanupCompletionPreparation, ProjectionRepositoryError>;
  /** Atomically advances the baseline and marks its receipt after dispatch succeeds. */
  readonly commitCompletion: (
    input: CommitBrowserTabCleanupCompletionInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class BrowserTabCleanupStateStore extends Context.Service<
  BrowserTabCleanupStateStore,
  BrowserTabCleanupStateStoreShape
>()("t3/persistence/Services/BrowserTabCleanupState/BrowserTabCleanupStateStore") {}
