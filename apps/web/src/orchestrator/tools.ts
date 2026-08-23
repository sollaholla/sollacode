import type {
  OrchestratorAuthority,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import { encodeTerminalWrite } from "@t3tools/shared/terminalText";

import type { OrchestratorWorld, ThreadSnapshot } from "./events";
import {
  DEFAULT_MESSAGE_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  MAX_MESSAGE_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_THREADS_PER_SEARCH,
  readThreadHistory,
  statusMessageTail,
  resolveLimit,
  searchThreadMessages,
  type ThreadHistoryActivityInput,
  type ThreadHistoryMessageInput,
  type ThreadSearchMatch,
} from "./threadHistory";
import {
  describeCandidate,
  resolveProjectReference,
  resolveThreadReference,
  type ProjectReference,
} from "./threadRouting";
import { isToolAllowed, type OrchestratorToolLogEntry } from "./toolRegistry";
import {
  compactTerminals,
  describeTerminalAloud,
  presentTerminalRead,
  resolveTerminalReference,
  terminalsForThread,
  type OrchestratorTerminalRecord,
} from "./terminals";
import { formatUsd } from "./usageTracking";
import { buildPlanImplementationPrompt } from "../proposedPlan";
import { resolveWebTarget, supportsQuery } from "./webTargets";
import {
  describePlanAloud,
  findActionablePlan,
  summarizeProposedPlan,
  type ProposedPlanInput,
  type ProposedPlanSummary,
} from "./proposedPlan";

/**
 * Client-side execution of the orchestrator's voice tools.
 *
 * The voice session talks to OpenAI directly, so it cannot reach the server-side
 * `workspace_orchestration` MCP toolkit (that one serves the orchestrator's
 * *thread*). These are the same operations expressed against the client's own
 * live state and command dispatch, which the client already has for every
 * thread across every environment.
 *
 * Schemas and authority floors live in `toolRegistry.ts`; this module is the
 * execution half. Anything the orchestrator needs that this client cannot
 * compute itself arrives as a function on {@link OrchestratorToolContext}, so
 * the tool bodies stay synchronous, pure and testable.
 */

export { isToolAllowed } from "./toolRegistry";

// ── Inspection reports ───────────────────────────────────────────

/** What the orchestrator can see about its own configuration. */
export interface OrchestratorSelfReport {
  /** Model the *running* voice session was started with. */
  readonly activeModel: string;
  /** Model currently saved in settings — may differ from {@link activeModel}. */
  readonly configuredModel: string;
  readonly activeVoice: string;
  readonly configuredVoice: string;
  readonly activeProvider?: string;
  readonly configuredProvider?: string;
  readonly language: string;
  readonly authority: OrchestratorAuthority;
  readonly confirmDestructiveActions: boolean;
  /**
   * True when settings have been edited since the voice session started. The
   * token is minted from settings when a session begins, so an edit lands on
   * the next session rather than the running one — no app restart involved.
   */
  readonly restartRequiredToApply: boolean;
}

export interface OrchestratorRuntimeReport {
  readonly appVersion: string;
  readonly environments: ReadonlyArray<{
    readonly name: string;
    readonly reachable: boolean;
    readonly threadCount: number;
  }>;
  readonly threadCounts: {
    readonly total: number;
    readonly working: number;
    readonly idle: number;
    readonly error: number;
    readonly unreachable: number;
  };
}

/**
 * What the user has spent, from the two places it is counted.
 *
 * Deliberately two independent halves, because they are not comparable and
 * running them together would be a lie: `providers` is quota the provider
 * itself reports against a plan, and `voice` is an estimate this app derives
 * from token counts on this machine alone. Someone asking "how much have I
 * used" usually means the first; someone asking what the orchestrator costs
 * means the second.
 */
export interface OrchestratorUsageReport {
  readonly providers: ReadonlyArray<{
    readonly name: string;
    /** "unsupported" means the provider does not report quota, not that it is idle. */
    readonly state: "available" | "stale" | "unavailable" | "unsupported";
    readonly reportedAt: string | null;
    readonly windows: ReadonlyArray<{
      readonly label: string;
      readonly usedPercent: number | null;
      readonly resetsAt: string | null;
      readonly detail: string | null;
    }>;
  }>;
  readonly voice: {
    readonly today: OrchestratorUsagePeriod;
    readonly month: OrchestratorUsagePeriod;
    readonly allTime: OrchestratorUsagePeriod;
  };
}

export interface OrchestratorUsagePeriod {
  /** Audio tokens are duration-encoded, so minutes are the honest unit. */
  readonly spokenMinutes: number;
  /** Null when any model in the period has no published rate. */
  readonly estimatedCostUsd: number | null;
  readonly models: ReadonlyArray<string>;
}

interface UsageScope {
  readonly wantsProviders: boolean;
  readonly wantsVoice: boolean;
}

/** Under a minute is a real answer; "0 minutes" reads as a broken counter. */
function spokenMinutesPhrase(minutes: number): string {
  if (minutes < 1) return "under a minute";
  const rounded = Math.round(minutes);
  return `about ${rounded} minute${rounded === 1 ? "" : "s"}`;
}

/**
 * What to say about usage, as an instruction rather than a script.
 *
 * Read out in full, quota is a wall of numbers nobody asked for. The one thing
 * a person wants when they ask is the window closest to running out, so that
 * leads; everything else is in the payload if they follow up. Money is always
 * flagged as an estimate — the rates are this app's, not a bill.
 */
function describeUsageAloud(report: OrchestratorUsageReport, scope: UsageScope): string {
  const parts: Array<string> = [];

  if (scope.wantsProviders) {
    const reported = report.providers.flatMap((provider) =>
      provider.windows
        .filter((window) => window.usedPercent !== null)
        .map((window) => ({ provider: provider.name, ...window })),
    );
    const busiest = [...reported].sort(
      (left, right) => (right.usedPercent ?? 0) - (left.usedPercent ?? 0),
    )[0];
    if (busiest === undefined) {
      parts.push(
        "No provider has reported a usage figure. Say that plainly — do not estimate one, and do not imply the user has used nothing.",
      );
    } else {
      parts.push(
        `Lead with the window closest to its limit: ${busiest.provider} is at ${Math.round(busiest.usedPercent ?? 0)}% of its ${busiest.label}. Mention the others only if asked.`,
      );
      const stale = report.providers
        .filter((provider) => provider.state === "stale")
        .map((provider) => provider.name);
      if (stale.length > 0) {
        parts.push(
          `These numbers are out of date for ${stale.join(", ")} — say they are the last reported figures rather than the current ones.`,
        );
      }
    }
  }

  if (scope.wantsVoice) {
    const { today, month } = report.voice;
    const cost =
      month.estimatedCostUsd === null
        ? ""
        : `, an estimated ${formatUsd(month.estimatedCostUsd)} this month`;
    parts.push(
      `Talking to you has taken ${spokenMinutesPhrase(today.spokenMinutes)} today and ${spokenMinutesPhrase(month.spokenMinutes)} this month${cost}. Say any money figure is an estimate, and that it counts this device only.`,
    );
  }

  return parts.join(" ");
}

/**
 * The plan a stopped thread is waiting on, or null if it cannot be read.
 *
 * Never throws: a thread whose plan cannot be fetched is still a thread worth
 * describing, and an error here would take the whole answer down over the one
 * field that is merely extra detail.
 */
async function readActionablePlan(
  context: OrchestratorToolContext,
  thread: ThreadSnapshot,
): Promise<ProposedPlanSummary | null> {
  try {
    const plans = await context.readProposedPlans({
      environmentId: thread.environmentId,
      threadId: thread.threadId,
    });
    const actionable = findActionablePlan(plans);
    return actionable === null ? null : summarizeProposedPlan(actionable);
  } catch {
    return null;
  }
}

/** One line for the tool log. */
function summariseUsage(report: OrchestratorUsageReport, scope: UsageScope): string {
  const parts: Array<string> = [];
  if (scope.wantsProviders) parts.push(`${report.providers.length} providers`);
  if (scope.wantsVoice)
    parts.push(`${formatUsd(report.voice.month.estimatedCostUsd)} voice this month`);
  return parts.join(", ");
}

// ── Thread settings ──────────────────────────────────────────────

export const RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

export const INTERACTION_MODES: ReadonlyArray<ProviderInteractionMode> = [
  "default",
  "plan",
  "agent",
];

/**
 * How permissive each access mode is. Used to detect a *raise*, which is
 * confirmed unconditionally — handing an agent broader filesystem and command
 * access is not something a misheard sentence should be able to do, even for a
 * user who turned confirmations off for everything else.
 */
const RUNTIME_MODE_PERMISSIVENESS: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

export interface ThreadSettingsRequest {
  readonly model?: string;
  readonly provider?: string;
  readonly effort?: string;
  readonly accessMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
}

export interface ThreadSettingsChange {
  readonly field: "model" | "provider" | "effort" | "accessMode" | "interactionMode";
  readonly from: string;
  readonly to: string;
  /**
   * When the change reaches the agent. Access mode restarts the live provider
   * session from its resume cursor, so it bites at once; model, effort and
   * interaction mode are cached and picked up when the next turn starts.
   */
  readonly effectiveOn: "immediately" | "next-turn";
}

export interface ThreadSettingsPlan {
  readonly changes: ReadonlyArray<ThreadSettingsChange>;
  /** Blocking problems. A non-empty list means nothing will be applied. */
  readonly rejections: ReadonlyArray<string>;
  /** Non-blocking caveats the user should hear before agreeing. */
  readonly warnings: ReadonlyArray<string>;
  readonly raisesPermissions: boolean;
}

export interface OrchestratorToolContext {
  /** Live world, keyed by `environmentId:threadId`. */
  readonly world: ReadonlyMap<string, ThreadSnapshot>;
  readonly authority: OrchestratorAuthority;
  /**
   * Enforced here, not merely asked for in the prompt. Interrupting and
   * changing settings are the actions that disturb in-flight work, and a
   * misheard thread name should not be able to reach them — so the first call
   * reports what would happen and the model has to come back with an explicit
   * confirmation.
   */
  readonly confirmDestructiveActions: boolean;
  readonly sendToThread: (input: {
    environmentId: string;
    threadId: string;
    message: string;
    /** Overrides the thread's own mode for this turn; see plan approval. */
    interactionMode?: string;
    /** False for bookkeeping turns that must not promise a spoken report. */
    awaited?: boolean;
    /** Spoken stand-in for the message when the message is machine text. */
    requestLabel?: string;
  }) => Promise<void>;
  readonly interruptThread: (input: { environmentId: string; threadId: string }) => Promise<void>;
  readonly renameThread: (input: {
    environmentId: string;
    threadId: string;
    title: string;
  }) => Promise<void>;
  /** Projects available to start new work in. */
  readonly listProjects: () => ReadonlyArray<ProjectReference>;
  /**
   * Links an existing folder as a project.
   *
   * Never creates the directory — a path that is not there is an error the user
   * hears, not an empty folder they did not ask for. That distinction is the
   * whole reason this is safe enough to expose to voice.
   */
  readonly createProject: (input: {
    readonly path: string;
    readonly name?: string;
  }) => Promise<{ readonly projectId: string; readonly title: string }>;
  readonly createThread: (input: {
    environmentId: string;
    projectId: string;
    title: string;
    message: string;
  }) => Promise<void>;
  /**
   * Records the settled flag. Deliberately does not archive: settling marks a
   * thread as dealt with, it does not remove it from view.
   */
  readonly setThreadSettled: (input: {
    environmentId: string;
    threadId: string;
    settled: boolean;
  }) => Promise<{ readonly deferred: boolean }>;
  readonly createSideChat: (input: {
    environmentId: string;
    threadId: string;
    title: string;
    message: string;
  }) => Promise<void>;
  /**
   * Loads one thread's stored conversation. Read-only, and the same snapshot
   * endpoint the UI itself renders a thread from.
   */
  readonly readThread: (input: { environmentId: string; threadId: string }) => Promise<{
    readonly messages: ReadonlyArray<ThreadHistoryMessageInput>;
    readonly activities: ReadonlyArray<ThreadHistoryActivityInput>;
  }>;
  /**
   * Read-only project inspection. Paths are confined to the project's own
   * workspace root by the server, so nothing here can reach outside a project
   * the user already has open.
   */
  readonly inspectProject: (input: {
    environmentId: string;
    projectId: string;
    action: "list" | "read" | "find" | "search";
    path?: string;
    query?: string;
  }) => Promise<unknown>;
  /**
   * Ends or silences the voice session because the user said so. Hands-free is
   * the whole point: telling someone on a walk to reach for a button is not an
   * answer.
   */
  readonly endVoiceSession: (mode: "stop" | "hush") => void;
  /**
   * Persists a new voice. Takes effect on the next session, because the voice
   * is minted with the session token rather than being changeable in flight.
   */
  readonly setOrchestratorVoice: (voice: string) => Promise<void>;
  readonly describeSelf: () => OrchestratorSelfReport;
  readonly describeRuntime: () => OrchestratorRuntimeReport;
  /** Provider quota and the orchestrator's own spend. Read-only. */
  readonly describeUsage: () => OrchestratorUsageReport;
  /**
   * Reads one thread's outstanding proposed plans. Called only for a thread
   * that is actually stopped on one, so the common path stays synchronous.
   */
  readonly readProposedPlans: (input: {
    environmentId: string;
    threadId: string;
  }) => Promise<ReadonlyArray<ProposedPlanInput>>;
  /**
   * Opens a web address on the user's screen. The only capability that reaches
   * outside the app, and deliberately the narrowest one that answers "put that
   * on" — a URL from a fixed catalog, handed to the browser. It cannot run a
   * command, launch an application, or touch a file.
   */
  readonly openWebsite: (url: string) => Promise<void>;
  /**
   * Runs a shell command on the host and returns what it printed.
   *
   * Read-only is asked of the model in the tool description rather than
   * enforced here; the server refuses only irreversible actions. See
   * `readOnlyCommand.ts` on the server for why an allowlist was dropped.
   */
  readonly runCommand: (input: {
    readonly command: string;
    readonly cwd?: string;
  }) => Promise<OrchestratorCommandResult>;
  /**
   * Live terminals across connected environments. Read does not spawn a pane;
   * write types into an existing one.
   */
  readonly listTerminals: () => Promise<ReadonlyArray<OrchestratorTerminalRecord>>;
  readonly readTerminal: (input: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly terminalId: string;
  }) => Promise<{ readonly history: string; readonly status: string; readonly label: string }>;
  readonly writeTerminal: (input: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly terminalId: string;
    readonly data: string;
  }) => Promise<void>;
  /** Validates a settings request against the provider catalog. Never throws. */
  readonly planThreadSettings: (input: {
    thread: ThreadSnapshot;
    request: ThreadSettingsRequest;
  }) => ThreadSettingsPlan;
  readonly applyThreadSettings: (input: {
    thread: ThreadSnapshot;
    request: ThreadSettingsRequest;
    plan: ThreadSettingsPlan;
    applyNow: boolean;
  }) => Promise<void>;
  /** Records every call for the settings pane and the console. */
  readonly onToolCall?: (entry: OrchestratorToolLogEntry) => void;
}

