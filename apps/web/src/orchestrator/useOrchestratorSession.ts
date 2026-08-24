import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  MessageId,
  ORCHESTRATOR_THREAD_ID,
  ProjectId,
  ThreadId,
  type DesktopOrchestratorBubbleState,
  type OrchestratorVoiceProvider,
} from "@t3tools/contracts";

import { useAtomValue } from "@effect/atom-react";
import { buildSettingsUpdatePrompt } from "@t3tools/shared/settingsPrompt";
import { createModelSelection } from "@t3tools/shared/model";

import { APP_VERSION } from "../branding";
import {
  getClientSettings,
  usePrimarySettings,
  useUpdatePrimarySettings,
} from "../hooks/useSettings";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useThreadShells } from "../state/entities";
import { vmAgentEnvironment } from "../state/vmAgents";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import { readPreparedConnection } from "../state/session";
import { primaryServerProvidersAtom } from "../state/server";
import { inferProjectTitleFromPath } from "../lib/projectPaths";
import { projectEnvironment } from "../state/projects";
import { terminalEnvironment } from "../state/terminal";
import { threadEnvironment } from "../state/threads";
import type { OrchestratorTerminalRecord } from "./terminals";
import { getProviderInstanceEntry, getProviderInstanceModels } from "../providerInstances";
import { getProviderModelCapabilities } from "../providerModels";
import {
  getAppModelOptionsForInstance,
  resolveAppModelSelectionForInstance,
} from "../modelSelection";
import { deriveProviderInstanceEntries } from "../providerInstances";
import {
  buildWorld,
  diffWorlds,
  shouldAnnounceEvent,
  type OrchestratorEvent,
  type OrchestratorWorld,
  workspaceBasename,
  type ProjectLookupEntry,
  type ThreadSnapshot,
} from "./events";
import { buildCompletionAnnouncement, describeEventFallback } from "./completionSummary";
import {
  buildWakeAnnouncement,
  decideWake,
  initialAwaitedWorkState,
  forgetAwaitedWork,
  noteSessionEnded,
  noteWoke,
  rememberAwaitedWork,
  resetWakeBudget,
  type AwaitedWorkState,
} from "./awaitedWork";
import { isEchoProneDevice, resolveInterruptWhileSpeaking } from "./echoProneDevice";
import { resolveVoiceCuePolicy } from "./voiceCues";
import { decideReconnect } from "./reconnect";
import { entriesSinceLastBoundary } from "./conversationBoundary";
import type { ProposedPlanInput } from "./proposedPlan";
import { createScreenWakeLock, findWakeLockRequester } from "./screenWakeLock";
import { createVoiceSession, type VoiceSession, type VoiceSessionState } from "./realtimeSession";
import type { RecentConversationEntry } from "./realtimeProtocol";
import {
  executeOrchestratorTool,
  OrchestratorToolError,
  type OrchestratorRuntimeReport,
  type OrchestratorSelfReport,
  type OrchestratorUsageReport,
  type ThreadSettingsPlan,
  type ThreadSettingsRequest,
} from "./tools";
import { MAX_TOOL_LOG_ENTRIES, type OrchestratorToolLogEntry } from "./toolRegistry";
import type { ThreadHistoryActivityInput, ThreadHistoryMessageInput } from "./threadHistory";
import { appendUsage, clearUsage, loadUsageDays } from "./usageStore";
import {
  dailyBuckets,
  estimateVoiceMinutes,
  localDayKey,
  monthlyBuckets,
  monthKeyOf,
  totalBucket,
  type UsageBucket,
  type UsageDay,
} from "./usageTracking";
import {
  deriveProviderUsageSummaries,
  providerUsageName,
} from "../components/chat/ProviderUsageBar";
import { useProviderUsageStore } from "../providerUsageStore";
import {
  describeSettingsForPrompt,
  matchModelSlug,
  reserveSettingsUpdatePrompt,
  resolveThreadSettings,
  type ProviderCatalog,
} from "./threadSettings";
import { useOrchestratorThread } from "./useOrchestratorThread";
import { randomUUID } from "../lib/utils";
import { ORCHESTRATOR_RUN_COMMAND_PATH } from "@t3tools/contracts";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  isRepeatedAssistantLine,
  isRepeatedUserLine,
  type TranscriptLine,
} from "./transcriptDedupe";
import type { OrchestratorCommandResult } from "./tools";
import { joinUrl } from "./realtimeSession";
import {
  reconcilePendingThreadTitles,
  rememberPendingThreadTitle,
  type PendingThreadTitles,
} from "./threadTitleOverrides";
import { createThreadCreationIntentGuard } from "./threadCreationIntentGuard";

/**
 * Whether the last thing voice reported was a fault or just an explanation.
 * Both reach the user; only one should be dressed as a failure.
 */
export type VoiceIssueSeverity = "error" | "notice";

export interface VoiceIssue {
  readonly message: string;
  readonly severity: VoiceIssueSeverity;
}

export interface OrchestratorSessionApi {
  readonly state: VoiceSessionState;
  readonly error: string | null;
  /** Severity of `error`; null exactly when `error` is null. */
  readonly errorSeverity: VoiceIssueSeverity | null;
  readonly transcript: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  /**
   * Live microphone and playback levels, 0..1.
   *
   * A subscription rather than state on purpose: these arrive at
   * animation-frame rate, and putting them through React would re-render the
   * whole overlay sixty times a second to move one shadow. Subscribers write
   * to a DOM node directly.
   *
   * Returns an unsubscribe function. Safe to call when no session is running —
   * the listener simply never fires.
   */
  readonly subscribeLevels: (
    listener: (levels: { readonly mic: number; readonly assistant: number }) => void,
  ) => () => void;
  /**
   * The assistant holds the floor while nothing is audible — the "let me check
   * that…" pause during a tool call.
   *
   * State rather than the ref the bubble publisher uses, because the overlay
   * renders from it: without this the mobile orb had no way to tell that pause
   * from an open microphone and showed both as an idle listening state, which
   * is the one moment the user most needs to know they cannot speak.
   */
  readonly working: boolean;
  /** Effective setting; may be safely forced off on an echo-prone handheld. */
  readonly canInterrupt: boolean;
  readonly canStart: boolean;
  readonly start: () => void;
  readonly stop: () => void;
  readonly toggle: () => void;
  /** Model the running session was minted with; null when nothing is running. */
  readonly activeModel: string | null;
  /**
   * Changes the realtime model the *voice* session speaks with, restarting a
   * live session so it applies now. Unrelated to the model the orchestrator
   * thread uses for typed chat, which is chosen in the composer.
   */
  readonly setOrchestratorModel: (model: string) => Promise<void>;
  readonly applyOrchestratorRealtime: (patch: {
    readonly provider?: OrchestratorVoiceProvider;
    readonly model?: string;
    readonly voice?: string;
  }) => Promise<void>;
  /** Most recent tool calls, newest first, for the settings pane. */
  readonly toolLog: ReadonlyArray<OrchestratorToolLogEntry>;
  /** Daily-per-model usage history, for the settings usage view. */
  readonly usageDays: ReadonlyArray<UsageDay>;
  readonly clearUsageHistory: () => void;
}

const MAX_TRANSCRIPT_ENTRIES = 40;
// Opening context is best-effort and races the microphone, so it gives up fast.
const RECENT_HISTORY_FETCH_TIMEOUT_MS = 1_500;
// An explicit read_thread is the user waiting on an answer, not a startup race.
// Sharing the 1.5s budget made a large thread abort mid-fetch, and the model —
// handed a bare abort error — narrated a background load that does not exist
// ("it's still loading that thread's messages") and then had nothing to come
// back with, because nothing was actually running.
const THREAD_READ_TIMEOUT_MS = 12_000;
const MAX_RECENT_HISTORY_ENTRIES = 30;
/**
 * Budget for reading what a finished thread actually said.
 *
 * Deliberately not the 1.5s startup budget it used to share. That races the
 * microphone, so on any real thread it lost — and the announcement fell back to
 * telling the user it could not read the result, which is the one thing they
 * already know. This is a background fetch with nobody waiting on it, so it can
 * afford to succeed.
 */
const COMPLETION_MESSAGE_FETCH_TIMEOUT_MS = 8_000;
const BUBBLE_LEVEL_PUBLISH_INTERVAL_MS = 80;

/** Search and listing results are read aloud, so they stay small. */
const PROJECT_TOOL_RESULT_LIMIT = 25;
const PROJECT_LISTING_LIMIT = 60;

/** Stands in for the agent registry until an environment is connected. */
const EMPTY_AGENT_REGISTRY_ATOM = Atom.make(null).pipe(
  Atom.withLabel("orchestrator-agent-registry:empty"),
);

/**
 * Folds a flat project file index into something answerable out loud.
 *
 * `projects.listEntries` returns the whole indexed tree; reading that back is
 * useless. This narrows to one folder level — the immediate children of the
 * requested path — which is what "what's in this project?" actually means.
 */
function summarizeProjectListing(
  entries: ReadonlyArray<{ readonly path: string }>,
  path: string | undefined,
): { directories: ReadonlyArray<string>; files: ReadonlyArray<string>; truncated: boolean } {
  const prefix = path === undefined ? "" : `${path.replace(/^\/+|\/+$/g, "")}/`;
  const directories = new Set<string>();
  const files: Array<string> = [];

  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) continue;
    const rest = entry.path.slice(prefix.length);
    if (rest.length === 0) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) files.push(rest);
    else directories.add(rest.slice(0, slash));
  }

  const truncated = files.length > PROJECT_LISTING_LIMIT;
  return {
    directories: [...directories].sort().slice(0, PROJECT_LISTING_LIMIT),
    files: files.sort().slice(0, PROJECT_LISTING_LIMIT),
    truncated,
  };
}

function readString(source: object, key: string): string {
  return key in source && typeof (source as Record<string, unknown>)[key] === "string"
    ? ((source as Record<string, unknown>)[key] as string)
    : "";
}

/**
 * One thread's stored conversation, straight off the snapshot endpoint the UI
 * renders threads from.
 *
 * Decoded by hand rather than through the contract schema: this runs inside the
 * voice session's tool path, where a thread from a server one version ahead
 * must degrade to "the fields I recognize" instead of throwing and taking the
 * whole tool call with it.
 */
