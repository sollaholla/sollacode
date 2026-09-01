/**
 * ProviderService - Service interface for provider sessions, turns, and checkpoints.
 *
 * Acts as the cross-provider facade used by transports (WebSocket/RPC). It
 * resolves provider adapters through `ProviderAdapterRegistry`, routes
 * session-scoped calls via `ProviderSessionDirectory`, and exposes one unified
 * provider event stream to callers.
 *
 * Uses Effect `Context.Service` for dependency injection and returns typed
 * domain errors for validation, session, codex, and checkpoint workflows.
 *
 * @module ProviderService
 */
import type {
  ProviderInterruptTurnInput,
  MessageId,
  ProviderPromoteQueuedTurnInput,
  ProviderStopTaskInput,
  ProviderInstanceId,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ThreadId,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { ProviderAdapterError, ProviderServiceError } from "../Errors.ts";
import type { ProviderAdapterCapabilities } from "./ProviderAdapter.ts";
import type { ProviderInstanceRoutingInfo } from "./ProviderAdapterRegistry.ts";

export interface ProviderSessionStartOptions {
  /**
   * Adopt a session that now matches the requested configuration instead of
   * restarting it. The command reactor uses this after its own preflight: any
   * matching session here was created by lifecycle work that won the race.
   */
  readonly reuseMatchingSession?: boolean;
}

export interface ProviderServiceNativeDispatchRoute {
  readonly providerInstanceId: ProviderInstanceId;
  readonly sessionGeneration: string | null;
  readonly messageDeliveryReceipts: boolean;
}

export interface ProviderServiceSendTurnOptions {
  /**
   * Runs after routing and live-target gates succeed, immediately before each
   * provider-native send attempt (including a definitely-undispatched
   * SessionNotFound recovery retry).
   */
  readonly beforeNativeDispatch?: Effect.Effect<void, ProviderAdapterError>;
  /**
   * Captures the exact persisted route that passed ProviderService's final
   * lifecycle check for this native attempt. Synthetic supervisors use this
   * to select the acceptance proof required by the adapter that actually
   * received the prompt, rather than a stale obligation owner.
   */
  readonly onNativeDispatchRoute?: (route: ProviderServiceNativeDispatchRoute) => void;
  /**
   * Runs once the prompt has entered the provider-native transport — for a
   * live steer or a fresh turn. Adapters whose `sendTurn` resolves only when
   * the turn ends (ACP) report admission here; others may never call it, in
   * which case `sendTurn` resolving is the admission boundary.
   */
  readonly onNativeDispatch?: Effect.Effect<void>;
}

/**
 * ProviderServiceShape - Service API for provider session and turn orchestration.
 */
export interface ProviderServiceShape {
  /**
   * Start a provider session.
   */
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
    options?: ProviderSessionStartOptions,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

  /**
   * Send a provider turn.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
    options?: ProviderServiceSendTurnOptions,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  /**
   * Interrupt a running provider turn.
   */
  readonly interruptTurn: (
    input: ProviderInterruptTurnInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /** Promote a provider-native queued follow-up without cancelling its background work. */
  readonly promoteQueuedTurn: (
    input: ProviderPromoteQueuedTurnInput,
  ) => Effect.Effect<ReadonlyArray<MessageId>, ProviderServiceError>;

  /**
   * Stop one background task or sub-agent by id without cancelling the turn.
   *
   * Fails with an unsupported-operation error on adapters that declare
   * `taskStop: false`, so the caller can report honestly rather than
   * pretending the kill landed.
   */
  readonly stopTask: (input: ProviderStopTaskInput) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider approval request.
   */
  readonly respondToRequest: (
    input: ProviderRespondToRequestInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider structured user-input request.
   */
  readonly respondToUserInput: (
    input: ProviderRespondToUserInputInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop a provider session.
   */
  readonly stopSession: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * List active provider sessions.
   *
   * Aggregates runtime session lists from all registered adapters.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Read capabilities for the adapter bound to a configured provider instance.
   */
  readonly getCapabilities: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>;

  readonly getInstanceInfo: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstanceRoutingInfo, ProviderServiceError>;

  /**
   * Roll back provider conversation state by a number of turns.
   */
  readonly rollbackConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Persist an independent provider-native continuation for a forked thread.
   * Optional for test and third-party service implementations predating
   * conversation forking.
   */
  readonly forkSessionBinding?: (input: {
    readonly sourceThreadId: ThreadId;
    readonly targetThreadId: ThreadId;
    readonly runtimeMode: ProviderSession["runtimeMode"];
  }) => Effect.Effect<ProviderSession | null, ProviderServiceError>;

  /**
   * Canonical provider runtime event stream.
   *
   * Fan-out is owned by ProviderService (not by a standalone event-bus service).
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

/**
 * ProviderService - Service tag for provider orchestration.
 */
export class ProviderService extends Context.Service<ProviderService, ProviderServiceShape>()(
  "t3/provider/Services/ProviderService",
) {}