export class OrchestratorToolError extends Error {}

/** Public shape returned to the model — deliberately small and id-light. */
export type OrchestratorCommandResult =
  | { readonly refused: true; readonly reason: string }
  | {
      readonly refused: false;
      readonly stdout: string;
      readonly stderr: string;
      readonly exitCode: number | null;
      readonly timedOut: boolean;
      readonly truncated: boolean;
    };

export interface SpokenThreadSummary {
  readonly threadId: string;
  readonly title: string;
  readonly status: string;
  readonly waitingOn: string;
  readonly isWorking: boolean;
  /**
   * Which model the thread runs on. Without this the orchestrator was asked
   * "what model is it using?" and, having no field for it, invented an
   * explanation about the model appearing later.
   */
  readonly model: string;
  readonly provider: string;
  readonly accessMode: string;
  readonly interactionMode: string;
  /**
   * Thinking effort, or "default" when the provider was left on its own.
   *
   * `update_thread_settings` could set this from the start, but nothing ever
   * reported it back — so the orchestrator could change a thread's effort and
   * then be unable to answer "what is it set to?", including about a change it
   * had just made itself.
   */
  readonly effort: string;
  /** Whether the user has marked this thread finished. */
  readonly settled: boolean;
  /**
   * Which project the thread belongs to. Titles alone cannot separate three
   * threads all called "Vera Medical"; the project is the second axis that can.
   */
  readonly project: string;
  /**
   * Whether this is a side chat, and what it hangs off.
   *
   * Reported on every thread rather than only when true: an absent field reads
   * to the model as "unknown", and it answered "is that a side chat?" by
   * guessing from the title. `sideChatOf` carries the parent's *title* because
   * that is the only handle the user has — they have never seen its id.
   */
  readonly isSideChat: boolean;
  readonly sideChatOf?: string;
  /**
   * Why the thread failed, in the provider's own words. Present only when
   * something actually failed — "it failed" without this was the entire
   * complaint about failure reporting.
   */
  readonly error?: string;
  /** Coarse classification of {@link error}, e.g. an auth or usage-limit failure. */
  readonly failureKind?: string;
  /** ISO timestamp of when the failure was recorded. Present only with {@link error}. */
  readonly errorAt?: string;
  /**
   * That timestamp as something speakable — "12 minutes ago". The model reading
   * an ISO string out loud is unusable, and asking it to subtract two datetimes
   * in its head is a reliable way to get a confidently wrong number.
   */
  readonly errorAge?: string;
  /** Terminals currently open on this thread. Empty when none. */
  readonly terminals: ReadonlyArray<{
    readonly terminalId: string;
    readonly label: string;
    readonly status: string;
    readonly hasRunningSubprocess: boolean;
  }>;
}

