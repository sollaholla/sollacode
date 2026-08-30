// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ModelSelection,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSendTurnInput,
  RuntimeTaskId,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { AGENT_CONTINUE_PROMPT } from "@t3tools/shared/agentMode";
import { RESUME_PROMPT } from "@t3tools/shared/resumePrompt";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { TextGenerationError } from "@t3tools/contracts";
import { ProviderAdapterProcessError, ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { CLAUDE_CODE_NOT_INSTALLED_MESSAGE } from "../../provider/providerFailureMessage.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ThreadWorkObligationRepositoryLive } from "../../persistence/Layers/ThreadWorkObligations.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import {
  ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON,
  ThreadWorkObligationRepository,
} from "../../persistence/Services/ThreadWorkObligations.ts";
import { RuntimeLeaseRegistryLive } from "../../provider/Layers/RuntimeLeaseRegistry.ts";
import { ThreadSubscriptionRegistryLive } from "./ThreadSubscriptionRegistry.ts";
import {
  ProviderService,
  type ProviderServiceSendTurnOptions,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import { TextGeneration, type TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import {
  classifyAuthenticationResumeDispatch,
  providerErrorLabel,
  providerErrorLabelFromInstanceHint,
  classifyTurnStartRecovery,
  countContinuationsSinceUserIntent,
  isDirectUserSteerCandidate,
  makeProviderCommandReactorLive,
  providerTurnProducedOutput,
} from "./ProviderCommandReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadWorkScheduler } from "../Services/ThreadWorkScheduler.ts";
import { makeThreadWorkSchedulerLive } from "./ThreadWorkScheduler.ts";
import {
  activeTurnWorkSourceId,
  BLOCKER_RESOLUTION_MESSAGE_ID_PREFIX,
  agentAutoResumeIds,
  startupAutoResumeIds,
  threadWorkObligationId,
} from "../agentModeContinuation.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ActionApprovalBroker from "../../mcp/toolkits/actionApproval/ActionApprovalBroker.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asApprovalRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };

  return poll();
}

describe("ProviderCommandReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | ProviderCommandReactor
    | ProjectionSnapshotQuery
    | ProjectionTurnRepository
    | ThreadWorkScheduler
    | ThreadWorkObligationRepository
    | ActionApprovalBroker.ActionApprovalBroker,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const createdStateDirs = new Set<string>();
  const createdBaseDirs = new Set<string>();

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const stateDir of createdStateDirs) {
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
    for (const baseDir of createdBaseDirs) {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
    createdBaseDirs.clear();
  });

  // An upstream request that times out ends the provider turn "successfully"
  // with an empty body — no message, no activity, nothing. Accepting that as a
  // finished resume retires the obligation, and the one-resume-per-source-turn
  // key then blocks every further attempt, so the thread sits dead wearing a
  // resume badge it never earned. Observed in production 2026-08-05 on the "3D
  // Modeling Trial" thread: the resume fired, ran 5m8s, emitted zero messages
  // and zero activities, and the thread stayed dead until morning. The healthy
  // resume on the sibling thread emitted 7 messages and 34 activities, so
  // "produced nothing at all" is an unambiguous discriminator.
  // Observed twice in production 2026-08-05: an auto-resume was enqueued,
  // dispatched, and then cancelled ~1.5s later as "turn-start was superseded"
  // with nothing whatsoever after it — `hasLaterRealUserTurn` was 0. The
  // handler reads the thread and the turn-start context separately, the
  // dispatch landed between the two reads, and the missing message was scored
  // as supersession. Since the projector declines to enqueue when a row for
  // that key exists, killing the row left nothing to drive the resume.
  describe("classifyTurnStartRecovery", () => {
    const userMessage = { role: "user", inputOrigin: null };
    const messageId = "message-1";

    it("waits rather than giving up when the source message has not projected yet", () => {
      expect(
        classifyTurnStartRecovery({
          sourceMessage: undefined,
          messageId,
          hasLaterRealUserTurn: false,
        }),
      ).toBe("awaiting-projection");
    });

    // Even with a later user turn, absence still means "not projected yet":
    // we cannot judge a message we cannot see, and the retry re-reads.
    it("does not score an unseen message as superseded", () => {
      expect(
        classifyTurnStartRecovery({
          sourceMessage: undefined,
          messageId,
          hasLaterRealUserTurn: true,
        }),
      ).toBe("awaiting-projection");
    });

    it("proceeds for a real user send with nothing behind it", () => {
      expect(
        classifyTurnStartRecovery({
          sourceMessage: userMessage,
          messageId,
          hasLaterRealUserTurn: false,
        }),
      ).toBe("proceed");
    });

    it("keeps an older real user send when a later one is queued", () => {
      expect(
        classifyTurnStartRecovery({
          sourceMessage: userMessage,
          messageId,
          hasLaterRealUserTurn: true,
        }),
      ).toBe("proceed");
    });

    it("drops a synthetic startup resume when newer user intent exists", () => {
      expect(
        classifyTurnStartRecovery({
          sourceMessage: userMessage,
          messageId: "startup-auto-resume-message:thread-1:turn-1",
          hasLaterRealUserTurn: true,
        }),
      ).toBe("superseded");
      expect(
        classifyTurnStartRecovery({
          sourceMessage: userMessage,
          messageId: "startup-auto-resume-message:thread-1:turn-1",
          hasLaterRealUserTurn: false,
        }),
      ).toBe("proceed");
    });

    it("gives up when the message is not a real user send", () => {
      expect(
        classifyTurnStartRecovery({
          sourceMessage: { role: "assistant", inputOrigin: null },
          messageId,
          hasLaterRealUserTurn: false,
        }),
      ).toBe("superseded");
      expect(
        classifyTurnStartRecovery({
          sourceMessage: { role: "user", inputOrigin: "agent-loop" },
          messageId: "agent-auto-resume-message:thread-1:turn-1",
          hasLaterRealUserTurn: false,
        }),
      ).toBe("superseded");
    });

    // The regression that shipped as "Queued for Codex" forever: scheduled
    // VM-agent task prompts carry inputOrigin "agent-loop" too, but their
    // turn-start obligation is the only thing that ever launches them.
    // Judging by origin instead of the auto-resume message id cancelled the
    // obligation ~50ms after the scheduler requested the turn.
    it("proceeds for a scheduled task prompt despite its agent-loop origin", () => {
      expect(
        classifyTurnStartRecovery({
          sourceMessage: { role: "user", inputOrigin: "agent-loop" },
          messageId: "vm-task:run-1",
          hasLaterRealUserTurn: false,
        }),
      ).toBe("proceed");
    });
  });

  describe("classifyAuthenticationResumeDispatch", () => {
    const deliveryTurnId = asTurnId("turn-auth-delivery");

    it("keeps supervising an admitted recovery after a later blocker appears", () => {
      expect(
        classifyAuthenticationResumeDispatch({
          sessionStatus: "running",
          activeTurnId: deliveryTurnId,
          deliveryTurnId,
          preDispatchSuperseded: true,
        }),
      ).toBe("supervise");
    });

    it("fails closed before dispatch and for an unrelated or unidentified live turn", () => {
      expect(classifyAuthenticationResumeDispatch({ preDispatchSuperseded: true })).toBe("cancel");
      expect(
        classifyAuthenticationResumeDispatch({
          sessionStatus: "running",
          activeTurnId: asTurnId("turn-newer"),
          deliveryTurnId,
          preDispatchSuperseded: false,
        }),
      ).toBe("cancel");
      expect(
        classifyAuthenticationResumeDispatch({
          sessionStatus: "running",
          deliveryTurnId,
          preDispatchSuperseded: false,
        }),
      ).toBe("retry");
      expect(classifyAuthenticationResumeDispatch({ preDispatchSuperseded: false })).toBe(
        "dispatch",
      );
    });
  });

  describe("isDirectUserSteerCandidate", () => {
    const threadId = ThreadId.make("thread-1");

    it("accepts typed and transcribed user input", () => {
      expect(
        isDirectUserSteerCandidate({
          threadId,
          message: {
            id: asMessageId("typed-message"),
            role: "user",
          },
        }),
      ).toBe(true);
      expect(
        isDirectUserSteerCandidate({
          threadId,
          message: {
            id: asMessageId("transcribed-message"),
            role: "user",
            inputOrigin: "transcription",
          },
        }),
      ).toBe(true);
    });

    it("keeps agent-loop and startup-auto-resume prompts off the priority lane", () => {
      expect(
        isDirectUserSteerCandidate({
          threadId,
          message: {
            id: asMessageId("agent-auto-resume-message:thread-1:turn-1"),
            role: "user",
            inputOrigin: "agent-loop",
          },
        }),
      ).toBe(false);
      expect(
        isDirectUserSteerCandidate({
          threadId,
          message: {
            id: asMessageId("startup-auto-resume-message:thread-1:turn-1"),
            role: "user",
          },
        }),
      ).toBe(false);
    });
  });

  describe("countContinuationsSinceUserIntent", () => {
    const typed = (id: string) => ({ id, role: "user", inputOrigin: null });
    const resume = (id: string) => ({
      id: `agent-auto-resume-message:${id}`,
      role: "user",
      inputOrigin: "agent-loop",
    });
    const scheduled = (id: string) => ({
      id: `vm-task:${id}`,
      role: "user",
      inputOrigin: "agent-loop",
    });
    const browserCleanup = (id: string) => ({
      id: `browser-tab-cleanup-message:${id}`,
      role: "user",
      inputOrigin: "agent-loop",
    });
    const assistant = (id: string) => ({ id, role: "assistant", inputOrigin: null });

    it("counts resumes since the last typed message", () => {
      expect(
        countContinuationsSinceUserIntent([
          typed("m1"),
          assistant("a1"),
          resume("r1"),
          resume("r2"),
        ]),
      ).toBe(2);
    });

    it("resets on a typed message", () => {
      expect(countContinuationsSinceUserIntent([resume("r1"), typed("m1"), resume("r2")])).toBe(1);
    });

    // A purely scheduled agent thread never sees a typed message. Each run's
    // prompt is the user's schedule firing — fresh intent — so it must reset
    // the budget rather than accumulate toward it, or the cap eventually
    // shuts continuation off for good on exactly the threads that depend on it.
    it("treats a scheduled task prompt as user intent, not a continuation", () => {
      expect(
        countContinuationsSinceUserIntent([
          scheduled("run-1"),
          assistant("a1"),
          resume("r1"),
          scheduled("run-2"),
          assistant("a2"),
          resume("r2"),
          resume("r3"),
        ]),
      ).toBe(2);
    });

    it("does not charge browser housekeeping against the continuation budget", () => {
      expect(
        countContinuationsSinceUserIntent([
          typed("m1"),
          resume("r1"),
          browserCleanup("thread-1:turn-1"),
          assistant("cleanup-reply"),
          resume("r2"),
        ]),
      ).toBe(2);
    });
  });

  describe("providerTurnProducedOutput", () => {
    const threadWith = (input: {
      readonly messages?: ReadonlyArray<{
        readonly turnId: string;
        readonly role?: "user" | "assistant";
        readonly text?: string;
        readonly streaming?: boolean;
        readonly attachments?: ReadonlyArray<unknown>;
      }>;
      readonly activities?: ReadonlyArray<{
        readonly turnId: string | null;
        readonly kind?: string;
      }>;
    }) =>
      ({
        messages: (input.messages ?? []).map((message) => ({
          role: message.role ?? "assistant",
          text: message.text ?? "substantive reply",
          streaming: message.streaming ?? false,
          attachments: message.attachments ?? [],
          turnId: asTurnId(message.turnId),
        })),
        activities: (input.activities ?? []).map((activity) => ({
          kind: activity.kind ?? "tool.completed",
          turnId: activity.turnId === null ? null : asTurnId(activity.turnId),
        })),
      }) as unknown as Parameters<typeof providerTurnProducedOutput>[0];

    it("is false for a turn that emitted neither a message nor an activity", () => {
      expect(
        providerTurnProducedOutput(
          threadWith({
            messages: [{ turnId: "other-turn" }],
            activities: [{ turnId: "other-turn" }, { turnId: null }],
          }),
          asTurnId("empty-resume-turn"),
        ),
      ).toBe(false);
    });

    it("is true when the turn spoke", () => {
      expect(
        providerTurnProducedOutput(
          threadWith({ messages: [{ turnId: "resume-turn" }] }),
          asTurnId("resume-turn"),
        ),
      ).toBe(true);
    });

    // A resume that only ran tools and never wrote prose still resumed, so
    // activities alone must count — otherwise the retry would re-run real work.
    it("is true when the turn only ran tools", () => {
      expect(
        providerTurnProducedOutput(
          threadWith({ activities: [{ turnId: "resume-turn" }] }),
          asTurnId("resume-turn"),
        ),
      ).toBe(true);
    });

    it("is false for input, delivery receipts, telemetry, blank rows, and streaming placeholders", () => {
      expect(
        providerTurnProducedOutput(
          threadWith({
            messages: [
              { turnId: "resume-turn", role: "user", text: "resume" },
              { turnId: "resume-turn", role: "assistant", text: "   " },
              {
                turnId: "resume-turn",
                role: "assistant",
                text: "partial",
                streaming: true,
              },
            ],
            activities: [
              { turnId: "resume-turn", kind: "message.delivered" },
              { turnId: "resume-turn", kind: "provider.usage.updated" },
              { turnId: "resume-turn", kind: "context-window.updated" },
            ],
          }),
          asTurnId("resume-turn"),
        ),
      ).toBe(false);
    });

    it("is true for a settled assistant attachment without prose", () => {
      expect(
        providerTurnProducedOutput(
          threadWith({
            messages: [
              {
                turnId: "resume-turn",
                role: "assistant",
                text: "",
                attachments: [{}],
              },
            ],
          }),
          asTurnId("resume-turn"),
        ),
      ).toBe(true);
    });
  });

  describe("provider error attribution", () => {
    it("uses the current provider instance slug when current instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "codex_personal",
          modelSelectionInstanceId: "codex",
          sessionProvider: "codex",
        }),
      ).toBe("codex_personal");
    });

    it("uses the desired provider instance slug when desired instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "claude_openrouter",
        }),
      ).toBe("claude_openrouter");
    });

    it("uses the unknown driver kind when the resolved driver is not registered locally", () => {
      expect(providerErrorLabel("third_party_driver")).toBe("third_party_driver");
    });
  });

  async function createHarness(input?: {
    readonly baseDir?: string;
    readonly threadModelSelection?: ModelSelection;
    readonly sessionModelSwitch?: "unsupported" | "in-session";
    readonly startReactor?: boolean;
    readonly serializeSessionLifecycle?: boolean;
    readonly providerSilenceRestartMs?: number;
    readonly providerMidTurnSilenceRestartMs?: number;
    readonly staleSteerReconcileGraceMs?: number;
    readonly stopTaskEffect?: (input: {
      readonly threadId: ThreadId;
      readonly taskId: RuntimeTaskId;
    }) => Effect.Effect<void>;
    readonly interruptTurnEffect?: (input: { readonly threadId: ThreadId }) => Effect.Effect<void>;
    readonly promoteQueuedTurnEffect?: (input: {
      readonly threadId: ThreadId;
      readonly messageIds?: ReadonlyArray<MessageId>;
    }) => Effect.Effect<ReadonlyArray<MessageId>, ProviderAdapterRequestError>;
    readonly stopSessionEffect?: (input: { readonly threadId: ThreadId }) => Effect.Effect<void>;
    readonly startSessionEffect?: (
      session: ProviderSession,
      runtimeSessions: Array<ProviderSession>,
    ) => Effect.Effect<ProviderSession, ProviderAdapterRequestError | ProviderAdapterProcessError>;
    readonly getCapabilitiesEffect?: (instanceId: ProviderInstanceId) => Effect.Effect<{
      readonly sessionModelSwitch: "unsupported" | "in-session";
      readonly messageDeliveryReceipts?: boolean;
    }>;
    readonly nativeRouteCapabilitiesEffect?: (instanceId: ProviderInstanceId) => Effect.Effect<{
      readonly sessionModelSwitch: "unsupported" | "in-session";
      readonly messageDeliveryReceipts?: boolean;
    }>;
    readonly sendTurnEffect?: (
      input: unknown,
      runtimeSessions: Array<ProviderSession>,
      options?: ProviderServiceSendTurnOptions,
    ) => Effect.Effect<
      { readonly threadId: ThreadId; readonly turnId: TurnId },
      ProviderAdapterRequestError | ProviderAdapterProcessError
    >;
  }) {
    const now = "2026-01-01T00:00:00.000Z";
    const baseDir =
      input?.baseDir ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-reactor-"));
    createdBaseDirs.add(baseDir);
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdStateDirs.add(stateDir);
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    let nextSessionIndex = 1;
    const runtimeSessions: Array<ProviderSession> = [];
    const modelSelection = input?.threadModelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    };
    const startSessionEffect = input?.startSessionEffect;
    const serializeSessionLifecycle = input?.serializeSessionLifecycle === true;
    const sessionLifecycleSemaphore = Effect.runSync(Semaphore.make(1));
    const startSession = vi.fn(
      (_: unknown, input: unknown, options?: { readonly reuseMatchingSession?: boolean }) => {
        const sessionIndex = nextSessionIndex++;
        const resumeCursor =
          typeof input === "object" && input !== null && "resumeCursor" in input
            ? input.resumeCursor
            : undefined;
        const threadId =
          typeof input === "object" &&
          input !== null &&
          "threadId" in input &&
          typeof input.threadId === "string"
            ? ThreadId.make(input.threadId)
            : ThreadId.make(`thread-${sessionIndex}`);
        const inputModelSelection =
          typeof input === "object" && input !== null && "modelSelection" in input
            ? (input.modelSelection as ModelSelection | undefined)
            : undefined;
        const providerInstanceId =
          typeof input === "object" && input !== null && "providerInstanceId" in input
            ? (input.providerInstanceId as ProviderInstanceId | undefined)
            : inputModelSelection?.instanceId;
        const provider =
          typeof input === "object" &&
          input !== null &&
          "provider" in input &&
          typeof input.provider === "string"
            ? (input.provider as ProviderSession["provider"])
            : ProviderDriverKind.make(inputModelSelection?.instanceId ?? modelSelection.instanceId);
        const session: ProviderSession = {
          provider,
          ...(providerInstanceId ? { providerInstanceId } : {}),
          status: "ready" as const,
          runtimeMode:
            typeof input === "object" &&
            input !== null &&
            "runtimeMode" in input &&
            (input.runtimeMode === "approval-required" || input.runtimeMode === "full-access")
              ? input.runtimeMode
              : "full-access",
          ...(typeof input === "object" &&
          input !== null &&
          "cwd" in input &&
          typeof input.cwd === "string"
            ? { cwd: input.cwd }
            : {}),
          ...((inputModelSelection?.model ?? modelSelection.model)
            ? { model: inputModelSelection?.model ?? modelSelection.model }
            : {}),
          threadId,
          resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
          createdAt: now,
          updatedAt: now,
        };
        const start = Effect.suspend(() => {
          const matching =
            options?.reuseMatchingSession === true
              ? runtimeSessions.find(
                  (candidate) =>
                    candidate.threadId === session.threadId &&
                    candidate.providerInstanceId === session.providerInstanceId &&
                    candidate.provider === session.provider &&
                    candidate.runtimeMode === session.runtimeMode &&
                    candidate.cwd === session.cwd &&
                    candidate.model === session.model &&
                    candidate.status !== "closed" &&
                    candidate.status !== "error",
                )
              : undefined;
          if (matching !== undefined) return Effect.succeed(matching);
          return (startSessionEffect?.(session, runtimeSessions) ?? Effect.succeed(session)).pipe(
            Effect.tap((startedSession) =>
              Effect.sync(() => {
                runtimeSessions.push(startedSession);
              }),
            ),
          );
        });
        return serializeSessionLifecycle ? sessionLifecycleSemaphore.withPermit(start) : start;
      },
    );
    const sendTurn = vi.fn((rawInput: unknown, options?: ProviderServiceSendTurnOptions) => {
      const threadId =
        typeof rawInput === "object" &&
        rawInput !== null &&
        "threadId" in rawInput &&
        typeof rawInput.threadId === "string"
          ? ThreadId.make(rawInput.threadId)
          : ThreadId.make("thread-1");
      const admittedInstanceId =
        runtimeSessions.find((session) => session.threadId === threadId)?.providerInstanceId ??
        modelSelection.instanceId;
      const capabilities =
        input?.nativeRouteCapabilitiesEffect?.(admittedInstanceId) ??
        input?.getCapabilitiesEffect?.(admittedInstanceId) ??
        Effect.succeed({
          sessionModelSwitch: input?.sessionModelSwitch ?? ("in-session" as const),
        });
      return capabilities.pipe(
        Effect.tap((admittedCapabilities) =>
          Effect.sync(() =>
            options?.onNativeDispatchRoute?.({
              providerInstanceId: admittedInstanceId,
              sessionGeneration: null,
              messageDeliveryReceipts: admittedCapabilities.messageDeliveryReceipts === true,
            }),
          ),
        ),
        Effect.andThen(
          input?.sendTurnEffect?.(rawInput, runtimeSessions, options) ??
            Effect.succeed({
              threadId,
              turnId: asTurnId("turn-1"),
            }),
        ),
      );
    });
    const interruptTurn = vi.fn((rawInput: unknown) => {
      const interruptInput = rawInput as { readonly threadId: ThreadId };
      return input?.interruptTurnEffect?.(interruptInput) ?? Effect.void;
    });
    const promoteQueuedTurn = vi.fn((rawInput: unknown) => {
      const promoteInput = rawInput as {
        readonly threadId: ThreadId;
        readonly messageIds?: ReadonlyArray<MessageId>;
      };
      return (
        input?.promoteQueuedTurnEffect?.(promoteInput) ??
        Effect.succeed([asMessageId("queued-grok-message-1"), asMessageId("queued-grok-message-2")])
      );
    });
    const stopTask = vi.fn((rawInput: unknown) => {
      const stopInput = rawInput as {
        readonly threadId: ThreadId;
        readonly taskId: RuntimeTaskId;
      };
      return input?.stopTaskEffect?.(stopInput) ?? Effect.void;
    });
    const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
    const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
    const stopSession = vi.fn((rawInput: unknown) => {
      const threadId =
        typeof rawInput === "object" && rawInput !== null && "threadId" in rawInput
          ? (rawInput as { threadId?: ThreadId }).threadId
          : undefined;
      if (!threadId) return Effect.void;
      return (input?.stopSessionEffect?.({ threadId }) ?? Effect.void).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
            if (index >= 0) {
              runtimeSessions.splice(index, 1);
            }
          }),
        ),
      );
    });
    const forkSessionBinding = vi.fn<NonNullable<ProviderServiceShape["forkSessionBinding"]>>(
      (forkInput) =>
        Effect.succeed({
          threadId: forkInput.targetThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "closed",
          runtimeMode: forkInput.runtimeMode,
          resumeCursor: { opaque: `fork-${String(forkInput.targetThreadId)}` },
          createdAt: now,
          updatedAt: now,
        }),
    );
    const renameBranch = vi.fn((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "newBranch" in input &&
          typeof input.newBranch === "string"
            ? input.newBranch
            : "renamed-branch",
      }),
    );
    const refreshStatus = vi.fn((_: string) =>
      Effect.succeed({
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "renamed-branch",
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
    );
    const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "disabled in test harness",
        }),
      ),
    );
    const providerSnapshots: ReadonlyArray<ServerProvider> = [
      {
        instanceId: modelSelection.instanceId,
        driver: ProviderDriverKind.make(
          String(modelSelection.instanceId).startsWith("claude") ? "claudeAgent" : "codex",
        ),
        enabled: true,
        installed: true,
        version: "test",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: now,
        availability: "available",
        models: [],
        slashCommands: [],
        skills: [],
      },
    ];

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape["startSession"],
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      promoteQueuedTurn,
      stopTask: stopTask as ProviderServiceShape["stopTask"],
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      forkSessionBinding,
      listSessions: () => Effect.succeed(runtimeSessions),
      getCapabilities: (instanceId) =>
        input?.getCapabilitiesEffect?.(instanceId) ??
        Effect.succeed({
          sessionModelSwitch: input?.sessionModelSwitch ?? "in-session",
        }),
      getInstanceInfo: (instanceId) => {
        const raw = String(instanceId);
        const driverKind = ProviderDriverKind.make(
          raw.startsWith("claude") ? "claudeAgent" : raw.startsWith("codex") ? "codex" : raw,
        );
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey:
              driverKind === ProviderDriverKind.make("codex")
                ? "codex:home:/shared-codex"
                : `${driverKind}:instance:${instanceId}`,
          },
        });
      },
      rollbackConversation: () => unsupported(),
      get streamEvents() {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    };

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const threadWorkPersistenceLayer = ThreadWorkObligationRepositoryLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
    );
    const projectionTurnPersistenceLayer = ProjectionTurnRepositoryLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
    );
    const threadWorkSchedulerLayer = makeThreadWorkSchedulerLive({
      pollIntervalMs: 60_000,
      claimLeaseMs: 60_000,
      heartbeatIntervalMs: 30_000,
    }).pipe(
      Layer.provideMerge(threadWorkPersistenceLayer),
      Layer.provideMerge(RuntimeLeaseRegistryLive),
    );
    const providerCommandReactorLayer = makeProviderCommandReactorLive(
      input?.providerSilenceRestartMs === undefined &&
        input?.providerMidTurnSilenceRestartMs === undefined &&
        input?.staleSteerReconcileGraceMs === undefined
        ? undefined
        : {
            ...(input?.providerSilenceRestartMs === undefined
              ? {}
              : { providerSilenceRestartMs: input.providerSilenceRestartMs }),
            ...(input?.providerMidTurnSilenceRestartMs === undefined
              ? {}
              : { providerMidTurnSilenceRestartMs: input.providerMidTurnSilenceRestartMs }),
            ...(input?.staleSteerReconcileGraceMs === undefined
              ? {}
              : { staleSteerReconcileGraceMs: input.staleSteerReconcileGraceMs }),
          },
    ).pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(ActionApprovalBroker.layer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(makeProviderRegistryLayer(providerSnapshots)),
      Layer.provideMerge(threadWorkPersistenceLayer),
      Layer.provideMerge(threadWorkSchedulerLayer),
      Layer.provideMerge(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          renameBranch,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
      Layer.provideMerge(
        Layer.succeed(VcsStatusBroadcaster, {
          getStatus: () => Effect.die("getStatus should not be called in this test"),
          refreshLocalStatus: () =>
            Effect.die("refreshLocalStatus should not be called in this test"),
          refreshStatus,
          streamStatus: () => Stream.die("streamStatus should not be called in this test"),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(TextGeneration, {
          generateBranchName,
          generateThreadTitle,
        }),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    const layer = Layer.mergeAll(
      providerCommandReactorLayer,
      threadWorkSchedulerLayer,
      threadWorkPersistenceLayer,
      projectionTurnPersistenceLayer,
    ).pipe(Layer.provideMerge(ThreadSubscriptionRegistryLive));
    runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    const threadWorkObligations = await runtime.runPromise(
      Effect.service(ThreadWorkObligationRepository),
    );
    const projectionTurns = await runtime.runPromise(Effect.service(ProjectionTurnRepository));
    const threadWorkScheduler = await runtime.runPromise(Effect.service(ThreadWorkScheduler));
    const actionApprovalBroker = await runtime.runPromise(
      Effect.service(ActionApprovalBroker.ActionApprovalBroker),
    );
    scope = await Effect.runPromise(Scope.make("sequential"));
    let reactorStarted = false;
    const startReactor = async () => {
      if (reactorStarted) return;
      reactorStarted = true;
      await Effect.runPromise(reactor.start().pipe(Scope.provide(scope!)));
    };
    if (input?.startReactor !== false) {
      await startReactor();
    }
    const drain = () => Effect.runPromise(reactor.drain);

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: "/tmp/provider-project",
        defaultModelSelection: modelSelection,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    return {
      engine,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      startSession,
      sendTurn,
      interruptTurn,
      promoteQueuedTurn,
      stopTask,
      respondToRequest,
      respondToUserInput,
      stopSession,
      forkSessionBinding,
      renameBranch,
      refreshStatus,
      generateBranchName,
      generateThreadTitle,
      runtimeSessions,
      stateDir,
      drain,
      drainEffect: reactor.drain,
      startReactor,
      threadWorkObligations,
      projectionTurns,
      threadWorkScheduler,
      actionApprovalBroker,
    };
  }

  type RoutedReceiptWorkKind = "agent-continuation" | "authentication-resume";

  async function seedRoutedReceiptWork(
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: {
      readonly kind: RoutedReceiptWorkKind;
      readonly suffix: string;
      readonly obligationProviderInstanceId: ProviderInstanceId;
    },
  ) {
    const threadId = ThreadId.make(`thread-routed-receipt-${input.kind}-${input.suffix}`);
    const sourceTurnId = asTurnId(`turn-routed-receipt-${input.kind}-${input.suffix}`);
    const sourceMessageId = asMessageId(`user-routed-receipt-${input.kind}-${input.suffix}`);
    const assistantMessageId = asMessageId(
      `assistant-routed-receipt-${input.kind}-${input.suffix}`,
    );
    const authFailure = "Failed to authenticate: OAuth session expired and could not be refreshed";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`cmd-routed-receipt-create-${input.kind}-${input.suffix}`),
        threadId,
        projectId: asProjectId("project-1"),
        title: `Routed receipt ${input.kind}`,
        modelSelection: {
          instanceId: input.obligationProviderInstanceId,
          model: "test-model",
        },
        interactionMode: "agent",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`cmd-routed-receipt-turn-${input.kind}-${input.suffix}`),
        threadId,
        message: {
          messageId: sourceMessageId,
          role: "user",
          text: "Continue until this work is complete.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`cmd-routed-receipt-running-${input.kind}-${input.suffix}`),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: input.obligationProviderInstanceId,
          runtimeMode: "approval-required",
          activeTurnId: sourceTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make(`cmd-routed-receipt-delta-${input.kind}-${input.suffix}`),
        threadId,
        messageId: assistantMessageId,
        delta:
          input.kind === "authentication-resume"
            ? authFailure
            : "One phase is complete; more verified work remains.",
        turnId: sourceTurnId,
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make(`cmd-routed-receipt-complete-${input.kind}-${input.suffix}`),
        threadId,
        messageId: assistantMessageId,
        turnId: sourceTurnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`cmd-routed-receipt-terminal-${input.kind}-${input.suffix}`),
        threadId,
        session: {
          threadId,
          status: input.kind === "authentication-resume" ? "error" : "ready",
          providerName: "codex",
          providerInstanceId: input.obligationProviderInstanceId,
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: input.kind === "authentication-resume" ? authFailure : null,
          updatedAt: "2026-01-01T00:00:04.000Z",
        },
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );

    let obligation = Option.getOrUndefined(
      await Effect.runPromise(
        harness.threadWorkObligations.getByKey({
          threadId,
          sourceTurnId,
          kind: input.kind,
        }),
      ),
    );
    if (obligation === undefined) {
      await waitFor(async () =>
        Option.isSome(
          await Effect.runPromise(
            harness.threadWorkObligations.getByKey({
              threadId,
              sourceTurnId,
              kind: input.kind,
            }),
          ),
        ),
      );
      obligation = Option.getOrThrow(
        await Effect.runPromise(
          harness.threadWorkObligations.getByKey({
            threadId,
            sourceTurnId,
            kind: input.kind,
          }),
        ),
      );
    }
    if (input.kind === "authentication-resume") {
      expect(obligation.state).toBe("blocked-authentication");
      expect(
        await Effect.runPromise(
          harness.threadWorkObligations.transition({
            obligationId: obligation.obligationId,
            expectedState: "blocked-authentication",
            expectedAttempt: obligation.attempt,
            state: "pending",
            nextAttemptAt: null,
            claimedAt: null,
            leaseExpiresAt: null,
            blockedReason: null,
            updatedAt: "2026-01-01T00:00:05.000Z",
          }),
        ),
      ).toBe(true);
    }

    return {
      threadId,
      sourceTurnId,
      deliveryMessageId:
        input.kind === "agent-continuation"
          ? agentAutoResumeIds({ threadId, completedTurnId: sourceTurnId }).messageId
          : MessageId.make(`provider-auth-resume-delivery:${threadId}:${sourceTurnId}`),
    };
  }

  it("reacts to thread.turn.start by ensuring session and sending provider turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-1"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.make("thread-1"));
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.status).toBe("starting");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("continues multiple Agent turns from the server without a mounted chat view", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-agent-1");
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-agent-mode"),
        threadId,
        interactionMode: "agent",
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-agent-first-turn"),
        threadId,
        message: {
          messageId: asMessageId("user-message-agent-first-turn"),
          role: "user",
          text: "Work autonomously.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await Effect.runPromise(
      harness.projectionTurns.deletePendingTurnStart({
        threadId,
        messageId: asMessageId("user-message-agent-first-turn"),
      }),
    );
    await Effect.runPromise(
      harness.projectionTurns.upsertByTurnId({
        threadId,
        turnId,
        pendingMessageId: asMessageId("user-message-agent-first-turn"),
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        assistantMessageId: null,
        state: "running",
        requestedAt: now,
        startedAt: "2026-01-01T00:00:01.000Z",
        completedAt: null,
        checkpointTurnCount: null,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-agent-next-model"),
        threadId,
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-agent-assistant-delta"),
        threadId,
        messageId: asMessageId("assistant-message-agent-1"),
        delta: "Finished one phase and continuing.",
        turnId,
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-agent-assistant-complete"),
        threadId,
        messageId: asMessageId("assistant-message-agent-1"),
        turnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:04.000Z",
        },
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );

    await waitFor(async () =>
      Option.isSome(
        await Effect.runPromise(
          harness.threadWorkObligations.getByKey({
            threadId,
            sourceTurnId: turnId,
            kind: "agent-continuation",
          }),
        ),
      ),
    );
    await waitFor(async () => {
      if (harness.sendTurn.mock.calls.length === 2) return true;
      const work = Option.getOrUndefined(
        await Effect.runPromise(
          harness.threadWorkObligations.getByKey({
            threadId,
            sourceTurnId: turnId,
            kind: "agent-continuation",
          }),
        ),
      );
      if (work?.state === "cancelled" || work?.state === "sleeping") {
        throw new Error(`Agent continuation became ${work.state}: ${work.blockedReason ?? ""}`);
      }
      return false;
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId,
      input: AGENT_CONTINUE_PROMPT,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
    });
    let readModel = await harness.readModel();
    let thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(thread?.messages.at(-1)).toMatchObject({
      role: "user",
      text: AGENT_CONTINUE_PROMPT,
      inputOrigin: "agent-loop",
    });

    const continuationTurnId = asTurnId("turn-agent-2");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-continuation-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: continuationTurnId,
          lastError: null,
          updatedAt: "2099-01-01T00:00:05.000Z",
        },
        createdAt: "2099-01-01T00:00:05.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-agent-continuation-assistant-delta"),
        threadId,
        messageId: asMessageId("assistant-message-agent-2"),
        delta: "The next autonomous phase is complete; more work remains.",
        turnId: continuationTurnId,
        createdAt: "2099-01-01T00:00:06.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-agent-continuation-assistant-complete"),
        threadId,
        messageId: asMessageId("assistant-message-agent-2"),
        turnId: continuationTurnId,
        createdAt: "2099-01-01T00:00:07.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-continuation-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2099-01-01T00:00:08.000Z",
        },
        createdAt: "2099-01-01T00:00:08.000Z",
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 3);
    expect(harness.sendTurn.mock.calls[2]?.[0]).toMatchObject({
      threadId,
      input: AGENT_CONTINUE_PROMPT,
    });
    readModel = await harness.readModel();
    thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(
      thread?.messages.filter(
        (message) => message.role === "user" && message.inputOrigin === "agent-loop",
      ),
    ).toHaveLength(2);
  });

  it("cancels persisted browser cleanup when its source turn signed off", async () => {
    const harness = await createHarness({ startReactor: false });
    const threadId = ThreadId.make("thread-1");
    const sourceTurnId = asTurnId("turn-browser-cleanup-source-stopped");
    const sourceMessageId = asMessageId("user-browser-cleanup-source-stopped");
    const assistantMessageId = asMessageId("assistant-browser-cleanup-source-stopped");
    const cleanupMessageId = asMessageId(`browser-tab-cleanup-message:${threadId}:${sourceTurnId}`);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-browser-cleanup-source-agent-mode"),
        threadId,
        interactionMode: "agent",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-browser-cleanup-source-turn"),
        threadId,
        message: {
          messageId: sourceMessageId,
          role: "user",
          text: "Complete the requested work and stop.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-browser-cleanup-source-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: sourceTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-browser-cleanup-source-assistant-delta"),
        threadId,
        messageId: assistantMessageId,
        delta: "Everything requested is complete.\n\nAGENT_STOP",
        turnId: sourceTurnId,
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-browser-cleanup-source-assistant-complete"),
        threadId,
        messageId: assistantMessageId,
        turnId: sourceTurnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-browser-cleanup-source-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:04.000Z",
        },
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );

    // Model the crash-window backstop directly: the cleanup turn was already
    // persisted before the stop marker won ingestion's planning race.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-browser-cleanup-persisted-before-stop"),
        threadId,
        message: {
          messageId: cleanupMessageId,
          role: "user",
          text: "Browser tab check: close tabs you no longer need.",
          inputOrigin: "agent-loop",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:05.000Z",
      }),
    );
    await harness.startReactor();

    const cleanupSourceTurnId = activeTurnWorkSourceId(cleanupMessageId);
    await waitFor(async () => {
      const cleanup = await Effect.runPromise(
        harness.threadWorkObligations
          .getByKey({
            threadId,
            sourceTurnId: cleanupSourceTurnId,
            kind: "active-turn-recovery",
          })
          .pipe(Effect.map(Option.getOrUndefined)),
      );
      return cleanup?.state === "cancelled";
    });

    const cleanup = await Effect.runPromise(
      harness.threadWorkObligations
        .getByKey({
          threadId,
          sourceTurnId: cleanupSourceTurnId,
          kind: "active-turn-recovery",
        })
        .pipe(Effect.map(Option.getOrUndefined)),
    );
    expect(cleanup?.blockedReason).toContain("signed off with Agent stop");
    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  /**
   * A thread whose newest assistant message ended the Agent loop, with one
   * message queued behind it that was never delivered. Signing off ends the
   * agent's own loop; it does not un-send work already waiting.
   */
  const signedOffThreadWithQueuedMessage = async (options: {
    readonly slug: string;
    readonly queuedMessageId: MessageId;
    readonly queuedText: string;
    readonly queuedInputOrigin?: "agent-loop" | undefined;
  }) => {
    const harness = await createHarness({ startReactor: false });
    const threadId = ThreadId.make("thread-1");
    const sourceTurnId = asTurnId(`turn-${options.slug}`);
    const sourceMessageId = asMessageId(`user-${options.slug}`);
    const assistantMessageId = asMessageId(`assistant-${options.slug}`);
    const session = (status: "running" | "ready", activeTurnId: TurnId | null) => ({
      threadId,
      status,
      providerName: "codex" as const,
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "approval-required" as const,
      activeTurnId,
      lastError: null,
      updatedAt: "2026-01-01T00:00:01.000Z",
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make(`cmd-${options.slug}-agent-mode`),
        threadId,
        interactionMode: "agent",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`cmd-${options.slug}-source-turn`),
        threadId,
        message: {
          messageId: sourceMessageId,
          role: "user",
          text: "Do the work and stop when you are blocked.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`cmd-${options.slug}-running`),
        threadId,
        session: session("running", sourceTurnId),
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make(`cmd-${options.slug}-assistant-delta`),
        threadId,
        messageId: assistantMessageId,
        delta: "Blocked on you, so I have stopped.\n\nAGENT_STOP",
        turnId: sourceTurnId,
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make(`cmd-${options.slug}-assistant-complete`),
        threadId,
        messageId: assistantMessageId,
        turnId: sourceTurnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`cmd-${options.slug}-ready`),
        threadId,
        session: session("ready", null),
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`cmd-${options.slug}-queued`),
        threadId,
        message: {
          messageId: options.queuedMessageId,
          role: "user",
          text: options.queuedText,
          ...(options.queuedInputOrigin === undefined
            ? {}
            : { inputOrigin: options.queuedInputOrigin }),
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:05.000Z",
      }),
    );
    await harness.startReactor();
    return { harness, threadId };
  };

  it("delivers a message sent while the agent was signing off", async () => {
    // Typed at 00:08:34 while the running turn signed off at 00:08:36: the
    // sign-off was newer than the message, so the gate cancelled the message's
    // own delivery and it sat queued forever (thread 66e462cc, 2026-08-29).
    const queuedMessageId = asMessageId("user-typed-during-signoff");
    const { harness, threadId } = await signedOffThreadWithQueuedMessage({
      slug: "typed-during-signoff",
      queuedMessageId,
      queuedText: "Also, all threads vanished on the Mac.",
    });

    const deliveryKey = {
      threadId,
      sourceTurnId: activeTurnWorkSourceId(queuedMessageId),
      kind: "active-turn-recovery" as const,
    };
    const readDelivery = () =>
      Effect.runPromise(
        harness.threadWorkObligations.getByKey(deliveryKey).pipe(Effect.map(Option.getOrUndefined)),
      );
    // A typed send is a direct steer candidate, so the provider call happens
    // off this obligation; what matters here is that the delivery settles
    // rather than being retired by the sign-off.
    await waitFor(async () => (await readDelivery())?.state === "completed");

    const delivery = await readDelivery();
    expect(delivery?.state).toBe("completed");
    expect(delivery?.blockedReason).toBeNull();
  });

  it("delivers a resolved blocker to the thread that stopped for it", async () => {
    // The blocker is why the agent signed off, so this notice always arrives
    // into a signed-off thread. Suppressing it stranded the work it unparks
    // (thread ce4c14c6, queued 20:58:57, cancelled 273ms later).
    const queuedMessageId = asMessageId(
      `${BLOCKER_RESOLUTION_MESSAGE_ID_PREFIX}0f0d2c5e-8f4a-4d9a-9f2c-3a1b6d7e8c90`,
    );
    const { harness, threadId } = await signedOffThreadWithQueuedMessage({
      slug: "blocker-resolved",
      queuedMessageId,
      queuedText: 'The user resolved the request "Sign in to VEERA Gmail".',
      queuedInputOrigin: "agent-loop",
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    const delivery = await Effect.runPromise(
      harness.threadWorkObligations
        .getByKey({
          threadId,
          sourceTurnId: activeTurnWorkSourceId(queuedMessageId),
          kind: "active-turn-recovery",
        })
        .pipe(Effect.map(Option.getOrUndefined)),
    );
    expect(delivery?.state).not.toBe("cancelled");
  });

  it("does not re-carry a steered predecessor that already has a delivery receipt", async () => {
    // A message steered into a running turn never starts its own provider
    // turn, so the carry-fold's providerTurnId probe reads it as stranded
    // forever. Observed 2026-08-30 on thread 66e462cc: the same steered
    // messages (screenshots included) were re-sent by every later turn for
    // the whole carry window. The durable message.delivered receipt is the
    // proof of consumption and must exclude it from the carry.
    const harness = await createHarness({
      startReactor: false,
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "test-model",
      },
    });
    const threadId = ThreadId.make("thread-1");
    const steeredMessageId = asMessageId("user-steered-delivered");
    const strandedMessageId = asMessageId("user-stranded");
    const queuedMessageId = asMessageId("user-final-queued");
    const startTurn = (messageId: MessageId, text: string, createdAt: string) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-carry-${messageId}`),
          threadId,
          message: { messageId, role: "user", text, attachments: [] },
          interactionMode: "default",
          runtimeMode: "approval-required",
          createdAt,
        }),
      );
    const readObligation = (messageId: MessageId) =>
      Effect.runPromise(
        harness.threadWorkObligations
          .getByKey({
            threadId,
            sourceTurnId: activeTurnWorkSourceId(messageId),
            kind: "active-turn-recovery",
          })
          .pipe(Effect.map(Option.getOrUndefined)),
      );
    const retire = async (messageId: MessageId, state: "completed" | "cancelled") => {
      const row = await readObligation(messageId);
      if (row === undefined) throw new Error(`no obligation for ${messageId}`);
      await Effect.runPromise(
        harness.threadWorkObligations.transition({
          obligationId: row.obligationId,
          expectedState: row.state,
          expectedAttempt: row.attempt,
          state,
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: null,
          updatedAt: "2026-01-01T00:00:03.000Z",
        }),
      );
    };

    // The steered message: consumed by the live turn, receipt persisted, its
    // steer pre-claimed the parked delivery as completed.
    await startTurn(steeredMessageId, "Steered and already answered.", "2026-01-01T00:00:00.000Z");
    await retire(steeredMessageId, "completed");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-carry-steered-receipt"),
        threadId,
        activity: {
          id: EventId.make("activity-carry-steered-receipt"),
          tone: "info",
          kind: "message.delivered",
          summary: "Message delivered to the provider",
          payload: { messageId: steeredMessageId },
          turnId: null,
          createdAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    // The stranded message: supersede-collapsed, no receipt — must be carried.
    await startTurn(strandedMessageId, "Stranded burst message.", "2026-01-01T00:00:02.000Z");
    await retire(strandedMessageId, "cancelled");
    // The winning delivery.
    await startTurn(queuedMessageId, "Latest message.", "2026-01-01T00:00:04.000Z");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-carry-session-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "claudeAgent",
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:04.000Z",
        },
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );
    await harness.startReactor();

    await waitFor(() => harness.sendTurn.mock.calls.length >= 1);
    const request = harness.sendTurn.mock.calls[0]?.[0] as { input: string };
    expect(request.input).toContain("Latest message.");
    expect(request.input).toContain("Stranded burst message.");
    expect(request.input).not.toContain("Steered and already answered.");
  });

  it("recovers an already-projected Agent continuation after a server restart", async () => {
    const harness = await createHarness({ startReactor: false });
    const threadId = ThreadId.make("thread-1");
    const sourceTurnId = asTurnId("turn-agent-restart-source");
    const continuationTurnId = asTurnId("turn-agent-restart-continuation");
    const sourceMessageId = asMessageId("user-message-agent-restart-source");
    const assistantMessageId = asMessageId("assistant-message-agent-restart-source");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-agent-restart-mode"),
        threadId,
        interactionMode: "agent",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-agent-restart-source"),
        threadId,
        message: {
          messageId: sourceMessageId,
          role: "user",
          text: "Keep working autonomously until every requirement is verified.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-restart-source-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: sourceTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-agent-restart-source-delta"),
        threadId,
        messageId: assistantMessageId,
        delta: "One phase is complete; the remaining acceptance checks still need work.",
        turnId: sourceTurnId,
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-agent-restart-source-complete"),
        threadId,
        messageId: assistantMessageId,
        turnId: sourceTurnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-restart-source-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:04.000Z",
        },
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );
    await waitFor(async () =>
      Option.isSome(
        await Effect.runPromise(
          harness.threadWorkObligations.getByKey({
            threadId,
            sourceTurnId,
            kind: "agent-continuation",
          }),
        ),
      ),
    );

    const continuationIds = agentAutoResumeIds({ threadId, completedTurnId: sourceTurnId });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: continuationIds.commandId,
        threadId,
        message: {
          messageId: continuationIds.messageId,
          role: "user",
          text: AGENT_CONTINUE_PROMPT,
          inputOrigin: "agent-loop",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:05.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-restart-continuation-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: continuationTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:06.000Z",
        },
        createdAt: "2026-01-01T00:00:06.000Z",
      }),
    );

    await harness.startReactor();
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId,
      messageId: MessageId.make(`agent-continuation-recovery-delivery:${threadId}:${sourceTurnId}`),
      input: AGENT_CONTINUE_PROMPT,
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(thread?.messages.filter((message) => message.inputOrigin === "agent-loop")).toHaveLength(
      1,
    );
  });

  it("redispatches an Agent continuation whose prior provider turn completed empty", async () => {
    const harness = await createHarness({ startReactor: false });
    const threadId = ThreadId.make("thread-1");
    const sourceTurnId = asTurnId("turn-agent-empty-source");
    const emptyContinuationTurnId = asTurnId("turn-agent-empty-continuation");
    const sourceMessageId = asMessageId("user-message-agent-empty-source");
    const assistantMessageId = asMessageId("assistant-message-agent-empty-source");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-agent-empty-mode"),
        threadId,
        interactionMode: "agent",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-agent-empty-source"),
        threadId,
        message: {
          messageId: sourceMessageId,
          role: "user",
          text: "Keep working until the remaining acceptance checks pass.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-empty-source-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: sourceTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-agent-empty-source-delta"),
        threadId,
        messageId: assistantMessageId,
        delta: "One phase is complete; more work remains.",
        turnId: sourceTurnId,
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-agent-empty-source-complete"),
        threadId,
        messageId: assistantMessageId,
        turnId: sourceTurnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-empty-source-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:04.000Z",
        },
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );

    const continuationIds = agentAutoResumeIds({ threadId, completedTurnId: sourceTurnId });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: continuationIds.commandId,
        threadId,
        message: {
          messageId: continuationIds.messageId,
          role: "user",
          text: AGENT_CONTINUE_PROMPT,
          inputOrigin: "agent-loop",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:05.000Z",
      }),
    );
    await Effect.runPromise(
      harness.projectionTurns.deletePendingTurnStart({
        threadId,
        messageId: continuationIds.messageId,
      }),
    );
    await Effect.runPromise(
      harness.projectionTurns.upsertByTurnId({
        threadId,
        turnId: emptyContinuationTurnId,
        pendingMessageId: continuationIds.messageId,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        assistantMessageId: null,
        state: "completed",
        requestedAt: "2026-01-01T00:00:05.000Z",
        startedAt: "2026-01-01T00:00:06.000Z",
        completedAt: "2026-01-01T00:00:07.000Z",
        checkpointTurnCount: null,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
      }),
    );

    await harness.startReactor();
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId,
      messageId: MessageId.make(`agent-continuation-recovery-delivery:${threadId}:${sourceTurnId}`),
      input: AGENT_CONTINUE_PROMPT,
    });

    const readObligation = () =>
      Effect.runPromise(
        harness.threadWorkObligations
          .getByKey({ threadId, sourceTurnId, kind: "agent-continuation" })
          .pipe(Effect.map(Option.getOrUndefined)),
      );
    await waitFor(async () => (await readObligation())?.state === "sleeping");
    expect((await readObligation())?.blockedReason).toBe("provider continuation is not running");
  });

  it("recovers a Default-mode active turn with the plain resume sentence", async () => {
    // Observed live 2026-08-14: a Default-mode chat whose turn died mid-flight
    // received the Agent-mode autonomous-continue wall (AGENT_STOP contract)
    // as a visible browser message. Crash recovery must keep nudging, but the
    // autonomy contract belongs to Agent mode only.
    const harness = await createHarness({ startReactor: false });
    const threadId = ThreadId.make("thread-1");
    const sourceTurnId = asTurnId("turn-default-recovery-source");
    const sourceMessageId = asMessageId("user-message-default-recovery");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-default-recovery-mode"),
        threadId,
        interactionMode: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-default-recovery-start"),
        threadId,
        message: {
          messageId: sourceMessageId,
          role: "user",
          text: "try again",
          attachments: [],
        },
        interactionMode: "default",
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-default-recovery-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: sourceTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );

    await harness.startReactor();
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId,
      messageId: MessageId.make(`active-turn-recovery-delivery:${threadId}:${sourceMessageId}`),
      input: RESUME_PROMPT,
    });
  });

  it("adopts a persisted active-turn recovery with output but retries one that completed empty", async () => {
    const harness = await createHarness({ startReactor: false });
    const scenarios = [
      { suffix: "output", producedOutput: true },
      { suffix: "empty", producedOutput: false },
    ] as const;

    for (const scenario of scenarios) {
      const threadId = ThreadId.make(`thread-active-recovery-${scenario.suffix}`);
      const sourceMessageId = asMessageId(`message-active-recovery-${scenario.suffix}`);
      const sourceTurnId = asTurnId(`turn-active-recovery-source-${scenario.suffix}`);
      const recoveryTurnId = asTurnId(`turn-active-recovery-delivery-${scenario.suffix}`);
      const recoveryMessageId = MessageId.make(
        `active-turn-recovery-delivery:${threadId}:${sourceMessageId}`,
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`cmd-active-recovery-thread-${scenario.suffix}`),
          threadId,
          projectId: asProjectId("project-1"),
          title: `Active recovery ${scenario.suffix}`,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-active-recovery-start-${scenario.suffix}`),
          threadId,
          message: {
            messageId: sourceMessageId,
            role: "user",
            text: "Continue the interrupted work.",
            attachments: [],
          },
          interactionMode: "default",
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
      );
      await Effect.runPromise(
        harness.projectionTurns.deletePendingTurnStart({ threadId, messageId: sourceMessageId }),
      );
      await Effect.runPromise(
        harness.projectionTurns.upsertByTurnId({
          threadId,
          turnId: sourceTurnId,
          pendingMessageId: sourceMessageId,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          assistantMessageId: null,
          state: "completed",
          requestedAt: "2026-01-01T00:00:01.000Z",
          startedAt: "2026-01-01T00:00:02.000Z",
          completedAt: "2026-01-01T00:00:03.000Z",
          checkpointTurnCount: null,
          checkpointRef: null,
          checkpointStatus: null,
          checkpointFiles: [],
        }),
      );
      await Effect.runPromise(
        harness.projectionTurns.upsertByTurnId({
          threadId,
          turnId: recoveryTurnId,
          pendingMessageId: recoveryMessageId,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          assistantMessageId: null,
          state: "completed",
          requestedAt: "2026-01-01T00:00:04.000Z",
          startedAt: "2026-01-01T00:00:05.000Z",
          completedAt: "2026-01-01T00:00:06.000Z",
          checkpointTurnCount: null,
          checkpointRef: null,
          checkpointStatus: null,
          checkpointFiles: [],
        }),
      );
      if (scenario.producedOutput) {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: CommandId.make("cmd-active-recovery-output-delta"),
            threadId,
            messageId: asMessageId("assistant-active-recovery-output"),
            delta: "The interrupted work is complete.",
            turnId: recoveryTurnId,
            createdAt: "2026-01-01T00:00:05.500Z",
          }),
        );
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.message.assistant.complete",
            commandId: CommandId.make("cmd-active-recovery-output-complete"),
            threadId,
            messageId: asMessageId("assistant-active-recovery-output"),
            turnId: recoveryTurnId,
            createdAt: "2026-01-01T00:00:06.000Z",
          }),
        );
      }
    }

    await harness.startReactor();
    const readWork = (suffix: "output" | "empty") =>
      Effect.runPromise(
        harness.threadWorkObligations
          .getByKey({
            threadId: ThreadId.make(`thread-active-recovery-${suffix}`),
            sourceTurnId: activeTurnWorkSourceId(asMessageId(`message-active-recovery-${suffix}`)),
            kind: "active-turn-recovery",
          })
          .pipe(Effect.map(Option.getOrUndefined)),
      );
    await waitFor(async () => (await readWork("output"))?.state === "completed");
    await waitFor(async () => (await readWork("empty"))?.state === "sleeping");

    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-active-recovery-empty"),
      messageId: MessageId.make(
        "active-turn-recovery-delivery:thread-active-recovery-empty:message-active-recovery-empty",
      ),
      input: RESUME_PROMPT,
    });
    expect((await readWork("empty"))?.blockedReason).toBe(
      "provider startup resume left no running session to supervise",
    );
  });

  it("does not deliver an already-projected Agent continuation after leaving Agent mode", async () => {
    const harness = await createHarness({ startReactor: false });
    const threadId = ThreadId.make("thread-1");
    const sourceTurnId = asTurnId("turn-agent-mode-exit-source");
    const sourceMessageId = asMessageId("user-message-agent-mode-exit-source");
    const assistantMessageId = asMessageId("assistant-message-agent-mode-exit-source");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-agent-mode-exit-agent"),
        threadId,
        interactionMode: "agent",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-agent-mode-exit-source"),
        threadId,
        message: {
          messageId: sourceMessageId,
          role: "user",
          text: "Keep working autonomously until every requirement is verified.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-mode-exit-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: sourceTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-agent-mode-exit-delta"),
        threadId,
        messageId: assistantMessageId,
        delta: "One phase is complete; more work remains.",
        turnId: sourceTurnId,
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-agent-mode-exit-complete"),
        threadId,
        messageId: assistantMessageId,
        turnId: sourceTurnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-mode-exit-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:04.000Z",
        },
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );
    await waitFor(async () =>
      Option.isSome(
        await Effect.runPromise(
          harness.threadWorkObligations.getByKey({
            threadId,
            sourceTurnId,
            kind: "agent-continuation",
          }),
        ),
      ),
    );

    const continuationIds = agentAutoResumeIds({ threadId, completedTurnId: sourceTurnId });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: continuationIds.commandId,
        threadId,
        message: {
          messageId: continuationIds.messageId,
          role: "user",
          text: AGENT_CONTINUE_PROMPT,
          inputOrigin: "agent-loop",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:05.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-agent-mode-exit-default"),
        threadId,
        interactionMode: "default",
        createdAt: "2026-01-01T00:00:06.000Z",
      }),
    );

    await harness.startReactor();
    const readObligation = () =>
      Effect.runPromise(
        harness.threadWorkObligations
          .getByKey({ threadId, sourceTurnId, kind: "agent-continuation" })
          .pipe(Effect.map(Option.getOrUndefined)),
      );
    await waitFor(async () => (await readObligation())?.state === "cancelled");

    const obligation = await readObligation();
    expect(obligation?.blockedReason).toContain("no longer in Agent mode");
    expect(harness.sendTurn).not.toHaveBeenCalled();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(thread?.interactionMode).toBe("default");
    expect(thread?.messages.filter((message) => message.inputOrigin === "agent-loop")).toHaveLength(
      1,
    );
  });

  it("resumes a completed authentication-failure turn without projecting a user message", async () => {
    const harness = await createHarness({ startReactor: false });
    const threadId = ThreadId.make("thread-1");
    const sourceTurnId = asTurnId("turn-auth-resume-source");
    const sourceMessageId = asMessageId("user-message-auth-resume-source");
    const assistantMessageId = asMessageId("assistant-message-auth-resume-source");
    const authFailure = "Failed to authenticate: OAuth session expired and could not be refreshed";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-auth-resume-agent-mode"),
        threadId,
        interactionMode: "agent",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-auth-resume-source"),
        threadId,
        message: {
          messageId: sourceMessageId,
          role: "user",
          text: "Continue the task after authentication recovers.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-auth-resume-source-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: sourceTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-auth-resume-source-delta"),
        threadId,
        messageId: assistantMessageId,
        delta: authFailure,
        turnId: sourceTurnId,
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-auth-resume-source-complete"),
        threadId,
        messageId: assistantMessageId,
        turnId: sourceTurnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-auth-resume-source-error"),
        threadId,
        session: {
          threadId,
          status: "error",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: authFailure,
          updatedAt: "2026-01-01T00:00:04.000Z",
        },
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );

    const obligation = Option.getOrThrow(
      await Effect.runPromise(
        harness.threadWorkObligations.getByKey({
          threadId,
          sourceTurnId,
          kind: "authentication-resume",
        }),
      ),
    );
    expect(
      await Effect.runPromise(
        harness.threadWorkObligations.transition({
          obligationId: obligation.obligationId,
          expectedState: "blocked-authentication",
          expectedAttempt: obligation.attempt,
          state: "pending",
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: null,
          updatedAt: "2026-01-01T00:00:05.000Z",
        }),
      ),
    ).toBe(true);

    await harness.startReactor();
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId,
      messageId: MessageId.make(`provider-auth-resume-delivery:${threadId}:${sourceTurnId}`),
      input: AGENT_CONTINUE_PROMPT,
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(thread?.messages.filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("redispatches an authentication resume whose prior provider turn completed empty", async () => {
    const harness = await createHarness({ startReactor: false });
    const threadId = ThreadId.make("thread-1");
    const sourceTurnId = asTurnId("turn-auth-empty-source");
    const emptyDeliveryTurnId = asTurnId("turn-auth-empty-delivery");
    const sourceMessageId = asMessageId("user-message-auth-empty-source");
    const assistantMessageId = asMessageId("assistant-message-auth-empty-source");
    const deliveryMessageId = MessageId.make(
      `provider-auth-resume-delivery:${threadId}:${sourceTurnId}`,
    );
    const authFailure = "Failed to authenticate: OAuth session expired and could not be refreshed";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-auth-empty-agent-mode"),
        threadId,
        interactionMode: "agent",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-auth-empty-source"),
        threadId,
        message: {
          messageId: sourceMessageId,
          role: "user",
          text: "Continue the task after authentication recovers.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-auth-empty-source-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: sourceTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-auth-empty-source-delta"),
        threadId,
        messageId: assistantMessageId,
        delta: authFailure,
        turnId: sourceTurnId,
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-auth-empty-source-complete"),
        threadId,
        messageId: assistantMessageId,
        turnId: sourceTurnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-auth-empty-source-error"),
        threadId,
        session: {
          threadId,
          status: "error",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: authFailure,
          updatedAt: "2026-01-01T00:00:04.000Z",
        },
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );

    const obligation = Option.getOrThrow(
      await Effect.runPromise(
        harness.threadWorkObligations.getByKey({
          threadId,
          sourceTurnId,
          kind: "authentication-resume",
        }),
      ),
    );
    expect(
      await Effect.runPromise(
        harness.threadWorkObligations.transition({
          obligationId: obligation.obligationId,
          expectedState: "blocked-authentication",
          expectedAttempt: obligation.attempt,
          state: "pending",
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: null,
          updatedAt: "2026-01-01T00:00:05.000Z",
        }),
      ),
    ).toBe(true);
    await Effect.runPromise(
      harness.projectionTurns.upsertByTurnId({
        threadId,
        turnId: emptyDeliveryTurnId,
        pendingMessageId: deliveryMessageId,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        assistantMessageId: null,
        state: "completed",
        requestedAt: "2026-01-01T00:00:05.000Z",
        startedAt: "2026-01-01T00:00:06.000Z",
        completedAt: "2026-01-01T00:00:07.000Z",
        checkpointTurnCount: null,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
      }),
    );

    await harness.startReactor();
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId,
      messageId: deliveryMessageId,
      input: AGENT_CONTINUE_PROMPT,
    });

    const readObligation = () =>
      Effect.runPromise(
        harness.threadWorkObligations
          .getByKey({ threadId, sourceTurnId, kind: "authentication-resume" })
          .pipe(Effect.map(Option.getOrUndefined)),
      );
    await waitFor(async () => (await readObligation())?.state === "sleeping");
    expect((await readObligation())?.blockedReason).toBe(
      "provider authentication resume is not running",
    );
  });

  it.each([
    { name: "Agent continuation", kind: "agent-continuation" as const },
    { name: "authentication resume", kind: "authentication-resume" as const },
  ])(
    "uses the admitted non-receipt route for a $name after a provider switch",
    async ({ kind }) => {
      const obligationProviderInstanceId = ProviderInstanceId.make("receipt-provider");
      const admittedProviderInstanceId = ProviderInstanceId.make("nonreceipt-provider");
      const capabilityReads: Array<ProviderInstanceId> = [];
      const nativeRouteCapabilityReads: Array<ProviderInstanceId> = [];
      const harness = await createHarness({
        startReactor: false,
        threadModelSelection: {
          instanceId: obligationProviderInstanceId,
          model: "test-model",
        },
        getCapabilitiesEffect: (instanceId) =>
          Effect.sync(() => {
            capabilityReads.push(instanceId);
            return {
              sessionModelSwitch: "in-session" as const,
              messageDeliveryReceipts: instanceId === obligationProviderInstanceId,
            };
          }),
        nativeRouteCapabilitiesEffect: (instanceId) =>
          Effect.sync(() => {
            nativeRouteCapabilityReads.push(instanceId);
            return {
              sessionModelSwitch: "in-session" as const,
              messageDeliveryReceipts: false,
            };
          }),
      });
      const work = await seedRoutedReceiptWork(harness, {
        kind,
        suffix: "receipt-to-nonreceipt",
        obligationProviderInstanceId,
      });
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`cmd-routed-receipt-switch-${kind}`),
          threadId: work.threadId,
          modelSelection: {
            instanceId: admittedProviderInstanceId,
            model: "test-model",
          },
        }),
      );
      await Effect.runPromise(
        harness.startSession(work.threadId, {
          threadId: work.threadId,
          provider: ProviderDriverKind.make(String(admittedProviderInstanceId)),
          providerInstanceId: admittedProviderInstanceId,
          cwd: "/tmp/provider-project",
          runtimeMode: "approval-required",
        }),
      );

      await harness.startReactor();
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      const readObligation = () =>
        Effect.runPromise(
          harness.threadWorkObligations
            .getByKey({
              threadId: work.threadId,
              sourceTurnId: work.sourceTurnId,
              kind,
            })
            .pipe(Effect.map(Option.getOrUndefined)),
        );
      await waitFor(async () => (await readObligation())?.state === "sleeping");

      expect(nativeRouteCapabilityReads).toEqual([admittedProviderInstanceId]);
      expect((await readObligation())?.blockedReason).toBe(
        kind === "agent-continuation"
          ? "provider continuation is not running"
          : "provider authentication resume is not running",
      );
    },
  );

  it.each([
    { name: "Agent continuation", kind: "agent-continuation" as const },
    { name: "authentication resume", kind: "authentication-resume" as const },
  ])(
    "requires the admitted receipt route for a $name without a post-acceptance capability lookup",
    async ({ kind }) => {
      const obligationProviderInstanceId = ProviderInstanceId.make("nonreceipt-provider");
      const admittedProviderInstanceId = ProviderInstanceId.make("receipt-provider");
      const capabilityReads: Array<ProviderInstanceId> = [];
      const nativeRouteCapabilityReads: Array<ProviderInstanceId> = [];
      let registryEntryAvailable = true;
      let nativeAccepted = false;
      const harness = await createHarness({
        startReactor: false,
        threadModelSelection: {
          instanceId: obligationProviderInstanceId,
          model: "test-model",
        },
        getCapabilitiesEffect: (instanceId) =>
          Effect.sync(() => {
            if (!registryEntryAvailable) {
              throw new Error("admitted provider registry entry was removed");
            }
            capabilityReads.push(instanceId);
            return {
              sessionModelSwitch: "in-session" as const,
              messageDeliveryReceipts: instanceId === admittedProviderInstanceId,
            };
          }),
        nativeRouteCapabilitiesEffect: (instanceId) =>
          Effect.sync(() => {
            nativeRouteCapabilityReads.push(instanceId);
            return {
              sessionModelSwitch: "in-session" as const,
              messageDeliveryReceipts: true,
            };
          }),
        sendTurnEffect: (rawInput) =>
          Effect.sync(() => {
            const request = rawInput as ProviderSendTurnInput;
            nativeAccepted = true;
            registryEntryAvailable = false;
            return {
              threadId: request.threadId,
              turnId: asTurnId(`turn-routed-receipt-${kind}`),
            };
          }),
      });
      const work = await seedRoutedReceiptWork(harness, {
        kind,
        suffix: "nonreceipt-to-receipt",
        obligationProviderInstanceId,
      });
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`cmd-routed-receipt-switch-${kind}`),
          threadId: work.threadId,
          modelSelection: {
            instanceId: admittedProviderInstanceId,
            model: "test-model",
          },
        }),
      );
      await Effect.runPromise(
        harness.startSession(work.threadId, {
          threadId: work.threadId,
          provider: ProviderDriverKind.make(String(admittedProviderInstanceId)),
          providerInstanceId: admittedProviderInstanceId,
          cwd: "/tmp/provider-project",
          runtimeMode: "approval-required",
        }),
      );

      await harness.startReactor();
      await waitFor(() => nativeAccepted);
      const readObligation = () =>
        Effect.runPromise(
          harness.threadWorkObligations
            .getByKey({
              threadId: work.threadId,
              sourceTurnId: work.sourceTurnId,
              kind,
            })
            .pipe(Effect.map(Option.getOrUndefined)),
        );
      await Effect.runPromise(Effect.yieldNow);
      expect(await readObligation()).toMatchObject({ state: "executing" });
      expect(nativeRouteCapabilityReads).toEqual([admittedProviderInstanceId]);

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`cmd-routed-receipt-delivered-${kind}`),
          threadId: work.threadId,
          activity: {
            id: EventId.make(`activity-routed-receipt-delivered-${kind}`),
            tone: "info",
            kind: "message.delivered",
            summary: "Message delivered to the provider",
            payload: { messageId: work.deliveryMessageId },
            turnId: null,
            createdAt: "2026-01-01T00:00:06.000Z",
          },
          createdAt: "2026-01-01T00:00:06.000Z",
        }),
      );
      await waitFor(async () => (await readObligation())?.state === "sleeping");
      expect(nativeRouteCapabilityReads).toEqual([admittedProviderInstanceId]);
    },
  );

  it("does not let route replacement preempt an already-emitted lagging receipt", async () => {
    const admittedProviderInstanceId = ProviderInstanceId.make("receipt-provider");
    const harness = await createHarness({
      startReactor: false,
      threadModelSelection: {
        instanceId: admittedProviderInstanceId,
        model: "test-model",
      },
      nativeRouteCapabilitiesEffect: () =>
        Effect.succeed({
          sessionModelSwitch: "in-session" as const,
          messageDeliveryReceipts: true,
        }),
    });
    const work = await seedRoutedReceiptWork(harness, {
      kind: "agent-continuation",
      suffix: "lagging-receipt-after-replacement",
      obligationProviderInstanceId: admittedProviderInstanceId,
    });
    await Effect.runPromise(
      harness.startSession(work.threadId, {
        threadId: work.threadId,
        provider: ProviderDriverKind.make(String(admittedProviderInstanceId)),
        providerInstanceId: admittedProviderInstanceId,
        cwd: "/tmp/provider-project",
        runtimeMode: "approval-required",
      }),
    );

    await harness.startReactor();
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const readObligation = () =>
      Effect.runPromise(
        harness.threadWorkObligations
          .getByKey({
            threadId: work.threadId,
            sourceTurnId: work.sourceTurnId,
            kind: "agent-continuation",
          })
          .pipe(Effect.map(Option.getOrUndefined)),
      );
    await waitFor(async () => (await readObligation())?.state === "executing");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-routed-receipt-route-replaced"),
        threadId: work.threadId,
        session: {
          threadId: work.threadId,
          status: "ready",
          providerName: "claudeAgent",
          providerInstanceId: ProviderInstanceId.make("replacement-provider"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:07.000Z",
        },
        createdAt: "2026-01-01T00:00:07.000Z",
      }),
    );
    await Effect.runPromise(Effect.yieldNow);
    expect(await readObligation()).toMatchObject({ state: "executing" });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-routed-receipt-route-lagging-delivery"),
        threadId: work.threadId,
        activity: {
          id: EventId.make("activity-routed-receipt-route-lagging-delivery"),
          tone: "info",
          kind: "message.delivered",
          summary: "Message delivered to the provider",
          payload: { messageId: work.deliveryMessageId },
          turnId: null,
          createdAt: "2026-01-01T00:00:08.000Z",
        },
        createdAt: "2026-01-01T00:00:08.000Z",
      }),
    );
    await waitFor(async () => (await readObligation())?.state === "sleeping");
    expect((await readObligation())?.blockedReason).toBe("provider continuation is not running");
  });

  it.each(["default", "plan"] as const)(
    "cancels a preexisting authentication resume after the thread moves to %s mode",
    async (interactionMode) => {
      const providerInstanceId = ProviderInstanceId.make("codex");
      const harness = await createHarness({ startReactor: false });
      const work = await seedRoutedReceiptWork(harness, {
        kind: "authentication-resume",
        suffix: `persisted-${interactionMode}`,
        obligationProviderInstanceId: providerInstanceId,
      });
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.make(`cmd-auth-resume-mode-${interactionMode}`),
          threadId: work.threadId,
          interactionMode,
          createdAt: "2026-01-01T00:00:06.000Z",
        }),
      );

      await harness.startReactor();
      const readObligation = () =>
        Effect.runPromise(
          harness.threadWorkObligations
            .getByKey({
              threadId: work.threadId,
              sourceTurnId: work.sourceTurnId,
              kind: "authentication-resume",
            })
            .pipe(Effect.map(Option.getOrUndefined)),
        );
      await waitFor(async () => (await readObligation())?.state === "cancelled");

      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect(await readObligation()).toMatchObject({
        state: "cancelled",
        blockedReason: "authentication resume requires Agent mode",
      });
    },
  );

  it("dispatches twenty authentication resumes once each with concurrency two and keeps empty acknowledgements retryable", async () => {
    const harness = await createHarness({ startReactor: false });
    const threadCount = 20;
    const authFailure = "Failed to authenticate: OAuth session expired and could not be refreshed";
    const threadIds = Array.from({ length: threadCount }, (_, index) =>
      ThreadId.make(`thread-auth-mass-${index}`),
    );
    const sourceTurnIdFor = (index: number) => asTurnId(`turn-auth-mass-${index}`);

    for (let index = 0; index < threadCount; index += 1) {
      const threadId = threadIds[index]!;
      const sourceTurnId = sourceTurnIdFor(index);
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`cmd-auth-mass-create-${index}`),
          threadId,
          projectId: asProjectId("project-1"),
          title: `Auth mass thread ${index}`,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "agent",
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-auth-mass-turn-${index}`),
          threadId,
          message: {
            messageId: asMessageId(`user-message-auth-mass-${index}`),
            role: "user",
            text: "Continue the task after authentication recovers.",
            attachments: [],
          },
          interactionMode: "agent",
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`cmd-auth-mass-running-${index}`),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "approval-required",
            activeTurnId: sourceTurnId,
            lastError: null,
            updatedAt: "2026-01-01T00:00:01.000Z",
          },
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
      );
      await Effect.runPromise(
        harness.projectionTurns.deletePendingTurnStart({
          threadId,
          messageId: asMessageId(`user-message-auth-mass-${index}`),
        }),
      );
      await Effect.runPromise(
        harness.projectionTurns.upsertByTurnId({
          threadId,
          turnId: sourceTurnId,
          pendingMessageId: asMessageId(`user-message-auth-mass-${index}`),
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          assistantMessageId: null,
          state: "running",
          requestedAt: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:01.000Z",
          completedAt: null,
          checkpointTurnCount: null,
          checkpointRef: null,
          checkpointStatus: null,
          checkpointFiles: [],
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make(`cmd-auth-mass-delta-${index}`),
          threadId,
          messageId: asMessageId(`assistant-message-auth-mass-${index}`),
          delta: authFailure,
          turnId: sourceTurnId,
          createdAt: "2026-01-01T00:00:02.000Z",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make(`cmd-auth-mass-complete-${index}`),
          threadId,
          messageId: asMessageId(`assistant-message-auth-mass-${index}`),
          turnId: sourceTurnId,
          createdAt: "2026-01-01T00:00:03.000Z",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`cmd-auth-mass-stopped-${index}`),
          threadId,
          session: {
            threadId,
            status: "stopped",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: authFailure,
            updatedAt: "2026-01-01T00:00:04.000Z",
          },
          createdAt: "2026-01-01T00:00:04.000Z",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`cmd-auth-mass-error-${index}`),
          threadId,
          session: {
            threadId,
            status: "error",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: authFailure,
            updatedAt: "2026-01-01T00:00:05.000Z",
          },
          createdAt: "2026-01-01T00:00:05.000Z",
        }),
      );
    }

    const pausedReadModel = await harness.readModel();
    for (let index = 0; index < threadCount; index += 1) {
      const threadId = threadIds[index]!;
      const obligation = Option.getOrThrow(
        await Effect.runPromise(
          harness.threadWorkObligations.getByKey({
            threadId,
            sourceTurnId: sourceTurnIdFor(index),
            kind: "authentication-resume",
          }),
        ),
      );
      expect(obligation.state).toBe("blocked-authentication");
      const thread = pausedReadModel.threads.find((entry) => entry.id === threadId);
      expect(thread?.latestTurn?.state).toBe("incomplete");
    }

    let inFlight = 0;
    let peakInFlight = 0;
    let dispatchedTurns = 0;
    harness.sendTurn.mockImplementation((request: unknown, options) =>
      Effect.gen(function* () {
        yield* Effect.sync(() =>
          options?.onNativeDispatchRoute?.({
            providerInstanceId: ProviderInstanceId.make("codex"),
            sessionGeneration: null,
            messageDeliveryReceipts: false,
          }),
        );
        yield* options?.onNativeDispatch ?? Effect.void;
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        yield* Effect.sleep(Duration.millis(40));
        inFlight -= 1;
        dispatchedTurns += 1;
        const requestThreadId =
          typeof request === "object" && request !== null && "threadId" in request
            ? (request as { threadId: ThreadId }).threadId
            : ThreadId.make("thread-auth-mass-unknown");
        return {
          threadId: requestThreadId,
          turnId: asTurnId(`turn-auth-mass-resume-${dispatchedTurns}`),
        };
      }),
    );

    // Reactor startup runs the authentication recovery sweep against the
    // already-authenticated provider snapshot, releasing every paused thread.
    await harness.startReactor();
    await waitFor(() => harness.sendTurn.mock.calls.length === threadCount);
    await waitFor(async () => {
      for (let index = 0; index < threadCount; index += 1) {
        const obligation = await Effect.runPromise(
          harness.threadWorkObligations.getByKey({
            threadId: threadIds[index]!,
            sourceTurnId: sourceTurnIdFor(index),
            kind: "authentication-resume",
          }),
        );
        if (Option.getOrNull(obligation)?.state !== "sleeping") return false;
      }
      return true;
    });

    expect(harness.sendTurn.mock.calls).toHaveLength(threadCount);
    const deliveredMessageIds = harness.sendTurn.mock.calls.map(
      (call) => (call[0] as { messageId: MessageId }).messageId,
    );
    const expectedMessageIds = threadIds.map((threadId, index) =>
      MessageId.make(`provider-auth-resume-delivery:${threadId}:${sourceTurnIdFor(index)}`),
    );
    expect([...deliveredMessageIds].sort()).toEqual([...expectedMessageIds].sort());
    expect(peakInFlight).toBe(2);

    for (let index = 0; index < threadCount; index += 1) {
      const obligation = Option.getOrThrow(
        await Effect.runPromise(
          harness.threadWorkObligations.getByKey({
            threadId: threadIds[index]!,
            sourceTurnId: sourceTurnIdFor(index),
            kind: "authentication-resume",
          }),
        ),
      );
      expect(obligation.blockedReason).toBe("provider authentication resume is not running");
    }

    const resumedReadModel = await harness.readModel();
    for (const threadId of threadIds) {
      const thread = resumedReadModel.threads.find((entry) => entry.id === threadId);
      expect(thread?.messages.filter((message) => message.role === "user")).toHaveLength(1);
    }
  });

  it.each([
    { name: "main thread", threadId: ThreadId.make("thread-1"), isSideChat: false },
    {
      name: "side chat",
      threadId: ThreadId.make("thread-agent-stop-race-side-chat"),
      isSideChat: true,
    },
  ])(
    "does not continue a $name from cached commentary after its final Agent reply stops",
    async ({ threadId, isSideChat }) => {
      const harness = await createHarness();
      const turnId = asTurnId("turn-agent-stop-after-commentary");
      const now = "2026-01-01T00:00:00.000Z";

      if (isSideChat) {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.fork",
            commandId: CommandId.make("cmd-agent-stop-race-side-chat-fork"),
            threadId,
            sourceThreadId: ThreadId.make("thread-1"),
            title: "Agent stop race side chat",
            isSideChat: true,
            createdAt: now,
          }),
        );
        await waitFor(() => harness.forkSessionBinding.mock.calls.length === 1);
      }

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.make("cmd-agent-stop-race-mode"),
          threadId,
          interactionMode: "agent",
          createdAt: now,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-agent-stop-race-turn"),
          threadId,
          message: {
            messageId: asMessageId("user-message-agent-stop-race"),
            role: "user",
            text: "Work autonomously until completion.",
            attachments: [],
          },
          interactionMode: "agent",
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-agent-stop-race-running"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: "2026-01-01T00:00:01.000Z",
          },
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("cmd-agent-stop-race-commentary-delta"),
          threadId,
          messageId: asMessageId("assistant-message-agent-stop-race-commentary"),
          delta: "One verification phase is complete; I am checking the release next.",
          turnId,
          createdAt: "2026-01-01T00:00:02.000Z",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make("cmd-agent-stop-race-commentary-complete"),
          threadId,
          messageId: asMessageId("assistant-message-agent-stop-race-commentary"),
          turnId,
          createdAt: "2026-01-01T00:00:03.000Z",
        }),
      );

      // Let the reactor cache the completed commentary while the provider turn
      // remains running. This is the stale candidate that previously escaped
      // after the later terminal response.
      await harness.drain();

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("cmd-agent-stop-race-final-delta"),
          threadId,
          messageId: asMessageId("assistant-message-agent-stop-race-final"),
          delta: "Everything requested is finished and verified. AGENT_STOP",
          turnId,
          createdAt: "2026-01-01T00:00:04.000Z",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make("cmd-agent-stop-race-final-complete"),
          threadId,
          messageId: asMessageId("assistant-message-agent-stop-race-final"),
          turnId,
          createdAt: "2026-01-01T00:00:05.000Z",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-agent-stop-race-ready"),
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:06.000Z",
          },
          createdAt: "2026-01-01T00:00:06.000Z",
        }),
      );

      await harness.drain();
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === threadId);
      expect(thread?.messages.at(-1)).toMatchObject({
        role: "assistant",
        text: "Everything requested is finished and verified. AGENT_STOP",
      });
    },
  );

  it("recovers a stranded completed Agent turn when the server starts", async () => {
    const harness = await createHarness({ startReactor: false });
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-agent-before-restart");
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-agent-before-restart-mode"),
        threadId,
        interactionMode: "agent",
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-agent-before-restart-turn"),
        threadId,
        message: {
          messageId: asMessageId("user-message-agent-before-restart"),
          role: "user",
          text: "Work autonomously until completion.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-before-restart-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    const blockedReply =
      "I am blocked on the current directive because the upstream account returned 402. " +
      "I completed the reusable pipeline and inventory, but additional model generation is still " +
      "required before the requested result is finished. No terminal stop signal was emitted.";
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-agent-before-restart-delta"),
        threadId,
        messageId: asMessageId("assistant-message-agent-before-restart"),
        delta: blockedReply,
        turnId,
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-agent-before-restart-complete"),
        threadId,
        messageId: asMessageId("assistant-message-agent-before-restart"),
        turnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-before-restart-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:04.000Z",
        },
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );

    await waitFor(async () =>
      Option.isSome(
        await Effect.runPromise(
          harness.threadWorkObligations.getByKey({
            threadId,
            sourceTurnId: turnId,
            kind: "agent-continuation",
          }),
        ),
      ),
    );
    expect(harness.sendTurn).not.toHaveBeenCalled();
    await harness.startReactor();
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId,
      input: AGENT_CONTINUE_PROMPT,
    });
  });

  it("marks turns from a side-chat fork for provider isolation guidance", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("cmd-side-chat-fork"),
        threadId: ThreadId.make("thread-side-chat"),
        sourceThreadId: ThreadId.make("thread-1"),
        title: "Thread (side chat)",
        isSideChat: true,
        createdAt: now,
      }),
    );
    await waitFor(() => harness.forkSessionBinding.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.make("thread-side-chat"),
      );
      return thread?.session?.providerInstanceId === ProviderInstanceId.make("codex");
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-side-chat-turn-start"),
        threadId: ThreadId.make("thread-side-chat"),
        message: {
          messageId: asMessageId("user-message-side-chat"),
          role: "user",
          text: "Investigate this independently.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-side-chat"),
      input: "Investigate this independently.",
      isSideChat: true,
    });
  });

  it("starts cross-provider forks fresh instead of cloning an incompatible session id", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-cross-provider-side-chat");
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("cmd-cross-provider-side-chat-fork"),
        threadId,
        sourceThreadId: ThreadId.make("thread-1"),
        title: "Claude side chat",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-fable-5",
        },
        runtimeMode: "approval-required",
        interactionMode: "agent",
        isSideChat: true,
        createdAt: now,
      }),
    );
    await harness.drain();

    expect(harness.forkSessionBinding).not.toHaveBeenCalled();
    const readModel = await harness.readModel();
    expect(readModel.threads.find((thread) => thread.id === threadId)).toMatchObject({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-fable-5",
      },
      runtimeMode: "approval-required",
      interactionMode: "agent",
      isSideChat: true,
      session: null,
    });
  });

  effectIt.effect("projects starting before a slow provider session finishes", () =>
    Effect.gen(function* () {
      const releaseStart = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) => Deferred.await(releaseStart).pipe(Effect.as(session)),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-slow-provider"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-slow-provider"),
          role: "user",
          text: "start slowly",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* Effect.promise(() => waitFor(() => harness.startSession.mock.calls.length === 1));
      const duringStartup = yield* Effect.promise(() => harness.readModel());
      expect(
        duringStartup.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
          ?.status,
      ).toBe("starting");
      expect(harness.sendTurn).not.toHaveBeenCalled();

      yield* Deferred.succeed(releaseStart, undefined);
      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
    }),
  );

  effectIt.effect("settles a failed provider startup and allows a clean retry", () =>
    Effect.gen(function* () {
      let failStartup = true;
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) =>
            failStartup
              ? Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: "codex",
                    method: "thread.start",
                    detail: "deterministic startup failure",
                  }),
                )
              : Effect.succeed(session),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-failure"),
          role: "user",
          text: "fail once",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* Effect.promise(() =>
        waitFor(async () => {
          const readModel = await harness.readModel();
          return (
            readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
              ?.status === "error"
          );
        }),
      );
      let readModel = yield* Effect.promise(() => harness.readModel());
      let thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.lastError).toContain("deterministic startup failure");
      expect(harness.sendTurn).not.toHaveBeenCalled();

      failStartup = false;
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-retry"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-retry"),
          role: "user",
          text: "retry",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
      readModel = yield* Effect.promise(() => harness.readModel());
      thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.status).toBe("starting");
      expect(thread?.session?.lastError).toBeNull();
    }),
  );

  // A deterministic failure — a broken build, a config that can never load —
  // fails identically on every attempt. Without a ceiling this obligation
  // re-dispatched every 15 seconds forever, flapping the session and stacking
  // error activities. The durable attempt counter must eventually cancel it.
  it("stops retrying a turn start that fails deterministically", async () => {
    const harness = await createHarness({
      startSessionEffect: () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "thread.start",
            detail: "deterministic startup failure",
          }),
        ),
    });
    const threadId = ThreadId.make("thread-1");
    const messageId = asMessageId("user-message-deterministic-failure");
    const sourceTurnId = activeTurnWorkSourceId(messageId);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-deterministic-failure"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "fail forever",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const readObligation = () =>
      Effect.runPromise(
        harness.threadWorkObligations
          .getByKey({ threadId, sourceTurnId, kind: "active-turn-recovery" })
          .pipe(Effect.map(Option.getOrUndefined)),
      );

    // Each failure parks the obligation as sleeping(+15s). Flip it straight
    // back to schedulable so the scheduler burns through real attempts without
    // the test waiting out the backoff; the wake mirrors what production does
    // after every transition.
    await waitFor(async () => {
      const work = await readObligation();
      if (work === undefined) return false;
      if (work.state === "cancelled") return true;
      if (work.state === "sleeping") {
        await Effect.runPromise(
          harness.threadWorkObligations
            .transition({
              obligationId: work.obligationId,
              expectedState: "sleeping",
              expectedAttempt: work.attempt,
              state: "pending",
              nextAttemptAt: null,
              claimedAt: null,
              leaseExpiresAt: null,
              blockedReason: null,
              updatedAt: "2026-01-01T00:00:01.000Z",
            })
            .pipe(Effect.andThen(harness.threadWorkScheduler.wake()), Effect.ignore),
        );
      }
      return false;
    }, 30_000);

    const cancelled = await readObligation();
    expect(cancelled?.state).toBe("cancelled");
    expect(cancelled?.blockedReason).toContain("Gave up after");
    expect(cancelled?.blockedReason).toContain("deterministic startup failure");
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("replaces a timed-out native Codex resume with one bounded-context fresh session", async () => {
    let startAttempts = 0;
    const messageId = asMessageId("user-message-resume-timeout-fallback");
    const pendingContextRecovery = {
      version: 1 as const,
      kind: "native-resume-timeout" as const,
      sourceMessageId: messageId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const harness = await createHarness({
      startSessionEffect: (session) => {
        startAttempts += 1;
        return startAttempts === 1
          ? Effect.fail(
              new ProviderAdapterRequestError({
                provider: "codex",
                method: "thread/resume",
                detail: "Codex App Server did not respond to 'thread/resume' within 90000ms.",
                failureKind: "local-control-timeout",
              }),
            )
          : Effect.succeed({ ...session, pendingContextRecovery });
      },
    });
    const threadId = ThreadId.make("thread-1");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-resume-timeout-fallback"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "continue the blocked task",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({ resumeCursor: null });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      messageId,
      contextRecovery: pendingContextRecovery,
    });
    const handoff = JSON.parse(
      (harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined)?.input ?? "{}",
    ) as {
      kind?: string;
      context?: {
        handoff?: { reason?: string; from?: { instanceId?: string }; to?: { instanceId?: string } };
        limits?: { maxSerializedChars?: number };
      };
      currentRequest?: string;
    };
    expect(handoff).toMatchObject({
      kind: "t3.provider-handoff-turn",
      context: {
        handoff: {
          reason: "native_resume_timeout_recovery",
          from: { instanceId: "codex" },
          to: { instanceId: "codex" },
        },
        limits: { maxSerializedChars: 32_000 },
      },
      currentRequest: "continue the blocked task",
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(thread?.session?.lastError).toBeNull();
    expect(thread?.session?.failureKind ?? null).toBeNull();
  });

  it("uses a persisted resume-timeout marker on an already-active session", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-1");
    const messageId = asMessageId("user-message-persisted-context-recovery");
    const pendingContextRecovery = {
      version: 1 as const,
      kind: "native-resume-timeout" as const,
      sourceMessageId: messageId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    harness.runtimeSessions.push({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      cwd: "/tmp/provider-project",
      model: "gpt-5-codex",
      threadId,
      resumeCursor: { opaque: "replacement-session" },
      pendingContextRecovery,
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-persisted-context-recovery-session"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-persisted-context-recovery-turn"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "continue after restarting the app",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      messageId,
      contextRecovery: pendingContextRecovery,
    });
    const handoff = JSON.parse(
      (harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined)?.input ?? "{}",
    ) as {
      context?: { handoff?: { reason?: string } };
      currentRequest?: string;
    };
    expect(handoff).toMatchObject({
      context: { handoff: { reason: "native_resume_timeout_recovery" } },
      currentRequest: "continue after restarting the app",
    });
  });

  it("keeps the real request ahead of a synthetic startup-resume handoff", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-1");
    const originalMessageId = asMessageId("user-message-before-startup-resume");
    const originalTurnId = asTurnId("turn-before-startup-resume");
    const startupMessageId = asMessageId(
      `startup-auto-resume-message:${threadId}:${originalTurnId}`,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-before-startup-resume"),
        threadId,
        message: {
          messageId: originalMessageId,
          role: "user",
          text: "finish the real blocked task",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-turn-before-startup-resume-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: originalTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-turn-before-startup-resume-delta"),
        threadId,
        messageId: asMessageId("assistant-message-before-startup-resume"),
        delta: "I was implementing the durable recovery marker.",
        turnId: originalTurnId,
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-turn-before-startup-resume-complete"),
        threadId,
        messageId: asMessageId("assistant-message-before-startup-resume"),
        turnId: originalTurnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-turn-before-startup-resume-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:04.000Z",
        },
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );

    const pendingContextRecovery = {
      version: 1 as const,
      kind: "native-resume-timeout" as const,
      sourceMessageId: startupMessageId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      createdAt: "2026-01-01T00:00:04.000Z",
    };
    const activeSession = harness.runtimeSessions[0];
    expect(activeSession).toBeDefined();
    harness.runtimeSessions[0] = {
      ...activeSession!,
      status: "ready",
      pendingContextRecovery,
    };
    harness.sendTurn.mockClear();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`startup-auto-resume-command:${threadId}:${originalTurnId}`),
        threadId,
        message: {
          messageId: startupMessageId,
          role: "user",
          text: RESUME_PROMPT,
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:05.000Z",
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const handoff = JSON.parse(
      (harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined)?.input ?? "{}",
    ) as {
      context?: {
        continuity?: { immediateRequirement?: string; inProgressWork?: string };
        history?: { messages?: Array<{ id?: string }> };
      };
      currentRequest?: string;
    };
    expect(handoff.context?.continuity).toEqual({
      immediateRequirement: "finish the real blocked task",
      inProgressWork: "I was implementing the durable recovery marker.",
    });
    expect(handoff.context?.history?.messages?.map((message) => message.id)).not.toContain(
      startupMessageId,
    );
    expect(handoff.currentRequest).toBe(RESUME_PROMPT);
  });

  effectIt.effect(
    "dispatches an eligible durable startup resume and retries an empty acknowledgement",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() => createHarness());
        const threadId = ThreadId.make("thread-1");
        const sourceMessageId = asMessageId("user-message-before-durable-startup-resume");
        const sourceTurnId = asTurnId("turn-1");
        const stoppedAt = "2026-01-01T00:00:03.000Z";

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-before-durable-startup-resume"),
          threadId,
          message: {
            messageId: sourceMessageId,
            role: "user",
            text: "Keep working after the application restarts.",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-before-durable-startup-resume-running"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "approval-required",
            activeTurnId: sourceTurnId,
            lastError: null,
            updatedAt: "2026-01-01T00:00:01.000Z",
          },
          createdAt: "2026-01-01T00:00:01.000Z",
        });
        yield* harness.projectionTurns.deletePendingTurnStart({
          threadId,
          messageId: sourceMessageId,
        });
        yield* harness.projectionTurns.upsertByTurnId({
          threadId,
          turnId: sourceTurnId,
          pendingMessageId: sourceMessageId,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          assistantMessageId: null,
          state: "running",
          requestedAt: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:01.000Z",
          completedAt: null,
          checkpointTurnCount: null,
          checkpointRef: null,
          checkpointStatus: null,
          checkpointFiles: [],
        });
        yield* harness.engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make("cmd-before-durable-startup-resume-stop"),
          threadId,
          createdAt: stoppedAt,
        });
        yield* Effect.promise(() =>
          waitFor(async () => {
            const model = await harness.readModel();
            const thread = model.threads.find((candidate) => candidate.id === threadId);
            return (
              thread?.session?.status === "stopped" && thread.latestTurn?.state === "incomplete"
            );
          }),
        );

        harness.sendTurn.mockClear();
        const startupIds = startupAutoResumeIds({ threadId, incompleteTurnId: sourceTurnId });
        const obligationId = threadWorkObligationId({
          threadId,
          sourceTurnId,
          kind: "startup-resume",
        });
        yield* harness.threadWorkObligations.insert({
          obligationId,
          threadId,
          sourceTurnId,
          kind: "startup-resume",
          state: "pending",
          providerInstanceId: ProviderInstanceId.make("codex"),
          attempt: 0,
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: null,
          createdAt: stoppedAt,
          updatedAt: stoppedAt,
        });
        yield* harness.threadWorkScheduler.wake();

        yield* Effect.promise(() =>
          waitFor(() =>
            harness.sendTurn.mock.calls.some(
              (call) => (call[0] as ProviderSendTurnInput).messageId === startupIds.messageId,
            ),
          ),
        );
        const work = yield* Effect.gen(function* () {
          for (let attempts = 0; attempts < 10_000; attempts += 1) {
            const candidate = yield* harness.threadWorkObligations.getByKey({
              threadId,
              sourceTurnId,
              kind: "startup-resume",
            });
            if (Option.isSome(candidate) && candidate.value.state === "sleeping") {
              return candidate.value;
            }
            yield* Effect.yieldNow;
          }
          return yield* Effect.die("startup resume obligation did not become retryable");
        });

        expect(work.blockedReason).toBe(
          "provider startup resume left no running session to supervise",
        );

        const model = yield* Effect.promise(harness.readModel);
        const thread = model.threads.find((candidate) => candidate.id === threadId);
        expect(thread?.messages.some((message) => message.id === startupIds.messageId)).toBe(true);
        expect(thread?.messages.find((message) => message.id === startupIds.messageId)?.text).toBe(
          RESUME_PROMPT,
        );
      }),
  );

  it("retries a route-created recovery marker without surfacing a terminal error", async () => {
    const threadId = ThreadId.make("thread-1");
    const messageId = asMessageId("user-message-route-created-context-recovery");
    const pendingContextRecovery = {
      version: 1 as const,
      kind: "native-resume-timeout" as const,
      sourceMessageId: messageId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    let sendAttempts = 0;
    const harness = await createHarness({
      sendTurnEffect: (_input, runtimeSessions) => {
        sendAttempts += 1;
        if (sendAttempts === 1) {
          const activeSession = runtimeSessions[0];
          if (activeSession !== undefined) {
            runtimeSessions[0] = { ...activeSession, pendingContextRecovery };
          }
          return Effect.fail(
            new ProviderAdapterRequestError({
              provider: "codex",
              method: "thread/context-recovery",
              detail: "bounded context handoff required",
            }),
          );
        }
        return Effect.succeed({ threadId, turnId: asTurnId("turn-context-recovery-retry") });
      },
    });
    const sourceTurnId = activeTurnWorkSourceId(messageId);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-route-created-context-recovery"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "continue through the recovered provider session",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitFor(async () => {
      const work = Option.getOrUndefined(
        await Effect.runPromise(
          harness.threadWorkObligations.getByKey({
            threadId,
            sourceTurnId,
            kind: "active-turn-recovery",
          }),
        ),
      );
      return work?.state === "sleeping";
    });
    const sleeping = Option.getOrUndefined(
      await Effect.runPromise(
        harness.threadWorkObligations.getByKey({
          threadId,
          sourceTurnId,
          kind: "active-turn-recovery",
        }),
      ),
    );
    expect(sleeping?.state).toBe("sleeping");
    if (!sleeping) return;
    await Effect.runPromise(
      harness.threadWorkObligations
        .transition({
          obligationId: sleeping.obligationId,
          expectedState: "sleeping",
          expectedAttempt: sleeping.attempt,
          state: "pending",
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: null,
          updatedAt: "2026-01-01T00:00:02.000Z",
        })
        .pipe(Effect.andThen(harness.threadWorkScheduler.wake()), Effect.ignore),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      messageId,
      contextRecovery: pendingContextRecovery,
    });
    const handoff = JSON.parse(
      (harness.sendTurn.mock.calls[1]?.[0] as { input?: string } | undefined)?.input ?? "{}",
    ) as { context?: { handoff?: { reason?: string } } };
    expect(handoff.context?.handoff?.reason).toBe("native_resume_timeout_recovery");
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(thread?.session?.lastError).toBeNull();
    expect(thread?.session?.failureKind ?? null).toBeNull();
  });

  it("stops after one local Codex control-plane fresh-start timeout", async () => {
    const harness = await createHarness({
      startSessionEffect: () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "thread/start",
            detail: "Codex App Server did not respond to 'thread/start' within 90000ms.",
            failureKind: "local-control-timeout",
          }),
        ),
    });
    const threadId = ThreadId.make("thread-1");
    const messageId = asMessageId("user-message-local-control-timeout");
    const sourceTurnId = activeTurnWorkSourceId(messageId);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-local-control-timeout"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "start once",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitFor(async () => {
      const work = await Effect.runPromise(
        harness.threadWorkObligations
          .getByKey({ threadId, sourceTurnId, kind: "active-turn-recovery" })
          .pipe(Effect.map(Option.getOrUndefined)),
      );
      return work?.state === "cancelled";
    });

    const cancelled = await Effect.runPromise(
      harness.threadWorkObligations
        .getByKey({ threadId, sourceTurnId, kind: "active-turn-recovery" })
        .pipe(Effect.map(Option.getOrUndefined)),
    );
    expect(cancelled?.attempt).toBe(1);
    expect(cancelled?.blockedReason).toContain("Provider startup timed out");
    expect(cancelled?.blockedReason).not.toContain("Gave up after");
    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("surfaces a missing Claude binary as a short error and stops retrying", async () => {
    const harness = await createHarness({
      startSessionEffect: () =>
        Effect.fail(
          new ProviderAdapterProcessError({
            provider: "claudeAgent",
            threadId: "thread-1",
            detail: "Failed to start Claude runtime session.",
            cause: new ReferenceError(
              "Claude Code native binary not found at C:\\Users\\dev\\claude.exe.",
            ),
          }),
        ),
    });
    const threadId = ThreadId.make("thread-1");
    const messageId = asMessageId("user-message-claude-missing");
    const sourceTurnId = activeTurnWorkSourceId(messageId);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-missing"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === threadId);
      return thread?.session?.lastError === CLAUDE_CODE_NOT_INSTALLED_MESSAGE;
    });

    const cancelled = await Effect.runPromise(
      harness.threadWorkObligations
        .getByKey({ threadId, sourceTurnId, kind: "active-turn-recovery" })
        .pipe(Effect.map(Option.getOrUndefined)),
    );
    expect(cancelled?.state).toBe("cancelled");
    expect(cancelled?.blockedReason).toBe(CLAUDE_CODE_NOT_INSTALLED_MESSAGE);
    expect(cancelled?.blockedReason).not.toContain("Gave up after");
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("retries a structured upstream failure beyond the deterministic cap", async () => {
    const harness = await createHarness({
      startSessionEffect: () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "thread.start",
            detail: "pxpipe upstream unreachable",
            failureKind: "retryable-upstream",
          }),
        ),
    });
    const threadId = ThreadId.make("thread-1");
    const messageId = asMessageId("user-message-transient-upstream");
    const sourceTurnId = activeTurnWorkSourceId(messageId);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-transient-upstream"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "survive the outage",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const readObligation = () =>
      Effect.runPromise(
        harness.threadWorkObligations
          .getByKey({ threadId, sourceTurnId, kind: "active-turn-recovery" })
          .pipe(Effect.map(Option.getOrUndefined)),
      );

    await waitFor(async () => {
      const work = await readObligation();
      if (work === undefined) return false;
      if (work.state === "cancelled") {
        throw new Error(`Transient obligation was cancelled: ${work.blockedReason ?? "unknown"}`);
      }
      if (work.state === "sleeping" && work.attempt >= 12) return true;
      if (work.state === "sleeping") {
        const retryDelayMs = Date.parse(work.nextAttemptAt ?? "") - Date.parse(work.updatedAt);
        expect(retryDelayMs).toBeGreaterThanOrEqual(0);
        expect(retryDelayMs).toBeLessThanOrEqual(15_000);
        await Effect.runPromise(
          harness.threadWorkObligations
            .transition({
              obligationId: work.obligationId,
              expectedState: "sleeping",
              expectedAttempt: work.attempt,
              state: "pending",
              nextAttemptAt: null,
              claimedAt: null,
              leaseExpiresAt: null,
              blockedReason: null,
              updatedAt: `2026-01-01T00:00:${String(work.attempt).padStart(2, "0")}.000Z`,
            })
            .pipe(Effect.andThen(harness.threadWorkScheduler.wake()), Effect.ignore),
        );
      }
      return false;
    }, 30_000);

    const sleeping = await readObligation();
    expect(sleeping?.state).toBe("sleeping");
    expect(sleeping?.attempt).toBeGreaterThanOrEqual(12);
    expect(sleeping?.blockedReason).toContain("pxpipe upstream unreachable");
    expect(harness.sendTurn).not.toHaveBeenCalled();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(thread?.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(thread?.messages.filter((message) => message.inputOrigin === "agent-loop")).toHaveLength(
      0,
    );
    expect(
      thread?.activities.filter((activity) => activity.kind === "provider.turn.start.failed"),
    ).toHaveLength(0);

    await Effect.runPromise(
      harness.threadWorkObligations.cancelByThread({
        threadId,
        updatedAt: "2026-01-01T00:01:00.000Z",
        blockedReason: "test cleanup",
        mode: "thread-terminal",
      }),
    );
  });

  // First coverage for the silence watchdog, which had none: it is the last
  // line of defence against a wedged provider and lives in exactly one place,
  // the wait loop, so every code path that returns before entering that loop
  // leaves a live turn completely unsupervised. The fake provider emits
  // nothing once the session is live, freezing the thread shell's fingerprint,
  // and the watchdog must restart the session rather than spin at 10Hz forever
  // holding the thread's only obligation slot. `providerSilenceRestartMs`
  // exists purely so this is reachable without burning the production four
  // minutes of wall clock.
  it("restarts the session when the provider feed goes silent mid-turn", async () => {
    const blockingTurnId = asTurnId("turn-already-running");
    const harness = await createHarness({
      providerSilenceRestartMs: 750,
      providerMidTurnSilenceRestartMs: 750,
      startSessionEffect: (session) =>
        Effect.succeed({ ...session, status: "running" as const, activeTurnId: blockingTurnId }),
    });
    const threadId = ThreadId.make("thread-1");
    const messageId = asMessageId("user-message-silent-provider");
    const sourceTurnId = activeTurnWorkSourceId(messageId);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-silent-provider"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "queued behind a turn that never finishes",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const readObligation = () =>
      Effect.runPromise(
        harness.threadWorkObligations
          .getByKey({ threadId, sourceTurnId, kind: "active-turn-recovery" })
          .pipe(Effect.map(Option.getOrUndefined)),
      );

    await waitFor(async () => {
      const work = await readObligation();
      return work?.state === "sleeping" || work?.state === "cancelled";
    }, 20_000);

    const parked = await readObligation();
    expect(parked?.state).toBe("sleeping");
    expect(parked?.blockedReason).toContain("provider went silent mid-turn");
    expect(harness.stopSession).toHaveBeenCalled();

    await Effect.runPromise(
      harness.threadWorkObligations.cancelByThread({
        threadId,
        updatedAt: "2026-01-01T00:01:00.000Z",
        blockedReason: "test cleanup",
        mode: "thread-terminal",
      }),
    );
  });

  // The watchdog must not execute a session whose provider is quietly
  // mid-tool: long tool calls emit only 30-second progress heartbeats, none
  // of which touch the projected shell, so shell silence alone is not a dead
  // feed. Ingestion's runtime observations are the liveness signal — while
  // they stay fresh the watchdog holds fire, and only genuine provider
  // silence restarts the session. Observed in production 2026-08-05: an
  // 11-minute APK build was killed mid-flight ("Session stopped", command
  // failed, turn interrupted) because the shell fingerprint froze.
  it("keeps a silent-shell session alive while runtime observations stay fresh", async () => {
    const blockingTurnId = asTurnId("turn-quiet-tool");
    const harness = await createHarness({
      providerSilenceRestartMs: 750,
      providerMidTurnSilenceRestartMs: 750,
      startSessionEffect: (session) =>
        Effect.succeed({ ...session, status: "running" as const, activeTurnId: blockingTurnId }),
    });
    const threadId = ThreadId.make("thread-1");
    const messageId = asMessageId("user-message-quiet-tool");
    const sourceTurnId = activeTurnWorkSourceId(messageId);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-quiet-tool"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "a long tool call that heartbeats without touching the shell",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const readObligation = () =>
      Effect.runPromise(
        harness.threadWorkObligations
          .getByKey({ threadId, sourceTurnId, kind: "active-turn-recovery" })
          .pipe(Effect.map(Option.getOrUndefined)),
      );

    // Pump liveness the way ingestion does for tool_progress heartbeats. The
    // observation only registers once the scheduler owns work for the thread.
    let pumping = true;
    const pump = (async () => {
      while (pumping) {
        await Effect.runPromise(
          harness.threadWorkScheduler.observeRuntime({ threadId, phase: "tool-running" }),
        );
        await Effect.runPromise(Effect.sleep(Duration.millis(100)));
      }
    })();

    // Several full silence windows: the watchdog must not misfire while the
    // heartbeats keep arriving.
    await Effect.runPromise(Effect.sleep(Duration.millis(2_500)));
    expect(harness.stopSession).not.toHaveBeenCalled();
    const live = await readObligation();
    expect(live?.state === "claimed" || live?.state === "executing").toBe(true);

    // Cut the heartbeats: now the feed is genuinely dead and the watchdog
    // must restart the session exactly as before.
    pumping = false;
    await pump;
    await waitFor(async () => {
      const work = await readObligation();
      return work?.state === "sleeping" || work?.state === "cancelled";
    }, 20_000);
    expect(harness.stopSession).toHaveBeenCalled();

    await Effect.runPromise(
      harness.threadWorkObligations.cancelByThread({
        threadId,
        updatedAt: "2026-01-01T00:01:00.000Z",
        blockedReason: "test cleanup",
        mode: "thread-terminal",
      }),
    );
  });

  // The boot backfill creates a startup-resume obligation from the settled
  // turn alone — its synthetic message and turn-start are dispatched a moment
  // later by the resume coordinator. Claiming inside that window must not
  // cancel the obligation: the projector treats the incoming turn-start as a
  // replay of the row that already exists, so a cancel there strands the
  // resume with nothing left to drive it. Observed in production 2026-08-05,
  // where a restart's auto-resume died 700ms after being enqueued and the
  // thread sat dead for eight hours.
  it("retries instead of cancelling when the turn-start context is not projected yet", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-1");
    const messageId = asMessageId("startup-resume-message-not-yet-projected");
    const sourceTurnId = activeTurnWorkSourceId(messageId);
    const obligationId = `thread-work:active-turn-recovery:${threadId}:${sourceTurnId}`;

    await Effect.runPromise(
      harness.threadWorkObligations.insert({
        obligationId,
        threadId,
        sourceTurnId,
        kind: "active-turn-recovery",
        state: "pending",
        providerInstanceId: ProviderInstanceId.make("codex"),
        attempt: 0,
        nextAttemptAt: null,
        claimedAt: null,
        leaseExpiresAt: null,
        blockedReason: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(harness.threadWorkScheduler.wake());

    const readObligation = () =>
      Effect.runPromise(
        harness.threadWorkObligations
          .getByKey({ threadId, sourceTurnId, kind: "active-turn-recovery" })
          .pipe(Effect.map(Option.getOrUndefined)),
      );

    await waitFor(async () => {
      const work = await readObligation();
      return work !== undefined && (work.state === "sleeping" || work.state === "cancelled");
    }, 15_000);

    const parked = await readObligation();
    expect(parked?.state).toBe("sleeping");
    expect(parked?.blockedReason).toContain("turn-start context has not been projected yet");
    expect(harness.sendTurn).not.toHaveBeenCalled();

    await Effect.runPromise(
      harness.threadWorkObligations.cancelByThread({
        threadId,
        updatedAt: "2026-01-01T00:01:00.000Z",
        blockedReason: "test cleanup",
        mode: "thread-terminal",
      }),
    );
  });

  // A real CLI spawn leaves the session "connecting" for ~10 seconds after the
  // turn is dispatched. Retiring the obligation as completed in that window
  // abandons the turn that is about to start: nothing supervises it, so the
  // silence watchdog never runs and a hung upstream request spins the UI
  // forever with no error and no retry. Observed in production 2026-08-05,
  // where an auto-resume turn sat silent for five minutes and then died with
  // "Request timed out" that never reached the user.
  it("keeps supervising a turn dispatched while the session is still connecting", async () => {
    const harness = await createHarness({
      startSessionEffect: (session) =>
        Effect.succeed({ ...session, status: "connecting" as const }),
    });
    const threadId = ThreadId.make("thread-1");
    const messageId = asMessageId("user-message-connecting-session");
    const sourceTurnId = activeTurnWorkSourceId(messageId);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-connecting"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "resume while the provider is still spawning",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const readObligation = () =>
      Effect.runPromise(
        harness.threadWorkObligations
          .getByKey({ threadId, sourceTurnId, kind: "active-turn-recovery" })
          .pipe(Effect.map(Option.getOrUndefined)),
      );

    // The turn is genuinely dispatched...
    await waitFor(async () => harness.sendTurn.mock.calls.length > 0, 10_000);

    // ...and the obligation stays live rather than retiring. Before the fix it
    // flipped to "completed" as soon as the post-send status read came back
    // anything other than "running".
    await waitFor(async () => {
      const work = await readObligation();
      return work !== undefined && (work.state === "claimed" || work.state === "executing");
    }, 10_000);

    const supervising = await readObligation();
    expect(supervising?.state).not.toBe("completed");
    expect(supervising?.state).not.toBe("cancelled");

    await Effect.runPromise(
      harness.threadWorkObligations.cancelByThread({
        threadId,
        updatedAt: "2026-01-01T00:01:00.000Z",
        blockedReason: "test cleanup",
        mode: "thread-terminal",
      }),
    );
  });

  // Provider failover can start a successor turn immediately after the old
  // turn settles. The thread shell then points at the successor, but the work
  // obligation still owns the old turn. Waiting only on `latestTurn` stranded
  // that obligation until the silence watchdog fired, which in turn blocked
  // every newer send on the thread. Observed on the 3D Modeling Trial thread:
  // Codex had the eventual message, while the app looked stuck for minutes.
  effectIt.effect("settles the supervised turn after a successor becomes latest", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness());
      const threadId = ThreadId.make("thread-1");
      const originalTurnId = asTurnId("turn-before-failover");
      const successorTurnId = asTurnId("turn-after-failover");
      const codex = ProviderInstanceId.make("codex");

      harness.sendTurn.mockImplementation(() =>
        Effect.sync(() => {
          const index = harness.runtimeSessions.findIndex(
            (session) => session.threadId === threadId,
          );
          const session = index >= 0 ? harness.runtimeSessions[index] : undefined;
          if (session !== undefined) {
            harness.runtimeSessions[index] = {
              ...session,
              status: "running",
              activeTurnId: originalTurnId,
            };
          }
          return { threadId, turnId: originalTurnId };
        }),
      );

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-before-failover"),
        threadId,
        message: {
          messageId: asMessageId("message-before-failover"),
          role: "user",
          text: "Start the original turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-original-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: codex,
          runtimeMode: "approval-required",
          activeTurnId: originalTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      });

      const readObligation = harness.threadWorkObligations
        .getByKey({
          threadId,
          sourceTurnId: activeTurnWorkSourceId(asMessageId("message-before-failover")),
          kind: "active-turn-recovery",
        })
        .pipe(Effect.map(Option.getOrUndefined));
      expect((yield* readObligation)?.state).toBe("executing");

      const runtimeIndex = harness.runtimeSessions.findIndex(
        (session) => session.threadId === threadId,
      );
      const runtimeSession = runtimeIndex >= 0 ? harness.runtimeSessions[runtimeIndex] : undefined;
      if (runtimeSession !== undefined) {
        harness.runtimeSessions[runtimeIndex] = {
          ...runtimeSession,
          status: "running",
          activeTurnId: successorTurnId,
        };
      }
      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-successor-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: codex,
          runtimeMode: "approval-required",
          activeTurnId: successorTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:03.000Z",
        },
        createdAt: "2026-01-01T00:00:03.000Z",
      });

      const overtakenReadModel = yield* Effect.promise(harness.readModel);
      expect(
        overtakenReadModel.threads.find((thread) => thread.id === threadId)?.latestTurn?.turnId,
      ).toBe(successorTurnId);
      yield* Effect.promise(() =>
        waitFor(async () => {
          const obligation = await runtime!.runPromise(readObligation);
          return obligation?.state === "completed";
        }),
      );
      expect((yield* readObligation)?.state).toBe("completed");
    }),
  );

  // A steer can fail because the provider already abandoned the turn the
  // projection still shows as running — a lost settle event or a dead adapter
  // thread. Nothing else ever settles that phantom: every later message parks
  // behind it until a manual Stop (observed live 2026-08-30, 4m48s of queued
  // messages behind a turn Codex reported as no longer active). The reconcile
  // probe re-checks after a grace and dispatches the same session stop the
  // Stop button sends, sparing the parked delivery so it promotes on its own.
  it("settles a phantom running turn when the provider rejects its steer", async () => {
    const harness = await createHarness({ staleSteerReconcileGraceMs: 120 });
    const threadId = ThreadId.make("thread-1");
    const hostTurnId = asTurnId("turn-phantom-steer-host");
    const freshTurnId = asTurnId("turn-phantom-steer-fresh");

    let sendTurnCalls = 0;
    harness.sendTurn.mockImplementation(
      (
        _rawInput: unknown,
        _options?: ProviderServiceSendTurnOptions,
      ): Effect.Effect<
        { threadId: ThreadId; turnId: TurnId },
        ProviderAdapterRequestError | ProviderAdapterProcessError
      > =>
        Effect.suspend(() => {
          sendTurnCalls += 1;
          if (sendTurnCalls === 1) {
            const index = harness.runtimeSessions.findIndex(
              (session) => session.threadId === threadId,
            );
            const session = index >= 0 ? harness.runtimeSessions[index] : undefined;
            if (session !== undefined) {
              harness.runtimeSessions[index] = {
                ...session,
                status: "running",
                activeTurnId: hostTurnId,
              };
            }
            return Effect.succeed({ threadId, turnId: hostTurnId });
          }
          if (sendTurnCalls === 2) {
            return Effect.fail(
              new ProviderAdapterRequestError({
                provider: "codex",
                method: "turn/steer",
                detail: "turn is no longer active",
              }),
            );
          }
          return Effect.succeed({ threadId, turnId: freshTurnId });
        }),
    );

    const dispatchTurn = (commandId: string, messageId: string, createdAt: string) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(commandId),
          threadId,
          message: {
            messageId: asMessageId(messageId),
            role: "user",
            text: messageId,
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        }),
      );
    const readObligation = (messageId: string) =>
      Effect.runPromise(
        harness.threadWorkObligations
          .getByKey({
            threadId,
            sourceTurnId: activeTurnWorkSourceId(asMessageId(messageId)),
            kind: "active-turn-recovery",
          })
          .pipe(Effect.map(Option.getOrUndefined)),
      );

    await dispatchTurn(
      "cmd-phantom-steer-host",
      "message-phantom-steer-host",
      "2026-01-01T00:00:01.000Z",
    );
    await waitFor(() => sendTurnCalls === 1);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-phantom-steer-host-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: hostTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await waitFor(async () => {
      const obligation = await readObligation("message-phantom-steer-host");
      return obligation?.state === "executing";
    });

    // The provider abandons the turn without any settle event reaching the
    // projection: the live session goes idle while the projection still says
    // "running".
    const runtimeIndex = harness.runtimeSessions.findIndex(
      (session) => session.threadId === threadId,
    );
    const runtimeSession = runtimeIndex >= 0 ? harness.runtimeSessions[runtimeIndex] : undefined;
    if (runtimeSession === undefined) {
      throw new Error("Expected the host provider session to exist.");
    }
    harness.runtimeSessions[runtimeIndex] = { ...runtimeSession, status: "ready" };

    const steerMessageId = "message-phantom-steer-follow-up";
    await dispatchTurn("cmd-phantom-steer-follow-up", steerMessageId, "2026-01-01T00:00:03.000Z");
    await waitFor(() => sendTurnCalls >= 2);

    // The probe settles the phantom, the spared parked delivery promotes the
    // message as a fresh turn, and the stale host turn is left incomplete.
    await waitFor(async () => {
      const obligation = await readObligation(steerMessageId);
      return obligation?.state === "completed" && sendTurnCalls >= 3;
    });
    const hostTurn = await Effect.runPromise(
      harness.projectionTurns
        .getByTurnId({ threadId, turnId: hostTurnId })
        .pipe(Effect.map(Option.getOrUndefined)),
    );
    expect(hostTurn?.state).toBe("incomplete");
  });

  // The counterpart guard: a transient steer failure against a turn the
  // provider is still genuinely running must reconcile nothing — the message
  // stays parked and delivers at the natural turn boundary, exactly the
  // pre-probe behavior.
  it("leaves a live turn alone when a steer fails transiently", async () => {
    const harness = await createHarness({ staleSteerReconcileGraceMs: 60 });
    const threadId = ThreadId.make("thread-1");
    const hostTurnId = asTurnId("turn-live-steer-host");

    let sendTurnCalls = 0;
    harness.sendTurn.mockImplementation(
      (
        _rawInput: unknown,
        _options?: ProviderServiceSendTurnOptions,
      ): Effect.Effect<
        { threadId: ThreadId; turnId: TurnId },
        ProviderAdapterRequestError | ProviderAdapterProcessError
      > =>
        Effect.suspend(() => {
          sendTurnCalls += 1;
          if (sendTurnCalls === 1) {
            const index = harness.runtimeSessions.findIndex(
              (session) => session.threadId === threadId,
            );
            const session = index >= 0 ? harness.runtimeSessions[index] : undefined;
            if (session !== undefined) {
              harness.runtimeSessions[index] = {
                ...session,
                status: "running",
                activeTurnId: hostTurnId,
              };
            }
            return Effect.succeed({ threadId, turnId: hostTurnId });
          }
          return Effect.fail(
            new ProviderAdapterRequestError({
              provider: "codex",
              method: "turn/steer",
              detail: "temporarily unavailable",
              failureKind: "retryable-upstream",
            }),
          );
        }),
    );

    const dispatchTurn = (commandId: string, messageId: string, createdAt: string) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(commandId),
          threadId,
          message: {
            messageId: asMessageId(messageId),
            role: "user",
            text: messageId,
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        }),
      );
    const readObligation = (messageId: string) =>
      Effect.runPromise(
        harness.threadWorkObligations
          .getByKey({
            threadId,
            sourceTurnId: activeTurnWorkSourceId(asMessageId(messageId)),
            kind: "active-turn-recovery",
          })
          .pipe(Effect.map(Option.getOrUndefined)),
      );

    await dispatchTurn(
      "cmd-live-steer-host",
      "message-live-steer-host",
      "2026-01-01T00:00:01.000Z",
    );
    await waitFor(() => sendTurnCalls === 1);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-live-steer-host-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: hostTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await waitFor(async () => {
      const obligation = await readObligation("message-live-steer-host");
      return obligation?.state === "executing";
    });

    const steerMessageId = "message-live-steer-follow-up";
    await dispatchTurn("cmd-live-steer-follow-up", steerMessageId, "2026-01-01T00:00:03.000Z");
    await waitFor(() => sendTurnCalls >= 2);

    // Wait well past the grace: the probe must observe the live session still
    // running the steered turn and reconcile nothing.
    await Effect.runPromise(Effect.sleep(300));

    const model = await harness.readModel();
    const thread = model.threads.find((candidate) => candidate.id === threadId);
    expect(thread?.session?.status).toBe("running");
    expect(thread?.session?.activeTurnId).toBe(hostTurnId);
    const parked = await readObligation(steerMessageId);
    expect(parked?.state).toBe("pending");
    expect(sendTurnCalls).toBe(2);
  });

  // Full-flow regression for the mid-turn send ("steer") pipeline: a steer is
  // injected into the live turn immediately when the provider accepts it, the
  // parked delivery resolves without double-sending, a steer the provider
  // rejects stays parked and delivers at turn end, and the user's Stop never
  // drops a parked message.
  it("uses the admitted no-receipt steer policy after a receipt-capable registry snapshot", async () => {
    const harness = await createHarness({
      getCapabilitiesEffect: () =>
        Effect.succeed({
          sessionModelSwitch: "in-session" as const,
          messageDeliveryReceipts: true,
        }),
      nativeRouteCapabilitiesEffect: () =>
        Effect.succeed({
          sessionModelSwitch: "in-session" as const,
          messageDeliveryReceipts: false,
        }),
    });
    const threadId = ThreadId.make("thread-1");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const hostTurnId = asTurnId("turn-steer-finalization-host");

    const dispatchTurn = (commandId: string, messageId: string, createdAt: string) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(commandId),
          threadId,
          message: {
            messageId: asMessageId(messageId),
            role: "user",
            text: messageId,
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        }),
      );
    const readObligation = (messageId: string) =>
      Effect.runPromise(
        harness.threadWorkObligations
          .getByKey({
            threadId,
            sourceTurnId: activeTurnWorkSourceId(asMessageId(messageId)),
            kind: "active-turn-recovery",
          })
          .pipe(Effect.map(Option.getOrUndefined)),
      );
    const readPendingTurn = (messageId: string) =>
      Effect.runPromise(
        harness.projectionTurns.getPendingTurnStart({
          threadId,
          messageId: asMessageId(messageId),
        }),
      );

    harness.sendTurn.mockImplementation(
      (
        _rawInput: unknown,
        options?: ProviderServiceSendTurnOptions,
      ): Effect.Effect<{ threadId: ThreadId; turnId: TurnId }, never> =>
        Effect.sync(() => {
          options?.onNativeDispatchRoute?.({
            providerInstanceId,
            sessionGeneration: null,
            messageDeliveryReceipts: false,
          });
          const index = harness.runtimeSessions.findIndex(
            (session) => session.threadId === threadId,
          );
          const session = index >= 0 ? harness.runtimeSessions[index] : undefined;
          const liveTurnId = session?.activeTurnId;
          if (session?.status === "running" && liveTurnId !== undefined) {
            return { threadId, turnId: liveTurnId };
          }
          if (session !== undefined) {
            harness.runtimeSessions[index] = {
              ...session,
              status: "running",
              activeTurnId: hostTurnId,
            };
          }
          return { threadId, turnId: hostTurnId };
        }),
    );

    await dispatchTurn(
      "cmd-steer-finalization-host",
      "message-steer-finalization-host",
      "2026-01-01T00:00:01.000Z",
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const runtimeIndex = harness.runtimeSessions.findIndex(
      (session) => session.threadId === threadId,
    );
    const runtimeSession = runtimeIndex >= 0 ? harness.runtimeSessions[runtimeIndex] : undefined;
    if (runtimeSession === undefined) {
      throw new Error("Expected the host provider session to exist.");
    }
    harness.runtimeSessions[runtimeIndex] = {
      ...runtimeSession,
      status: "running",
      activeTurnId: hostTurnId,
    };
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-steer-finalization-host-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "approval-required",
          activeTurnId: hostTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await waitFor(async () => {
      const obligation = await readObligation("message-steer-finalization-host");
      return obligation?.state === "executing";
    });

    // This harness adapter does not declare durable delivery receipts. Its
    // successful send result is therefore the acceptance boundary, so the
    // temporary marker and exact pending placeholder finalize immediately.
    const immediateMessageId = "message-steer-finalization-immediate";
    await dispatchTurn(
      "cmd-steer-finalization-immediate",
      immediateMessageId,
      "2026-01-01T00:00:03.000Z",
    );
    await waitFor(async () => {
      const obligation = await readObligation(immediateMessageId);
      return obligation?.state === "completed" && obligation.blockedReason === null;
    });
    expect(Option.isNone(await readPendingTurn(immediateMessageId))).toBe(true);

    // Hold a second steer in sendTurn, then project its durable receipt first.
    // When the delayed send subsequently fails, its fallback transition is
    // stale and must lose the blocked-reason CAS instead of rearming delivery.
    const racedMessageId = "message-steer-finalization-receipt-race";
    let racedSendSettled = false;
    const racedSend = Effect.runSync(Deferred.make<{ threadId: ThreadId; turnId: TurnId }>());
    harness.sendTurn.mockImplementation(
      (
        rawInput: unknown,
        options?: ProviderServiceSendTurnOptions,
      ): Effect.Effect<{ threadId: ThreadId; turnId: TurnId }, never> => {
        options?.onNativeDispatchRoute?.({
          providerInstanceId,
          sessionGeneration: null,
          messageDeliveryReceipts: false,
        });
        const messageId = (rawInput as { readonly messageId?: string }).messageId;
        if (messageId !== racedMessageId) {
          return Effect.succeed({ threadId, turnId: hostTurnId });
        }
        return Deferred.await(racedSend).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              racedSendSettled = true;
            }),
          ),
        );
      },
    );

    let staleFallbackAttempted = false;
    const transition = harness.threadWorkObligations.transition;
    vi.spyOn(harness.threadWorkObligations, "transition").mockImplementation((input) =>
      transition(input).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (
              input.state === "pending" &&
              input.expectedBlockedReason === ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON
            ) {
              staleFallbackAttempted = true;
            }
          }),
        ),
      ),
    );

    await dispatchTurn(
      "cmd-steer-finalization-receipt-race",
      racedMessageId,
      "2026-01-01T00:00:04.000Z",
    );
    await waitFor(async () => {
      const obligation = await readObligation(racedMessageId);
      return (
        obligation?.state === "completed" &&
        obligation.blockedReason === ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON
      );
    });
    expect(Option.isSome(await readPendingTurn(racedMessageId))).toBe(true);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-steer-finalization-delivery-receipt"),
        threadId,
        activity: {
          id: EventId.make("activity-steer-finalization-delivery-receipt"),
          tone: "info",
          kind: "message.delivered",
          summary: "Message delivered to the provider",
          payload: { messageId: racedMessageId },
          turnId: hostTurnId,
          createdAt: "2026-01-01T00:00:04.100Z",
        },
        createdAt: "2026-01-01T00:00:04.100Z",
      }),
    );
    await waitFor(async () => {
      const obligation = await readObligation(racedMessageId);
      return obligation?.state === "completed" && obligation.blockedReason === null;
    });
    expect(Option.isNone(await readPendingTurn(racedMessageId))).toBe(true);

    await Effect.runPromise(
      Deferred.die(racedSend, new Error("late send failure after durable receipt")),
    );
    await waitFor(() => racedSendSettled && staleFallbackAttempted);

    expect(await readObligation(racedMessageId)).toMatchObject({
      state: "completed",
      blockedReason: null,
    });
    expect(Option.isNone(await readPendingTurn(racedMessageId))).toBe(true);
    expect(
      harness.sendTurn.mock.calls.filter(
        (call) => (call[0] as { readonly messageId?: string }).messageId === racedMessageId,
      ),
    ).toHaveLength(1);
  });

  it("uses the admitted receipt-capable steer policy after a non-receipt registry snapshot", async () => {
    const threadId = ThreadId.make("thread-1");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const hostTurnId = asTurnId("turn-exact-delivery-receipt-host");
    const steerMessageId = asMessageId("message-exact-delivery-receipt-steer");
    const harness = await createHarness({
      getCapabilitiesEffect: () =>
        Effect.succeed({
          sessionModelSwitch: "in-session" as const,
          messageDeliveryReceipts: false,
        }),
      nativeRouteCapabilitiesEffect: () =>
        Effect.succeed({
          sessionModelSwitch: "in-session" as const,
          messageDeliveryReceipts: true,
        }),
      sendTurnEffect: (_rawInput, _runtimeSessions, options) =>
        (options?.onNativeDispatch ?? Effect.void).pipe(
          Effect.as({ threadId, turnId: hostTurnId }),
        ),
    });
    const dispatchTurn = (commandId: string, messageId: MessageId, createdAt: string) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(commandId),
          threadId,
          message: {
            messageId,
            role: "user",
            text: String(messageId),
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        }),
      );
    const readSteerObligation = () =>
      Effect.runPromise(
        harness.threadWorkObligations
          .getByKey({
            threadId,
            sourceTurnId: activeTurnWorkSourceId(steerMessageId),
            kind: "active-turn-recovery",
          })
          .pipe(Effect.map(Option.getOrUndefined)),
      );

    await dispatchTurn(
      "cmd-exact-delivery-receipt-host",
      asMessageId("message-exact-delivery-receipt-host"),
      "2026-01-01T00:00:01.000Z",
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const liveSession = harness.runtimeSessions[0];
    if (liveSession === undefined) throw new Error("provider session was not started");
    harness.runtimeSessions[0] = {
      ...liveSession,
      status: "running",
      activeTurnId: hostTurnId,
    };
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-exact-delivery-receipt-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "approval-required",
          activeTurnId: hostTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await harness.drain();

    await dispatchTurn(
      "cmd-exact-delivery-receipt-steer",
      steerMessageId,
      "2026-01-01T00:00:03.000Z",
    );
    await waitFor(async () => {
      const obligation = await readSteerObligation();
      return (
        obligation?.state === "completed" &&
        obligation.blockedReason === ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON
      );
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-wrong-delivery-receipt"),
        threadId,
        activity: {
          id: EventId.make("activity-wrong-delivery-receipt"),
          tone: "info",
          kind: "message.delivered",
          summary: "Different message delivered",
          payload: { messageId: "message-some-other-steer" },
          turnId: hostTurnId,
          createdAt: "2026-01-01T00:00:03.100Z",
        },
        createdAt: "2026-01-01T00:00:03.100Z",
      }),
    );
    expect(await readSteerObligation()).toMatchObject({
      state: "completed",
      blockedReason: ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON,
    });
    expect(
      Option.isSome(
        await Effect.runPromise(
          harness.projectionTurns.getPendingTurnStart({ threadId, messageId: steerMessageId }),
        ),
      ),
    ).toBe(true);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-exact-delivery-receipt"),
        threadId,
        activity: {
          id: EventId.make("activity-exact-delivery-receipt"),
          tone: "info",
          kind: "message.delivered",
          summary: "Message delivered to the provider",
          payload: { messageId: steerMessageId },
          turnId: hostTurnId,
          createdAt: "2026-01-01T00:00:03.200Z",
        },
        createdAt: "2026-01-01T00:00:03.200Z",
      }),
    );
    await waitFor(async () => {
      const obligation = await readSteerObligation();
      return obligation?.state === "completed" && obligation.blockedReason === null;
    });
    expect(
      Option.isNone(
        await Effect.runPromise(
          harness.projectionTurns.getPendingTurnStart({ threadId, messageId: steerMessageId }),
        ),
      ),
    ).toBe(true);
    await harness.drain();
  });

  it("dispatches a live user steer before slow session work finishes", async () => {
    const sessionWorkEntered = await Effect.runPromise(Deferred.make<void>());
    const releaseSessionWork = await Effect.runPromise(Deferred.make<void>());
    const steerAccepted = await Effect.runPromise(Deferred.make<void>());
    const threadId = ThreadId.make("thread-1");
    const activeTurnId = asTurnId("turn-priority-steer-host");
    const steerMessageId = asMessageId("message-priority-steer");
    let startCount = 0;
    let holdSessionWork = false;
    let didBlockSessionWork = false;
    const harness = await createHarness({
      startSessionEffect: (session) => {
        startCount += 1;
        return Effect.succeed(session);
      },
      getCapabilitiesEffect: () =>
        holdSessionWork && !didBlockSessionWork
          ? Effect.sync(() => {
              didBlockSessionWork = true;
            }).pipe(
              Effect.andThen(Deferred.succeed(sessionWorkEntered, undefined)),
              Effect.andThen(Deferred.await(releaseSessionWork)),
              Effect.as({ sessionModelSwitch: "in-session" as const }),
            )
          : Effect.succeed({ sessionModelSwitch: "in-session" as const }),
      sendTurnEffect: (rawInput) => {
        const messageId = (rawInput as { readonly messageId?: MessageId }).messageId;
        return (
          messageId === steerMessageId ? Deferred.succeed(steerAccepted, undefined) : Effect.void
        ).pipe(Effect.as({ threadId, turnId: activeTurnId }));
      },
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-priority-steer-host"),
        threadId,
        message: {
          messageId: asMessageId("message-priority-steer-host"),
          role: "user",
          text: "Start the long turn.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    const liveSession = harness.runtimeSessions[0];
    if (liveSession === undefined) throw new Error("provider session was not started");
    harness.runtimeSessions[0] = {
      ...liveSession,
      status: "running",
      activeTurnId,
    };
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-priority-steer-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await harness.drain();
    holdSessionWork = true;

    // Hold ordinary session reconfiguration before it can tear down the live
    // provider. The priority lane must still reach the exact native turn.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-priority-steer-slow-resume"),
        threadId,
        runtimeMode: "full-access",
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );
    await Effect.runPromise(Deferred.await(sessionWorkEntered).pipe(Effect.timeout("5 seconds")));

    try {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-priority-steer"),
          threadId,
          message: {
            messageId: steerMessageId,
            role: "user",
            text: "Change direction immediately.",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt: "2026-01-01T00:00:04.000Z",
        }),
      );

      await Effect.runPromise(Deferred.await(steerAccepted).pipe(Effect.timeout("5 seconds")));
      expect(startCount).toBe(1);
      expect(
        harness.sendTurn.mock.calls.some((call) => {
          const input = call[0] as ProviderSendTurnInput;
          return (
            input.messageId === steerMessageId &&
            input.liveSteerTarget?.providerInstanceId === ProviderInstanceId.make("codex") &&
            input.liveSteerTarget.activeTurnId === activeTurnId
          );
        }),
      ).toBe(true);
    } finally {
      await Effect.runPromise(Deferred.succeed(releaseSessionWork, undefined));
    }

    await harness.drain();
    expect(startCount).toBe(2);
  });

  it("starts repeated live steers in FIFO order before either provider response resolves", async () => {
    const firstSteerEntered = await Effect.runPromise(Deferred.make<void>());
    const secondSteerEntered = await Effect.runPromise(Deferred.make<void>());
    const releaseFirstNativeAdmission = await Effect.runPromise(Deferred.make<void>());
    const releaseSteers = await Effect.runPromise(Deferred.make<void>());
    const followupWorkEntered = await Effect.runPromise(Deferred.make<void>());
    const releaseFollowupWork = await Effect.runPromise(Deferred.make<void>());
    let blockFollowupWork = false;
    let dispatchFollowupWork: Effect.Effect<void> = Effect.void;
    const threadId = ThreadId.make("thread-1");
    const activeTurnId = asTurnId("turn-repeated-steer-host");
    const firstMessageId = asMessageId("message-repeated-steer-first");
    const secondMessageId = asMessageId("message-repeated-steer-second");
    const harness = await createHarness({
      getCapabilitiesEffect: () =>
        blockFollowupWork
          ? Deferred.succeed(followupWorkEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFollowupWork)),
              Effect.as({ sessionModelSwitch: "in-session" as const }),
            )
          : Effect.succeed({ sessionModelSwitch: "in-session" as const }),
      sendTurnEffect: (rawInput, _runtimeSessions, options) => {
        const input = rawInput as ProviderSendTurnInput;
        const entered =
          input.messageId === firstMessageId
            ? firstSteerEntered
            : input.messageId === secondMessageId
              ? secondSteerEntered
              : undefined;
        if (entered === undefined) {
          return Effect.succeed({ threadId, turnId: activeTurnId });
        }
        const waitForAdmission =
          input.messageId === firstMessageId
            ? Deferred.await(releaseFirstNativeAdmission)
            : Effect.void;
        return waitForAdmission.pipe(
          Effect.andThen(options?.onNativeDispatch ?? Effect.void),
          Effect.andThen(Deferred.succeed(entered, undefined)),
          Effect.andThen(Deferred.await(releaseSteers)),
          Effect.andThen(
            input.messageId === secondMessageId
              ? Effect.sync(() => {
                  blockFollowupWork = true;
                }).pipe(Effect.andThen(Effect.suspend(() => dispatchFollowupWork)))
              : Effect.void,
          ),
          Effect.as({ threadId, turnId: activeTurnId }),
        );
      },
    });
    dispatchFollowupWork = harness.engine
      .dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-repeated-steer-followup-work"),
        threadId,
        runtimeMode: "full-access",
        createdAt: "2026-01-01T00:00:05.000Z",
      })
      .pipe(Effect.asVoid, Effect.orDie);

    const dispatchTurn = (
      commandId: string,
      messageId: MessageId,
      createdAt: string,
      modelSelection?: ModelSelection,
    ) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(commandId),
          threadId,
          message: {
            messageId,
            role: "user",
            text: String(messageId),
            attachments: [],
          },
          ...(modelSelection === undefined ? {} : { modelSelection }),
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        }),
      );

    await dispatchTurn(
      "cmd-repeated-steer-host",
      asMessageId("message-repeated-steer-host"),
      "2026-01-01T00:00:01.000Z",
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const liveSession = harness.runtimeSessions[0];
    if (liveSession === undefined) throw new Error("provider session was not started");
    harness.runtimeSessions[0] = {
      ...liveSession,
      status: "running",
      activeTurnId,
    };
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-repeated-steer-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await harness.drain();

    await dispatchTurn("cmd-repeated-steer-first", firstMessageId, "2026-01-01T00:00:03.000Z");
    await dispatchTurn("cmd-repeated-steer-second", secondMessageId, "2026-01-01T00:00:04.000Z", {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex-next",
    });
    await waitFor(() =>
      harness.sendTurn.mock.calls.some(
        (call) => (call[0] as ProviderSendTurnInput).messageId === firstMessageId,
      ),
    );
    expect(
      harness.sendTurn.mock.calls.some(
        (call) => (call[0] as ProviderSendTurnInput).messageId === secondMessageId,
      ),
    ).toBe(false);

    await Effect.runPromise(Deferred.succeed(releaseFirstNativeAdmission, undefined));
    await Effect.runPromise(
      Effect.all([Deferred.await(firstSteerEntered), Deferred.await(secondSteerEntered)], {
        concurrency: 2,
      }).pipe(Effect.timeout("5 seconds")),
    );

    expect(
      harness.sendTurn.mock.calls
        .map((call) => (call[0] as ProviderSendTurnInput).messageId)
        .filter((messageId) => messageId === firstMessageId || messageId === secondMessageId),
    ).toEqual([firstMessageId, secondMessageId]);

    const drainCompleted = await Effect.runPromise(Deferred.make<void>());
    const drainFiber = Effect.runFork(
      harness.drainEffect.pipe(Effect.andThen(Deferred.succeed(drainCompleted, undefined))),
    );
    await Effect.runPromise(Effect.yieldNow);
    expect(await Effect.runPromise(Deferred.isDone(drainCompleted))).toBe(false);

    await Effect.runPromise(Deferred.succeed(releaseSteers, undefined));
    await Effect.runPromise(Deferred.await(followupWorkEntered).pipe(Effect.timeout("5 seconds")));
    expect(await Effect.runPromise(Deferred.isDone(drainCompleted))).toBe(false);
    await Effect.runPromise(Deferred.succeed(releaseFollowupWork, undefined));
    await Effect.runPromise(Fiber.join(drainFiber).pipe(Effect.timeout("5 seconds")));
  });

  it("re-arms a steer when restart teardown removed its exact live target", async () => {
    const restartEntered = await Effect.runPromise(Deferred.make<void>());
    const releaseRestart = await Effect.runPromise(Deferred.make<void>());
    const threadId = ThreadId.make("thread-1");
    const activeTurnId = asTurnId("turn-restart-teardown-host");
    const steerMessageId = asMessageId("message-restart-teardown-steer");
    let startCount = 0;
    const harness = await createHarness({
      serializeSessionLifecycle: true,
      startSessionEffect: (session, runtimeSessions) => {
        startCount += 1;
        if (startCount !== 2) return Effect.succeed(session);
        runtimeSessions.splice(0, runtimeSessions.length);
        return Deferred.succeed(restartEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseRestart)),
          Effect.as(session),
        );
      },
      sendTurnEffect: (rawInput, runtimeSessions) => {
        const input = rawInput as ProviderSendTurnInput;
        if (input.messageId !== steerMessageId || input.liveSteerTarget === undefined) {
          return Effect.succeed({ threadId, turnId: activeTurnId });
        }
        const target = input.liveSteerTarget;
        const targetIsLive = runtimeSessions.some(
          (session) =>
            session.threadId === threadId &&
            session.providerInstanceId === target?.providerInstanceId &&
            session.status === "running" &&
            session.activeTurnId === target?.activeTurnId,
        );
        return targetIsLive
          ? Effect.succeed({ threadId, turnId: activeTurnId })
          : Effect.fail(
              new ProviderAdapterRequestError({
                provider: "codex",
                method: "turn/steer",
                detail: "exact live turn was removed by restart teardown",
              }),
            );
      },
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-restart-teardown-host"),
        threadId,
        message: {
          messageId: asMessageId("message-restart-teardown-host"),
          role: "user",
          text: "Start the long turn.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const liveSession = harness.runtimeSessions[0];
    if (liveSession === undefined) throw new Error("provider session was not started");
    harness.runtimeSessions[0] = {
      ...liveSession,
      status: "running",
      activeTurnId,
    };
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-restart-teardown-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await harness.drain();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-restart-teardown-slow-resume"),
        threadId,
        runtimeMode: "full-access",
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );
    await Effect.runPromise(Deferred.await(restartEntered).pipe(Effect.timeout("5 seconds")));
    expect(harness.runtimeSessions).toHaveLength(0);

    try {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-restart-teardown-steer"),
          threadId,
          message: {
            messageId: steerMessageId,
            role: "user",
            text: "Change direction immediately.",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt: "2026-01-01T00:00:04.000Z",
        }),
      );
      await waitFor(() =>
        harness.sendTurn.mock.calls.some(
          (call) => (call[0] as ProviderSendTurnInput).messageId === steerMessageId,
        ),
      );
      await waitFor(async () => {
        const obligation = await Effect.runPromise(
          harness.threadWorkObligations.getByKey({
            threadId,
            sourceTurnId: activeTurnWorkSourceId(steerMessageId),
            kind: "active-turn-recovery",
          }),
        );
        return Option.isSome(obligation) && obligation.value.state === "pending";
      });
      expect(startCount).toBe(2);
    } finally {
      await Effect.runPromise(Deferred.succeed(releaseRestart, undefined));
    }

    await harness.drain();
    await waitFor(
      () =>
        harness.sendTurn.mock.calls.filter(
          (call) => (call[0] as ProviderSendTurnInput).messageId === steerMessageId,
        ).length === 2,
    );
    await waitFor(async () => {
      const obligation = await Effect.runPromise(
        harness.threadWorkObligations.getByKey({
          threadId,
          sourceTurnId: activeTurnWorkSourceId(steerMessageId),
          kind: "active-turn-recovery",
        }),
      );
      return Option.isSome(obligation) && obligation.value.state === "completed";
    });
    expect(startCount).toBe(2);
  });

  it("injects steers into a running turn and parks them when the provider refuses", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-1");
    const codex = ProviderInstanceId.make("codex");
    const refuseSteerFor = new Set<string>();
    let startedTurns = 0;
    harness.sendTurn.mockImplementation(
      (
        rawInput: unknown,
        options?: ProviderServiceSendTurnOptions,
      ): Effect.Effect<{ threadId: ThreadId; turnId: TurnId }, never> =>
        Effect.sync(() =>
          options?.onNativeDispatchRoute?.({
            providerInstanceId: codex,
            sessionGeneration: null,
            messageDeliveryReceipts: false,
          }),
        ).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              const request = rawInput as { readonly messageId?: string };
              const index = harness.runtimeSessions.findIndex(
                (session) => session.threadId === threadId,
              );
              const live = index >= 0 ? harness.runtimeSessions[index] : undefined;
              const liveTurnId = live?.activeTurnId ?? undefined;
              if (live?.status === "running" && liveTurnId !== undefined) {
                // Mid-turn send = steer attempt against the live turn.
                if (request.messageId !== undefined && refuseSteerFor.has(request.messageId)) {
                  return Effect.die(
                    new ProviderAdapterRequestError({
                      provider: "codex",
                      method: "turn/steer",
                      detail: "steer refused in test",
                    }),
                  );
                }
                return (options?.onNativeDispatch ?? Effect.void).pipe(
                  Effect.as({ threadId, turnId: liveTurnId }),
                );
              }
              startedTurns += 1;
              const turnId = asTurnId(`turn-live-${startedTurns}`);
              if (index >= 0 && live !== undefined) {
                harness.runtimeSessions[index] = {
                  ...live,
                  status: "running",
                  activeTurnId: turnId,
                };
              }
              return Effect.succeed({ threadId, turnId });
            }),
          ),
        ),
    );
    const providerIdle = () => {
      const index = harness.runtimeSessions.findIndex((session) => session.threadId === threadId);
      if (index >= 0) {
        const existing = harness.runtimeSessions[index];
        if (existing !== undefined) {
          harness.runtimeSessions[index] = {
            ...existing,
            status: "ready",
            activeTurnId: undefined,
          };
        }
      }
    };
    const dispatchTurn = (commandId: string, messageId: string, text: string, createdAt: string) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(commandId),
          threadId,
          message: { messageId: asMessageId(messageId), role: "user", text, attachments: [] },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        }),
      );
    const setSession = (
      commandId: string,
      status: "running" | "ready",
      activeTurnId: TurnId | null,
      updatedAt: string,
    ) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(commandId),
          threadId,
          session: {
            threadId,
            status,
            providerName: "codex",
            providerInstanceId: codex,
            runtimeMode: "approval-required",
            activeTurnId,
            lastError: null,
            updatedAt,
          },
          createdAt: updatedAt,
        }),
      );
    const obligationState = async (messageId: string) => {
      const row = await Effect.runPromise(
        harness.threadWorkObligations.getByKey({
          threadId,
          sourceTurnId: activeTurnWorkSourceId(asMessageId(messageId)),
          kind: "active-turn-recovery",
        }),
      );
      return Option.getOrUndefined(row)?.state;
    };
    const deliveredMessageIds = () =>
      harness.sendTurn.mock.calls.map(
        (call) => (call[0] as { readonly messageId?: string }).messageId,
      );

    // Message 1 starts a turn; its delivery obligation becomes the supervisor.
    await dispatchTurn(
      "cmd-steer-msg1",
      "steer-msg-1",
      "start working",
      "2026-01-01T00:00:01.000Z",
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await setSession(
      "cmd-steer-running-1",
      "running",
      asTurnId("turn-live-1"),
      "2026-01-01T00:00:02.000Z",
    );
    await waitFor(async () => (await obligationState("steer-msg-1")) === "executing");

    // Reproduce the production race: on a supervisor-less running session the
    // scheduler can claim the durable delivery before the event reactor gets
    // to its live-steer branch. The reactor must take over this executing row
    // instead of leaving the message queued for the blocking turn's lifetime.
    const firstObligation = Option.getOrThrow(
      await Effect.runPromise(
        harness.threadWorkObligations.getByKey({
          threadId,
          sourceTurnId: activeTurnWorkSourceId(asMessageId("steer-msg-1")),
          kind: "active-turn-recovery",
        }),
      ),
    );
    expect(
      await Effect.runPromise(
        harness.threadWorkObligations.transition({
          obligationId: firstObligation.obligationId,
          expectedState: "executing",
          expectedAttempt: firstObligation.attempt,
          state: "completed",
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: null,
          updatedAt: "2026-01-01T00:00:02.250Z",
        }),
      ),
    ).toBe(true);
    await Effect.runPromise(
      harness.threadWorkObligations.insert({
        obligationId: `thread-work:active-turn-recovery:${threadId}:turn-start:steer-msg-2`,
        threadId,
        sourceTurnId: activeTurnWorkSourceId(asMessageId("steer-msg-2")),
        kind: "active-turn-recovery",
        state: "executing",
        providerInstanceId: codex,
        attempt: 1,
        nextAttemptAt: null,
        claimedAt: "2026-01-01T00:00:02.500Z",
        leaseExpiresAt: "2026-01-01T00:01:02.500Z",
        blockedReason: null,
        createdAt: "2026-01-01T00:00:02.500Z",
        updatedAt: "2026-01-01T00:00:02.500Z",
      }),
    );

    // Message 2 mid-turn: the provider accepts the steer, so it reaches the
    // agent immediately and its parked delivery resolves as completed.
    await dispatchTurn("cmd-steer-msg2", "steer-msg-2", "steer me", "2026-01-01T00:00:03.000Z");
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(deliveredMessageIds()[1]).toBe("steer-msg-2");
    await waitFor(async () => (await obligationState("steer-msg-2")) === "completed");
    expect(await obligationState("steer-msg-1")).toBe("completed");

    // Message 3 mid-turn: the provider refuses the steer (turn boundary race,
    // old binary). The message parks and must not dispatch while the turn runs.
    refuseSteerFor.add("steer-msg-3");
    await dispatchTurn("cmd-steer-msg3", "steer-msg-3", "park me", "2026-01-01T00:00:04.000Z");
    await waitFor(() => harness.sendTurn.mock.calls.length === 3); // the refused steer attempt
    expect(await obligationState("steer-msg-3")).toBe("pending");
    expect(await obligationState("steer-msg-1")).toBe("completed");

    // Turn 1 completes: the parked message delivers as its own turn.
    providerIdle();
    await setSession("cmd-steer-idle-1", "ready", null, "2026-01-01T00:00:05.000Z");
    await waitFor(
      () => harness.sendTurn.mock.calls.length === 4 && deliveredMessageIds()[3] === "steer-msg-3",
    );
    await setSession(
      "cmd-steer-running-2",
      "running",
      asTurnId("turn-live-2"),
      "2026-01-01T00:00:06.000Z",
    );
    await waitFor(async () => (await obligationState("steer-msg-3")) === "executing");

    // Messages 4 and 5 arrive mid-turn 2 and both steers are refused. Stop must
    // preserve the entire parked batch, then the scheduler must deliver it in
    // original FIFO order rather than keeping only the newest correction.
    refuseSteerFor.add("steer-msg-4");
    await dispatchTurn("cmd-steer-msg4", "steer-msg-4", "after stop", "2026-01-01T00:00:07.000Z");
    await waitFor(() => harness.sendTurn.mock.calls.length === 5); // refused steer attempt
    expect(await obligationState("steer-msg-4")).toBe("pending");
    refuseSteerFor.add("steer-msg-5");
    await dispatchTurn(
      "cmd-steer-msg5",
      "steer-msg-5",
      "also after stop",
      "2026-01-01T00:00:07.500Z",
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 6); // second refused steer attempt
    expect(await obligationState("steer-msg-5")).toBe("pending");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-steer-interrupt"),
        threadId,
        turnId: asTurnId("turn-live-2"),
        createdAt: "2026-01-01T00:00:08.000Z",
      }),
    );
    expect(await obligationState("steer-msg-4")).toBe("pending");
    expect(await obligationState("steer-msg-5")).toBe("pending");
    const attemptsBeforeRelease = harness.sendTurn.mock.calls.length;
    providerIdle();
    await setSession("cmd-steer-idle-2", "ready", null, "2026-01-01T00:00:09.000Z");
    await waitFor(() => harness.sendTurn.mock.calls.length === attemptsBeforeRelease + 1);
    expect(deliveredMessageIds()[attemptsBeforeRelease]).toBe("steer-msg-4");

    await setSession(
      "cmd-steer-running-3",
      "running",
      asTurnId("turn-live-3"),
      "2026-01-01T00:00:10.000Z",
    );
    providerIdle();
    await setSession("cmd-steer-idle-3", "ready", null, "2026-01-01T00:00:11.000Z");
    await waitFor(() => harness.sendTurn.mock.calls.length === attemptsBeforeRelease + 2);
    expect(deliveredMessageIds()[attemptsBeforeRelease + 1]).toBe("steer-msg-5");

    await setSession(
      "cmd-steer-running-4",
      "running",
      asTurnId("turn-live-4"),
      "2026-01-01T00:00:12.000Z",
    );
    providerIdle();
    await setSession("cmd-steer-idle-4", "ready", null, "2026-01-01T00:00:13.000Z");
    await waitFor(
      async () =>
        (await obligationState("steer-msg-4")) === "completed" &&
        (await obligationState("steer-msg-5")) === "completed",
    );
    // The steered message was consumed by the live turn — it must not be
    // re-delivered as its own turn afterwards.
    expect(deliveredMessageIds().filter((messageId) => messageId === "steer-msg-2")).toHaveLength(
      1,
    );
  });

  it("parks a Default-mode settings update instead of steering it into the Agent turn", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-1");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const activeTurnId = asTurnId("turn-settings-agent-active");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-settings-agent-mode"),
        threadId,
        interactionMode: "agent",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-settings-agent-turn"),
        threadId,
        message: {
          messageId: asMessageId("message-settings-agent-turn"),
          role: "user",
          text: "Keep working in Agent mode.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const runtimeIndex = harness.runtimeSessions.findIndex(
      (session) => session.threadId === threadId,
    );
    const runtimeSession = harness.runtimeSessions[runtimeIndex];
    if (runtimeSession === undefined) throw new Error("provider session was not started");
    harness.runtimeSessions[runtimeIndex] = {
      ...runtimeSession,
      status: "running",
      activeTurnId,
    };
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-settings-agent-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "approval-required",
          activeTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-settings-default-mode"),
        threadId,
        interactionMode: "default",
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );
    const settingsMessageId = asMessageId("message-settings-default-mode");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-settings-default-turn"),
        threadId,
        message: {
          messageId: settingsMessageId,
          role: "user",
          text: "Settings updated: interaction mode to Default. Apply these settings immediately.",
          attachments: [],
        },
        interactionMode: "default",
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId,
      turnId: activeTurnId,
    });
    const obligation = Option.getOrUndefined(
      await Effect.runPromise(
        harness.threadWorkObligations.getByKey({
          threadId,
          sourceTurnId: activeTurnWorkSourceId(settingsMessageId),
          kind: "active-turn-recovery",
        }),
      ),
    );
    expect(obligation?.state).toBe("pending");
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    const readModel = await harness.readModel();
    expect(readModel.threads.find((thread) => thread.id === threadId)?.interactionMode).toBe(
      "default",
    );
  });

  it("generates a thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Generated title" }));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-seed"),
        threadId: ThreadId.make("thread-1"),
        title: seededTitle,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      message: "Please investigate reconnect failures after restarting the session.",
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Generated title"
      );
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Generated title");
  });

  it("does not overwrite an existing custom thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-custom"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep this custom title",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-preserve"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-preserve"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep this custom title");
  });

  it("matches the client-seeded title even when the outgoing prompt is reformatted", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Fix reconnect spinner on resume";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({
        title: "Reconnect spinner resume bug",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-formatted-seed"),
        threadId: ThreadId.make("thread-1"),
        title: seededTitle,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-formatted"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-formatted"),
          role: "user",
          text: "[effort:high]\\n\\nFix reconnect spinner on resume",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Reconnect spinner resume bug"
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Reconnect spinner resume bug");
  });

  it("generates a worktree branch name for the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-branch"),
        threadId: ThreadId.make("thread-1"),
        branch: "t3code/1234abcd",
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );

    harness.generateBranchName.mockImplementation((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "modelSelection" in input &&
          typeof input.modelSelection === "object" &&
          input.modelSelection !== null &&
          "model" in input.modelSelection &&
          typeof input.modelSelection.model === "string"
            ? `feature/${input.modelSelection.model}`
            : "feature/generated",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-branch-model"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-branch-model"),
          role: "user",
          text: "Add a safer reconnect backoff.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateBranchName.mock.calls.length === 1);
    await waitFor(() => harness.refreshStatus.mock.calls.length === 1);
    expect(harness.generateBranchName.mock.calls[0]?.[0]).toMatchObject({
      message: "Add a safer reconnect backoff.",
    });
    expect(harness.refreshStatus.mock.calls[0]?.[0]).toBe("/tmp/provider-project-worktree");
  });

  it("forwards codex model options through session start and turn send", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-fast"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-fast"),
          role: "user",
          text: "hello fast mode",
          attachments: [],
        },
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ]),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    });
  });

  it("forwards claude effort options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort"),
          role: "user",
          text: "hello with effort",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("forwards claude fast mode options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-fast-mode"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-fast-mode"),
          role: "user",
          text: "hello with fast mode",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "fastMode", value: true }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
    });
  });

  it("forwards plan interaction mode to the provider turn request", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-interaction-mode-set-plan"),
        threadId: ThreadId.make("thread-1"),
        interactionMode: "plan",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-plan"),
          role: "user",
          text: "plan this change",
          attachments: [],
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      interactionMode: "plan",
    });
  });

  it("preserves the active session model when in-session model switching is unsupported", async () => {
    const harness = await createHarness({ sessionModelSwitch: "unsupported" });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
    });
  });

  it("restarts the same-thread provider session and hands off context when in-session model switching is unsupported", async () => {
    const harness = await createHarness({ sessionModelSwitch: "unsupported" });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-model-restart-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-model-restart-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-model-restart-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-model-restart-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.1-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.1-codex",
      },
    });
    expect(harness.startSession.mock.calls[1]?.[1]).not.toHaveProperty("resumeCursor");
    const handoff = JSON.parse(
      (harness.sendTurn.mock.calls[1]?.[0] as { input?: string } | undefined)?.input ?? "{}",
    ) as {
      kind?: string;
      context?: { handoff?: { reason?: string } };
      currentRequest?: string;
    };
    expect(handoff).toMatchObject({
      kind: "t3.provider-handoff-turn",
      context: { handoff: { reason: "manual_model_switch" } },
      currentRequest: "second",
    });
  });

  it("starts a first turn on the requested provider instance even when it differs from the thread model", async () => {
    const harness = await createHarness({
      threadModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-first"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-first"),
          role: "user",
          text: "hello claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerName).toBe("claudeAgent");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("claudeAgent"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBeUndefined();
  });

  it("reuses the same provider session when runtime mode is unchanged", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);
  });

  it("restarts an existing Codex thread on a compatible requested instance without reusing its cursor", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex_work"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex_work"),
    });
    expect(harness.startSession.mock.calls[1]?.[1]).not.toHaveProperty("resumeCursor");
    const handoff = JSON.parse(
      (harness.sendTurn.mock.calls[1]?.[0] as { input?: string } | undefined)?.input ?? "{}",
    ) as {
      kind?: string;
      context?: { handoff?: { reason?: string } };
      currentRequest?: string;
    };
    expect(handoff).toMatchObject({
      kind: "t3.provider-handoff-turn",
      context: { handoff: { reason: "manual_provider_switch" } },
      currentRequest: "second",
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
  });

  it("restarts the provider session when the thread workspace changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-1"),
          role: "user",
          text: "first in project root",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-worktree-change"),
        threadId: ThreadId.make("thread-1"),
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-2"),
          role: "user",
          text: "second in worktree",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project-worktree",
      resumeCursor: { opaque: "resume-1" },
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("restarts claude sessions when claude effort changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-1"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "medium" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-2"),
          role: "user",
          text: "second claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("restarts claude after metadata advances before a fast-mode settings turn", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";
    const fastSelection = createModelSelection(
      ProviderInstanceId.make("claudeAgent"),
      "claude-opus-4-6",
      [{ id: "fastMode", value: true }],
    );
    const normalSelection = createModelSelection(
      ProviderInstanceId.make("claudeAgent"),
      "claude-opus-4-6",
      [{ id: "fastMode", value: false }],
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-fast-on"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-fast-on"),
          role: "user",
          text: "first fast turn",
          attachments: [],
        },
        modelSelection: fastSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    // The UI persists the desired metadata before it starts the settings turn.
    // That projection must not be mistaken for the live SDK session state.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-fast-off-metadata"),
        threadId: ThreadId.make("thread-1"),
        modelSelection: normalSelection,
      }),
    );
    await waitFor(async () => {
      const readModel = await harness.readModel();
      return Equal.equals(
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.modelSelection,
        normalSelection,
      );
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-fast-off"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-fast-off"),
          role: "user",
          text: "Settings updated: normal speed. Apply these settings immediately.",
          attachments: [],
        },
        modelSelection: normalSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      modelSelection: normalSelection,
    });
  });

  it("restarts the provider session when runtime mode is updated on the thread", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-1"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      resumeCursor: { opaque: "resume-1" },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("does not inject derived model options when restarting claude on runtime mode changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-runtime-mode-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-claude-no-options"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("does not stop the active session when restart fails before rebind", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access-2"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-restart-failure-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-restart-failure-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    harness.startSession.mockImplementationOnce(
      (_: unknown, __: unknown) => Effect.fail("simulated restart failure") as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-restart-failure"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await harness.drain();

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(1);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("full-access");
  });

  it("interrupts a live bound thread and continues on another provider with a JSON handoff", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const sourceTurnId = asTurnId("turn-provider-switch-source");
    let sendCount = 0;
    harness.sendTurn.mockImplementation(
      (_rawInput: unknown): Effect.Effect<{ threadId: ThreadId; turnId: TurnId }, never> =>
        Effect.sync(() => {
          sendCount += 1;
          if (sendCount === 1) {
            const index = harness.runtimeSessions.findIndex(
              (session) => session.threadId === ThreadId.make("thread-1"),
            );
            const session = index >= 0 ? harness.runtimeSessions[index] : undefined;
            if (session !== undefined) {
              harness.runtimeSessions[index] = {
                ...session,
                status: "running",
                activeTurnId: sourceTurnId,
              };
            }
          }
          return {
            threadId: ThreadId.make("thread-1"),
            turnId: sendCount === 1 ? sourceTurnId : asTurnId("turn-provider-switch-destination"),
          };
        }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const runtimeIndex = harness.runtimeSessions.findIndex(
      (session) => session.threadId === ThreadId.make("thread-1"),
    );
    const runtimeSession = harness.runtimeSessions[runtimeIndex];
    if (runtimeSession === undefined) throw new Error("provider session was not started");
    harness.runtimeSessions[runtimeIndex] = {
      ...runtimeSession,
      status: "running",
      activeTurnId: sourceTurnId,
    };
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-running-before-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: sourceTurnId,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    expect(harness.interruptTurn).toHaveBeenCalledWith({
      threadId: ThreadId.make("thread-1"),
      turnId: sourceTurnId,
    });
    expect(harness.stopSession).toHaveBeenCalledWith({
      threadId: ThreadId.make("thread-1"),
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-ready-after-provider-switch-interrupt"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    });
    expect(harness.startSession.mock.calls[1]?.[1]).not.toHaveProperty("resumeCursor");
    const handoff = JSON.parse(
      (harness.sendTurn.mock.calls[1]?.[0] as { input?: string } | undefined)?.input ?? "{}",
    ) as {
      kind?: string;
      context?: { handoff?: { reason?: string } };
      currentRequest?: string;
    };
    expect(handoff).toMatchObject({
      kind: "t3.provider-handoff-turn",
      context: { handoff: { reason: "manual_provider_switch" } },
      currentRequest: "second",
    });

    await harness.drain();
    await waitFor(async () => {
      const projected = (await harness.readModel()).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      return (
        projected?.activities.some((activity) => activity.kind === "provider.handoff.completed") ??
        false
      );
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerName).toBe("claudeAgent");
    expect(thread?.session?.providerInstanceId).toBe("claudeAgent");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.handoff.completed"),
    ).toMatchObject({
      summary: "Switched from codex to claudeAgent",
      payload: expect.objectContaining({
        targetModel: "claude-opus-4-6",
        immediateRequirement: "second",
      }),
    });
  });

  it("terminalizes a failed provider switch instead of retrying it", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-1");
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-provider-switch-failure-source"),
        threadId,
        message: {
          messageId: asMessageId("user-provider-switch-failure-source"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    harness.sendTurn.mockImplementationOnce(
      () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "claudeAgent",
            method: "thread.turn.start",
            detail: "Provider validation rejected the handoff",
          }),
        ) as never,
    );
    const messageId = asMessageId("user-provider-switch-failure-target");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-provider-switch-failure-target"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "switch to Claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );

    const sourceTurnId = activeTurnWorkSourceId(messageId);
    await waitFor(async () => {
      const work = await Effect.runPromise(
        harness.threadWorkObligations
          .getByKey({ threadId, sourceTurnId, kind: "active-turn-recovery" })
          .pipe(Effect.map(Option.getOrUndefined)),
      );
      return work?.state === "cancelled";
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(harness.sendTurn).toHaveBeenCalledTimes(2);
    expect(thread?.session?.status).toBe("error");
    expect(thread?.session?.lastError).toContain("Provider validation rejected the handoff");
    expect(
      thread?.activities.filter((activity) => activity.kind === "provider.turn.start.failed"),
    ).toHaveLength(1);
  });

  it("continues a stopped projected thread on another provider with a JSON handoff", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "stopped",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-meta-update-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stopped-provider-switch"),
          role: "user",
          text: "continue with claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    });
    expect(harness.startSession.mock.calls[0]?.[1]).not.toHaveProperty("resumeCursor");
    const handoff = JSON.parse(
      (harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined)?.input ?? "{}",
    ) as {
      kind?: string;
      context?: { handoff?: { reason?: string } };
      currentRequest?: string;
    };
    expect(handoff).toMatchObject({
      kind: "t3.provider-handoff-turn",
      context: { handoff: { reason: "manual_provider_switch" } },
      currentRequest: "continue with claude",
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerName).toBe("claudeAgent");
    expect(thread?.session?.providerInstanceId).toBe("claudeAgent");
  });

  it("reacts to thread.turn.interrupt-requested by calling provider interrupt", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.runtimeSessions.push({
      threadId: ThreadId.make("thread-1"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      activeTurnId: asTurnId("provider-turn-1"),
      createdAt: now,
      updatedAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
    });
    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    expect(harness.stopSession.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
    });
    expect(harness.runtimeSessions).toHaveLength(0);
    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session).toMatchObject({
      status: "stopped",
      activeTurnId: null,
    });
  });

  it("promotes the queued Grok batch and records the durable cutoff", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const messageIds = [
      MessageId.make("queued-grok-message-1"),
      MessageId.make("queued-grok-message-2"),
    ];

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-grok-session-set"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "grok",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("grok-turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.queued-turn.promote",
        commandId: CommandId.make("cmd-promote-grok-queue"),
        threadId,
        messageIds,
        createdAt: "2026-01-01T00:00:05.000Z",
      }),
    );

    await waitFor(() => harness.promoteQueuedTurn.mock.calls.length === 1);
    expect(harness.promoteQueuedTurn).toHaveBeenCalledWith({ threadId, messageIds });
    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({
        kind: "provider.queue.promoted",
        summary: "Queued messages sent now",
        createdAt: "2026-01-01T00:00:05.000Z",
        payload: {
          messageIds: ["queued-grok-message-1", "queued-grok-message-2"],
          requestId: "cmd-promote-grok-queue",
        },
      }),
    );
  });

  it("deduplicates the exact promoted batch after remount or an ambiguous RPC retry", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const messageIds = [
      MessageId.make("queued-grok-message-1"),
      MessageId.make("queued-grok-message-2"),
    ];

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-grok-session-set-idempotent-promotion"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "grok",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("grok-turn-idempotent-promotion"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.queued-turn.promote",
        commandId: CommandId.make("cmd-promote-original"),
        threadId,
        messageIds,
        createdAt: "2026-01-01T00:00:05.000Z",
      }),
    );
    await harness.drain();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-stop-before-duplicate-promotion"),
        threadId,
        session: {
          threadId,
          status: "stopped",
          providerName: "grok",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:06.000Z",
        },
        createdAt: "2026-01-01T00:00:06.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.queued-turn.promote",
        commandId: CommandId.make("cmd-promote-retry-after-remount"),
        threadId,
        messageIds,
        createdAt: "2026-01-01T00:00:07.000Z",
      }),
    );
    await harness.drain();

    expect(harness.promoteQueuedTurn).toHaveBeenCalledTimes(1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(
      thread?.activities
        .filter((activity) => activity.kind === "provider.queue.promoted")
        .map((activity) => activity.payload),
    ).toEqual([
      { messageIds, requestId: "cmd-promote-original" },
      { messageIds, requestId: "cmd-promote-retry-after-remount" },
    ]);
  });

  it("serializes concurrent retries of the same exact promotion batch", async () => {
    const promotionStarted = await Effect.runPromise(Deferred.make<void>());
    const releasePromotion = await Effect.runPromise(Deferred.make<void>());
    const harness = await createHarness({
      promoteQueuedTurnEffect: (input) =>
        Deferred.succeed(promotionStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releasePromotion)),
          Effect.as(input.messageIds ?? []),
        ),
    });
    const now = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const messageIds = [
      MessageId.make("queued-grok-message-1"),
      MessageId.make("queued-grok-message-2"),
    ];

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-grok-session-set-concurrent-promotion-retry"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "grok",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("grok-turn-concurrent-promotion-retry"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.queued-turn.promote",
        commandId: CommandId.make("cmd-promote-concurrent-original"),
        threadId,
        messageIds,
        createdAt: "2026-01-01T00:00:05.000Z",
      }),
    );
    await Effect.runPromise(Deferred.await(promotionStarted));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.queued-turn.promote",
        commandId: CommandId.make("cmd-promote-concurrent-retry"),
        threadId,
        messageIds,
        createdAt: "2026-01-01T00:00:06.000Z",
      }),
    );
    await Effect.runPromise(Deferred.succeed(releasePromotion, undefined));
    await harness.drain();

    expect(harness.promoteQueuedTurn).toHaveBeenCalledTimes(1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(
      thread?.activities
        .filter((activity) => activity.kind === "provider.queue.promoted")
        .map((activity) => activity.payload),
    ).toEqual([
      { messageIds, requestId: "cmd-promote-concurrent-original" },
      { messageIds, requestId: "cmd-promote-concurrent-retry" },
    ]);
  });

  it("filters durably covered messages before replaying a partial promotion batch", async () => {
    const harness = await createHarness({
      promoteQueuedTurnEffect: (input) => Effect.succeed(input.messageIds ?? []),
    });
    const now = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const coveredMessageId = MessageId.make("queued-grok-message-covered");
    const remainingMessageId = MessageId.make("queued-grok-message-remaining");
    const messageIds = [coveredMessageId, remainingMessageId];

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-grok-session-set-partial-promotion-replay"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "grok",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("grok-turn-partial-promotion-replay"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-covered-message-delivered-before-promotion-replay"),
        threadId,
        activity: {
          id: EventId.make("activity-covered-message-delivered-before-promotion-replay"),
          tone: "info",
          kind: "message.delivered",
          summary: "Message delivered to the provider",
          payload: { messageId: coveredMessageId },
          turnId: asTurnId("grok-turn-partial-promotion-replay"),
          createdAt: "2026-01-01T00:00:04.000Z",
        },
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );
    await harness.drain();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.queued-turn.promote",
        commandId: CommandId.make("cmd-promote-partially-covered-replay"),
        threadId,
        messageIds,
        createdAt: "2026-01-01T00:00:05.000Z",
      }),
    );
    await harness.drain();

    expect(harness.promoteQueuedTurn).toHaveBeenCalledTimes(1);
    expect(harness.promoteQueuedTurn).toHaveBeenCalledWith({
      threadId,
      messageIds: [remainingMessageId],
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({
        kind: "provider.queue.promoted",
        payload: {
          messageIds,
          requestId: "cmd-promote-partially-covered-replay",
        },
      }),
    );
  });

  it("records a correlated terminal failure when queued promotion has no provider session", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-1");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.queued-turn.promote",
        commandId: CommandId.make("cmd-promote-missing-session"),
        threadId,
        createdAt: "2026-01-01T00:00:05.000Z",
      }),
    );
    await harness.drain();

    expect(harness.promoteQueuedTurn).not.toHaveBeenCalled();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({
        kind: "provider.queue.promote.failed",
        payload: expect.objectContaining({
          requestId: "cmd-promote-missing-session",
          detail: expect.stringContaining("no longer has a provider session"),
        }),
      }),
    );
  });

  it("records a correlated terminal failure when the provider session already stopped", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-1");
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-grok-session-set-stopped-promotion"),
        threadId,
        session: {
          threadId,
          status: "stopped",
          providerName: "grok",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.queued-turn.promote",
        commandId: CommandId.make("cmd-promote-stopped-session"),
        threadId,
        createdAt: "2026-01-01T00:00:05.000Z",
      }),
    );
    await harness.drain();

    expect(harness.promoteQueuedTurn).not.toHaveBeenCalled();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({
        kind: "provider.queue.promote.failed",
        payload: expect.objectContaining({
          requestId: "cmd-promote-stopped-session",
          detail: expect.stringContaining("session is stopped, not running"),
        }),
      }),
    );
  });

  it("records a correlated terminal failure when the provider rejects queued promotion", async () => {
    const harness = await createHarness({
      promoteQueuedTurnEffect: () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "Grok",
            method: "x.ai/queue/interject",
            detail: "the native queue retained the requested prompt",
            failureKind: "retryable-upstream",
          }),
        ),
    });
    const now = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-grok-session-set-for-rejection"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "grok",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("grok-turn-rejected-promotion"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.queued-turn.promote",
        commandId: CommandId.make("cmd-promote-provider-rejection"),
        threadId,
        createdAt: "2026-01-01T00:00:05.000Z",
      }),
    );
    await harness.drain();

    expect(harness.promoteQueuedTurn).toHaveBeenCalledWith({ threadId });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({
        kind: "provider.queue.promote.failed",
        payload: expect.objectContaining({
          requestId: "cmd-promote-provider-rejection",
          detail: expect.stringContaining("native queue retained"),
        }),
      }),
    );
    expect(thread?.activities.some((activity) => activity.kind === "provider.queue.promoted")).toBe(
      false,
    );
  });

  it("releases the thread on interrupt even when the provider session cannot be stopped", async () => {
    // Observed 2026-08-06: a usage-limited Codex session pinned a thread in
    // `running` for three hours. Stop is authoritative over T3's own state and
    // only best-effort over the provider's, so a provider that will not die
    // must still not leave the thread claiming to work — otherwise the spinner
    // never clears and there is no way back short of restarting the app.
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.stopSession.mockImplementation((() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "Codex",
          method: "session.stop",
          detail: "the provider process is not responding",
        }),
      )) as unknown as (input: unknown) => Effect.Effect<void>);
    harness.runtimeSessions.push({
      threadId: ThreadId.make("thread-1"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      activeTurnId: asTurnId("provider-turn-1"),
      createdAt: now,
      updatedAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt-wedged"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session).toMatchObject({
      status: "stopped",
      activeTurnId: null,
    });
    // The failure is still surfaced — it is reported, not swallowed.
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.turn.interrupt.failed"),
    ).toBe(true);
  });

  it("clears a session still claiming an active turn after the provider already stopped", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stale"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "stopped",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt-stale"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
      }),
    );

    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session).toMatchObject({ status: "stopped", activeTurnId: null });
    // Nothing was live upstream, so Stop must not manufacture a provider call.
    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.interruptTurn.mock.calls.length).toBe(0);
  });

  it("reacts to thread.task.stop by killing that task and leaving the session alone", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.runtimeSessions.push({
      threadId: ThreadId.make("thread-1"),
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      status: "running",
      runtimeMode: "approval-required",
      activeTurnId: asTurnId("provider-turn-1"),
      createdAt: now,
      updatedAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.task.stop",
        commandId: CommandId.make("cmd-task-stop"),
        threadId: ThreadId.make("thread-1"),
        taskId: RuntimeTaskId.make("task-7"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.stopTask.mock.calls.length === 1);
    expect(harness.stopTask.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      taskId: "task-7",
    });
    // A per-task kill must never take the turn or the session with it.
    expect(harness.interruptTurn.mock.calls.length).toBe(0);
    expect(harness.stopSession.mock.calls.length).toBe(0);

    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session).toMatchObject({ status: "running" });
    // Without a synthesised terminal activity the row keeps claiming to run.
    expect(
      thread?.activities.some(
        (entry) =>
          entry.kind === "task.completed" &&
          (entry.payload as { taskId?: string; status?: string } | null)?.taskId === "task-7" &&
          (entry.payload as { status?: string } | null)?.status === "stopped",
      ),
    ).toBe(true);
  });

  it("does not queue a turn interrupt behind a blocked task kill", async () => {
    const taskStopStarted = await Effect.runPromise(Deferred.make<void>());
    const releaseTaskStop = await Effect.runPromise(Deferred.make<void>());
    const harness = await createHarness({
      stopTaskEffect: () =>
        Deferred.succeed(taskStopStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseTaskStop)),
        ),
    });
    const now = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-control-plane");
    harness.runtimeSessions.push({
      threadId,
      provider: ProviderDriverKind.make("grok"),
      providerInstanceId: ProviderInstanceId.make("grok"),
      status: "running",
      runtimeMode: "approval-required",
      activeTurnId: turnId,
      createdAt: now,
      updatedAt: now,
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-control-plane-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "grok",
          providerInstanceId: ProviderInstanceId.make("grok"),
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.task.stop",
        commandId: CommandId.make("cmd-control-plane-task-stop"),
        threadId,
        taskId: RuntimeTaskId.make("task-blocked"),
        createdAt: now,
      }),
    );
    await Effect.runPromise(Deferred.await(taskStopStarted).pipe(Effect.timeout("2 seconds")));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-control-plane-turn-interrupt"),
        threadId,
        turnId,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1, 2_000);
    expect(harness.interruptTurn).toHaveBeenCalledWith({ threadId });
    expect(harness.stopTask.mock.calls.length).toBe(1);

    await Effect.runPromise(Deferred.succeed(releaseTaskStop, undefined));
    await harness.drain();
  });

  it("does not queue Grok send-now behind blocked ordinary provider work", async () => {
    const taskStopStarted = await Effect.runPromise(Deferred.make<void>());
    const releaseTaskStop = await Effect.runPromise(Deferred.make<void>());
    const harness = await createHarness({
      stopTaskEffect: () =>
        Deferred.succeed(taskStopStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseTaskStop)),
        ),
    });
    const now = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-promote-control-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "grok",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("grok-turn-control"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.task.stop",
        commandId: CommandId.make("cmd-promote-control-blocker"),
        threadId,
        taskId: RuntimeTaskId.make("task-blocking-normal-lane"),
        createdAt: now,
      }),
    );
    await Effect.runPromise(Deferred.await(taskStopStarted).pipe(Effect.timeout("2 seconds")));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.queued-turn.promote",
        commandId: CommandId.make("cmd-promote-control-send-now"),
        threadId,
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );

    await waitFor(() => harness.promoteQueuedTurn.mock.calls.length === 1, 2_000);
    expect(harness.promoteQueuedTurn).toHaveBeenCalledWith({ threadId });

    await Effect.runPromise(Deferred.succeed(releaseTaskStop, undefined));
    await harness.drain();
  });

  it("lets session Stop preempt an unknown-target queued promotion wait", async () => {
    const promotionStarted = await Effect.runPromise(Deferred.make<void>());
    const releasePromotion = await Effect.runPromise(Deferred.make<void>());
    const stopExecuted = await Effect.runPromise(Deferred.make<void>());
    const harness = await createHarness({
      promoteQueuedTurnEffect: () =>
        Deferred.succeed(promotionStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releasePromotion)),
          Effect.andThen(
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: "Grok",
                method: "x.ai/queue/interject",
                detail: "the session stopped while the target was awaiting native admission",
                failureKind: "retryable-upstream",
              }),
            ),
          ),
        ),
      stopSessionEffect: () =>
        Deferred.succeed(stopExecuted, undefined).pipe(
          Effect.andThen(Deferred.succeed(releasePromotion, undefined)),
          Effect.asVoid,
        ),
    });
    const now = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const requestId = CommandId.make("cmd-promote-preempted-by-session-stop");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-running-before-promotion-session-stop"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "grok",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("grok-turn-before-promotion-session-stop"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.queued-turn.promote",
        commandId: requestId,
        threadId,
        messageIds: [MessageId.make("unknown-native-target")],
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await Effect.runPromise(Deferred.await(promotionStarted));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-session-stop-preempts-promotion"),
        threadId,
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await Effect.runPromise(Deferred.await(stopExecuted));
    await harness.drain();

    expect(harness.stopSession).toHaveBeenCalledWith({ threadId });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({
        kind: "provider.queue.promote.failed",
        payload: expect.objectContaining({
          requestId,
          detail: expect.stringContaining("session stopped while the target"),
        }),
      }),
    );
  });

  it("lets turn interrupt preempt an unknown-target queued promotion wait", async () => {
    const promotionStarted = await Effect.runPromise(Deferred.make<void>());
    const releasePromotion = await Effect.runPromise(Deferred.make<void>());
    const interruptExecuted = await Effect.runPromise(Deferred.make<void>());
    const harness = await createHarness({
      promoteQueuedTurnEffect: () =>
        Deferred.succeed(promotionStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releasePromotion)),
          Effect.andThen(
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: "Grok",
                method: "x.ai/queue/interject",
                detail: "the turn ended while the target was awaiting native admission",
                failureKind: "retryable-upstream",
              }),
            ),
          ),
        ),
      interruptTurnEffect: () =>
        Deferred.succeed(interruptExecuted, undefined).pipe(
          Effect.andThen(Deferred.succeed(releasePromotion, undefined)),
          Effect.asVoid,
        ),
    });
    const now = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("grok-turn-before-promotion-interrupt");
    const requestId = CommandId.make("cmd-promote-preempted-by-turn-interrupt");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-running-before-promotion-interrupt"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "grok",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.queued-turn.promote",
        commandId: requestId,
        threadId,
        messageIds: [MessageId.make("unknown-native-target")],
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await Effect.runPromise(Deferred.await(promotionStarted));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt-preempts-promotion"),
        threadId,
        turnId,
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await Effect.runPromise(Deferred.await(interruptExecuted));
    await harness.drain();

    expect(harness.interruptTurn).toHaveBeenCalledWith({ threadId });
    expect(harness.stopSession).toHaveBeenCalledWith({ threadId });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({
        kind: "provider.queue.promote.failed",
        payload: expect.objectContaining({
          requestId,
          detail: expect.stringContaining("turn ended while the target"),
        }),
      }),
    );
  });

  it("does not queue one thread's interrupt behind another thread's blocked session stop", async () => {
    const sessionStopStarted = await Effect.runPromise(Deferred.make<void>());
    const releaseSessionStop = await Effect.runPromise(Deferred.make<void>());
    const stoppedThreadId = ThreadId.make("thread-1");
    const interruptedThreadId = ThreadId.make("thread-2");
    const harness = await createHarness({
      stopSessionEffect: ({ threadId }) =>
        threadId === stoppedThreadId
          ? Deferred.succeed(sessionStopStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseSessionStop)),
            )
          : Effect.void,
    });
    const now = "2026-01-01T00:00:00.000Z";
    const interruptedTurnId = asTurnId("turn-other-control-lane");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-create-other-control-thread"),
        threadId: interruptedThreadId,
        projectId: asProjectId("project-1"),
        title: "Other control thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-code-fast-1",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );
    for (const [threadId, activeTurnId] of [
      [stoppedThreadId, null],
      [interruptedThreadId, interruptedTurnId],
    ] as const) {
      harness.runtimeSessions.push({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        providerInstanceId: ProviderInstanceId.make("grok"),
        status: activeTurnId === null ? "ready" : "running",
        runtimeMode: "approval-required",
        ...(activeTurnId === null ? {} : { activeTurnId }),
        createdAt: now,
        updatedAt: now,
      });
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`cmd-set-control-session-${String(threadId)}`),
          threadId,
          session: {
            threadId,
            status: activeTurnId === null ? "ready" : "running",
            providerName: "grok",
            providerInstanceId: ProviderInstanceId.make("grok"),
            runtimeMode: "approval-required",
            activeTurnId,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-block-first-control-lane"),
        threadId: stoppedThreadId,
        createdAt: now,
      }),
    );
    await Effect.runPromise(Deferred.await(sessionStopStarted).pipe(Effect.timeout("2 seconds")));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-interrupt-other-control-lane"),
        threadId: interruptedThreadId,
        turnId: interruptedTurnId,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1, 2_000);
    expect(harness.interruptTurn).toHaveBeenCalledWith({ threadId: interruptedThreadId });

    await Effect.runPromise(Deferred.succeed(releaseSessionStop, undefined));
    await harness.drain();
  });

  it("settles the task row without calling the provider when no session is live", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.task.stop",
        commandId: CommandId.make("cmd-task-stop-dead"),
        threadId: ThreadId.make("thread-1"),
        taskId: RuntimeTaskId.make("task-9"),
        createdAt: now,
      }),
    );

    await harness.drain();
    expect(harness.stopTask.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.some(
        (entry) =>
          entry.kind === "task.completed" &&
          (entry.payload as { taskId?: string } | null)?.taskId === "task-9",
      ),
    ).toBe(true);
  });

  it("starts a fresh session when only projected session state exists", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stale"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stale"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stale"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });
  });

  it("rejects active runtime sessions that are missing provider instance ids", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    harness.runtimeSessions.push({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project",
      resumeCursor: { opaque: "resume-without-instance" },
      createdAt: now,
      updatedAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-missing-instance"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("without a provider instance id"),
      },
    });
  });

  it("reacts to thread.approval.respond by forwarding provider approval response", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-approval"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "accept",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToRequest.mock.calls.length === 1);
    expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "approval-request-1",
      decision: "accept",
    });
  });

  it("reacts to thread.user-input.respond by forwarding structured user input answers", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-user-input"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-user-input-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToUserInput.mock.calls.length === 1);
    expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "user-input-request-1",
      answers: {
        sandbox_mode: "workspace-write",
      },
    });
  });

  it("routes Solla-owned action approval responses without calling the provider adapter", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const requestId = asApprovalRequestId("solla-action-approval-request-1");
    const registration = await Effect.runPromise(
      harness.actionApprovalBroker.register({
        threadId: ThreadId.make("thread-1"),
        requestId,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-solla-action-approval-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId,
        answers: { t3_action_approval: "Approve" },
        createdAt: now,
      }),
    );

    expect(await Effect.runPromise(registration.answers.pipe(Effect.timeout("2 seconds")))).toEqual(
      {
        t3_action_approval: "Approve",
      },
    );
    expect(harness.respondToUserInput).not.toHaveBeenCalled();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-solla-action-approval-respond-duplicate"),
        threadId: ThreadId.make("thread-1"),
        requestId,
        answers: { t3_action_approval: "Approve" },
        createdAt: now,
      }),
    );
    await harness.drain();
    expect(harness.respondToUserInput).not.toHaveBeenCalled();
  });

  it("resumes a durable action approval in a fresh turn without blocking the MCP lane", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const requestId = asApprovalRequestId("action-approval:durable-request-1");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-durable-action-approval-requested"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-durable-action-approval-requested"),
          tone: "approval",
          kind: "user-input.requested",
          summary: "Action approval requested",
          payload: {
            requestId,
            questions: [],
            actionApproval: {
              actionKind: "publish_content",
              summary: "Publish Pawstalgia video to YouTube",
              preview: "Destination: @PawstalgiaTunes\nTitle: Gloria's Rainy Cottage",
            },
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-durable-action-approval-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId,
        answers: { t3_action_approval: "Approve" },
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find((entry) => entry.id === "thread-1");
      return (
        thread?.messages.some(
          (message) => message.id === `action-approval-response:${requestId}`,
        ) === true
      );
    });

    const thread = (await harness.readModel()).threads.find((entry) => entry.id === "thread-1");
    expect(harness.respondToUserInput).not.toHaveBeenCalled();
    expect(
      thread?.activities.some(
        (activity) =>
          activity.kind === "user-input.resolved" &&
          typeof activity.payload === "object" &&
          activity.payload !== null &&
          (activity.payload as Record<string, unknown>).requestId === requestId,
      ),
    ).toBe(true);
    expect(
      thread?.messages.find((message) => message.id === `action-approval-response:${requestId}`)
        ?.text,
    ).toContain("Proceed with exactly that action now");
    expect(
      thread?.messages.find((message) => message.id === `action-approval-response:${requestId}`)
        ?.text,
    ).toContain("Gloria's Rainy Cottage");
  });

  it("surfaces stale provider approval request failures without faking approval resolution", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.respondToRequest.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "session/request_permission",
          detail: "Unknown pending permission request: approval-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-approval-error"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-approval-requested"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-approval-requested"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: {
            requestId: "approval-request-1",
            requestKind: "command",
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond-stale"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "acceptForSession",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.approval.respond.failed",
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.approval.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "approval-request-1",
      detail: expect.stringContaining("Stale pending approval request: approval-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "approval.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "approval-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("delivers a non-resumable user-input answer as a message instead of losing it", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.respondToUserInput.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("claudeAgent"),
          method: "item/tool/respondToUserInput",
          detail: "Unknown pending Codex user input request: user-input-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-user-input-error"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-user-input-requested"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-user-input-requested"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "user-input-request-1",
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-user-input-respond-stale"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) =>
          activity.kind === "user-input.resolved" &&
          typeof activity.payload === "object" &&
          activity.payload !== null &&
          (activity.payload as Record<string, unknown>).requestId === "user-input-request-1",
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    // The person already answered; only the callback expired. Surfacing that
    // as a failure threw their words away and left the card open with a submit
    // button that could never succeed.
    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "user-input.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "user-input-request-1",
    );
    expect(resolvedActivity).toBeDefined();
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.user-input.respond.failed"),
    ).toBe(false);

    const deliveredMessage = thread?.messages.find(
      (message) => message.id === "user-input-response:user-input-request-1",
    );
    expect(deliveredMessage?.role).toBe("user");
    expect(deliveredMessage?.text).toContain("workspace-write");

    // The dead session still has to be released — left running, the turn never
    // settles and the thread stays permanently busy. What must NOT happen is
    // the thread being left stopped with the answer stranded: the delivered
    // message carries it into a fresh turn, so the thread ends up working
    // again rather than parked.
    await waitFor(async () => {
      const settled = await harness.readModel();
      const settledThread = settled.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return settledThread?.session?.status !== "stopped";
    });

    const settledModel = await harness.readModel();
    const settledThread = settledModel.threads.find(
      (entry) => entry.id === ThreadId.make("thread-1"),
    );
    expect(settledThread?.session?.status).not.toBe("stopped");
  });

  it("delivers an answer as a message when no session is bound to the thread", async () => {
    // The failure a person actually meets: the conversation ended, or the app
    // restarted, and the card is still on screen. Answering it reported
    // "No active provider session is bound to this thread" — a detail the
    // pending-input projection does not treat as resolving, so the card and
    // its submit button stayed forever and the answer was lost.
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-user-input-requested-no-session"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-user-input-requested-no-session"),
          tone: "info",
          kind: "user-input.requested",
          summary: "Agent asked a question",
          payload: {
            requestId: "user-input-request-no-session",
            questions: [
              {
                id: "budget",
                header: "Budget",
                question: "What monthly budget should I assume?",
                options: [{ label: "60", description: "Sixty per month" }],
              },
            ],
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-user-input-respond-no-session"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-no-session"),
        answers: { budget: "60 per month" },
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.messages.some(
          (message) => message.id === "user-input-response:user-input-request-no-session",
        ) === true
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    const delivered = thread?.messages.find(
      (message) => message.id === "user-input-response:user-input-request-no-session",
    );
    expect(delivered?.role).toBe("user");
    expect(delivered?.text).toContain("60 per month");
    expect(
      thread?.activities.some(
        (activity) =>
          activity.kind === "user-input.resolved" &&
          typeof activity.payload === "object" &&
          activity.payload !== null &&
          (activity.payload as Record<string, unknown>).requestId ===
            "user-input-request-no-session",
      ),
    ).toBe(true);
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.user-input.respond.failed"),
    ).toBe(false);
  });

  it("treats a late duplicate user-input response as a quiet no-op", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.respondToUserInput.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("claudeAgent"),
          method: "item/tool/respondToUserInput",
          detail: "Unknown pending Codex user input request: user-input-request-2",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-double-submit"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    // The answer already landed once: the adapter dropped its callback, so the
    // second submit reports the request as unknown even though the session is
    // healthy and mid-turn.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-activity-user-input-resolved"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-user-input-resolved"),
          tone: "info",
          kind: "user-input.resolved",
          summary: "User input resolved",
          payload: { requestId: "user-input-request-2" },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-user-input-respond-double"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-2"),
        answers: { sandbox_mode: "workspace-write" },
        createdAt: now,
      }),
    );

    await harness.drain();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.status).toBe("running");
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.user-input.respond.failed"),
    ).toBe(false);
    expect(harness.respondToUserInput).not.toHaveBeenCalled();
    expect(harness.stopSession).not.toHaveBeenCalled();
  });

  it("treats a late duplicate approval response as a quiet no-op", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-approval-double-submit"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-activity-approval-resolved"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-approval-resolved"),
          tone: "info",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: { requestId: "approval-request-2" },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond-double"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-2"),
        decision: "accept",
        createdAt: now,
      }),
    );

    await harness.drain();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.status).toBe("running");
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.approval.respond.failed"),
    ).toBe(false);
    expect(harness.respondToRequest).not.toHaveBeenCalled();
    expect(harness.stopSession).not.toHaveBeenCalled();
  });

  it("reacts to thread.session.stop by stopping provider session and clearing thread session state", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-stop"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex_work"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError:
            "this session has failed 5 turns in a row; refusing to start another until the cause is fixed. Stop and restart the session to reset the breaker.",
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.session?.status === "ready";
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-session-stop"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session).not.toBeNull();
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
    expect(thread?.session?.activeTurnId).toBeNull();
    expect(thread?.session?.lastError).toBeNull();
  });

  it("restarts a live provider session whose breaker has already tripped", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.runtimeSessions.push({
      threadId: ThreadId.make("thread-1"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      createdAt: now,
      updatedAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-breaker"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "error",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError:
            "this session has failed 5 turns in a row; refusing to start another until the cause is fixed. Stop and restart the session to reset the breaker.",
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-after-breaker"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-after-breaker"),
          role: "user",
          text: "try again",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.stopSession.mock.calls[0]?.[0]).toEqual({ threadId: "thread-1" });
  });
});