async function fetchThreadContents(
  connection: {
    readonly httpBaseUrl: string;
    readonly bearerToken: string | null;
  },
  threadId: string,
  timeoutMs: number = RECENT_HISTORY_FETCH_TIMEOUT_MS,
): Promise<{
  readonly messages: ReadonlyArray<ThreadHistoryMessageInput>;
  readonly activities: ReadonlyArray<ThreadHistoryActivityInput>;
  readonly proposedPlans: ReadonlyArray<ProposedPlanInput>;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const base = connection.httpBaseUrl.replace(/\/+$/, "");
    const response = await fetch(
      `${base}/api/orchestration/threads/${encodeURIComponent(threadId)}`,
      {
        signal: controller.signal,
        ...(connection.bearerToken === null
          ? { credentials: "include" as const }
          : { headers: { authorization: `Bearer ${connection.bearerToken}` } }),
      },
    );
    if (!response.ok) throw new Error("That thread could not be read.");
    // Anything past here is decoding, which cannot hang.
    const payload: unknown = await response.json();
    const thread =
      typeof payload === "object" &&
      payload !== null &&
      "thread" in payload &&
      typeof payload.thread === "object" &&
      payload.thread !== null
        ? (payload.thread as Record<string, unknown>)
        : null;
    if (thread === null) return { messages: [], activities: [], proposedPlans: [] };

    const rawMessages = Array.isArray(thread.messages) ? thread.messages : [];
    const messages: Array<ThreadHistoryMessageInput> = [];
    for (const message of rawMessages) {
      if (typeof message !== "object" || message === null) continue;
      const turnId =
        "turnId" in message && typeof message.turnId === "string" ? message.turnId : null;
      messages.push({
        role: readString(message, "role"),
        text: readString(message, "text"),
        turnId,
        streaming: "streaming" in message && message.streaming === true,
        createdAt: readString(message, "createdAt"),
      });
    }

    const rawActivities = Array.isArray(thread.activities) ? thread.activities : [];
    const activities: Array<ThreadHistoryActivityInput> = [];
    for (const activity of rawActivities) {
      if (typeof activity !== "object" || activity === null) continue;
      const turnId =
        "turnId" in activity && typeof activity.turnId === "string" ? activity.turnId : null;
      activities.push({
        kind: readString(activity, "kind"),
        summary: readString(activity, "summary"),
        tone: readString(activity, "tone"),
        turnId,
        createdAt: readString(activity, "createdAt"),
      });
    }

    const rawPlans = Array.isArray(thread.proposedPlans) ? thread.proposedPlans : [];
    const proposedPlans: Array<ProposedPlanInput> = [];
    for (const plan of rawPlans) {
      if (typeof plan !== "object" || plan === null) continue;
      const markdown = readString(plan, "planMarkdown");
      if (markdown.trim().length === 0) continue;
      proposedPlans.push({
        planId: readString(plan, "id"),
        planMarkdown: markdown,
        // Absent or null both mean outstanding; only a real timestamp means it
        // has already been acted on.
        implementedAt:
          "implementedAt" in plan && typeof plan.implementedAt === "string"
            ? plan.implementedAt
            : null,
        createdAt: readString(plan, "createdAt"),
      });
    }

    return { messages, activities, proposedPlans };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Best-effort read of the orchestrator thread's recent exchanges, folded into
 * the voice session's opening instructions so speech continues the typed
 * conversation. Bounded and fallible by design: a slow or failed fetch must
 * never delay or block the microphone.
 */
async function fetchRecentThreadHistory(
  connection: {
    readonly httpBaseUrl: string;
    readonly bearerToken: string | null;
  },
  threadId: string = ORCHESTRATOR_THREAD_ID,
  timeoutMs: number = RECENT_HISTORY_FETCH_TIMEOUT_MS,
): Promise<ReadonlyArray<RecentConversationEntry>> {
  try {
    const { messages } = await fetchThreadContents(connection, threadId, timeoutMs);
    const entries: Array<RecentConversationEntry & { readonly createdAt: string }> = [];
    for (const message of messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      if (message.streaming || message.text.trim().length === 0) continue;
      entries.push({ role: message.role, text: message.text, createdAt: message.createdAt });
    }
    // Only the conversation in progress. The orchestrator has one permanent
    // thread, so without this the "recent" history is a slice of whatever was
    // last said — often a finished exchange from hours ago, which the model
    // then tried to resume. A long silence is the boundary between sittings.
    // A conversation begins when the *user* comes back, not when the
    // orchestrator finally says something — an announcement fired hours after
    // the exchange it belongs to would otherwise orphan the question it answers.
    const current = entriesSinceLastBoundary(entries, {
      opensConversation: (entry) => entry.role === "user",
    });
    return current.slice(-MAX_RECENT_HISTORY_ENTRIES).map(({ role, text }) => ({ role, text }));
  } catch {
    // Opening context is best-effort: a session without it still works.
    return [];
  }
}

/**
 * Owns the single voice session and the proactive announcements.
 *
 * The world is diffed on every shell change; the resulting transitions are read
 * out only while a session is live. When no session is running the diff still
 * advances the baseline, so reconnecting does not replay everything that
 * happened while the mic was off.
 */
export function useOrchestratorSession(): OrchestratorSessionApi {
  const settings = usePrimarySettings();
  const updatePrimarySettings = useUpdatePrimarySettings();
  const shells = useThreadShells();
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const orchestratorTarget = useOrchestratorThread();
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const recordVoiceTranscript = useAtomCommand(threadEnvironment.recordVoiceTranscript, {
    reportFailure: false,
  });

  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const providers = useAtomValue(primaryServerProvidersAtom);

  const [state, setState] = useState<VoiceSessionState>("idle");
  // One piece of state rather than a message plus a parallel severity flag: the
  // two can never disagree, and every existing `setError` call site keeps its
  // shape. Severity exists because not everything reported here is a fault —
  // "stopped after N seconds of silence" is the session doing what it was told.
  const [issue, setIssue] = useState<VoiceIssue | null>(null);
  const setError = useCallback((message: string | null) => {
    setIssue(message === null ? null : { message, severity: "error" });
  }, []);
  const setNotice = useCallback((message: string) => {
    setIssue({ message, severity: "notice" });
  }, []);
  const error = issue?.message ?? null;
  const errorSeverity = issue?.severity ?? null;
  const [activeSession, setActiveSession] = useState<{ model: string; voice: string } | null>(null);
  const [toolLog, setToolLog] = useState<ReadonlyArray<OrchestratorToolLogEntry>>([]);
  const [usageDays, setUsageDays] = useState<ReadonlyArray<UsageDay>>(() => loadUsageDays());
  const [transcript, setTranscript] = useState<
    ReadonlyArray<{ role: "user" | "assistant"; text: string }>
  >([]);

  const sessionRef = useRef<VoiceSession | null>(null);
  const threadCreationIntentGuardRef = useRef(createThreadCreationIntentGuard());
  // A start() is asynchronous (it reads recent history first); this generation
  // counter cancels a stale start when stop() lands before the session exists.
  const startGenerationRef = useRef(0);
  const worldRef = useRef<OrchestratorWorld>(new Map());
  // When each thread+kind was last spoken, for the flap rate limit.
  const announcedEventsRef = useRef(new Map<string, number>());
  // What the orchestrator owes the user an answer on, and whether the last
  // session closed in a way that permits reopening the microphone.
  const awaitedRef = useRef<AwaitedWorkState>(initialAwaitedWorkState);
  // Spoken once the woken session is actually listening; announce() is a no-op
  // before then, which would drop the very line the wake-up exists to deliver.
  const pendingWakeLinesRef = useRef<Array<string>>([]);
  // Read inside the world-diff effect, which must not re-subscribe every time a
  // setting changes — and must not close over a stale copy either. Assigned
  // just below, once settings are in scope.
  const wakeOnAwaitedResultRef = useRef(true);
  const orchestratorEnabledRef = useRef(false);
  /**
   * The pending reconnect, so turning voice off can actually turn it off.
   *
   * During the backoff `sessionRef.current` is null — that is what the backoff
   * means — so every "is a session running" check answers no while a new one is
   * seconds from being created. The handle is the only way to reach in and
   * stop it.
   */
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current === null) return;
    clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }, []);
  // `start` is declared below that effect and depends on far more than it does;
  // going through a ref keeps the diff from re-running on every render of it.
  const startRef = useRef<(() => void) | null>(null);
  /** Live session state, readable from callbacks without re-creating them. */
  const stateRef = useRef<VoiceSessionState>("idle");
  /** The last line actually recorded, for the repeat guard below. */
  const lastTranscriptLineRef = useRef<TranscriptLine | null>(null);
  /** A voice/model change that arrived mid-answer and is waiting to apply. */
  const pendingRestartRef = useRef(false);
  /** Attempts made for the current drop; reset once a session comes up. */
  const reconnectAttemptsRef = useRef(0);
  /** False once the user deliberately stops, so a drop is not chased. */
  const sessionWantedRef = useRef(false);

  const orchestrator = settings.orchestrator;
  const canInterrupt = resolveInterruptWhileSpeaking({
    setting: orchestrator.interruptWhileSpeaking,
    echoProne: isEchoProneDevice(),
  });
  wakeOnAwaitedResultRef.current = orchestrator.wakeOnAwaitedResult;
  orchestratorEnabledRef.current = orchestrator.enabled;
  // Keyed the same way threads reference them, so a thread can name its project
  // without a second lookup at every call site.
  const projectLookup = useMemo(() => {
    const lookup = new Map<string, ProjectLookupEntry>();
    for (const project of projects) {
      lookup.set(`${project.environmentId}:${project.id}`, {
        title: project.title,
        workspaceRoot: project.workspaceRoot,
      });
    }
    return lookup;
  }, [projects]);
  // Named background agents' chat threads, so the world can tell Scout the
  // agent apart from a chat that merely runs in agent mode. Primary host only —
  // that is where named agents live.
  const agentsRegistryAtom = useMemo(
    () =>
      primaryEnvironmentId === null
        ? EMPTY_AGENT_REGISTRY_ATOM
        : vmAgentEnvironment.agents({ environmentId: primaryEnvironmentId, input: {} }),
    [primaryEnvironmentId],
  );
  const agentsRegistryResult = useAtomValue(agentsRegistryAtom);
  const backgroundAgentNames = useMemo(() => {
    const names = new Map<string, string>();
    if (agentsRegistryResult === null || primaryEnvironmentId === null) return names;
    const latest = Option.getOrNull(AsyncResult.value(agentsRegistryResult));
    if (latest === null || latest.type !== "snapshot") return names;
    for (const agent of latest.agents) {
      if (agent.threadId !== null) {
        names.set(`${primaryEnvironmentId}:${agent.threadId}`, agent.name);
      }
    }
    return names;
  }, [agentsRegistryResult, primaryEnvironmentId]);
  const rawWorld = useMemo(
    () => buildWorld(shells, undefined, projectLookup, backgroundAgentNames),
    [backgroundAgentNames, projectLookup, shells],
  );
  const pendingThreadTitlesRef = useRef<PendingThreadTitles>(new Map());
  /** Settings marker messages recently sent, keyed by target and final values. */
  const recentSettingsUpdatePromptsRef = useRef(new Map<string, number>());
  const reconciledThreadTitles = reconcilePendingThreadTitles(
    rawWorld,
    pendingThreadTitlesRef.current,
    Date.now(),
  );
  pendingThreadTitlesRef.current = reconciledThreadTitles.pending;
  const world = reconciledThreadTitles.world;

  // Kept in a ref so the tool executor always sees the latest world without
  // tearing down and rebuilding the session on every shell tick.
  const worldForToolsRef = useRef(world);
  worldForToolsRef.current = world;
  const authorityRef = useRef(orchestrator.authority);
  authorityRef.current = orchestrator.authority;
  const confirmDestructiveRef = useRef(orchestrator.confirmDestructiveActions);
  confirmDestructiveRef.current = orchestrator.confirmDestructiveActions;
  const orchestratorTargetRef = useRef(orchestratorTarget);
  orchestratorTargetRef.current = orchestratorTarget;

  // ── Floating bubble mirror ─────────────────────────────────────
  // The bubble window cannot host the WebRTC session, so this renderer streams
  // it a compact state: status immediately, audio levels throttled.
  const bubbleStateRef = useRef<DesktopOrchestratorBubbleState>({
    status: "idle",
    micLevel: 0,
    assistantLevel: 0,
  });
  const lastLevelPublishRef = useRef(0);

  const publishBubbleState = useCallback((next: DesktopOrchestratorBubbleState) => {
    bubbleStateRef.current = next;
    const bridge = window.desktopBridge?.orchestratorBubble;
    if (bridge === undefined) return;
    void bridge.publishState(next).catch(() => undefined);
  }, []);

  /**
   * Set while the assistant holds the floor silently, so the orb can stop
   * showing an open microphone during a tool call. Held in a ref because both
   * the status publisher and the working callback need it without either
   * re-running on the other's change.
   */
  const bubbleWorkingRef = useRef(false);
  // Flips a few times a turn, not per frame, so it is cheap to render from.
  const [working, setWorking] = useState(false);
  const publishBubbleStatus = useCallback(
    (status: VoiceSessionState) => {
      // "Working" only ever overrides "listening": while connecting there is
      // nothing to wait on yet, and while speaking the answer is its own
      // signal that the floor is taken.
      const resolved =
        status === "listening" && bubbleWorkingRef.current ? ("working" as const) : status;
      // Levels follow the *resolved* status: swelling to the user's voice while
      // the orb is telling them it cannot hear them says both things at once.
      const live = resolved === "listening" || resolved === "speaking";
      publishBubbleState({
        status: resolved,
        micLevel: live ? bubbleStateRef.current.micLevel : 0,
        assistantLevel: live ? bubbleStateRef.current.assistantLevel : 0,
      });
    },
    [publishBubbleState],
  );

  /**
   * Everything watching the live levels. A Set so a component remounting twice
   * — React strict mode does exactly that — cannot leave a stale listener.
   */
  const levelListenersRef = useRef(
    new Set<(levels: { readonly mic: number; readonly assistant: number }) => void>(),
  );
  const subscribeLevels = useCallback(
    (listener: (levels: { readonly mic: number; readonly assistant: number }) => void) => {
      levelListenersRef.current.add(listener);
      return () => {
        levelListenersRef.current.delete(listener);
      };
    },
    [],
  );

  const publishBubbleLevels = useCallback(
    (levels: { readonly mic: number; readonly assistant: number }) => {
      // Fanned out before the throttle below: the desktop bubble is behind IPC
      // and has to be rate-limited, but an in-process subscriber painting a
      // shadow wants every frame it can get.
      for (const listener of levelListenersRef.current) listener(levels);
      const now = Date.now();
      if (now - lastLevelPublishRef.current < BUBBLE_LEVEL_PUBLISH_INTERVAL_MS) {
        bubbleStateRef.current = {
          ...bubbleStateRef.current,
          micLevel: levels.mic,
          assistantLevel: levels.assistant,
        };
        return;
      }
      lastLevelPublishRef.current = now;
      publishBubbleState({
        status: bubbleStateRef.current.status,
        micLevel: levels.mic,
        assistantLevel: levels.assistant,
      });
    },
    [publishBubbleState],
  );

  // The bubble exists independent of any live session: it is the always-there
  // way back to the orchestrator. The server-held setting decides.
  useEffect(() => {
    const bridge = window.desktopBridge?.orchestratorBubble;
    if (bridge === undefined) return;
    void bridge.setVisible(orchestrator.floatingBubble).catch(() => undefined);
  }, [orchestrator.floatingBubble]);

  // ── Transcript persistence ─────────────────────────────────────
  // Every utterance becomes a real (turn-less) message in the orchestrator
  // thread, so typing there later continues the spoken conversation.
  const persistTranscriptEntry = useCallback(
    (entry: { role: "user" | "assistant"; text: string }) => {
      const target = orchestratorTargetRef.current;
      if (target === null || entry.text.trim().length === 0) return;
      void recordVoiceTranscript({
        environmentId: EnvironmentId.make(target.ref.environmentId),
        input: {
          threadId: ThreadId.make(target.ref.threadId),
          entries: [
            {
              messageId: MessageId.make(randomUUID()),
              role: entry.role,
              text: entry.text,
            },
          ],
          createdAt: new Date().toISOString(),
        },
      });
    },
    [recordVoiceTranscript],
  );

  const sendToThread = useCallback(
    async (input: {
      environmentId: string;
      threadId: string;
      message: string;
      /**
       * Selection this turn must run under, when the caller has just changed it.
       *
       * A turn carries the model it should use, and the server persists what it
       * receives — so sending a stale one does not merely mislabel the turn, it
       * writes the old model back and undoes the change. The shell cannot be
       * trusted here: it is projected from a server broadcast, so it still holds
       * the previous selection for the whole round-trip after a change is
       * applied. A caller that just chose a model knows better than the shell.
       */
      modelSelection?: {
        readonly instanceId: string;
        readonly model: string;
        readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
      };
      /**
       * Interaction mode this turn must run under.
       *
       * Approving a plan is the case that needs it: the thread is sitting in
       * plan mode *because* it proposed one, and sending the implementation
       * prompt back under the thread's own mode would produce another plan
       * instead of the work.
       */
      interactionMode?: string;
      /**
       * False for turns the orchestrator sends for its own bookkeeping — a
       * settings marker, not work the user dispatched. Those must not become
       * promises to report back, or the microphone reopens later to narrate a
       * machine prompt as the user's own request.
       */
      awaited?: boolean;
      /** What to say the user asked for, when the message itself is machine text. */
      requestLabel?: string;
    }) => {
      // Read through the ref, not the closed-over render value: this callback
      // outlives the render it was created in, and a send is often the last
      // step of something that just changed the thread.
      const shell = shellsRef.current.find(
        (candidate) =>
          candidate.id === input.threadId && candidate.environmentId === input.environmentId,
      );
      if (!shell) throw new Error("That thread is no longer open.");

      const result = await startThreadTurn({
        environmentId: EnvironmentId.make(input.environmentId),
        input: {
          threadId: ThreadId.make(input.threadId),
          message: {
            messageId: MessageId.make(randomUUID()),
            role: "user",
            text: input.message,
            // Renders the same "Transcribed" badge dictation produces, so the
            // user can tell at a glance which messages the orchestrator sent.
            inputOrigin: "transcription",
            attachments: [],
          },
          modelSelection:
            input.modelSelection === undefined
              ? shell.modelSelection
              : createModelSelection(
                  input.modelSelection.instanceId as never,
                  input.modelSelection.model,
                  input.modelSelection.options,
                ),
          runtimeMode: shell.runtimeMode,
          interactionMode: (input.interactionMode ?? shell.interactionMode) as never,
          createdAt: new Date().toISOString(),
        },
      });
      if (result._tag === "Failure") throw new Error("Could not send that message.");

      // The orchestrator has just handed work off, which is exactly when it
      // tells the user it will report back. Record the promise so a completion
      // that lands after the silence timeout can still be delivered — unless
      // the caller said this turn is bookkeeping. Recording those too meant
      // the microphone could reopen later to narrate a settings marker as
      // "the user asked you to: [machine prompt]".
      if (input.awaited !== false) {
        awaitedRef.current = rememberAwaitedWork(awaitedRef.current, {
          threadKey: `${input.environmentId}:${input.threadId}`,
          threadTitle: shell.title,
          // The label, not the raw message: for a plan approval the message is
          // an entire plan markdown document, and the wake line quotes this
          // back as what the user asked for.
          request: input.requestLabel ?? input.message,
          askedAt: Date.now(),
        });
      }
    },
    [startThreadTurn],
  );

  const interruptThread = useCallback(
    async (input: { environmentId: string; threadId: string }) => {
      const shell = shells.find(
        (candidate) =>
          candidate.id === input.threadId && candidate.environmentId === input.environmentId,
      );
      if (!shell) throw new Error("That thread is no longer open.");
      const turnId = shell.latestTurn?.turnId;

      const result = await interruptThreadTurn({
        environmentId: EnvironmentId.make(input.environmentId),
        input: {
          threadId: ThreadId.make(input.threadId),
          ...(turnId === undefined ? {} : { turnId }),
          createdAt: new Date().toISOString(),
        },
      });
      if (result._tag === "Failure") throw new Error("Could not interrupt that thread.");
    },
    [interruptThreadTurn, shells],
  );

  // ── Tool call log ──────────────────────────────────────────────
  // Newest first. Mirrored to the console so a session can be debugged from
  // devtools without opening settings, and surfaced in the orchestrator
  // settings pane so "what did it just do, and why?" is answerable after the
  // fact rather than only while it is speaking.
  const recordToolCall = useCallback((entry: OrchestratorToolLogEntry) => {
    console.info(
      `[orchestrator] ${entry.name} — ${entry.reason ?? "no reason given"} → ${entry.outcome}: ${entry.detail} (${entry.durationMs}ms)`,
    );
    setToolLog((previous) => [entry, ...previous].slice(0, MAX_TOOL_LOG_ENTRIES));
  }, []);

  // ── Provider catalog ───────────────────────────────────────────
  // Backs validation for `update_thread_settings`. Everything the orchestrator
  // is told about which models and effort levels exist comes from here, so a
  // request for a model that is not installed is refused with the real reason
  // instead of dispatched and silently failing later.
  const catalog = useMemo<ProviderCatalog>(() => {
    const providerList = providers ?? [];
    const modelSlugsFor = (instanceId: string): ReadonlyArray<string> => {
      const entry = getProviderInstanceEntry(providerList, instanceId as never);
      if (entry === undefined) return [];
      return getAppModelOptionsForInstance(settings, entry).map((option) => option.slug);
    };
    return {
      hasInstance: (instanceId) =>
        getProviderInstanceEntry(providerList, instanceId as never) !== undefined,
      resolveModel: (instanceId, model) => {
        const slugs = modelSlugsFor(instanceId);
        if (model === undefined) {
          // No model named: the instance's own default, which is what a bare
          // provider switch wants.
          return resolveAppModelSelectionForInstance(
            instanceId as never,
            settings,
            providerList,
            null,
          );
        }
        // Strict. `resolveAppModelSelectionForInstance` falls back to the
        // instance default on a miss, which silently turned "switch to
        // claude-opus-5" on a browser-bridge thread into "keep chatgpt-browser"
        // and reported already-set.
        return matchModelSlug(slugs, model);
      },
      listModels: (instanceId) => modelSlugsFor(instanceId),
      findModelAcrossInstances: (model) => {
        const hits: Array<{ instanceId: string; model: string }> = [];
        for (const entry of deriveProviderInstanceEntries(providerList)) {
          const matched = matchModelSlug(modelSlugsFor(entry.instanceId), model);
          if (matched !== null) hits.push({ instanceId: entry.instanceId, model: matched });
        }
        return hits;
      },
      effortOption: (instanceId, model) => {
        const entry = getProviderInstanceEntry(providerList, instanceId as never);
        if (entry === undefined) return null;
        const capabilities = getProviderModelCapabilities(
          getProviderInstanceModels(providerList, instanceId as never),
          model,
          entry.driverKind,
        );
        const descriptor = capabilities?.optionDescriptors?.find(
          (option) => option.id === "effort" || option.id === "reasoningEffort",
        );
        if (descriptor === undefined || descriptor.type !== "select") return null;
        return {
          id: descriptor.id,
          // The selection value is the choice's id, not its label.
          values: descriptor.options.map((choice) => choice.id),
        };
      },
    };
  }, [providers, settings]);

  const shellsRef = useRef(shells);
  shellsRef.current = shells;
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;

  const findShell = useCallback((environmentId: string, threadId: string) => {
    const shell = shellsRef.current.find(
      (candidate) => candidate.id === threadId && candidate.environmentId === environmentId,
    );
    if (shell === undefined) throw new Error("That thread is no longer open.");
    return shell;
  }, []);

  const resolveSettingsChange = useCallback(
    (input: { thread: ThreadSnapshot; request: ThreadSettingsRequest }) => {
      const shell = findShell(input.thread.environmentId, input.thread.threadId);
      return resolveThreadSettings({
        thread: input.thread,
        current: {
          instanceId: shell.modelSelection.instanceId,
          model: shell.modelSelection.model,
          options: shell.modelSelection.options ?? [],
          runtimeMode: shell.runtimeMode,
          interactionMode: shell.interactionMode,
        },
        request: input.request,
        catalog: catalogRef.current,
      });
    },
    [findShell],
  );

  const planThreadSettings = useCallback(
    (input: { thread: ThreadSnapshot; request: ThreadSettingsRequest }) =>
      resolveSettingsChange(input).plan,
    [resolveSettingsChange],
  );

  const applyThreadSettings = useCallback(
    async (input: {
      thread: ThreadSnapshot;
      request: ThreadSettingsRequest;
      plan: ThreadSettingsPlan;
      applyNow: boolean;
    }) => {
      // Re-resolved rather than trusting the plan built at confirmation time:
      // the thread may have moved on between the two calls.
      const { plan, nextModelSelection } = resolveSettingsChange({
        thread: input.thread,
        request: input.request,
      });
      if (plan.rejections.length > 0) throw new Error(plan.rejections.join(" "));
      if (plan.changes.length === 0) return;

      const environmentId = EnvironmentId.make(input.thread.environmentId);
      const threadId = ThreadId.make(input.thread.threadId);
      const createdAt = new Date().toISOString();

      // Three separate commands; there is no combined one. Each is skipped
      // when the plan shows that field unchanged.
      if (nextModelSelection !== null) {
        // The composer keeps its own per-provider draft selection, and
        // `ChatView` reads that *before* the thread's own model when deciding
        // what to display. So changing the thread's model out from under a
        // stale draft applied the change for real while the UI went on showing
        // the previous model — the switch looked like it had silently failed.
        // The user explicitly asked for this model, which supersedes whatever
        // they had staged in the composer for that provider.
        useComposerDraftStore.getState().setModelSelection(
          {
            environmentId: EnvironmentId.make(input.thread.environmentId),
            threadId: ThreadId.make(input.thread.threadId),
          },
          createModelSelection(
            nextModelSelection.instanceId as never,
            nextModelSelection.model,
            nextModelSelection.options,
          ),
          { replaceOptions: true },
        );
        const result = await updateThreadMetadata({
          environmentId,
          input: {
            threadId,
            modelSelection: createModelSelection(
              nextModelSelection.instanceId as never,
              nextModelSelection.model,
              nextModelSelection.options,
            ),
          },
        });
        if (result._tag === "Failure") throw new Error("Could not change the model.");
      }

      const accessChange = plan.changes.find((entry) => entry.field === "accessMode");
      if (accessChange !== undefined) {
        const result = await setThreadRuntimeMode({
          environmentId,
          input: { threadId, runtimeMode: accessChange.to as never, createdAt },
        });
        if (result._tag === "Failure") throw new Error("Could not change access permissions.");
      }

      const modeChange = plan.changes.find((entry) => entry.field === "interactionMode");
      if (modeChange !== undefined) {
        const result = await setThreadInteractionMode({
          environmentId,
          input: { threadId, interactionMode: modeChange.to as never, createdAt },
        });
        if (result._tag === "Failure") throw new Error("Could not change the mode.");
      }

      // Commands alone only cache the new selection against the thread; the
      // provider keeps using the old one until a turn establishes a session.
      // The marker message is what actually applies it — on a working thread
      // the server stops the turn first so the update is not queued behind work
      // still running under the old settings, and on an idle one it starts a
      // short turn that adopts them. Skipping this for idle threads was why a
      // model switch looked like it had not happened.
      if (input.applyNow) {
        const description = describeSettingsForPrompt(plan);
        const promptKey = `${input.thread.environmentId}:${input.thread.threadId}:${description}`;
        if (
          reserveSettingsUpdatePrompt(recentSettingsUpdatePromptsRef.current, promptKey, Date.now())
        ) {
          try {
            await sendToThread({
              environmentId: input.thread.environmentId,
              threadId: input.thread.threadId,
              message: buildSettingsUpdatePrompt(description),
              // A marker turn adopting the settings, not work anyone asked
              // for; finishing it is not worth reopening the microphone.
              awaited: false,
              // Explicitly, not from the shell. `updateThreadMetadata` above is an
              // RPC, and the shell only catches up when the server broadcasts back
              // — so at this instant it still names the old model. Sending that
              // stale selection made the server persist it again, silently undoing
              // the change and reporting the old model in the settings-applied
              // separator right under a message announcing the new one.
              ...(nextModelSelection === null ? {} : { modelSelection: nextModelSelection }),
            });
          } catch (cause) {
            // A failed send did not notify the agent, so a retry must remain possible.
            recentSettingsUpdatePromptsRef.current.delete(promptKey);
            throw cause;
          }
        }
      }
    },
    [
      resolveSettingsChange,
      sendToThread,
      setThreadInteractionMode,
      setThreadRuntimeMode,
      updateThreadMetadata,
    ],
  );

  // ── Self and runtime inspection ────────────────────────────────
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;

  const describeSelf = useCallback((): OrchestratorSelfReport => {
    const active = activeSessionRef.current;
    return {
      activeModel: active?.model ?? "not running",
      configuredModel: orchestrator.model,
      activeVoice: active?.voice ?? "not running",
      configuredVoice: orchestrator.voice,
      activeProvider: active === null ? "not running" : orchestrator.provider,
      configuredProvider: orchestrator.provider,
      language: orchestrator.language,
      authority: orchestrator.authority,
      confirmDestructiveActions: orchestrator.confirmDestructiveActions,
      restartRequiredToApply:
        active !== null &&
        (active.model !== orchestrator.model || active.voice !== orchestrator.voice),
    };
  }, [
    orchestrator.authority,
    orchestrator.confirmDestructiveActions,
    orchestrator.language,
    orchestrator.model,
    orchestrator.provider,
    orchestrator.voice,
  ]);

  const environmentsRef = useRef(environments);
  environmentsRef.current = environments;
  const primaryEnvironmentIdRef = useRef(primaryEnvironmentId);
  primaryEnvironmentIdRef.current = primaryEnvironmentId;

  const describeRuntime = useCallback((): OrchestratorRuntimeReport => {
    const threads = [...worldForToolsRef.current.values()];
    return {
      appVersion: APP_VERSION,
      environments: environmentsRef.current.map((environment) => ({
        name: environment.label,
        reachable: environment.connection.phase === "connected",
        threadCount: threads.filter((thread) => thread.environmentId === environment.environmentId)
          .length,
      })),
      threadCounts: {
        total: threads.length,
        working: threads.filter((thread) => thread.isWorking).length,
        idle: threads.filter(
          (thread) => !thread.isWorking && !thread.hasError && !thread.environmentUnreachable,
        ).length,
        error: threads.filter((thread) => thread.hasError).length,
        unreachable: threads.filter((thread) => thread.environmentUnreachable).length,
      },
    };
  }, []);

  const usageDaysRef = useRef(usageDays);
  usageDaysRef.current = usageDays;
  const providersRef = useRef(providers);
  providersRef.current = providers;

  const describeUsage = useCallback((): OrchestratorUsageReport => {
    const now = new Date();
    // The Providers tab's own derivation, given the same inputs — so the
    // spoken answer and the screen can never disagree about a number. No
    // activities: those only add live-session reports the store already has.
    const summaries = deriveProviderUsageSummaries(
      providersRef.current,
      [],
      useProviderUsageStore.getState().byAccountKey,
      now.getTime(),
      primaryEnvironmentIdRef.current ?? undefined,
    );

    const days = usageDaysRef.current;
    const today = localDayKey(now);
    const month = monthKeyOf(today);
    // `costUsd` is null when a model in the period has no published rate, and
    // that null has to survive: a bucket whose cost is unknown is not a bucket
    // that cost nothing, and reading "$0.00" out loud would be a wrong answer
    // rather than a missing one. Only a period with no usage at all is zero.
    const period = (bucket: UsageBucket | undefined) =>
      bucket === undefined
        ? { spokenMinutes: 0, estimatedCostUsd: 0, models: [] }
        : {
            spokenMinutes: estimateVoiceMinutes(bucket.usage),
            estimatedCostUsd: bucket.costUsd,
            models: bucket.models,
          };

    return {
      providers: summaries.map((summary) => ({
        name: providerUsageName(summary.provider),
        state: summary.state,
        reportedAt: summary.reportedAt,
        windows: summary.windows.map((window) => ({
          label: window.label,
          usedPercent: window.usedPercent,
          resetsAt: window.resetAt === null ? null : new Date(window.resetAt).toISOString(),
          detail: window.detail ?? null,
        })),
      })),
      voice: {
        today: period(dailyBuckets(days).find((bucket) => bucket.key === today)),
        month: period(monthlyBuckets(days).find((bucket) => bucket.key === month)),
        allTime: period(totalBucket(days)),
      },
    };
  }, []);

  const readProposedPlans = useCallback(
    async (input: { environmentId: string; threadId: string }) => {
      const connection = readPreparedConnection(EnvironmentId.make(input.environmentId));
      if (connection === null) return [];
      const contents = await fetchThreadContents(
        {
          httpBaseUrl: connection.httpBaseUrl,
          bearerToken: connection.httpAuthorization?.token ?? null,
        },
        input.threadId,
        THREAD_READ_TIMEOUT_MS,
      );
      return contents.proposedPlans;
    },
    [],
  );

  const runCommand = useCallback(
    async (input: {
      readonly command: string;
      readonly cwd?: string;
    }): Promise<OrchestratorCommandResult> => {
      const environmentId = primaryEnvironmentIdRef.current;
      if (environmentId === null) {
        throw new OrchestratorToolError("No environment is connected, so nothing can be run.");
      }
      const connection = readPreparedConnection(environmentId);
      if (connection === null) {
        throw new OrchestratorToolError("The environment is still connecting.");
      }

      const response = await fetch(joinUrl(connection.httpBaseUrl, ORCHESTRATOR_RUN_COMMAND_PATH), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(connection.httpAuthorization?.token === undefined
            ? {}
            : { authorization: `Bearer ${connection.httpAuthorization.token}` }),
        },
        body: JSON.stringify({
          command: input.command,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new OrchestratorToolError(
          detail.trim().length > 0 ? detail : `The command could not be run (${response.status}).`,
        );
      }
      return (await response.json()) as OrchestratorCommandResult;
    },
    [],
  );

  const openWebsite = useCallback(async (url: string) => {
    if (typeof window === "undefined") {
      throw new OrchestratorToolError("There is no browser here to open it in.");
    }

    // Through the same door a clicked link uses. On desktop that is
    // `shell.openExternal`, allow-listed to http and https in the main process,
    // which reports whether it actually opened.
    const bridge = window.desktopBridge;
    if (bridge !== undefined) {
      const opened = await bridge.openExternal(url);
      if (!opened) throw new OrchestratorToolError("The app would not open that address.");
      return;
    }

    // In a browser, opening a tool call is not a click — there is no user
    // gesture behind it — so a popup blocker refusing is the normal case rather
    // than the exception. `window.open` returns null when that happens, and
    // that null has to become an error: saying "opened YouTube" when the
    // browser silently blocked it is worse than not opening it, because the
    // user goes looking for a tab that was never there.
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (opened === null) {
      throw new OrchestratorToolError(
        "The browser blocked the new tab. Tell the user to allow pop-ups for this site, or to open it themselves — do not say it opened.",
      );
    }
  }, []);

  const createThreadCommand = useAtomCommand(threadEnvironment.create, { reportFailure: false });

  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  const listProjects = useCallback(
    () =>
      projectsRef.current.map((project) => ({
        projectId: project.id,
        environmentId: project.environmentId,
        environmentName:
          environmentsRef.current.find(
            (environment) => environment.environmentId === project.environmentId,
          )?.label ?? project.environmentId,
        name: project.title,
        workspaceName: workspaceBasename(project.workspaceRoot),
      })),
    [],
  );

  const createThread = useCallback(
    async (input: { environmentId: string; projectId: string; title: string; message: string }) => {
      await threadCreationIntentGuardRef.current.run(input, async () => {
        const environmentId = EnvironmentId.make(input.environmentId);
        const project = projectsRef.current.find(
          (candidate) =>
            candidate.id === input.projectId && candidate.environmentId === environmentId,
        );
        // A new thread needs a model up front. The project's own default is the
        // right one — it is what the sidebar's "new thread" button uses too.
        const modelSelection =
          project?.defaultModelSelection ??
          [...worldForToolsRef.current.values()]
            .map((thread) => shellsRef.current.find((shell) => shell.id === thread.threadId))
            .find((shell) => shell !== undefined)?.modelSelection;
        if (modelSelection === undefined || modelSelection === null) {
          throw new Error("No model is configured to start a thread with.");
        }

        const threadId = ThreadId.make(randomUUID());
        const created = await createThreadCommand({
          environmentId,
          input: {
            threadId,
            projectId: ProjectId.make(input.projectId),
            title: input.title,
            createdByThreadId: ORCHESTRATOR_THREAD_ID,
            modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
          },
        });
        if (created._tag === "Failure") throw new Error("Could not create that thread.");

        const started = await startThreadTurn({
          environmentId,
          input: {
            threadId,
            message: {
              messageId: MessageId.make(randomUUID()),
              role: "user",
              text: input.message,
              inputOrigin: "transcription",
              attachments: [],
            },
            modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: new Date().toISOString(),
          },
        });
        if (started._tag === "Failure") {
          throw new Error("The thread was created but the first message did not send.");
        }
      });
    },
    [createThreadCommand, startThreadTurn],
  );

  const createProjectCommand = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const readProjectFile = useAtomCommand(projectEnvironment.readFileNow, { reportFailure: false });
  const createProjectFromFolder = useCallback(
    async (input: { readonly path: string; readonly name?: string }) => {
      const environmentId = primaryEnvironmentIdRef.current;
      if (environmentId === null) {
        throw new OrchestratorToolError("No environment is connected.");
      }
      const title = input.name ?? inferProjectTitleFromPath(input.path);
      const projectId = ProjectId.make(randomUUID());
      const result = await createProjectCommand({
        environmentId: EnvironmentId.make(environmentId),
        input: {
          projectId,
          title,
          workspaceRoot: input.path,
          // Never true here. The tool exists to *link* a folder the user
          // already has; creating one from a path that arrived by voice is how
          // a mis-transcription becomes an empty directory nobody wanted.
          createWorkspaceRootIfMissing: false,
          defaultModelSelection: null,
        },
      });
      if (result._tag === "Failure") {
        throw new OrchestratorToolError(
          `That folder could not be added — check the path exists and is not already a project.`,
        );
      }
      return { projectId, title };
    },
    [createProjectCommand],
  );

  const listProjectEntries = useAtomCommand(projectEnvironment.listEntriesNow, {
    reportFailure: false,
  });
  const findProjectEntries = useAtomCommand(projectEnvironment.searchEntriesNow, {
    reportFailure: false,
  });
  const searchProjectContents = useAtomCommand(projectEnvironment.searchContentsNow, {
    reportFailure: false,
  });
  const listTerminalsCommand = useAtomCommand(terminalEnvironment.list, { reportFailure: false });
  const readTerminalCommand = useAtomCommand(terminalEnvironment.read, { reportFailure: false });
  const writeTerminalCommand = useAtomCommand(terminalEnvironment.write, { reportFailure: false });

  /**
   * Reads one thread's stored conversation for `read_thread` and
   * `search_threads`. Throws rather than returning empty: "that thread could
   * not be reached" and "that thread has said nothing" are different answers,
   * and reporting the second for the first is how a search silently lies.
   */
  const readThread = useCallback(
    async (input: { environmentId: string; threadId: string }) => {
      const connection = readPreparedConnection(EnvironmentId.make(input.environmentId));
      if (connection === null) throw new Error("That thread's environment is not connected.");
      try {
        return await fetchThreadContents(
          {
            httpBaseUrl: connection.httpBaseUrl,
            bearerToken: connection.httpAuthorization?.token ?? null,
          },
          input.threadId,
          THREAD_READ_TIMEOUT_MS,
        );
      } catch (cause) {
        // Said in terms the model cannot turn into "it is still loading": this
        // read is over, nothing is running, and trying again is the only way
        // forward. A bare AbortError is what it improvised a background job from.
        const aborted = cause instanceof Error && cause.name === "AbortError";
        throw new Error(
          aborted
            ? "Reading that thread timed out and was abandoned. Nothing is still loading. Say so and offer to try again."
            : "That thread could not be read. Nothing is still loading. Say so and offer to try again.",
          { cause },
        );
      }
    },
    // readPreparedConnection is a module import, not reactive state.
    [],
  );

  /**
   * Read-only project inspection for the file tools.
   *
   * Everything is scoped to the project's `workspaceRoot`: the server resolves
   * paths against it and refuses anything that escapes, so a mis-transcribed
   * path fails rather than wandering up the filesystem. Results are trimmed to
   * what is useful spoken aloud — a directory listing of ten thousand files is
   * no more answerable than none.
   */
  const inspectProject = useCallback(
    async (input: {
      environmentId: string;
      projectId: string;
      action: "list" | "read" | "find" | "search";
      path?: string;
      query?: string;
    }) => {
      const environmentId = EnvironmentId.make(input.environmentId);
      const project = projectsRef.current.find(
        (candidate) =>
          candidate.id === input.projectId && candidate.environmentId === environmentId,
      );
      if (project === undefined) throw new Error("That project is no longer open.");
      const cwd = project.workspaceRoot;

      if (input.action === "read") {
        const result = await readProjectFile({
          environmentId,
          input: { cwd, relativePath: input.path ?? "" },
        });
        if (result._tag === "Failure") {
          throw new Error(`Could not read ${input.path ?? "that file"}.`);
        }
        return {
          path: result.value.relativePath,
          contents: result.value.contents,
          truncated: result.value.truncated,
          byteLength: result.value.byteLength,
        };
      }

      if (input.action === "find") {
        const result = await findProjectEntries({
          environmentId,
          input: { cwd, query: input.query ?? "", limit: PROJECT_TOOL_RESULT_LIMIT },
        });
        if (result._tag === "Failure") throw new Error("Could not search that project.");
        return { matches: result.value.entries.map((entry) => entry.path) };
      }

      if (input.action === "search") {
        const result = await searchProjectContents({
          environmentId,
          input: {
            cwd,
            query: input.query ?? "",
            limit: PROJECT_TOOL_RESULT_LIMIT,
            caseSensitive: false,
            wholeWord: false,
            useRegex: false,
          },
        });
        if (result._tag === "Failure") throw new Error("Could not search that project.");
        return {
          matches: result.value.matches.map((match) => ({
            path: match.path,
            line: match.lineNumber,
            text: match.lineContent.trim().slice(0, 200),
          })),
          truncated: result.value.truncated,
        };
      }

      const result = await listProjectEntries({ environmentId, input: { cwd } });
      if (result._tag === "Failure") throw new Error("Could not list that project.");
      return summarizeProjectListing(result.value.entries, input.path);
    },
    [findProjectEntries, listProjectEntries, readProjectFile, searchProjectContents],
  );

  const listTerminals = useCallback(async (): Promise<
    ReadonlyArray<OrchestratorTerminalRecord>
  > => {
    const records: Array<OrchestratorTerminalRecord> = [];
    for (const environment of environmentsRef.current) {
      if (environment.connection.phase !== "connected") continue;
      const result = await listTerminalsCommand({
        environmentId: environment.environmentId,
        input: {},
      });
      if (result._tag === "Failure") continue;
      for (const terminal of result.value.terminals) {
        const thread = [...worldForToolsRef.current.values()].find(
          (candidate) =>
            candidate.environmentId === environment.environmentId &&
            candidate.threadId === terminal.threadId,
        );
        records.push({
          environmentId: environment.environmentId,
          threadId: terminal.threadId,
          threadTitle: thread?.title ?? terminal.threadId,
          terminalId: terminal.terminalId,
          label: terminal.label,
          status: terminal.status,
          hasRunningSubprocess: terminal.hasRunningSubprocess,
          cwd: terminal.cwd,
        });
      }
    }
    return records;
  }, [listTerminalsCommand]);

  const readTerminal = useCallback(
    async (input: { environmentId: string; threadId: string; terminalId: string }) => {
      const result = await readTerminalCommand({
        environmentId: EnvironmentId.make(input.environmentId),
        input: { threadId: input.threadId, terminalId: input.terminalId },
      });
      if (result._tag === "Failure") {
        throw new OrchestratorToolError("That terminal could not be read.");
      }
      return {
        history: result.value.history,
        status: result.value.status,
        label: result.value.label,
      };
    },
    [readTerminalCommand],
  );

  const writeTerminal = useCallback(
    async (input: {
      environmentId: string;
      threadId: string;
      terminalId: string;
      data: string;
    }) => {
      const result = await writeTerminalCommand({
        environmentId: EnvironmentId.make(input.environmentId),
        input: {
          threadId: input.threadId,
          terminalId: input.terminalId,
          data: input.data,
        },
      });
      if (result._tag === "Failure") {
        throw new OrchestratorToolError("That terminal could not be written to.");
      }
    },
    [writeTerminalCommand],
  );

  const settleThreadCommand = useAtomCommand(threadEnvironment.settle, { reportFailure: false });
  const unsettleThreadCommand = useAtomCommand(threadEnvironment.unsettle, {
    reportFailure: false,
  });

  /**
   * Records the settled flag and nothing else — no archive, no hide. The thread
   * stays in the sidebar exactly where it was.
   *
   * The decider refuses to settle a thread for a short grace window after a
   * user message (it looks like queued work), so a failure right after sending
   * something is expected rather than a bug; it is reported as such.
   */
  const setThreadSettled = useCallback(
    async (input: { environmentId: string; threadId: string; settled: boolean }) => {
      const environmentId = EnvironmentId.make(input.environmentId);
      const threadId = ThreadId.make(input.threadId);
      const result = input.settled
        ? await settleThreadCommand({ environmentId, input: { threadId } })
        : // "user" marks this as a deliberate un-settle rather than the system
          // reviving a thread because new work arrived.
          await unsettleThreadCommand({ environmentId, input: { threadId, reason: "user" } });
      if (result._tag === "Failure") {
        throw new Error(
          input.settled
            ? "Could not mark that settled — it may have just been sent new work."
            : "Could not un-settle that thread.",
        );
      }
      return { deferred: result.value._tag === "Deferred" };
    },
    [settleThreadCommand, unsettleThreadCommand],
  );

  const forkThreadCommand = useAtomCommand(threadEnvironment.fork, { reportFailure: false });

  /**
   * Opens a side chat off an existing thread.
   *
   * A fork, not a new thread: the side chat inherits the parent's provider
   * conversation as it stands right now, so it can be asked about the work in
   * progress without the parent replaying anything. The parent keeps running.
   */
  const createSideChat = useCallback(
    async (input: { environmentId: string; threadId: string; title: string; message: string }) => {
      const environmentId = EnvironmentId.make(input.environmentId);
      const shell = findShell(input.environmentId, input.threadId);
      const threadId = ThreadId.make(randomUUID());

      const forked = await forkThreadCommand({
        environmentId,
        input: {
          threadId,
          sourceThreadId: ThreadId.make(input.threadId),
          title: input.title,
          isSideChat: true,
        },
      });
      if (forked._tag === "Failure") throw new Error("Could not open that side chat.");

      const started = await startThreadTurn({
        environmentId,
        input: {
          threadId,
          message: {
            messageId: MessageId.make(randomUUID()),
            role: "user",
            text: input.message,
            inputOrigin: "transcription",
            attachments: [],
          },
          modelSelection: shell.modelSelection,
          runtimeMode: shell.runtimeMode,
          interactionMode: shell.interactionMode,
          createdAt: new Date().toISOString(),
        },
      });
      if (started._tag === "Failure") {
        throw new Error("The side chat opened but the first message did not send.");
      }
    },
    [findShell, forkThreadCommand, startThreadTurn],
  );

  const renameThread = useCallback(
    async (input: { environmentId: string; threadId: string; title: string }) => {
      const result = await updateThreadMetadata({
        environmentId: EnvironmentId.make(input.environmentId),
        input: { threadId: ThreadId.make(input.threadId), title: input.title },
      });
      if (result._tag === "Failure") throw new Error("Could not rename that thread.");

      // The dispatch receipt precedes the shell broadcast. Remember the
      // accepted title immediately so another voice command can refer to the
      // name it just assigned instead of briefly falling back to the old one.
      const threadKey = `${input.environmentId}:${input.threadId}`;
      pendingThreadTitlesRef.current = rememberPendingThreadTitle(pendingThreadTitlesRef.current, {
        threadKey,
        title: input.title,
        nowMs: Date.now(),
      });
      const reconciled = reconcilePendingThreadTitles(
        worldForToolsRef.current,
        pendingThreadTitlesRef.current,
        Date.now(),
      );
      pendingThreadTitlesRef.current = reconciled.pending;
      worldForToolsRef.current = reconciled.world;
    },
    [updateThreadMetadata],
  );

  /**
   * Reads the finished thread's closing message so the announcement can say
   * what it actually did. Bounded and fallible: a slow or unreachable host
   * degrades to the plain "it finished" line rather than delaying the news.
   */
  const announceCompletion = useCallback(
    async (event: OrchestratorEvent, speak: (text: string) => void) => {
      const snapshot = worldForToolsRef.current.get(event.threadKey);
      const connection = readPreparedConnection(EnvironmentId.make(event.environmentId));
      let lastMessage: string | undefined;
      if (connection !== null) {
        const history = await fetchRecentThreadHistory(
          {
            httpBaseUrl: connection.httpBaseUrl,
            bearerToken: connection.httpAuthorization?.token ?? null,
          },
          event.threadId,
          COMPLETION_MESSAGE_FETCH_TIMEOUT_MS,
        );
        for (let index = history.length - 1; index >= 0; index -= 1) {
          const entry = history[index];
          if (entry?.role === "assistant" && entry.text.trim().length > 0) {
            lastMessage = entry.text;
            break;
          }
        }
      }
      speak(
        buildCompletionAnnouncement({
          event,
          ...(lastMessage === undefined ? {} : { lastMessage }),
          ...(snapshot === undefined ? {} : { waitingOn: snapshot.waitingOn }),
          // The provider's own words for the failure, so the announcement can
          // say why rather than only that.
          ...(snapshot?.lastError ? { error: snapshot.lastError } : {}),
          ...(snapshot?.failureKind ? { failureKind: snapshot.failureKind } : {}),
        }),
      );
    },
    [],
  );

  const stop = useCallback(() => {
    // Deliberate stop: a later drop must not be chased.
    sessionWantedRef.current = false;
    reconnectAttemptsRef.current = 0;
    clearReconnectTimer();
    startGenerationRef.current += 1;
    sessionRef.current?.stop();
    sessionRef.current = null;
    // Stopping mid tool call would otherwise leave "working" latched: the
    // session that was going to report false is gone, and the next session's
    // report dedupe starts at false, so nobody ever says it again.
    bubbleWorkingRef.current = false;
    setWorking(false);
    // Stopping by hand is a decision, not a lull. Anything the orchestrator was
    // waiting on stays recorded, but nothing may reopen the microphone until
    // the user starts it again themselves.
    awaitedRef.current = noteSessionEnded(awaitedRef.current, "user");
    pendingWakeLinesRef.current = [];
    setState("idle");
    setActiveSession(null);
    publishBubbleStatus("idle");
  }, [clearReconnectTimer, publishBubbleStatus]);

  /**
   * The spoken "that's all" / "be quiet". Hands-free is the whole point of the
   * feature: someone walking with headphones cannot reach for a button, and
   * telling them to is not an answer.
   *
   * "stop" defers to `endAfterReply` so the goodbye is actually spoken — closing
   * the moment the tool is called cut the farewell in half and read as a crash.
   */
  const endVoiceSession = useCallback((mode: "stop" | "hush") => {
    const session = sessionRef.current;
    if (session === null) return;
    if (mode === "hush") {
      session.hush();
      return;
    }
    session.endAfterReply();
  }, []);

  /**
   * Persists a voice-session setting and puts it on the air immediately.
   *
   * Both the voice and the realtime model are minted with the session token, so
   * neither can genuinely change mid-conversation — but "it will apply next
   * time" is a strange answer to someone who just changed a setting, and next
   * time might be hours away. If a session is live it is torn down and
   * restarted, which is the only way the change can take effect at once.
   *
   * These settings belong to the *voice* session alone. Typing to the
   * orchestrator uses its thread's own model, chosen in the composer like any
   * other thread's.
   */
  const applyRealtimeSetting = useCallback(
    async (patch: {
      readonly voice?: string;
      readonly model?: string;
      readonly provider?: OrchestratorVoiceProvider;
    }) => {
      await updatePrimarySettings({ orchestrator: patch });
      if (sessionRef.current === null) return;
      // Mid-answer, the restart waits. Tearing the session down while a reply
      // is playing cut the sentence off and left the user with a dead
      // microphone to restart by hand — the change is not urgent enough to be
      // worth that. `pendingRestartRef` is picked up the moment the session
      // goes quiet, so it still applies without anyone touching anything.
      if (stateRef.current === "speaking") {
        pendingRestartRef.current = true;
        return;
      }
      stop();
      // The settings write has resolved, so the restart mints its token against
      // the new value. Deferred a tick so the teardown's state updates land
      // first and `start` sees no session in flight.
      setTimeout(() => startRef.current?.(), 0);
    },
    [updatePrimarySettings, stop],
  );

  const setOrchestratorVoice = useCallback(
    (voice: string) => applyRealtimeSetting({ voice }),
    [applyRealtimeSetting],
  );

  const setOrchestratorModel = useCallback(
    (model: string) => applyRealtimeSetting({ model }),
    [applyRealtimeSetting],
  );

  const applyOrchestratorRealtime = applyRealtimeSetting;

  const start = useCallback(() => {
    if (sessionRef.current !== null) return;
    // From here a drop is worth chasing; `stop` clears this again.
    sessionWantedRef.current = true;
    if (primaryEnvironmentId === null) {
      setError("No environment is connected.");
      return;
    }

    const prepared = readPreparedConnection(primaryEnvironmentId);
    if (prepared === null) {
      setError("The environment is still connecting.");
      return;
    }

    setError(null);
    setState("connecting");
    publishBubbleStatus("connecting");

    const generation = (startGenerationRef.current += 1);
    void (async () => {
      // Read the thread's recent exchanges from the environment that owns the
      // orchestrator thread; bounded so a slow server cannot hold the mic.
      // The orchestrator thread has a reserved literal id, so its history can be
      // fetched without waiting for the thread row to resolve. Keying this off
      // the resolved target meant that starting voice before the shell had
      // loaded silently produced an empty history, and the session opened with
      // no memory of the conversation the user was in the middle of.
      const target = orchestratorTargetRef.current;
      const historyConnection =
        (target === null ? null : readPreparedConnection(target.ref.environmentId)) ?? prepared;
      // Awaited before anything is created, so a rejection here would otherwise
      // escape into the `void` below and leave the UI stuck on "connecting"
      // forever with nothing to explain it — the silent stall this feature is
      // supposed to have stopped doing.
      let recentHistory: Awaited<ReturnType<typeof fetchRecentThreadHistory>>;
      try {
        recentHistory = await fetchRecentThreadHistory({
          httpBaseUrl: historyConnection.httpBaseUrl,
          bearerToken: historyConnection.httpAuthorization?.token ?? null,
        });
      } catch (cause) {
        if (generation !== startGenerationRef.current) return;
        setState("idle");
        publishBubbleStatus("idle");
        setError(
          `Voice could not start: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        return;
      }
      if (generation !== startGenerationRef.current) return;

      const session = createVoiceSession(
        {
          httpBaseUrl: prepared.httpBaseUrl,
          bearerToken: prepared.httpAuthorization?.token ?? null,
          authority: orchestrator.authority,
          confirmDestructiveActions: orchestrator.confirmDestructiveActions,
          language: orchestrator.language,
          recentHistory,
          ...(orchestrator.autoDisableOnSilence
            ? { silenceTimeoutSeconds: orchestrator.silenceTimeoutSeconds }
            : {}),
          // Read at each play rather than captured here, so muting cues in
          // settings lands mid-session without restarting voice.
          cuePolicy: () => resolveVoiceCuePolicy(getClientSettings()),
          voiceIsolation: orchestrator.voiceIsolation === true,
          // Forced off on a phone: with the speaker centimetres from the
          // microphone the assistant's own voice comes back in, gets
          // transcribed as the user, and the conversation runs away by itself.
          // The setting is honoured everywhere it can be.
          interruptWhileSpeaking: canInterrupt,
        },
        {
          onStateChange: (next) => {
            setState(next);
            // Up and listening: the drop is over, so the next one starts its
            // own budget rather than inheriting a spent one.
            if (next === "listening") {
              reconnectAttemptsRef.current = 0;
            }
            publishBubbleStatus(next);
            // announce() is a no-op until the session is listening, so a wake-up
            // line handed over any earlier would be silently dropped — which is
            // the whole failure this feature exists to fix.
            if (next === "listening" && pendingWakeLinesRef.current.length > 0) {
              const lines = pendingWakeLinesRef.current;
              pendingWakeLinesRef.current = [];
              for (const line of lines) sessionRef.current?.announce(line);
            }
          },
          onError: setError,
          onWorkingChange: (isWorking) => {
            bubbleWorkingRef.current = isWorking;
            setWorking(isWorking);
            // Republish immediately: the session state has not changed, so
            // nothing else will, and the orb would keep the stale icon until
            // the next transition.
            publishBubbleStatus(stateRef.current);
          },
          onSessionReady: setActiveSession,
          onEndedByVoice: () => {
            // Spoken "goodbye" is as deliberate as pressing stop, so nothing may
            // reopen the microphone afterwards.
            sessionRef.current = null;
            awaitedRef.current = noteSessionEnded(awaitedRef.current, "user");
            pendingWakeLinesRef.current = [];
            setState("idle");
            setActiveSession(null);
            publishBubbleStatus("idle");
          },
          onConnectionLost: () => {
            sessionRef.current = null;
            setState("idle");
            const decision = decideReconnect({
              attemptsMade: reconnectAttemptsRef.current,
              wanted: sessionWantedRef.current,
            });
            if (decision.kind === "give-up") {
              setError(
                decision.reason === "attempts-exhausted"
                  ? "The connection dropped and could not be restored. Start voice again when you are back online."
                  : null,
              );
              return;
            }
            reconnectAttemptsRef.current = decision.attempt;
            // A dropped WebRTC session cannot be resumed — the token is spent
            // and the transport is gone — so this mints a new one and carries
            // on, which is nearly invisible for a brief drop.
            reconnectTimerRef.current = setTimeout(() => {
              reconnectTimerRef.current = null;
              // Enabled is checked here and not only at the stop() chokepoint
              // because disabling during the backoff sees no session to stop:
              // this timer IS the session at that moment.
              if (!sessionWantedRef.current || !orchestratorEnabledRef.current) return;
              if (sessionRef.current !== null) return;
              startRef.current?.();
            }, decision.delayMs);
          },
          onIdleTimeout: () => {
            // Not an error: say plainly why the microphone closed, so it does
            // not look like a dropped connection.
            setNotice(
              `Voice stopped after ${orchestrator.silenceTimeoutSeconds} seconds of silence.`,
            );
            // The session ended on its own, so work the orchestrator promised to
            // report on may still reopen it. `stop()` overwrites this whenever
            // the user is the one who ended the session.
            sessionRef.current = null;
            awaitedRef.current = noteSessionEnded(awaitedRef.current, "idle-timeout");
          },
          onUsage: (usage) => {
            // Priced against the model this session actually minted, not the
            // one settings currently names — they diverge after an edit.
            const model = activeSessionRef.current?.model ?? orchestrator.model;
            setUsageDays(appendUsage({ model, usage, now: new Date() }));
          },
          onLevels: publishBubbleLevels,
          onTranscript: (entry) => {
            // The user is here and talking, so the app is demonstrably not
            // waking itself into an empty room; the wake budget resets.
            if (entry.role === "user") {
              awaitedRef.current = resetWakeBudget(awaitedRef.current);
            }
            // The session's own guards against a doubled response depend on
            // frame ordering; this catches whatever gets past them, before the
            // duplicate reaches the screen *or* the stored thread.
            const nowMs = Date.now();
            if (
              isRepeatedAssistantLine({
                role: entry.role,
                text: entry.text,
                previous: lastTranscriptLineRef.current,
                nowMs,
              }) ||
              isRepeatedUserLine({
                role: entry.role,
                text: entry.text,
                previous: lastTranscriptLineRef.current,
                nowMs,
              })
            ) {
              return;
            }
            lastTranscriptLineRef.current = { role: entry.role, text: entry.text, atMs: nowMs };
            setTranscript((previous) => [...previous, entry].slice(-MAX_TRANSCRIPT_ENTRIES));
            persistTranscriptEntry(entry);
          },
          onToolCall: (call) =>
            executeOrchestratorTool(
              {
                world: worldForToolsRef.current,
                authority: authorityRef.current,
                confirmDestructiveActions: confirmDestructiveRef.current,
                sendToThread,
                interruptThread,
                renameThread,
                listProjects,
                createThread,
                createProject: createProjectFromFolder,
                createSideChat,
                setThreadSettled,
                readThread,
                inspectProject,
                endVoiceSession,
                setOrchestratorVoice,
                describeSelf,
                describeRuntime,
                describeUsage,
                readProposedPlans,
                openWebsite,
                runCommand,
                listTerminals,
                readTerminal,
                writeTerminal,
                planThreadSettings,
                applyThreadSettings,
                onToolCall: recordToolCall,
              },
              call,
            ),
        },
      );
      sessionRef.current = session;
      void session.start();
    })();
  }, [
    applyThreadSettings,
    describeRuntime,
    describeUsage,
    describeSelf,
    readProposedPlans,
    openWebsite,
    listTerminals,
    readTerminal,
    writeTerminal,
    interruptThread,
    createSideChat,
    createThread,
    setThreadSettled,
    readThread,
    inspectProject,
    endVoiceSession,
    listProjects,
    planThreadSettings,
    recordToolCall,
    renameThread,
    orchestrator.autoDisableOnSilence,
    canInterrupt,
    orchestrator.voiceIsolation,
    orchestrator.model,
    orchestrator.silenceTimeoutSeconds,
    orchestrator.authority,
    orchestrator.confirmDestructiveActions,
    orchestrator.language,
    persistTranscriptEntry,
    primaryEnvironmentId,
    publishBubbleLevels,
    publishBubbleStatus,
    sendToThread,
  ]);
  // Published for the world-diff effect above, which needs to reopen the session
  // but must not take `start` as a dependency.
  startRef.current = start;

  // Diff the world on every shell change and read out what changed. The baseline
  // advances whether or not a session is live, so turning the mic on does not
  // replay history.
  //
  // The diff itself now runs with the microphone closed too. It used to return
  // early with no session, *after* advancing the baseline — so work finishing
  // during the silence timeout was computed and then discarded, and the user who
  // had been told "I'll let you know when it's done" never heard again. Events
  // for work the orchestrator promised to report on can now reopen the session.
  useEffect(() => {
    const previous = worldRef.current;
    worldRef.current = world;

    const session = sessionRef.current;
    for (const event of diffWorlds(previous, world, orchestrator.spokenEvents)) {
      // A provider at its usage cap fails and retries in a tight loop, so one
      // thread can produce the same transition several times a minute. Speaking
      // each one buried the user under near-identical sentences (2026-08-23:
      // four back-to-back replies for one side-chat creation). One per minute
      // per thread and kind, live session or wake path alike.
      if (!shouldAnnounceEvent(announcedEventsRef.current, event, Date.now())) {
        recordToolCall({
          name: `event:${event.kind}`,
          reason: event.title,
          outcome: "error",
          detail: `${event.title} — suppressed, same event announced under a minute ago`,
          durationMs: 0,
          at: new Date().toISOString(),
        });
        continue;
      }
      if (session !== null) {
        // A thread ending is the event worth real detail; the rest are one-liners
        // whose whole content is already in the transition itself.
        if (event.kind === "thread-finished" || event.kind === "thread-failed") {
          const threadKey = event.threadKey;
          recordToolCall({
            name: `event:${event.kind}`,
            reason: event.title,
            outcome: "ok",
            detail: `${event.title} — summarizing to announce`,
            durationMs: 0,
            at: new Date().toISOString(),
          });
          void announceCompletion(event, (text) => {
            // The summary fetch takes seconds, and the session can die inside
            // them — at which point announce() refuses the text. Marking it
            // delivered anyway was how "I'll let you know when it's done"
            // ended in silence. Hand it to whichever session next reaches
            // listening instead; a deliberate stop clears that queue, so
            // stopped-by-hand still means quiet until they start again.
            const delivered = sessionRef.current === session && session.announce(text);
            if (!delivered) pendingWakeLinesRef.current.push(text);
          });
          // The result is on its way to the user one way or the other, so the
          // promise is kept.
          awaitedRef.current = forgetAwaitedWork(awaitedRef.current, threadKey);
        } else {
          const delivered = session.announce(describeEventFallback(event));
          // Every event becomes speech, so every event is worth a log line —
          // an honest one. "Announced" for a session still connecting was a
          // lie the log told about exactly the deliveries that failed.
          recordToolCall({
            name: `event:${event.kind}`,
            reason: event.title,
            outcome: delivered ? "ok" : "error",
            detail: delivered
              ? `${event.title} — announced`
              : `${event.title} — dropped, session not connected`,
            durationMs: 0,
            at: new Date().toISOString(),
          });
          // Deliberately NOT forgetting awaited work here: approval-needed and
          // input-needed are progress on the work, not its result. Forgetting
          // on them meant a thread that paused for approval could never wake
          // the session when it actually finished.
        }
        continue;
      }

      // No session. Only a finish or a failure on work the orchestrator was
      // actually waiting for is worth reopening the microphone for; every other
      // transition stays dropped, exactly as before.
      if (event.kind !== "thread-finished" && event.kind !== "thread-failed") continue;

      const decision = decideWake({
        state: awaitedRef.current,
        threadKey: event.threadKey,
        now: Date.now(),
        settingEnabled: wakeOnAwaitedResultRef.current,
        orchestratorEnabled: orchestratorEnabledRef.current,
        sessionLive: false,
      });
      if (!decision.wake) {
        recordToolCall({
          name: "wake_on_awaited_result",
          reason: `"${event.title}" finished while voice was closed`,
          outcome: "error",
          detail: `not woken: ${decision.reason}`,
          durationMs: 0,
          at: new Date().toISOString(),
        });
        continue;
      }

      const work = decision.work;
      awaitedRef.current = noteWoke(awaitedRef.current, event.threadKey);
      recordToolCall({
        name: "wake_on_awaited_result",
        reason: `"${work.threadTitle}" finished what the user asked for`,
        outcome: "ok",
        detail: "reopening voice to report back",
        durationMs: 0,
        at: new Date().toISOString(),
      });

      // Build the completion line first, then start: a session that comes up
      // with nothing queued would sit there silently, which looks identical to
      // the bug this replaces.
      void announceCompletion(event, (completion) => {
        const line = buildWakeAnnouncement({ work, completion });
        // The user may have started voice themselves during the summary fetch.
        // A line queued behind an already-listening session waits for a
        // "listening" transition that never comes, then replays out of context
        // on some later reconnect — so deliver into the live session first.
        const live = sessionRef.current;
        if (live !== null && live.announce(line)) return;
        pendingWakeLinesRef.current.push(line);
        startRef.current?.();
      });
    }
  }, [announceCompletion, orchestrator.spokenEvents, recordToolCall, world]);

  // Tear the session down when the feature is switched off or the component
  // unmounts, so the microphone never outlives its owner.
  useEffect(() => {
    // `sessionWantedRef` too: during a reconnect backoff there is no session,
    // but there is an intent to make one, and switching the feature off must
    // cancel that intent — not watch a timer reopen the microphone in a few
    // seconds with the setting already off.
    if (!orchestrator.enabled && (sessionRef.current !== null || sessionWantedRef.current)) {
      stop();
    }
  }, [orchestrator.enabled, stop]);

  useEffect(
    () => () => {
      startGenerationRef.current += 1;
      // Intent dies with the owner: a reconnect timer surviving unmount would
      // open a session no UI can see or stop.
      sessionWantedRef.current = false;
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      sessionRef.current?.stop();
    },
    [],
  );

  // Hold the screen awake for as long as the microphone is open.
  //
  // Locking the phone mid-conversation suspends the page, and with it the
  // WebRTC connection — the indicator stays lit, the model stops answering, and
  // coming back shows the chat ended. No web API keeps a browser voice session
  // alive in the background, so the only real remedy is stopping the lock from
  // happening while a session is live. Best-effort by nature: the platform may
  // have no wake lock, or may refuse one.
  useEffect(() => {
    const live = state === "listening" || state === "speaking" || state === "connecting";
    if (!live) return;
    const lock = createScreenWakeLock(findWakeLockRequester());
    void lock.acquire();
    // The browser drops the lock whenever the page hides and does not restore
    // it on return, so re-acquiring here is required rather than defensive.
    const onVisibility = () => {
      if (typeof document !== "undefined" && !document.hidden) void lock.acquire();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      lock.release();
    };
  }, [state]);

  // Set when a settings change arrived mid-answer; performed once the reply has
  // finished playing so nothing is cut off and nothing has to be restarted by
  // hand.
  stateRef.current = state;

  useEffect(() => {
    if (!pendingRestartRef.current) return;
    if (state === "speaking" || state === "connecting") return;
    pendingRestartRef.current = false;
    if (sessionRef.current === null) return;
    stop();
    setTimeout(() => startRef.current?.(), 0);
  }, [state, stop]);

  const toggle = useCallback(() => {
    if (sessionRef.current === null && state !== "connecting") start();
    else stop();
  }, [start, state, stop]);

  // The floating orb is the microphone control, but it lives in a window that
  // cannot host a session — so its taps arrive here. Held in a ref so the
  // subscription is made once rather than resubscribing on every state change.
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => {
    const bridge = window.desktopBridge?.orchestratorBubble;
    if (bridge?.onVoiceToggleRequested === undefined) return;
    return bridge.onVoiceToggleRequested(() => toggleRef.current());
  }, []);

  return {
    state,
    error,
    errorSeverity,
    transcript,
    subscribeLevels,
    working,
    canInterrupt,
    canStart:
      orchestrator.enabled &&
      (orchestrator.provider === "xai"
        ? orchestrator.xaiApiKeyConfigured
        : orchestrator.openAiApiKeyConfigured),
    start,
    stop,
    toggle,
    activeModel: activeSession?.model ?? null,
    setOrchestratorModel,
    applyOrchestratorRealtime,
    toolLog,
    usageDays,
    clearUsageHistory: () => {
      clearUsage();
      setUsageDays([]);
    },
  };
}