/**
 * How long ago something happened, in words a voice can use.
 *
 * Deliberately coarse: "about 3 hours ago" is what the user wants to hear, and
 * a precise duration read aloud is noise. Returns null for a timestamp that
 * cannot be parsed, so a malformed value is omitted rather than announced as
 * "NaN minutes ago".
 */
export function describeAge(iso: string, now: number): string | undefined {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return undefined;
  const seconds = Math.round((now - at) / 1_000);
  // Clock skew between the client and the environment can put a fresh failure
  // slightly in the future; "just now" is the honest reading of that.
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `about ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `about ${days} day${days === 1 ? "" : "s"} ago`;
}

/** Both age fields or neither, so a bad timestamp is omitted rather than voiced. */
function describeFailureAge(
  errorAt: string | null,
  now: number,
): { errorAt?: string; errorAge?: string } {
  if (errorAt === null) return {};
  const age = describeAge(errorAt, now);
  return age === undefined ? {} : { errorAt, errorAge: age };
}

function summarize(
  snapshot: ThreadSnapshot,
  now: number = Date.now(),
  world?: OrchestratorWorld,
  terminals: ReadonlyArray<OrchestratorTerminalRecord> = [],
): SpokenThreadSummary {
  const parent =
    snapshot.isSideChat && snapshot.sideChatParentThreadId !== null && world !== undefined
      ? findThreadById(world, snapshot.environmentId, snapshot.sideChatParentThreadId)
      : undefined;
  return {
    threadId: snapshot.threadId,
    title: snapshot.title,
    // Settled outranks a stale error, but not live work or an unreachable host —
    // both of those are facts about right now, where "settled" is a note the
    // user left. A thread marked finished that still carried a provider error
    // used to read as "error" here while the sidebar showed it settled.
    status: snapshot.environmentUnreachable
      ? "unreachable"
      : snapshot.isWorking
        ? "working"
        : snapshot.settled
          ? "settled"
          : snapshot.hasError
            ? "error"
            : "idle",
    // Reported alongside the status, not folded into it: a settled thread that
    // errored is still a thread that errored, and the error fields below stay
    // present so nothing is hidden by the label.
    settled: snapshot.settled,
    waitingOn: snapshot.waitingOn,
    isWorking: snapshot.isWorking,
    model: snapshot.model,
    provider: snapshot.provider,
    accessMode: snapshot.accessMode,
    interactionMode: snapshot.interactionMode,
    effort: snapshot.effort,
    project: snapshot.projectName.length > 0 ? snapshot.projectName : snapshot.workspaceName,
    // Spread rather than set to null: an absent key reads to the model as "no
    // failure", where an explicit null invites it to narrate one.
    ...(snapshot.lastError === null ? {} : { error: snapshot.lastError }),
    ...(snapshot.failureKind === null ? {} : { failureKind: snapshot.failureKind }),
    isSideChat: snapshot.isSideChat,
    // Only when the parent is actually in the world: naming a thread the user
    // cannot open is worse than saying nothing about it.
    ...(parent === undefined ? {} : { sideChatOf: parent.title }),
    ...describeFailureAge(snapshot.errorAt, now),
    terminals: compactTerminals(terminalsForThread(terminals, snapshot)),
  };
}

/** The parent of a side chat, when it is still present in the world. */
function findThreadById(
  world: OrchestratorWorld,
  environmentId: string,
  threadId: string,
): ThreadSnapshot | undefined {
  for (const snapshot of world.values()) {
    if (snapshot.environmentId === environmentId && snapshot.threadId === threadId) return snapshot;
  }
  return undefined;
}

/**
 * Either the thread the user meant, or the question to ask them.
 *
 * Routing is the step most likely to go wrong, but asking about *every* message
 * was worse than the problem — so the ask is now reserved for the case where
 * the name genuinely fits more than one thread. Everything else resolves and
 * proceeds.
 */
type TargetResolution =
  | { readonly ok: true; readonly thread: ThreadSnapshot; readonly confident: boolean }
  | { readonly ok: false; readonly result: ToolResult };

function resolveTarget(
  context: OrchestratorToolContext,
  args: Record<string, unknown>,
  action: string,
): TargetResolution {
  // `threadId` is still accepted: the model has seen it in earlier sessions and
  // ids resolve through the same path anyway.
  const raw = args.thread ?? args.threadId ?? args.title;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new OrchestratorToolError(
      "Which thread? Pass the name the user used, or an id from list_threads.",
    );
  }
  const query = raw.trim();
  const projectHint = typeof args.project === "string" ? args.project.trim() : undefined;

  const resolution = resolveThreadReference(
    context.world,
    query,
    projectHint !== undefined && projectHint.length > 0 ? { projectHint } : {},
  );

  if (resolution.kind === "resolved") {
    return { ok: true, thread: resolution.thread, confident: resolution.confident };
  }

  if (resolution.kind === "ambiguous") {
    const options = resolution.candidates.map((thread) => ({
      threadId: thread.threadId,
      title: thread.title,
      project: thread.projectName,
      status: thread.isWorking ? "working" : "idle",
      describe: describeCandidate(thread),
    }));
    return {
      ok: false,
      result: {
        value: {
          ok: false,
          ambiguous: true,
          heard: query,
          candidates: options,
          say: `"${query}" matches ${options.length} threads: ${options.map((option) => option.describe).join("; ")}. Ask the user which one they mean, using what tells them apart — the project, or what each is doing. Then call again with that thread.`,
        },
        outcome: "needs-confirmation",
        detail: `"${query}" matched ${options.length} threads`,
      },
    };
  }

  const suggestions = resolution.suggestions.map((thread) => describeCandidate(thread));
  return {
    ok: false,
    result: {
      value: {
        ok: false,
        notFound: true,
        heard: query,
        suggestions,
        say:
          suggestions.length > 0
            ? `Nothing is open called "${query}". The closest are: ${suggestions.join("; ")}. Ask the user whether they meant one of those; do not ${action} anything until they say.`
            : `Nothing is open called "${query}". Tell the user that, and offer to list what is open.`,
      },
      outcome: "error",
      detail: `no thread matching "${query}"`,
    },
  };
}

type TerminalTargetResolution =
  | {
      readonly ok: true;
      readonly terminal: OrchestratorTerminalRecord;
      readonly confident: boolean;
    }
  | { readonly ok: false; readonly result: ToolResult };

async function resolveTerminalTarget(
  context: OrchestratorToolContext,
  args: Record<string, unknown>,
  action: string,
): Promise<TerminalTargetResolution> {
  const namedThread =
    typeof args.thread === "string" ||
    typeof args.threadId === "string" ||
    typeof args.title === "string";
  let thread: ThreadSnapshot | undefined;
  // Starts true because an unnamed thread is not a guess about the thread.
  let threadConfident = true;
  if (namedThread) {
    const target = resolveTarget(context, args, action);
    if (!target.ok) return target;
    thread = target.thread;
    threadConfident = target.confident;
  }

  const terminals = await context.listTerminals();
  const scoped = thread === undefined ? terminals : terminalsForThread(terminals, thread);
  const query = typeof args.terminal === "string" ? args.terminal.trim() : "";
  const resolution = resolveTerminalReference(scoped, {
    query,
    ...(thread === undefined ? {} : { threadId: thread.threadId }),
  });

  if (resolution.ok) {
    // Both resolutions were guesses or neither was. Dropping the thread's
    // confidence here was how "type yes into Vera" could execute in whichever
    // "Vera …" thread fuzzy-matched first, with the confirm gate never asked:
    // the terminal within the (wrong) thread resolved unambiguously, and that
    // was the only confidence the caller ever saw.
    return { ...resolution, confident: resolution.confident && threadConfident };
  }

  if (resolution.kind === "ambiguous") {
    const options = resolution.candidates.map((terminal) => describeTerminalAloud(terminal));
    return {
      ok: false,
      result: {
        value: {
          ok: false,
          ambiguous: true,
          heard: query,
          candidates: resolution.candidates.map((terminal) => ({
            thread: terminal.threadTitle,
            terminalId: terminal.terminalId,
            label: terminal.label,
          })),
          say: `That matches ${options.length} terminals: ${options.join("; ")}. Ask which one they mean, then call again.`,
        },
        outcome: "needs-confirmation",
        detail: `"${query || "the terminal"}" matched ${options.length} terminals`,
      },
    };
  }

  return {
    ok: false,
    result: {
      value: {
        ok: false,
        notFound: true,
        heard: query,
        say:
          scoped.length === 0
            ? thread === undefined
              ? "No terminals are open. Tell the user that rather than guessing."
              : `"${thread.title}" has no terminals open. Tell the user that rather than guessing.`
            : `Nothing is open called "${query}". The open terminals are: ${scoped.map((terminal) => describeTerminalAloud(terminal)).join("; ")}.`,
      },
      outcome: "error",
      detail: `no terminal matching "${query}"`,
    },
  };
}

/**
 * Titles are what the user sees in the sidebar, and they come from speech — so
 * a stray newline or a whole dictated paragraph must not become one.
 */
const MAX_THREAD_TITLE_LENGTH = 80;

function readTitle(value: unknown): string {
  if (typeof value !== "string") {
    throw new OrchestratorToolError("A new title is required.");
  }
  const title = value.replace(/\s+/g, " ").trim();
  if (title.length === 0) {
    throw new OrchestratorToolError("A thread title cannot be empty.");
  }
  if (title.length > MAX_THREAD_TITLE_LENGTH) {
    throw new OrchestratorToolError(
      `That title is ${title.length} characters; keep it under ${MAX_THREAD_TITLE_LENGTH}.`,
    );
  }
  return title;
}

type ProjectChoice =
  | { readonly ok: true; readonly project: ProjectReference }
  | { readonly ok: false; readonly result: ToolResult };

/**
 * Picks the project a call is about.
 *
 * With one project there is nothing to ask about, so it never asks — that kind
 * of question, with exactly one possible answer, is the friction the user
 * objected to. With several and none named, it asks, because that genuinely is
 * underdetermined.
 */
function chooseProject(
  projects: ReadonlyArray<ProjectReference>,
  requested: unknown,
): ProjectChoice {
  const name = typeof requested === "string" ? requested.trim() : "";
  if (name.length === 0) {
    const only = projects[0];
    if (projects.length === 1 && only !== undefined) return { ok: true, project: only };
    return {
      ok: false,
      result: {
        value: {
          ok: false,
          needsProject: true,
          projects: projects.map((entry) => entry.name),
          say: `Ask which project they mean: ${projects.map((entry) => entry.name).join(", ")}.`,
        },
        outcome: "needs-confirmation",
        detail: "project not specified",
      },
    };
  }

  const resolution = resolveProjectReference(projects, name);
  if (resolution.kind === "resolved") return { ok: true, project: resolution.project };
  if (resolution.kind === "ambiguous") {
    return {
      ok: false,
      result: {
        value: {
          ok: false,
          needsProject: true,
          projects: resolution.candidates.map((entry) => entry.name),
          say: `"${name}" matches more than one project. Ask which: ${resolution.candidates.map((entry) => entry.name).join(", ")}.`,
        },
        outcome: "needs-confirmation",
        detail: `"${name}" matched several projects`,
      },
    };
  }
  return {
    ok: false,
    result: {
      value: {
        ok: false,
        notFound: true,
        suggestions: resolution.suggestions.map((entry) => entry.name),
        say: `There is no project called "${name}". Say what does exist and ask which they meant.`,
      },
      outcome: "error",
      detail: `no project matching "${name}"`,
    },
  };
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OrchestratorToolError(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

/** Parses a closed set, reporting the whole set rather than just "invalid". */
function readEnum<T extends string>(
  value: unknown,
  allowed: ReadonlyArray<T>,
  field: string,
): T | undefined {
  const raw = readOptionalString(value, field);
  if (raw === undefined) return undefined;
  const match = allowed.find((candidate) => candidate === raw);
  if (match === undefined) {
    throw new OrchestratorToolError(
      `${field} must be one of: ${allowed.join(", ")}. Got "${raw}".`,
    );
  }
  return match;
}

function buildSettingsRequest(args: Record<string, unknown>): ThreadSettingsRequest {
  const model = readOptionalString(args.model, "model");
  const provider = readOptionalString(args.provider, "provider");
  const effort = readOptionalString(args.effort, "effort");
  const accessMode = readEnum(args.accessMode, RUNTIME_MODES, "accessMode");
  const interactionMode = readEnum(args.interactionMode, INTERACTION_MODES, "interactionMode");
  return {
    ...(model === undefined ? {} : { model }),
    ...(provider === undefined ? {} : { provider }),
    ...(effort === undefined ? {} : { effort }),
    ...(accessMode === undefined ? {} : { accessMode }),
    ...(interactionMode === undefined ? {} : { interactionMode }),
  };
}

export function raisesPermissions(from: string, to: RuntimeMode): boolean {
  const before = RUNTIME_MODE_PERMISSIVENESS[from as RuntimeMode];
  // An unrecognised current mode is treated as the most restrictive, so the
  // change is confirmed rather than waved through.
  return RUNTIME_MODE_PERMISSIVENESS[to] > (before ?? 0);
}

function describeChanges(changes: ReadonlyArray<ThreadSettingsChange>): string {
  return changes.map((change) => `${change.field} ${change.from} → ${change.to}`).join(", ");
}

// ── Execution ────────────────────────────────────────────────────

type ToolOutcome = OrchestratorToolLogEntry["outcome"];

interface ToolResult {
  readonly value: unknown;
  readonly outcome: ToolOutcome;
  readonly detail: string;
}

export async function executeOrchestratorTool(
  context: OrchestratorToolContext,
  call: { readonly name: string; readonly args: Record<string, unknown> },
): Promise<unknown> {
  const startedAt = Date.now();
  const reason = typeof call.args.reason === "string" ? call.args.reason.trim() : "";

  const log = (outcome: ToolOutcome, detail: string): void => {
    context.onToolCall?.({
      name: call.name,
      reason: reason.length > 0 ? reason : null,
      outcome,
      detail,
      durationMs: Date.now() - startedAt,
      at: new Date().toISOString(),
    });
  };

  try {
    const result = await runTool(context, call);
    log(result.outcome, result.detail);
    return result.value;
  } catch (error) {
    log("error", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function runTool(
  context: OrchestratorToolContext,
  call: { readonly name: string; readonly args: Record<string, unknown> },
): Promise<ToolResult> {
  // Belt-and-braces: the session only advertises tools for the current
  // authority, but a model can still emit a name it saw earlier in the session
  // if the setting changed mid-conversation.
  if (!isToolAllowed(call.name, context.authority)) {
    throw new OrchestratorToolError(
      `Not permitted at the current authority level (${context.authority}).`,
    );
  }

  switch (call.name) {
    case "list_threads": {
      const terminals = await context.listTerminals();
      const threads = [...context.world.values()].map((snapshot) =>
        summarize(snapshot, Date.now(), context.world, terminals),
      );
      return {
        value: { threads, totalCount: threads.length },
        outcome: "ok",
        detail: `${threads.length} thread${threads.length === 1 ? "" : "s"}`,
      };
    }

    case "describe_thread": {
      const target = resolveTarget(context, call.args, "describe");
      if (!target.ok) return target.result;
      const terminals = await context.listTerminals();
      const thread = summarize(target.thread, Date.now(), context.world, terminals);
      // A status without the thread's last words made every answer that
      // mattered need a second read_thread call — and usually got given
      // without one, from nothing. Best-effort on purpose: a status answer
      // must not start failing because a history fetch did, so an unreachable
      // environment simply means the tail is absent.
      const recentMessages = await context
        .readThread({
          environmentId: target.thread.environmentId,
          threadId: target.thread.threadId,
        })
        .then((stored) => statusMessageTail(stored.messages))
        .catch(() => []);
      const described = recentMessages.length > 0 ? { ...thread, recentMessages } : thread;

      // "Waiting on a proposed plan" is true and useless on its own. Fetched
      // only in the one state where there is a plan to fetch, so describing an
      // ordinary thread stays a single synchronous read of the world.
      if (target.thread.waitingOn !== "proposed-plan") {
        return { value: { thread: described }, outcome: "ok", detail: thread.title };
      }

      const plan = await readActionablePlan(context, target.thread);
      if (plan === null) {
        return {
          value: {
            thread: described,
            say: `${thread.title} is waiting for the user to approve a plan, but the plan itself could not be read. Say that, rather than guessing at what it proposes.`,
          },
          outcome: "ok",
          detail: `${thread.title} (plan unreadable)`,
        };
      }

      return {
        value: {
          thread: described,
          proposedPlan: plan,
          say: describePlanAloud(plan, thread.title),
        },
        outcome: "ok",
        detail: `${thread.title} (awaiting approval: ${plan.title})`,
      };
    }

    case "read_thread": {
      const target = resolveTarget(context, call.args, "read");
      if (!target.ok) return target.result;
      const thread = target.thread;
      const limit = resolveLimit(call.args.limit, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT);
      const includeActivities = call.args.includeActivities === true;

      const stored = await context.readThread({
        environmentId: thread.environmentId,
        threadId: thread.threadId,
      });
      const history = readThreadHistory({
        messages: stored.messages,
        activities: stored.activities,
        limit,
        includeActivities,
      });

      return {
        value: {
          thread: thread.title,
          project: thread.projectName,
          ...history,
          say:
            history.messages.length === 0
              ? `"${thread.title}" has nothing said in it yet. Tell the user that rather than guessing what it is doing.`
              : `Use these messages to finish the user's request. They are the real contents of "${thread.title}", newest last${history.truncated ? `, and only the last ${history.messages.length} of ${history.totalMessages}` : ""}. If the user asked you to act, call the action tool now; do not stop at a suggestion. Summarize only when they asked a question, and never read the messages out verbatim.`,
        },
        outcome: "ok",
        detail: `${thread.title}: ${history.messages.length} message${history.messages.length === 1 ? "" : "s"}`,
      };
    }

    case "search_threads": {
      const query = call.args.query;
      if (typeof query !== "string" || query.trim().length === 0) {
        throw new OrchestratorToolError("Something to search for is required.");
      }
      const limit = resolveLimit(call.args.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);

      // Scope narrows the search before any thread is opened, which is what
      // keeps a workspace-wide question from costing one request per thread.
      let candidates: ReadonlyArray<ThreadSnapshot> = [...context.world.values()];
      let scope = "the workspace";
      if (typeof call.args.thread === "string" && call.args.thread.trim().length > 0) {
        const target = resolveTarget(context, call.args, "search");
        if (!target.ok) return target.result;
        candidates = [target.thread];
        scope = `"${target.thread.title}"`;
      } else if (typeof call.args.project === "string" && call.args.project.trim().length > 0) {
        const chosen = chooseProject(context.listProjects(), call.args.project);
        if (!chosen.ok) return chosen.result;
        candidates = candidates.filter((thread) => thread.projectId === chosen.project.projectId);
        scope = chosen.project.name;
      }

      // Newest first, so the cap keeps the threads most likely to be asked about.
      const ordered = [...candidates].sort((left, right) =>
        left.isWorking === right.isWorking ? 0 : left.isWorking ? -1 : 1,
      );
      const searched = ordered.slice(0, MAX_THREADS_PER_SEARCH);
      const skipped = ordered.length - searched.length;

      const matches: Array<ThreadSearchMatch> = [];
      const unreadable: Array<string> = [];
      for (const thread of searched) {
        if (matches.length >= limit) break;
        let stored;
        try {
          stored = await context.readThread({
            environmentId: thread.environmentId,
            threadId: thread.threadId,
          });
        } catch {
          // One unreachable environment must not fail the whole search.
          unreadable.push(thread.title);
          continue;
        }
        matches.push(
          ...searchThreadMessages({
            thread: thread.title,
            project: thread.projectName,
            messages: stored.messages,
            // Errors live here, not in the messages.
            activities: stored.activities,
            query,
            limit: limit - matches.length,
          }),
        );
      }

      const threadsWithMatches = new Set(matches.map((match) => match.thread)).size;
      const errorMatches = matches.filter((match) => match.isError).length;
      return {
        value: {
          query,
          matches,
          threadsSearched: searched.length,
          // Never let a capped search read as an exhaustive one.
          ...(skipped > 0 ? { threadsNotSearched: skipped } : {}),
          ...(unreadable.length > 0 ? { threadsUnreadable: unreadable } : {}),
          say:
            matches.length === 0
              ? `Nothing in ${scope} mentions "${query}".${skipped > 0 ? ` Say that only ${searched.length} threads were searched, and offer to narrow it to a project.` : ""}`
              : `Tell the user what was found and which thread said it — ${matches.length} match${matches.length === 1 ? "" : "es"} across ${threadsWithMatches} thread${threadsWithMatches === 1 ? "" : "s"}.${errorMatches > 0 ? ` ${errorMatches} of them ${errorMatches === 1 ? "is a recorded failure" : "are recorded failures"} — lead with ${errorMatches === 1 ? "that one" : "those"}, and say when ${errorMatches === 1 ? "it" : "they"} happened.` : ""}${skipped > 0 ? ` Mention that ${skipped} further threads were not searched.` : ""}`,
        },
        outcome: "ok",
        detail: `"${query}": ${matches.length} match${matches.length === 1 ? "" : "es"} in ${threadsWithMatches} thread${threadsWithMatches === 1 ? "" : "s"}`,
      };
    }

    case "end_voice_session": {
      const mode = call.args.mode === "hush" ? "hush" : "stop";
      context.endVoiceSession(mode);
      return {
        value: {
          ended: mode === "stop",
          // The session stays open long enough to say this; realtimeSession
          // waits for the reply to finish before closing.
          say:
            mode === "stop"
              ? "Say one short goodbye — a few words. Voice closes as soon as you finish speaking, so do not ask a follow-up question."
              : "Stop talking now. Do not answer this; say nothing further until the user speaks again.",
        },
        outcome: "ok",
        detail: mode === "stop" ? "closing voice" : "silenced",
      };
    }

    case "set_orchestrator_voice": {
      const voice = call.args.voice;
      if (typeof voice !== "string" || voice.trim().length === 0) {
        throw new OrchestratorToolError("A voice name is required.");
      }
      const next = voice.trim();
      const current = context.describeSelf();
      if (next === current.configuredVoice) {
        return {
          value: {
            changed: false,
            voice: next,
            say: `You are already set to ${next}. Say so rather than claiming to have changed it.`,
          },
          outcome: "ok",
          detail: `already ${next}`,
        };
      }

      await context.setOrchestratorVoice(next);
      return {
        value: {
          changed: true,
          voice: next,
          // The voice still rides the session token and cannot change within a
          // session — so a live session is restarted instead, which is why this
          // now reads as active. The restart is why nothing more is said here:
          // the sentence would be cut off by the reconnection anyway.
          activeNow: true,
          say: `The voice is set to ${next} and the session is reconnecting now so the user hears it immediately. Say only that you are switching to ${next} — keep it to a few words, because the reconnection will cut off anything longer.`,
        },
        outcome: "ok",
        detail: `${current.configuredVoice} → ${next}`,
      };
    }

    case "get_orchestrator_settings": {
      const report = context.describeSelf();
      return {
        value: {
          ...report,
          say: report.restartRequiredToApply
            ? `You are running on ${report.activeModel}, but settings now say ${report.configuredModel}. Tell the user the new setting takes effect when they stop and start voice again — no app restart needed.`
            : `You are running on ${report.activeModel}, which matches the saved setting.`,
        },
        outcome: "ok",
        detail: report.restartRequiredToApply
          ? `${report.activeModel} (settings say ${report.configuredModel})`
          : report.activeModel,
      };
    }

    case "open_website": {
      const site = typeof call.args.site === "string" ? call.args.site : "";
      const query = typeof call.args.query === "string" ? call.args.query : undefined;
      const resolution = resolveWebTarget(site, query);

      if (resolution.kind === "not-found") {
        return {
          value: {
            opened: false,
            known: resolution.known,
            say: `You cannot open "${site}". Tell the user which sites you can open — ${resolution.known.join(", ")} — and offer to search Google for it instead.`,
          },
          outcome: "error",
          detail: `no such site: ${site}`,
        };
      }

      if (resolution.kind === "ambiguous") {
        const names = resolution.candidates.map((candidate) => candidate.names[0] ?? candidate.id);
        return {
          value: {
            opened: false,
            candidates: names,
            say: `Ask which one they meant: ${names.join(" or ")}.`,
          },
          outcome: "needs-confirmation",
          detail: `ambiguous: ${names.join(", ")}`,
        };
      }

      const name = resolution.target.names[0] ?? resolution.target.id;
      await context.openWebsite(resolution.url);
      // Told nothing, the model narrates the URL. Nobody wants a URL read out.
      const droppedQuery =
        query !== undefined && query.trim().length > 0 && !supportsQuery(resolution.target);
      return {
        value: {
          opened: true,
          site: name,
          say: droppedQuery
            ? `Opened ${name}. Say that it does not support searching from here, so they will need to search once it is open.`
            : `Opened ${name}. Say so in a few words. Do not read the address out.`,
        },
        outcome: "ok",
        detail: droppedQuery ? `${name} (query not supported)` : name,
      };
    }

    case "create_project": {
      const path = typeof call.args.path === "string" ? call.args.path.trim() : "";
      if (path.length === 0) {
        throw new OrchestratorToolError(
          "Which folder? Give its absolute path — use run_command to find it if you only have a name.",
        );
      }
      if (!path.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(path)) {
        throw new OrchestratorToolError(
          "That is not an absolute path. Find the folder first, then pass its full path.",
        );
      }
      const name = typeof call.args.name === "string" ? call.args.name.trim() : "";

      const created = await context.createProject({
        path,
        ...(name.length > 0 ? { name } : {}),
      });

      return {
        value: {
          created: true,
          project: created.title,
          say: `Say that ${created.title} is now a project, in a few words. Do not read the path out.`,
        },
        outcome: "ok",
        detail: created.title,
      };
    }

    case "approve_proposed_plan": {
      const target = resolveTarget(context, call.args, "approve the plan for");
      if (!target.ok) return target.result;
      const thread = target.thread;

      // Read raw rather than through `readActionablePlan`: the summary is built
      // for speech and drops the markdown, which is the whole payload here.
      const plans = await context.readProposedPlans({
        environmentId: thread.environmentId,
        threadId: thread.threadId,
      });
      const actionable = findActionablePlan(plans);
      if (actionable === null) {
        return {
          value: {
            approved: false,
            say: `${thread.title} has no plan waiting for approval. Say that rather than approving anything.`,
          },
          outcome: "error",
          detail: `${thread.title} (no plan)`,
        };
      }
      const plan = summarizeProposedPlan(actionable);

      // The same prompt the approve button sends, under the same mode. Sending
      // it under the thread's own mode would land in plan mode — which is what
      // the thread is in, precisely because it just proposed a plan — and
      // produce a second plan instead of the work.
      await context.sendToThread({
        environmentId: thread.environmentId,
        threadId: thread.threadId,
        message: buildPlanImplementationPrompt(actionable.planMarkdown),
        // The wake announcement quotes the request back as what the user asked
        // for; the raw message here is an entire plan document.
        requestLabel: "implement the approved plan",
        interactionMode: "default",
      });

      return {
        value: {
          approved: true,
          plan: plan.title,
          say: `Approved. Say that ${thread.title} is starting on it, in a few words.`,
        },
        outcome: "ok",
        detail: `${thread.title}: ${plan.title}`,
      };
    }

    case "run_command": {
      const command = typeof call.args.command === "string" ? call.args.command.trim() : "";
      if (command.length === 0) {
        throw new OrchestratorToolError(
          "What command? Give the line exactly as it would be typed.",
        );
      }
      const cwd =
        typeof call.args.cwd === "string" && call.args.cwd.trim().length > 0
          ? call.args.cwd.trim()
          : undefined;

      const result = await context.runCommand({ command, ...(cwd === undefined ? {} : { cwd }) });
      if (result.refused) {
        return {
          value: {
            ran: false,
            reason: result.reason,
            say: `That command was refused: ${result.reason} Say so plainly and suggest something narrower.`,
          },
          outcome: "error",
          detail: `refused: ${command}`,
        };
      }

      // Told what to do with the output, because the natural failure here is
      // reading a directory listing out loud line by line.
      return {
        value: {
          ran: true,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated: result.truncated,
          say: result.timedOut
            ? "The command was still running after twenty seconds and was stopped. Say that, and offer a narrower one."
            : "Answer the user's question from this output in a sentence or two. Do not read it out line by line, and do not quote paths or ids unless they asked for one.",
        },
        outcome: result.exitCode === 0 ? "ok" : "error",
        detail: `${command} (exit ${result.exitCode ?? "none"})`,
      };
    }

    case "list_terminals": {
      const namedThread =
        typeof call.args.thread === "string" ||
        typeof call.args.threadId === "string" ||
        typeof call.args.title === "string";
      let terminals = await context.listTerminals();
      let scope = "the workspace";
      if (namedThread) {
        const target = resolveTarget(context, call.args, "list terminals for");
        if (!target.ok) return target.result;
        terminals = terminalsForThread(terminals, target.thread);
        scope = `"${target.thread.title}"`;
      }
      return {
        value: {
          terminals: terminals.map((terminal) => ({
            thread: terminal.threadTitle,
            terminalId: terminal.terminalId,
            label: terminal.label,
            status: terminal.status,
            hasRunningSubprocess: terminal.hasRunningSubprocess,
          })),
          totalCount: terminals.length,
          say:
            terminals.length === 0
              ? `No terminals are open in ${scope}. Tell the user that rather than guessing.`
              : `Summarize which terminals are open and which thread each belongs to. Do not read ids aloud.`,
        },
        outcome: "ok",
        detail: `${terminals.length} terminal${terminals.length === 1 ? "" : "s"}`,
      };
    }

    case "read_terminal": {
      const target = await resolveTerminalTarget(context, call.args, "read");
      if (!target.ok) return target.result;
      const terminal = target.terminal;
      const snapshot = await context.readTerminal({
        environmentId: terminal.environmentId,
        threadId: terminal.threadId,
        terminalId: terminal.terminalId,
      });
      const presented = presentTerminalRead(terminal, snapshot.history);
      return {
        value: {
          thread: terminal.threadTitle,
          terminal: terminal.label,
          status: snapshot.status,
          output: presented.output,
          truncated: presented.truncated,
          say:
            presented.output.trim().length === 0
              ? `${describeTerminalAloud(terminal)} has no output yet. Say that rather than guessing.`
              : `Answer from this output in a sentence or two. It is the current screen of ${describeTerminalAloud(terminal)}. Do not read it out line by line.${presented.truncated ? " Only the tail was returned." : ""}`,
        },
        outcome: "ok",
        detail: describeTerminalAloud(terminal),
      };
    }

    case "write_to_terminal": {
      const target = await resolveTerminalTarget(context, call.args, "type into");
      if (!target.ok) return target.result;
      const terminal = target.terminal;
      // Missing text is a malformed call, not a request to press Enter — the
      // old "" default plus submit-by-default sent a bare newline to a live
      // shell, which runs whatever is sitting at the prompt. An explicit empty
      // string with submit on stays allowed: that is the model deliberately
      // pressing Enter.
      if (typeof call.args.text !== "string") {
        throw new OrchestratorToolError("What should be typed? Give the text.");
      }
      const text = call.args.text;
      const submit = call.args.submit !== false;
      const payload = encodeTerminalWrite(text, submit);
      if (payload.length === 0) {
        throw new OrchestratorToolError("What should be typed? Give the text.");
      }
      if (!target.confident && call.args.confirm !== true) {
        return {
          value: {
            written: false,
            confirmationRequired: true,
            willTypeInto: describeTerminalAloud(terminal),
            say: `You are not certain they meant ${describeTerminalAloud(terminal)}. Check, then call again with confirm set to true.`,
          },
          outcome: "needs-confirmation",
          detail: `unsure: would type into ${describeTerminalAloud(terminal)}`,
        };
      }
      await context.writeTerminal({
        environmentId: terminal.environmentId,
        threadId: terminal.threadId,
        terminalId: terminal.terminalId,
        data: payload,
      });
      return {
        value: {
          written: true,
          thread: terminal.threadTitle,
          terminal: terminal.label,
          submitted: submit,
          say: `Say briefly that you typed into ${describeTerminalAloud(terminal)}.`,
        },
        outcome: "ok",
        detail: `typed into ${describeTerminalAloud(terminal)}`,
      };
    }

    case "get_usage": {
      const report = context.describeUsage();
      const scope = typeof call.args.scope === "string" ? call.args.scope : "all";
      const wantsProviders = scope !== "voice";
      const wantsVoice = scope !== "providers";
      return {
        value: {
          ...(wantsProviders ? { providers: report.providers } : {}),
          ...(wantsVoice ? { voice: report.voice } : {}),
          say: describeUsageAloud(report, { wantsProviders, wantsVoice }),
        },
        outcome: "ok",
        detail: summariseUsage(report, { wantsProviders, wantsVoice }),
      };
    }

    case "get_runtime_state": {
      const report = context.describeRuntime();
      return {
        value: report,
        outcome: "ok",
        detail: `${report.threadCounts.total} threads, ${report.environments.length} environment${report.environments.length === 1 ? "" : "s"}`,
      };
    }

    case "send_to_thread": {
      const target = resolveTarget(context, call.args, "send to");
      if (!target.ok) return target.result;
      const thread = target.thread;
      const message = call.args.message;
      if (typeof message !== "string" || message.trim().length === 0) {
        throw new OrchestratorToolError("A message is required.");
      }

      // Sending is not destructive, and confirming every message made the
      // orchestrator exhausting to talk to. The only thing worth stopping for
      // is a target we are not actually sure of — a weak, fuzzy-only match.
      // Genuine ambiguity was already handled by resolveTarget.
      if (!target.confident && call.args.confirm !== true) {
        return {
          value: {
            delivered: false,
            confirmationRequired: true,
            willSendTo: {
              title: thread.title,
              project: thread.projectName,
              status: thread.isWorking ? "working" : "idle",
            },
            say: `You are fairly but not entirely sure they meant "${thread.title}"${thread.projectName.length > 0 ? ` in ${thread.projectName}` : ""}. Say which thread you are about to send to and get a quick yes, then call again with confirm set to true.`,
          },
          outcome: "needs-confirmation",
          detail: `unsure: would send to ${thread.title}`,
        };
      }

      await context.sendToThread({
        environmentId: thread.environmentId,
        threadId: thread.threadId,
        message,
      });
      return {
        value: {
          delivered: true,
          title: thread.title,
          project: thread.projectName,
          say: `Confirm briefly that you sent it to "${thread.title}".`,
        },
        outcome: "ok",
        detail: `sent to ${thread.title}`,
      };
    }

    case "list_project_files":
    case "read_project_file":
    case "find_project_files":
    case "search_project": {
      const chosen = chooseProject(context.listProjects(), call.args.project);
      if (!chosen.ok) return chosen.result;

      const action =
        call.name === "list_project_files"
          ? "list"
          : call.name === "read_project_file"
            ? "read"
            : call.name === "find_project_files"
              ? "find"
              : "search";

      const path = readOptionalString(call.args.path, "path");
      const query = readOptionalString(call.args.query, "query");
      if (action === "read" && path === undefined) {
        throw new OrchestratorToolError("A file path is required.");
      }
      if ((action === "find" || action === "search") && query === undefined) {
        throw new OrchestratorToolError("A search query is required.");
      }

      const result = await context.inspectProject({
        environmentId: chosen.project.environmentId,
        projectId: chosen.project.projectId,
        action,
        ...(path === undefined ? {} : { path }),
        ...(query === undefined ? {} : { query }),
      });
      return {
        value: { project: chosen.project.name, ...(result as Record<string, unknown>) },
        outcome: "ok",
        detail: `${call.name} in ${chosen.project.name}${path === undefined ? "" : ` (${path})`}${query === undefined ? "" : ` "${query}"`}`,
      };
    }

    case "create_thread": {
      const projects = context.listProjects();
      const title = readTitle(call.args.title);
      const message = call.args.message;
      if (typeof message !== "string" || message.trim().length === 0) {
        throw new OrchestratorToolError("A first message is required.");
      }

      const requested = typeof call.args.project === "string" ? call.args.project.trim() : "";
      let project: ProjectReference;
      if (requested.length === 0) {
        // With one project there is nothing to ask about; with several there
        // genuinely is not enough context to choose.
        const only = projects[0];
        if (projects.length !== 1 || only === undefined) {
          return {
            value: {
              created: false,
              needsProject: true,
              projects: projects.map((entry) => entry.name),
              say: `Ask which project this belongs to: ${projects.map((entry) => entry.name).join(", ")}.`,
            },
            outcome: "needs-confirmation",
            detail: "project not specified",
          };
        }
        project = only;
      } else {
        const resolution = resolveProjectReference(projects, requested);
        if (resolution.kind === "ambiguous") {
          return {
            value: {
              created: false,
              needsProject: true,
              projects: resolution.candidates.map((entry) => entry.name),
              say: `"${requested}" matches more than one project. Ask which: ${resolution.candidates.map((entry) => entry.name).join(", ")}.`,
            },
            outcome: "needs-confirmation",
            detail: `"${requested}" matched several projects`,
          };
        }
        if (resolution.kind === "not-found") {
          return {
            value: {
              created: false,
              notFound: true,
              suggestions: resolution.suggestions.map((entry) => entry.name),
              say: `There is no project called "${requested}". Tell the user what does exist and ask which they meant.`,
            },
            outcome: "error",
            detail: `no project matching "${requested}"`,
          };
        }
        project = resolution.project;
      }

      await context.createThread({
        environmentId: project.environmentId,
        projectId: project.projectId,
        title,
        message,
      });
      return {
        value: {
          created: true,
          title,
          project: project.name,
          say: `Say briefly that you started "${title}" in ${project.name} and passed the request on.`,
        },
        outcome: "ok",
        detail: `created "${title}" in ${project.name}`,
      };
    }

    case "settle_thread": {
      const target = resolveTarget(context, call.args, "settle");
      if (!target.ok) return target.result;
      const thread = target.thread;
      const settled = call.args.undo !== true;

      // Marking running work "finished" is a contradiction worth surfacing —
      // but settling something idle is exactly the cleanup being asked for and
      // must not require a round trip.
      if (settled && thread.isWorking && call.args.confirm !== true) {
        return {
          value: {
            settled: false,
            confirmationRequired: true,
            thread: thread.title,
            say: `"${thread.title}" is still running. Check they want it marked settled anyway — this only records the state, it does not stop the work or hide the thread — then call again with confirm set to true.`,
          },
          outcome: "needs-confirmation",
          detail: `${thread.title} is still working`,
        };
      }

      if (!target.confident && call.args.confirm !== true) {
        return {
          value: {
            settled: false,
            confirmationRequired: true,
            thread: thread.title,
            say: `You are not certain they meant "${thread.title}". Check, then call again with confirm set to true.`,
          },
          outcome: "needs-confirmation",
          detail: `unsure: would settle ${thread.title}`,
        };
      }

      const delivery = await context.setThreadSettled({
        environmentId: thread.environmentId,
        threadId: thread.threadId,
        settled,
      });
      if (delivery.deferred) {
        return {
          value: {
            settled,
            queued: true,
            thread: thread.title,
            stillVisible: true,
            say: settled
              ? `Confirm briefly that "${thread.title}" will be marked settled when its computer reconnects.`
              : `Confirm briefly that "${thread.title}" will be un-settled when its computer reconnects.`,
          },
          outcome: "ok",
          detail: `queued ${settled ? "settle" : "un-settle"} for ${thread.title}`,
        };
      }
      return {
        value: {
          settled,
          thread: thread.title,
          stillVisible: true,
          say: settled
            ? `Confirm briefly that "${thread.title}" is marked settled, and that it is still in the sidebar.`
            : `Confirm briefly that "${thread.title}" is no longer marked settled.`,
        },
        outcome: "ok",
        detail: `${settled ? "settled" : "un-settled"} ${thread.title}`,
      };
    }

    case "create_side_chat": {
      const target = resolveTarget(
        context,
        { ...call.args, title: undefined },
        "open a side chat on",
      );
      if (!target.ok) return target.result;
      const thread = target.thread;
      const title = readTitle(call.args.title);
      const message = call.args.message;
      if (typeof message !== "string" || message.trim().length === 0) {
        throw new OrchestratorToolError("A first message is required.");
      }

      // Forking touches the parent's provider session, so an unsure target is
      // worth a check even though the side chat itself is harmless.
      if (!target.confident && call.args.confirm !== true) {
        return {
          value: {
            created: false,
            confirmationRequired: true,
            willForkFrom: { title: thread.title, project: thread.projectName },
            say: `You are not certain they meant "${thread.title}". Check that is the thread to branch from, then call again with confirm set to true.`,
          },
          outcome: "needs-confirmation",
          detail: `unsure: would fork ${thread.title}`,
        };
      }

      await context.createSideChat({
        environmentId: thread.environmentId,
        threadId: thread.threadId,
        title,
        message,
      });
      return {
        value: {
          created: true,
          title,
          parent: thread.title,
          say: `Say briefly that you opened "${title}" alongside "${thread.title}", and that the parent thread is still running.`,
        },
        outcome: "ok",
        detail: `side chat "${title}" off ${thread.title}`,
      };
    }

    case "rename_thread": {
      const target = resolveTarget(context, { ...call.args, title: undefined }, "rename");
      if (!target.ok) return target.result;
      const thread = target.thread;
      const title = readTitle(call.args.title);

      if (title === thread.title) {
        return {
          value: { renamed: false, reason: "already-named", title },
          outcome: "ok",
          detail: `${thread.title} already had that name`,
        };
      }

      // Renaming is reversible and touches no work in progress, so it does not
      // need a confirmation of its own — only of the target, when unsure.
      if (!target.confident && call.args.confirm !== true) {
        return {
          value: {
            renamed: false,
            confirmationRequired: true,
            willRename: { from: thread.title, to: title, project: thread.projectName },
            say: `You are not certain they meant "${thread.title}". Check that is the thread to rename, then call again with confirm set to true.`,
          },
          outcome: "needs-confirmation",
          detail: `unsure: would rename ${thread.title}`,
        };
      }

      await context.renameThread({
        environmentId: thread.environmentId,
        threadId: thread.threadId,
        title,
      });
      return {
        value: {
          renamed: true,
          from: thread.title,
          to: title,
          say: `Confirm briefly that it is now called "${title}".`,
        },
        outcome: "ok",
        detail: `renamed "${thread.title}" to "${title}"`,
      };
    }

    case "update_thread_settings": {
      const target = resolveTarget(context, call.args, "change settings on");
      if (!target.ok) return target.result;
      const thread = target.thread;
      const request = buildSettingsRequest(call.args);
      if (Object.keys(request).length === 0) {
        throw new OrchestratorToolError(
          "Nothing to change. Set at least one of model, provider, effort, accessMode or interactionMode.",
        );
      }
      const plan = context.planThreadSettings({ thread, request });

      if (plan.rejections.length > 0) {
        return {
          value: {
            applied: false,
            rejected: true,
            problems: plan.rejections,
            say: `Tell the user this change cannot be made and why, using the problems listed. Do not retry with a guess.`,
          },
          outcome: "error",
          detail: plan.rejections.join("; "),
        };
      }

      if (plan.changes.length === 0) {
        return {
          value: {
            applied: false,
            reason: "already-set",
            say: `${thread.title} is already set that way, so nothing changed.`,
          },
          outcome: "ok",
          detail: `${thread.title} already matched`,
        };
      }

      // Only genuinely destructive outcomes are confirmed. Widening an agent's
      // permissions and stopping a turn in progress qualify no matter what the
      // user's general preference is; swapping a model on an idle thread does
      // not, and asking about that every time was pure friction.
      //
      // Every reason is collected and read back together. Surfacing them one at
      // a time meant a call that both stopped a turn and widened access asked
      // twice, which reads as the first confirmation not having registered.
      // Dispatching the commands alone only *caches* a model or effort change;
      // the thread keeps talking to the old one until a turn starts. Asking for
      // a model switch and being told "it will apply next turn" is not what
      // anyone means by switching a model, so applying is the default and
      // `applyNow: false` is the way to opt out.
      //
      // Only deferred changes need a turn. Access mode reaches the live session
      // through its own command, so forcing a turn for it would stop work in
      // progress to deliver something that had already arrived.
      const needsTurnToApply = plan.changes.some((change) => change.effectiveOn === "next-turn");
      const applyNow = needsTurnToApply && call.args.applyNow !== false;
      // An access-mode-only change dispatches straight to the live session, so
      // it is active the moment applyThreadSettings returns even though no
      // turn was forced. Reporting it as "takes effect next turn" told the
      // user their lockdown had not landed when it already had.
      const activeNow =
        applyNow ||
        (plan.changes.length > 0 &&
          plan.changes.every((change) => change.effectiveOn === "immediately"));

      // The user asking for the change *is* the authorisation to make it. The
      // only thing left worth a question is a consequence they did not ask for:
      // losing work in progress, or widening what the agent may do.
      const confirmationReasons: Array<string> = [];
      if (plan.raisesPermissions) {
        confirmationReasons.push("it gives the agent broader access");
      }
      if (applyNow && thread.isWorking) {
        confirmationReasons.push("it stops the turn the thread is running right now");
      }
      if (!target.confident) {
        confirmationReasons.push(`you are not certain they meant "${thread.title}"`);
      }
      const mustConfirm = confirmationReasons.length > 0;

      if (mustConfirm && call.args.confirm !== true) {
        const immediate = plan.changes.filter((change) => change.effectiveOn === "immediately");
        const deferred = plan.changes.filter((change) => change.effectiveOn === "next-turn");
        return {
          value: {
            applied: false,
            confirmationRequired: true,
            thread: thread.title,
            changes: plan.changes,
            warnings: plan.warnings,
            raisesPermissions: plan.raisesPermissions,
            takesEffectImmediately: immediate.map((change) => change.field),
            takesEffectNextTurn: deferred.map((change) => change.field),
            willStopCurrentTurn: applyNow && thread.isWorking,
            confirmationReasons,
            say: [
              `Read this back to the user and ask them to confirm: on "${thread.title}", ${describeChanges(plan.changes)}.`,
              immediate.length > 0
                ? `${immediate.map((change) => change.field).join(" and ")} take effect right away.`
                : "",
              deferred.length > 0
                ? `${deferred.map((change) => change.field).join(" and ")} apply on its next turn.`
                : "",
              applyNow && thread.isWorking
                ? "Warn them this stops the turn it is running right now."
                : "",
              plan.raisesPermissions ? "Say clearly that this gives the agent broader access." : "",
              ...plan.warnings,
              // One round, not one per reason.
              "Cover all of that in a single question. One yes is enough for the whole change: call update_thread_settings again with the same arguments plus confirm set to true, and do not ask again.",
            ]
              .filter((line) => line.length > 0)
              .join(" "),
          },
          outcome: "needs-confirmation",
          detail: `${thread.title}: ${describeChanges(plan.changes)}`,
        };
      }

      await context.applyThreadSettings({ thread, request, plan, applyNow });
      return {
        value: {
          applied: true,
          thread: thread.title,
          changes: plan.changes,
          warnings: plan.warnings,
          // False would mean the change is merely queued against the thread.
          activeNow,
          say: activeNow
            ? `Say briefly what changed on "${thread.title}" and that it is applied.`
            : `Say briefly what changed on "${thread.title}", and that it takes effect when the thread next runs.`,
        },
        outcome: "ok",
        detail: `${thread.title}: ${describeChanges(plan.changes)}${activeNow ? " (applied now)" : ""}`,
      };
    }

    case "interrupt_thread": {
      const target = resolveTarget(context, call.args, "interrupt");
      if (!target.ok) return target.result;
      const thread = target.thread;

      // Interrupting an idle thread is a no-op that still reads as success and
      // leaves the user believing something was stopped.
      if (!thread.isWorking) {
        return {
          value: {
            interrupted: false,
            reason: "nothing-in-flight",
            title: thread.title,
            say: `${thread.title} is not running anything right now, so there is nothing to interrupt.`,
          },
          outcome: "ok",
          detail: `${thread.title} was idle`,
        };
      }

      if ((context.confirmDestructiveActions || !target.confident) && call.args.confirm !== true) {
        return {
          value: {
            interrupted: false,
            confirmationRequired: true,
            willInterrupt: {
              title: thread.title,
              model: thread.model,
              provider: thread.provider,
              waitingOn: thread.waitingOn,
            },
            say: `Tell the user you are about to interrupt "${thread.title}", which is running on ${thread.model}, and that this stops its work in progress. Ask them to confirm. Only call interrupt_thread again — with confirm set to true — after they clearly say yes.`,
          },
          outcome: "needs-confirmation",
          detail: `would interrupt ${thread.title}`,
        };
      }

      await context.interruptThread({
        environmentId: thread.environmentId,
        threadId: thread.threadId,
      });
      return {
        value: { interrupted: true, title: thread.title },
        outcome: "ok",
        detail: `interrupted ${thread.title}`,
      };
    }

    default:
      throw new OrchestratorToolError(`Unknown tool ${call.name}.`);
  }
}
