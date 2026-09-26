import {
  type ClientOrchestrationCommand,
  type VmAgentBlockerResolveInput,
  CommandId,
  type EnvironmentId,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  type OrchestrationThreadDetailSnapshot,
  type ServerConfig,
  type ThreadId,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ConnectionRegistration } from "../connection/catalog.ts";
import type { ConnectionTarget } from "../connection/model.ts";

export type DeferredThreadCommand = Extract<
  ClientOrchestrationCommand,
  {
    readonly type:
      | "thread.delete"
      | "thread.archive"
      | "thread.unarchive"
      | "thread.settle"
      | "thread.unsettle"
      | "thread.turn.start";
  }
>;

export interface DeferredThreadCommandEntry {
  readonly command: DeferredThreadCommand;
  readonly enqueuedAt: string;
  readonly thread?: OrchestrationThreadShell;
  readonly before?: readonly ClientOrchestrationCommand[];
  readonly error?: string;
  readonly accepted?: boolean;
  readonly afterReply?: typeof VmAgentBlockerResolveInput.Type;
}

export class ConnectionPersistenceError extends Schema.TaggedErrorClass<ConnectionPersistenceError>()(
  "ConnectionPersistenceError",
  {
    operation: Schema.Literals([
      "list-targets",
      "register-connection",
      "remove-connection",
      "load-shell",
      "save-shell",
      "load-thread",
      "save-thread",
      "remove-thread",
      "load-server-config",
      "save-server-config",
      "load-vcs-refs",
      "save-vcs-refs",
      "remove-vcs-refs",
      "clear-vcs-refs",
      "load-deferred-thread-commands",
      "save-deferred-thread-command",
      "remove-deferred-thread-command",
      "clear-deferred-thread-commands",
      "clear-environment",
    ]),
    message: Schema.String,
  },
) {}

export class ConnectionTargetStore extends Context.Service<
  ConnectionTargetStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<ConnectionTarget>, ConnectionPersistenceError>;
  }
>()("@t3tools/client-runtime/platform/persistence/ConnectionTargetStore") {}

export class ConnectionRegistrationStore extends Context.Service<
  ConnectionRegistrationStore,
  {
    readonly register: (
      registration: ConnectionRegistration,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly remove: (target: ConnectionTarget) => Effect.Effect<void, ConnectionPersistenceError>;
  }
>()("@t3tools/client-runtime/platform/persistence/ConnectionRegistrationStore") {}

export class EnvironmentCacheStore extends Context.Service<
  EnvironmentCacheStore,
  {
    readonly loadShell: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<OrchestrationShellSnapshot>, ConnectionPersistenceError>;
    readonly saveShell: (
      environmentId: EnvironmentId,
      snapshot: OrchestrationShellSnapshot,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly loadThread: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<
      Option.Option<OrchestrationThreadDetailSnapshot>,
      ConnectionPersistenceError
    >;
    readonly saveThread: (
      environmentId: EnvironmentId,
      snapshot: OrchestrationThreadDetailSnapshot,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly removeThread: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    /**
     * The last complete server configuration. This deliberately includes provider
     * metadata so offline task creation can still offer the models a user last saw.
     */
    readonly loadServerConfig: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<ServerConfig>, ConnectionPersistenceError>;
    readonly saveServerConfig: (
      environmentId: EnvironmentId,
      config: ServerConfig,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    /**
     * The unfiltered branch list for a workspace. Query-specific lists are not
     * cached because they are incomplete and unsafe to present as a full picker.
     */
    readonly loadVcsRefs: (
      environmentId: EnvironmentId,
      cwd: string,
    ) => Effect.Effect<Option.Option<VcsListRefsResult>, ConnectionPersistenceError>;
    readonly saveVcsRefs: (
      environmentId: EnvironmentId,
      cwd: string,
      refs: VcsListRefsResult,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly removeVcsRefs: (
      environmentId: EnvironmentId,
      cwd: string,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    /**
     * Removes every persisted branch-list snapshot for an environment. Git ref
     * mutations are repository-wide, and linked worktrees may have cached the
     * same refs under different working-directory keys.
     */
    readonly clearVcsRefs: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly clear: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
  }
>()("@t3tools/client-runtime/platform/persistence/EnvironmentCacheStore") {}

/**
 * Durable client-side messages and reversible thread lifecycle commands.
 *
 * Archive/unarchive and settle/unsettle each form a last-write-wins axis for
 * one thread. Implementations compact an axis when enqueueing so an offline
 * user can reverse their choice without replaying contradictory commands when
 * the environment reconnects. Messages retain their original command IDs and
 * payloads independently of those lifecycle axes until server acknowledgment.
 */
export class DeferredThreadCommandStore extends Context.Service<
  DeferredThreadCommandStore,
  {
    readonly list: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<ReadonlyArray<DeferredThreadCommandEntry>, ConnectionPersistenceError>;
    readonly enqueue: (
      environmentId: EnvironmentId,
      entry: DeferredThreadCommandEntry,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly remove: (
      environmentId: EnvironmentId,
      commandId: CommandId,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly clear: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
  }
>()("@t3tools/client-runtime/platform/persistence/DeferredThreadCommandStore") {}

export class EnvironmentOwnedDataCleanup extends Context.Reference<{
  readonly clear: (environmentId: EnvironmentId) => Effect.Effect<void>;
}>("@t3tools/client-runtime/platform/persistence/EnvironmentOwnedDataCleanup", {
  defaultValue: () => ({
    clear: () => Effect.void,
  }),
}) {}
