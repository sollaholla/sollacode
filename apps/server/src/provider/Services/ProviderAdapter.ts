/**
 * ProviderAdapter - Provider-specific runtime adapter contract.
 *
 * Defines the provider-native session/protocol operations that `ProviderService`
 * routes to after resolving the target provider. Implementations should focus
 * on provider behavior only and avoid cross-provider orchestration concerns.
 *
 * @module ProviderAdapter
 */
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderUserInputAnswers,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ModelSelection,
  MessageId,
  RuntimeMode,
  RuntimeTaskId,
  ThreadId,
  ProviderTurnStartResult,
  TurnId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export type ProviderSessionModelSwitchMode = "in-session" | "unsupported";

/**
 * Whether the adapter can accept input into an already-running turn.
 *
 * "native" (the default) joins the running turn, so a message typed mid-turn
 * reaches the model straight away. "unsupported" means the message cannot
 * reach it until the turn ends; the orchestrator then stops the running turn
 * so the parked message is delivered as the next turn promptly instead of
 * waiting behind a long one. Deep Code's one-shot `--exec` is the motivating
 * case.
 */
export type ProviderLiveSteeringMode = "native" | "unsupported";

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether changing the model on an existing session is supported.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;

  /**
   * Declares whether a mid-turn message can join the running turn. Defaults to
   * "native" when omitted.
   */
  readonly liveSteering?: ProviderLiveSteeringMode;

  /**
   * Whether one background task or sub-agent can be stopped by id without
   * cancelling the whole turn.
   *
   * An adapter that emits `task.started` MUST declare this `true`. The
   * orchestrator reads the pair as an ownership test: a stop aimed at a session
   * that cannot stop tasks is treated as a stop aimed at a row that session
   * never started -- a leftover from a provider switch -- and the row is
   * settled rather than left claiming to run. An adapter that announced tasks
   * without a kill would make that inference wrong, and the panel would report
   * live work as stopped.
   */
  readonly taskStop?: boolean;

  /** Whether the provider can destructively roll back persisted turns. */
  readonly threadRollback?: boolean;

  /** Whether the provider can materialize an independent conversation fork. */
  readonly threadFork?: boolean;

  /** Whether this instance may be selected for auxiliary text generation. */
  readonly textGeneration?: boolean;

  /**
   * Whether a successful send is followed by an exact durable
   * `message.delivered` runtime receipt.
   */
  readonly messageDeliveryReceipts?: boolean;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}

export interface ProviderSessionForkInput {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly sourceResumeCursor: unknown;
  readonly providerInstanceId: ProviderInstanceId;
  readonly runtimeMode: RuntimeMode;
  readonly cwd?: string;
  readonly modelSelection?: ModelSelection;
}

export interface ProviderAdapterSendTurnOptions {
  /** Runs after the adapter enters its provider-native prompt or steer call. */
  readonly onNativeDispatch?: Effect.Effect<void>;
}

export interface ProviderAdapterShape<TError> {
  /**
   * Provider kind implemented by this adapter.
   */
  readonly provider: ProviderDriverKind;
  readonly capabilities: ProviderAdapterCapabilities;

  /**
   * Start a provider-backed session.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  /**
   * Materialize a provider-native conversation fork without starting an
   * agent loop. Adapters that cannot fork independently may omit this and the
   * provider service will materialize the fork by starting a target session.
   */
  readonly forkSession?: (
    input: ProviderSessionForkInput,
  ) => Effect.Effect<ProviderSession, TError>;

  /**
   * Send a turn to an active provider session.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
    options?: ProviderAdapterSendTurnOptions,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /**
   * Interrupt an active turn.
   */
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;

  /** Promote every provider-native queued follow-up without cancelling background work. */
  readonly promoteQueuedTurn?: (
    threadId: ThreadId,
    messageIds?: ReadonlyArray<MessageId>,
  ) => Effect.Effect<ReadonlyArray<MessageId>, TError>;

  /**
   * Stop one background task or sub-agent by id, leaving the turn running.
   *
   * Optional: adapters whose runtime exposes no per-task kill omit it and
   * declare `taskStop: false`.
   */
  readonly stopTask?: (threadId: ThreadId, taskId: RuntimeTaskId) => Effect.Effect<void, TError>;

  /**
   * Respond to an interactive approval request.
   */
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to a structured user-input request.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  /**
   * Stop one provider session.
   */
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * List currently active provider sessions for this adapter.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /** Restore durable assistant messages without opening or resuming a provider session. */
  readonly replayStoredTranscript?: (input: {
    readonly threadId: ThreadId;
    readonly sessionId: string;
  }) => Effect.Effect<number, TError>;

  /**
   * Compact the provider's own session history in place so the next request
   * fits the model's context window again, keeping the session and its
   * working memory. Resolves true when the provider confirmed the compaction;
   * false when it declined. Adapters without a native compaction leave this
   * undefined and the caller falls back to a fresh session with a digest.
   */
  readonly compactSessionHistory?: (threadId: ThreadId) => Effect.Effect<boolean, TError>;

  /**
   * Roll back a provider thread by N turns.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
