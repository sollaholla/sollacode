import type {
  ModelSelection,
  ModelAccessPolicy,
  OrchestrationMessage,
  OrchestrationThreadActivity,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderModel,
  ThreadId,
} from "@t3tools/contracts";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";

import { modelAccessPoliciesAllow } from "@t3tools/shared/modelAccessPolicy";
import { antigravityUsageModelFamily } from "@t3tools/shared/model";
import { parseDeepCodeBalance } from "@t3tools/shared/deepcodeUsage";
import { providerDriverHasSollaMcpTools } from "@t3tools/shared/providerDrivers";
import { antigravityUsageWindowsFromAccountUsage } from "../provider/antigravityUsage.ts";
import { isDeepCodeContextOverflow } from "../provider/deepcodeContext.ts";
import { DEEPCODE_PROGRESS_TIMEOUT_MESSAGE } from "../provider/deepcodeProtocol.ts";

import { contextRecoveryReminder } from "../provider/contextRecovery.ts";

export const PROVIDER_HANDOFF_MAX_SERIALIZED_CHARS = 32_000;
export const PROVIDER_HANDOFF_MAX_MESSAGES = 24;
export const PROVIDER_HANDOFF_MAX_MESSAGE_CHARS = 2_000;
export const PROVIDER_HANDOFF_TURN_MAX_SERIALIZED_CHARS = PROVIDER_SEND_TURN_MAX_INPUT_CHARS;

const METADATA_STRING_MAX_CHARS = 256;
const CONTINUITY_STRING_MAX_CHARS = 512;

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface ProviderUsageLimitExhaustion {
  readonly reason: string;
  readonly resetsAt: number | null;
}

export interface ProviderFailoverTarget {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly modelSelection: ModelSelection;
}

export interface ProviderHandoffSummaryInput {
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly from: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
  };
  readonly to: ProviderFailoverTarget;
  readonly exhaustion: ProviderUsageLimitExhaustion;
  readonly generatedAt: string;
  readonly immediateRequirement?: string | null;
  readonly inProgressWork?: string | null;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedMetadata(value: string): string {
  return value.length <= METADATA_STRING_MAX_CHARS
    ? value
    : `${value.slice(0, METADATA_STRING_MAX_CHARS - 1)}…`;
}

function boundedContinuity(value: string): string {
  return value.length <= CONTINUITY_STRING_MAX_CHARS
    ? value
    : `${value.slice(0, CONTINUITY_STRING_MAX_CHARS - 1)}…`;
}

function latestResetAt(records: ReadonlyArray<UnknownRecord | undefined>): number | null {
  let resetAt: number | null = null;
  for (const record of records) {
    const candidate = finiteNumber(record?.resetsAt);
    if (candidate !== undefined && (resetAt === null || candidate > resetAt)) {
      resetAt = candidate;
    }
  }
  return resetAt;
}

function codexSnapshotOf(rateLimits: unknown): UnknownRecord | undefined {
  const envelope = asRecord(rateLimits);
  return asRecord(envelope?.rateLimits) ?? envelope;
}

function detectCodexExhaustion(rateLimits: unknown): ProviderUsageLimitExhaustion | null {
  const snapshot = codexSnapshotOf(rateLimits);
  if (!snapshot) {
    return null;
  }

  const primary = asRecord(snapshot.primary);
  const secondary = asRecord(snapshot.secondary);
  const rateLimitReachedType =
    typeof snapshot.rateLimitReachedType === "string" ? snapshot.rateLimitReachedType : undefined;
  const spendControlReached = snapshot.spendControlReached === true;

  // A window reading 100% is not a refusal. An account with credits — or
  // flexible/extra usage on top of the included quota — keeps serving past
  // the end of its window, and moving that thread to another model would take
  // away usage the user has already paid for. Codex says a limit actually
  // stopped a request with `rateLimitReachedType`, and `spendControlReached`
  // is a real hard stop; those two are the only signals allowed to switch a
  // thread off its chosen model. (Claude is rejection-driven for the same
  // reason — see `detectClaudeExhaustion`.)
  if (rateLimitReachedType === undefined && !spendControlReached) {
    return null;
  }

  return {
    reason: boundedMetadata(
      rateLimitReachedType ??
        (spendControlReached ? "spend_control_reached" : "rate_limit_window_exhausted"),
    ),
    resetsAt: latestResetAt([primary, secondary]),
  };
}

function detectClaudeExhaustion(rateLimits: unknown): ProviderUsageLimitExhaustion | null {
  const envelope = asRecord(rateLimits);
  const info = asRecord(envelope?.rate_limit_info);
  if (info?.status !== "rejected") {
    return null;
  }

  return {
    reason: boundedMetadata(
      typeof info.rateLimitType === "string"
        ? `rate_limit_rejected:${info.rateLimitType}`
        : "rate_limit_rejected",
    ),
    resetsAt: finiteNumber(info.resetsAt) ?? finiteNumber(info.overageResetsAt) ?? null,
  };
}

function detectGrokExhaustion(rateLimits: unknown): ProviderUsageLimitExhaustion | null {
  const envelope = asRecord(rateLimits);
  const config = asRecord(envelope?.config) ?? envelope;
  const usedPercent = finiteNumber(config?.creditUsagePercent);
  if (usedPercent === undefined || usedPercent < 100) {
    return null;
  }
  const period = asRecord(config?.currentPeriod);
  return {
    reason: "weekly_usage_pool_exhausted",
    resetsAt: epochMilliseconds(period?.end) ?? epochMilliseconds(config?.billingPeriodEnd) ?? null,
  };
}

/**
 * Whether Codex reports fallback credit that keeps serving past the end of
 * the included-quota window. Unknown means yes: an absent or unparseable
 * credit reading must not move a thread off the model the user chose.
 */
function codexHasFallbackCredit(snapshot: UnknownRecord): boolean {
  const credits = asRecord(snapshot.credits);
  if (!credits) return true;
  if (credits.unlimited === true) return true;
  if (credits.hasCredits === true) return true;
  const balance = credits.balance;
  if (typeof balance === "number") return balance > 0;
  if (typeof balance === "string") {
    const stripped = balance.replace(/[^0-9.-]/g, "");
    // An unparseable balance says nothing; assume fallback remains.
    if (stripped.length === 0) return true;
    const numeric = Number(stripped);
    if (!Number.isFinite(numeric)) return true;
    return numeric > 0;
  }
  return false;
}

function codexWindowSpent(window: UnknownRecord | undefined, nowEpochMs: number | null): boolean {
  if (!window) return false;
  const usedPercent = finiteNumber(window.usedPercent);
  if (usedPercent === undefined || usedPercent < QUOTA_EXHAUSTED_PERCENT) return false;
  const resetAt = epochMilliseconds(window.resetsAt);
  // A window that already rolled over is stale rather than spent.
  if (resetAt !== null && nowEpochMs !== null && resetAt <= nowEpochMs) return false;
  return true;
}

/**
 * Whether a Codex quota snapshot shows a spent window with no fallback credit
 * behind it. This never triggers a failover on its own — a bare 100% reading
 * must not take a thread off its chosen model — but it corroborates a refusal
 * (see `detectProviderUsageLimitRefusal`) and screens spent Codex instances
 * out of failover targets.
 */
export function isCodexQuotaWindowExhausted(
  rateLimits: unknown,
  nowEpochMs?: number | null,
): boolean {
  const snapshot = codexSnapshotOf(rateLimits);
  if (!snapshot) return false;
  if (codexHasFallbackCredit(snapshot)) return false;
  const now = nowEpochMs ?? null;
  return (
    codexWindowSpent(asRecord(snapshot.primary), now) ||
    codexWindowSpent(asRecord(snapshot.secondary), now)
  );
}

/**
 * Codex's canonical usage-limit refusal. Observed 2026-09-14: "You've hit
 * your usage limit. Visit https://chatgpt.com/codex/settings/usage to
 * purchase more credits or try again at Sep 19th, 2026 6:19 PM." — while the
 * typed snapshot still read `rateLimitReachedType: null`.
 */
function isCodexUsageLimitRefusal(message: string): boolean {
  return (
    /you(?:'|\u2019)?ve hit your usage limit/i.test(message) ||
    (/usage limit/i.test(message) && /purchase more credits/i.test(message))
  );
}

/**
 * Google's canonical quota rejection, matched by the Antigravity adapter from
 * the CLI's own `Run: attempt N failed (RESOURCE_EXHAUSTED (code 429) …)`
 * line and re-emitted verbatim. The text never names which family pool died,
 * so the stored windows decide that below.
 */
function isAntigravityQuotaRejection(message: string): boolean {
  return (
    /rejected by Google with RESOURCE_EXHAUSTED \(429\)/i.test(message) ||
    (/RESOURCE_EXHAUSTED/i.test(message) && /429/.test(message))
  );
}

function isClaudeUsageLimitRefusal(message: string): boolean {
  return (
    (/you(?:'|\u2019)?ve hit your/i.test(message) && /limit|quota|\bcap\b/i.test(message)) ||
    /session limit/i.test(message)
  );
}

/** Mirror of the per-model screen in `failoverModel`: spent and unexpired. */
function isAntigravityWindowExhausted(
  window: { readonly usedPercent: number; readonly resetsAt: string | null },
  nowEpochMs: number | null,
): boolean {
  return (
    window.usedPercent >= QUOTA_EXHAUSTED_PERCENT &&
    (window.resetsAt === null || nowEpochMs === null || Date.parse(window.resetsAt) > nowEpochMs)
  );
}

/**
 * Whether an Antigravity quota rejection spends the whole instance. One dead
 * family pool must not exile the others: when any known window still has
 * quota, the same instance stays eligible and `failoverModel` walks to the
 * surviving family. Unknown windows (no probe yet) also stay eligible; a
 * rejection the windows cannot explain still moves the thread, and the
 * per-model exclusions converge if the next pool rejects too.
 */
export function isAntigravityExhaustionAccountWide(
  accountUsage: unknown,
  nowEpochMs?: number | null,
): boolean {
  const now = nowEpochMs ?? null;
  const windows = antigravityUsageWindowsFromAccountUsage(accountUsage);
  if (windows.length === 0) return false;
  return !windows.some((window) => !isAntigravityWindowExhausted(window, now));
}

/** Latest unexpired family reset, for restore-on-reset. Null when unknown. */
function antigravityUnexpiredResetMax(
  accountUsage: unknown,
  nowEpochMs?: number | null,
): number | null {
  const now = nowEpochMs ?? null;
  let latest: number | null = null;
  for (const window of antigravityUsageWindowsFromAccountUsage(accountUsage)) {
    if (window.resetsAt === null) continue;
    const resetAtMs = Date.parse(window.resetsAt);
    if (!Number.isFinite(resetAtMs)) continue;
    if (now !== null && resetAtMs <= now) continue;
    if (latest === null || resetAtMs > latest) latest = resetAtMs;
  }
  return latest;
}

/**
 * A spent Claude window corroborating a rejection that arrived as text. Uses
 * the same window predicate as the typed path, so text only ever confirms
 * what the snapshot already proves. The reason names the first spent window
 * found; any of them justifies leaving.
 */
function detectClaudeSpentWindowExhaustion(
  accountUsage: unknown,
  nowEpochMs: number | null,
): ProviderUsageLimitExhaustion | null {
  const envelope = asRecord(accountUsage);
  const rateLimits = asRecord(envelope?.rate_limits);
  if (!rateLimits) return null;
  const candidates: Array<{ readonly key: string; readonly window: UnknownRecord }> = [];
  for (const [key, value] of Object.entries(rateLimits)) {
    const window = asRecord(value);
    if (window) candidates.push({ key, window });
  }
  for (const key of ["model_scoped", "limits"] as const) {
    const entries = rateLimits[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const window = asRecord(entry);
      if (window) candidates.push({ key, window });
    }
  }
  for (const { key, window } of candidates) {
    if (!isWindowExhausted(window, nowEpochMs)) continue;
    return {
      reason: boundedMetadata(`rate_limit_window_exhausted:${key}`),
      resetsAt:
        epochMilliseconds(window.resets_at ?? window.resetsAt) ??
        epochMilliseconds(window.overageResetsAt),
    };
  }
  return null;
}

/**
 * A usage-limit refusal carried as provider error text, corroborated by the
 * provider's latest quota snapshot. Text alone never switches providers (an
 * unrelated failure or a translated message must not move a thread), and a
 * bare 100% window alone never does either (fallback credit keeps serving
 * past it) — but a refusal naming a spent window with no fallback credit is
 * the provider saying it stopped, exactly like a typed rejection.
 *
 * Antigravity is the exception to corroboration: it has no live quota stream,
 * only lagging `agy /usage` probes, while its 429 text is already a positive
 * rejection the adapter matched from the CLI's own retry-exhaustion line. The
 * windows still decide the scope (one dead pool keeps the instance eligible)
 * and the restore time, but a rejection never waits on them.
 *
 * The Deep Code stall marker is the other exception: the adapter measured five
 * silent minutes itself and killed the wedged request, so the exact marker is
 * already the positive signal and no quota snapshot confirms it.
 */
/**
 * The provider refused the shape of the request, not the work in it. Another
 * provider speaks a different protocol and may well accept the same turn, and
 * no amount of retrying changes what we send.
 */
const PROTOCOL_REJECTION_SIGNATURES: ReadonlyArray<RegExp> = [
  /\binvalid params\b/iu,
  /\binvalid request\b/iu,
  /\bmethod not found\b/iu,
];

/**
 * Provider-side failures that a DIFFERENT provider can serve right now.
 *
 * Quota exhaustion already moves a thread instead of parking it; everything
 * else fell through to the generic retry budget and left the thread stopped
 * behind a banner, which is the same outcome the failover exists to avoid
 * (2026-09-18: a DeepCode thread paused on "model stream idle timeout after
 * 180000ms", an OpenCode thread on a model its gateway had dropped, and a
 * Grok thread on an exhausted balance — three usable providers sat idle in
 * every case).
 *
 * Deliberately narrow. Each entry is a failure the SAME provider will keep
 * producing and a human cannot clear mid-turn, so retrying it is waste and
 * moving is strictly better. Authentication is excluded on purpose: it has
 * its own blocked state and the user must act on that provider, not be
 * quietly moved off it. Context overflow, transient upstream 5xx and
 * user-initiated stops are excluded because they each own a better recovery.
 */
const PROVIDER_UNUSABLE_SIGNATURES: ReadonlyArray<RegExp> = [
  /\busage balance exhausted\b/iu,
  /\bno credit left\b/iu,
  /\bHTTP 402\b/iu,
  /\bpayment required\b/iu,
  /\bstream idle timeout after \d+\s*ms\b/iu,
  /\bmodel not found\b/iu,
  /\bmodel is (?:no longer |not )available\b/iu,
  // JSON-RPC rejections of the request ITSELF. The identical request fails
  // identically every time, so the retry budget is pure waste: a Grok thread
  // burned eight attempts on a bare "Invalid params" over two minutes and
  // then parked, while Muse sat at 9% used (2026-09-19).
  ...PROTOCOL_REJECTION_SIGNATURES,
];

/** Cap for the same reason as the other classifiers: prose is not a status. */
const PROVIDER_UNUSABLE_MAX_CHARS = 600;

/**
 * The subset whose cause is the ACCOUNT, not the model: no balance, no
 * credit, payment required. Another model on the same provider bills the same
 * empty account, so the whole instance has to come out of the running — the
 * first cut of this moved an exhausted Grok thread from grok-4.6 to grok-4.5
 * and failed again half a second later (2026-09-18).
 */
const ACCOUNT_WIDE_UNUSABLE_SIGNATURES: ReadonlyArray<RegExp> = [
  /\busage balance exhausted\b/iu,
  /\bno credit left\b/iu,
  /\bHTTP 402\b/iu,
  /\bpayment required\b/iu,
  // A protocol rejection is the provider's, not the model's: every model
  // behind it speaks the same protocol and rejects the same request.
  ...PROTOCOL_REJECTION_SIGNATURES,
];

export function isAccountWideUnusableRefusal(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length === 0 || trimmed.length > PROVIDER_UNUSABLE_MAX_CHARS) return false;
  return ACCOUNT_WIDE_UNUSABLE_SIGNATURES.some((pattern) => pattern.test(trimmed));
}

export function detectProviderUnusableRefusal(
  message: string,
): ProviderUsageLimitExhaustion | null {
  const trimmed = message.trim();
  if (trimmed.length === 0 || trimmed.length > PROVIDER_UNUSABLE_MAX_CHARS) return null;
  return PROVIDER_UNUSABLE_SIGNATURES.some((pattern) => pattern.test(trimmed))
    ? { reason: "provider_unusable", resetsAt: null }
    : null;
}

export function detectProviderUsageLimitRefusal(
  driver: ProviderDriverKind,
  message: string,
  accountUsage: unknown,
  nowEpochMs?: number | null,
): ProviderUsageLimitExhaustion | null {
  const driverName = String(driver);
  if (driverName === "codex") {
    if (!isCodexUsageLimitRefusal(message)) return null;
    const typed = detectCodexExhaustion(accountUsage);
    if (typed) return typed;
    if (!isCodexQuotaWindowExhausted(accountUsage, nowEpochMs ?? null)) return null;
    const snapshot = codexSnapshotOf(accountUsage);
    return {
      reason: "usage_limit_refused",
      resetsAt: latestResetAt([asRecord(snapshot?.primary), asRecord(snapshot?.secondary)]),
    };
  }
  if (driverName === "antigravity") {
    if (!isAntigravityQuotaRejection(message)) return null;
    return {
      reason: "resource_exhausted",
      resetsAt: antigravityUnexpiredResetMax(accountUsage, nowEpochMs ?? null),
    };
  }
  if (driverName === CLAUDE_DRIVER) {
    if (!isClaudeUsageLimitRefusal(message)) return null;
    return (
      detectClaudeExhaustion(accountUsage) ??
      detectClaudeSpentWindowExhaustion(accountUsage, nowEpochMs ?? null)
    );
  }
  if (driverName === "deepcode") {
    if (message !== DEEPCODE_PROGRESS_TIMEOUT_MESSAGE) return null;
    const now = nowEpochMs ?? null;
    return {
      reason: "upstream_stalled",
      resetsAt: now === null ? null : now + DEEPCODE_STALL_RESTORE_DELAY_MS,
    };
  }
  return null;
}

export type DeferredRecoveryKind =
  | "usage-exhaustion"
  | "context-overflow-retry"
  | "progress-timeout-retry";

export type DeferredRecoveryAction =
  | { readonly kind: "exhaustion"; readonly target: ProviderFailoverTarget | null }
  | { readonly kind: "silent-retry" }
  | null;

/**
 * What a deferred failure wants from its obligation: retry quietly while
 * recovery is live, record exactly once when it gives up, or fall through to
 * the generic record-and-recover path when no recovery applies.
 *
 * Exhaustion retries until the generic cap because each round trip may land
 * on a new provider; silent retries get a tight budget because a second
 * identical stall is deterministic, not a wobble.
 */
export function decideDeferredRecoveryOutcome(
  action: DeferredRecoveryAction,
  attempt: number,
  caps: { readonly maxAttempts: number; readonly silentRetryMaxAttempts: number },
): "retry" | "record-and-cancel" | "fall-through" {
  if (action?.kind === "exhaustion" && action.target !== null) {
    return attempt >= caps.maxAttempts ? "record-and-cancel" : "retry";
  }
  if (action?.kind === "silent-retry" && attempt < caps.silentRetryMaxAttempts) {
    return "retry";
  }
  if (action !== null) return "record-and-cancel";
  return "fall-through";
}

/**
 * Failures whose recovery owns the outcome, so surfacing them would only
 * flash an error the system immediately contradicts:
 *
 * - usage-exhaustion: failover moves the thread while quota remains
 *   elsewhere;
 * - context-overflow-retry: DeepCode retries the same turn with a smaller
 *   working context;
 * - progress-timeout-retry: a stalled Muse turn restarts on a fresh host,
 *   and a finished-but-unverified delivery resumes to recover its saved
 *   response instead of redoing work.
 *
 * Every kind records exactly once if recovery gives up; until then, callers
 * stay silent.
 */
export function classifyDeferredRecoveryFailure(input: {
  readonly driver: ProviderDriverKind;
  readonly message: string;
  readonly accountUsage?: unknown;
  readonly nowEpochMs?: number | null;
}): DeferredRecoveryKind | null {
  const driverName = String(input.driver);
  if (
    detectProviderUsageLimitRefusal(
      input.driver,
      input.message,
      input.accountUsage,
      input.nowEpochMs ?? null,
    ) !== null
  ) {
    return "usage-exhaustion";
  }
  if (driverName === "deepcode" && isDeepCodeContextOverflow(input.message)) {
    return "context-overflow-retry";
  }
  if (driverName === "muse" && /\[muse-progress-timeout\]/i.test(input.message)) {
    return "progress-timeout-retry";
  }
  return null;
}

/**
 * Returns an exhaustion signal only for provider adapters that expose a typed,
 * canonical account rate-limit event. Text matching provider errors is
 * intentionally avoided because it would switch providers on unrelated
 * failures and translated CLI output; the one exception is a refusal text
 * corroborated by a spent quota snapshot (see
 * `detectProviderUsageLimitRefusal`).
 */
export function detectProviderUsageLimitExhaustion(
  driver: ProviderDriverKind,
  rateLimits: unknown,
): ProviderUsageLimitExhaustion | null {
  switch (String(driver)) {
    case "codex":
      return detectCodexExhaustion(rateLimits);
    case "claudeAgent":
      return detectClaudeExhaustion(rateLimits);
    case "grok":
      return detectGrokExhaustion(rateLimits);
    case "deepcode":
      return parseDeepCodeBalance(rateLimits)?.is_available === false
        ? { reason: "insufficient_account_credit", resetsAt: null }
        : null;
    default:
      return null;
  }
}

const CLAUDE_DRIVER = "claudeAgent";
const QUOTA_EXHAUSTED_PERCENT = 100;
/** How long a stalled Deep Code account rests before the thread may return. */
const DEEPCODE_STALL_RESTORE_DELAY_MS = 30 * 60 * 1000;

/**
 * Claude meters these model families against their own quota window, so one
 * family can be rejected while the rest of the account still has headroom.
 * Ordered longest-first so `claude-opus-4-5` cannot match a shorter family.
 */
const CLAUDE_MODEL_FAMILIES = ["sonnet", "haiku", "fable", "opus"] as const;
type ClaudeModelFamily = (typeof CLAUDE_MODEL_FAMILIES)[number];

const CLAUDE_ACCOUNT_WIDE_LIMIT_KEYS = new Set([
  "five_hour",
  "current_session",
  "seven_day",
  "one_day",
  "daily",
  "weekly",
  "seven_day_oauth_apps",
]);

export function providerFailoverModelKey(
  instanceId: ProviderInstanceId | string,
  model: string,
): string {
  return `${String(instanceId)}\0${model}`;
}

function claudeModelFamily(slug: string): ClaudeModelFamily | null {
  const normalized = slug.toLowerCase();
  return CLAUDE_MODEL_FAMILIES.find((family) => normalized.includes(family)) ?? null;
}

function normalizeClaudeLimitKey(value: string): string {
  return value
    .trim()
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replaceAll(/[\s-]+/g, "_")
    .toLowerCase();
}

function claudeFamilyFromLimitKey(key: string): ClaudeModelFamily | null {
  return claudeModelFamily(normalizeClaudeLimitKey(key));
}

function isClaudeExtraUsageLimitKey(key: string): boolean {
  const normalized = normalizeClaudeLimitKey(key);
  return (
    normalized.includes("extra") || normalized.includes("overage") || normalized.includes("credit")
  );
}

function isClaudeAccountWideLimitKey(key: string): boolean {
  const normalized = normalizeClaudeLimitKey(key);
  if (claudeFamilyFromLimitKey(normalized) !== null) return false;
  if (isClaudeExtraUsageLimitKey(normalized)) return false;
  return CLAUDE_ACCOUNT_WIDE_LIMIT_KEYS.has(normalized);
}

/**
 * Codex and Grok meter the whole account. Claude only does so for shared
 * windows such as the five-hour session or weekly cap; a Fable-only rejection
 * must not disqualify Opus 5 on the same instance. Antigravity reads its
 * family windows: one dead pool keeps the instance eligible so the fallback
 * walks to the surviving family.
 */
export function isAccountWideProviderExhaustion(
  driver: ProviderDriverKind,
  exhaustion: ProviderUsageLimitExhaustion,
  accountUsage?: unknown,
  nowEpochMs?: number | null,
): boolean {
  if (String(driver) === "antigravity") {
    return isAntigravityExhaustionAccountWide(accountUsage, nowEpochMs ?? null);
  }
  if (String(driver) !== CLAUDE_DRIVER) {
    return true;
  }
  const reason = exhaustion.reason.trim();
  const separator = reason.lastIndexOf(":");
  const limitType = separator >= 0 ? reason.slice(separator + 1) : reason;
  return isClaudeAccountWideLimitKey(limitType);
}

function epochMilliseconds(value: unknown): number | null {
  const numeric = finiteNumber(value);
  if (numeric !== undefined) {
    // The usage endpoint reports seconds; typed rate-limit events report ms.
    return numeric > 1e11 ? numeric : numeric * 1_000;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * A window that already reset is stale rather than exhausted. Provider
 * snapshots are refreshed by health probes, so a cached 100% reading must not
 * permanently exclude a model whose quota has since rolled over.
 */
function isWindowExhausted(window: UnknownRecord, nowEpochMs: number | null): boolean {
  const usedPercent = finiteNumber(window.utilization) ?? finiteNumber(window.percent);
  if (usedPercent === undefined || usedPercent < QUOTA_EXHAUSTED_PERCENT) {
    return false;
  }
  const resetAt = epochMilliseconds(window.resets_at ?? window.resetsAt);
  return !(resetAt !== null && nowEpochMs !== null && resetAt <= nowEpochMs);
}

function displayNameOf(record: UnknownRecord | undefined): string {
  const scopedModel = asRecord(asRecord(record?.scope)?.model);
  const value = scopedModel?.display_name ?? record?.display_name;
  return typeof value === "string" ? value.toLowerCase() : "";
}

/**
 * Reads the model-scoped quota for one family out of the raw Claude usage
 * snapshot. Claude Code has exposed these limits under several shapes across
 * versions (named `rate_limits` keys, a `model_scoped` array, and a generic
 * `limits` array), so every known representation is consulted.
 */
function isClaudeModelFamilyExhausted(input: {
  readonly accountUsage: unknown;
  readonly family: ClaudeModelFamily;
  readonly nowEpochMs: number | null;
}): boolean {
  const rateLimits = asRecord(asRecord(input.accountUsage)?.rate_limits);
  if (!rateLimits) {
    return false;
  }

  for (const [key, value] of Object.entries(rateLimits)) {
    const window = asRecord(value);
    if (!window || !key.toLowerCase().includes(input.family)) continue;
    if (isWindowExhausted(window, input.nowEpochMs)) return true;
  }

  for (const key of ["model_scoped", "limits"] as const) {
    const entries = rateLimits[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const window = asRecord(entry);
      if (!window || !displayNameOf(window).includes(input.family)) continue;
      if (isWindowExhausted(window, input.nowEpochMs)) return true;
    }
  }

  return false;
}

function isRejectedWindowStillOpen(record: UnknownRecord, nowEpochMs: number | null): boolean {
  const resetAt = epochMilliseconds(record.resetsAt ?? record.overageResetsAt ?? record.resets_at);
  return !(resetAt !== null && nowEpochMs !== null && resetAt <= nowEpochMs);
}

/**
 * Live `rate_limit_event` snapshots overwrite the usage probe. A Fable
 * rejection stored this way must still skip Fable without treating every
 * other Claude family as spent.
 */
function isClaudeRateLimitInfoRejectedForFamily(input: {
  readonly accountUsage: unknown;
  readonly family: ClaudeModelFamily;
  readonly nowEpochMs: number | null;
}): boolean {
  const info = asRecord(asRecord(input.accountUsage)?.rate_limit_info);
  if (info?.status !== "rejected") {
    return false;
  }
  const limitType = typeof info.rateLimitType === "string" ? info.rateLimitType : "";
  const family = claudeFamilyFromLimitKey(limitType);
  if (
    family !== input.family &&
    !(input.family === "fable" && isClaudeExtraUsageLimitKey(limitType))
  ) {
    return false;
  }
  return isRejectedWindowStillOpen(info, input.nowEpochMs);
}

/**
 * Fable is metered against the plan's extra-usage credit pool, so a depleted
 * pool rejects the turn ("out of usage credits") even when no Fable-scoped
 * window reports 100%. Only the positive signal is used: an absent or disabled
 * pool says nothing about the model's availability.
 */
function isClaudeExtraUsageDepleted(accountUsage: unknown, nowEpochMs: number | null): boolean {
  const extraUsage = asRecord(asRecord(asRecord(accountUsage)?.rate_limits)?.extra_usage);
  if (!extraUsage || extraUsage.is_enabled !== true) {
    return false;
  }
  if (isWindowExhausted(extraUsage, nowEpochMs)) {
    return true;
  }
  const monthlyLimit = finiteNumber(extraUsage.monthly_limit);
  const usedCredits = finiteNumber(extraUsage.used_credits);
  return (
    monthlyLimit !== undefined &&
    monthlyLimit > 0 &&
    usedCredits !== undefined &&
    usedCredits >= monthlyLimit
  );
}

/**
 * Failing over to Claude's first-listed model is wrong when that specific
 * model's quota is already spent: the replacement turn is rejected on arrival
 * and the thread stalls with no provider left to try. Screening the account
 * usage snapshot lets selection skip to the next-highest usable Claude model.
 */
export function isClaudeModelExhausted(input: {
  readonly accountUsage: unknown;
  readonly modelSlug: string;
  readonly nowEpochMs?: number | null;
}): boolean {
  const nowEpochMs = input.nowEpochMs ?? null;
  const family = claudeModelFamily(input.modelSlug);
  if (family === null) {
    return false;
  }
  if (isClaudeModelFamilyExhausted({ accountUsage: input.accountUsage, family, nowEpochMs })) {
    return true;
  }
  if (
    isClaudeRateLimitInfoRejectedForFamily({ accountUsage: input.accountUsage, family, nowEpochMs })
  ) {
    return true;
  }
  return family === "fable" && isClaudeExtraUsageDepleted(input.accountUsage, nowEpochMs);
}

function isEligibleTarget(provider: ServerProvider): boolean {
  return (
    provider.availability !== "unavailable" &&
    provider.enabled &&
    provider.installed &&
    provider.status !== "disabled" &&
    provider.status !== "error" &&
    provider.auth.status !== "unauthenticated" &&
    provider.models.length > 0
  );
}

/** Highest Claude tier first, then newest version, independent of CLI menu order. */
function compareClaudeModels(a: ServerProviderModel, b: ServerProviderModel): number {
  const tiers = ["fable", "opus", "sonnet", "haiku"];
  const tier = (slug: string) => {
    const index = tiers.findIndex((family) => slug.toLowerCase().includes(family));
    return index < 0 ? tiers.length : index;
  };
  const tierDifference = tier(a.slug) - tier(b.slug);
  if (tierDifference !== 0) return tierDifference;
  return b.slug.localeCompare(a.slug, "en", { numeric: true });
}

/** Select the highest usable Claude model before other provider defaults. */
function failoverModel(
  provider: ServerProvider,
  nowEpochMs: number | null,
  skipSlugs?: ReadonlySet<string>,
): ServerProviderModel | null {
  const antigravityWindows =
    provider.driver === "antigravity"
      ? antigravityUsageWindowsFromAccountUsage(provider.accountUsage)
      : [];
  const usable = provider.models.filter((entry) => {
    if (skipSlugs?.has(entry.slug)) return false;
    if (
      antigravityWindows.some(
        (window) =>
          window.family === antigravityUsageModelFamily(entry.slug) &&
          isAntigravityWindowExhausted(window, nowEpochMs),
      )
    )
      return false;
    if (String(provider.driver) !== CLAUDE_DRIVER) return true;
    return !isClaudeModelExhausted({
      accountUsage: provider.accountUsage,
      modelSlug: entry.slug,
      nowEpochMs,
    });
  });
  // Antigravity exhausts its Gemini pool before touching Claude or GPT: the
  // Gemini quota is separate, and burning Claude first wastes the pool with
  // the tighter limit. Claude tiers still order strongest-first once no
  // usable Gemini model remains.
  if (provider.driver === "antigravity") {
    const gemini = usable.filter((entry) => antigravityUsageModelFamily(entry.slug) === "gemini");
    const preferredGemini = gemini.find((entry) => entry.isDefault === true) ?? gemini[0] ?? null;
    if (preferredGemini) return preferredGemini;
    const claude = usable
      .filter((entry) => claudeModelFamily(entry.slug) !== null)
      .sort(compareClaudeModels);
    if (claude[0]) return claude[0];
  }
  // Secondary models follow the same policy as Fable -> Opus: choose the
  // strongest remaining Claude tier rather than a menu default.
  if (String(provider.driver) === CLAUDE_DRIVER) {
    const claude = usable
      .filter((entry) => claudeModelFamily(entry.slug) !== null)
      .sort(compareClaudeModels);
    if (claude[0]) return claude[0];
  }
  return usable.find((entry) => entry.isDefault === true) ?? usable[0] ?? null;
}

/**
 * Whether this provider's *account* is out of quota, as opposed to one of its
 * models. Claude meters per model family and is screened in `failoverModel`;
 * only shared Claude windows (five-hour session, weekly cap) disqualify the
 * whole instance. Codex meters the whole account, so a per-model screen can
 * never see it.
 *
 * Without this, failover happily hands the turn to a provider whose own health
 * probe already said it was spent, and the replacement turn is rejected on
 * arrival. Observed 2026-08-06: Claude hit its five-hour window, failover chose
 * Codex, and Codex answered "You've hit your usage limit … try again at Aug
 * 8th" — a two-day reset — within seven seconds, leaving the thread with no
 * provider and no way to say so.
 *
 * Only a positive, unexpired signal disqualifies a candidate. A missing or
 * stale snapshot says nothing, and must not exclude an otherwise usable
 * provider.
 */
function isClaudeAccountExhausted(accountUsage: unknown, nowEpochMs: number | null): boolean {
  const envelope = asRecord(accountUsage);
  const info = asRecord(envelope?.rate_limit_info);
  if (info?.status === "rejected") {
    const limitType = typeof info.rateLimitType === "string" ? info.rateLimitType : "";
    if (!isClaudeAccountWideLimitKey(limitType)) {
      return false;
    }
    return isRejectedWindowStillOpen(info, nowEpochMs);
  }

  const rateLimits = asRecord(envelope?.rate_limits);
  if (!rateLimits) {
    return false;
  }
  for (const [key, value] of Object.entries(rateLimits)) {
    if (!isClaudeAccountWideLimitKey(key)) continue;
    const window = asRecord(value);
    if (window && isWindowExhausted(window, nowEpochMs)) return true;
  }
  return false;
}

/**
 * Is this provider's binding usage window already full?
 *
 * Failover used to consult only the outgoing provider's rate-limit signal, so
 * it would happily hand a thread to an instance the usage guard already reads
 * at 100% -- the handoff ran, the first turn hit the same wall, and the thread
 * bounced again. Checking the reading before choosing skips those.
 *
 * Only a definite full reading disqualifies a candidate. A provider that
 * reports nothing, has the guard switched off, or whose window has already
 * rolled over stays selectable: an absent reading is not evidence of
 * exhaustion, and failing closed here would leave failover with no target at
 * all. This filters *targets*; it never forces a switch off the provider the
 * person chose, which a bare 100% reading must not do.
 */
export function isProviderUsageWindowFull(
  provider: ServerProvider,
  nowEpochMs: number | null,
): boolean {
  const usageGuard = provider.usageGuard;
  if (!usageGuard) return false;
  // Only an account-wide window speaks for the whole instance. A model-family
  // window at 100% leaves the other families usable, and `failoverModel`
  // already skips the exhausted ones per model.
  if (usageGuard.windowScope !== "account") return false;
  const resetsAt = usageGuard.resetsAt;
  if (resetsAt !== null && nowEpochMs !== null && resetsAt <= nowEpochMs) return false;
  const percent = usageGuard.reportedPercent ?? usageGuard.estimatedPercent;
  return percent !== null && percent !== undefined && percent >= 100;
}

function isProviderAccountExhausted(provider: ServerProvider, nowEpochMs: number | null): boolean {
  if (
    provider.driver === "deepcode" &&
    (provider.accountUsageStatus?.state === "error" ||
      (nowEpochMs !== null &&
        (!provider.accountUsageReportedAt ||
          nowEpochMs - Date.parse(provider.accountUsageReportedAt) > 20 * 60_000)))
  )
    return false;
  if (String(provider.driver) === CLAUDE_DRIVER) {
    return isClaudeAccountExhausted(provider.accountUsage, nowEpochMs);
  }
  // Codex can refuse turns ("You've hit your usage limit …") while its typed
  // snapshot still reads `rateLimitReachedType: null`, so the typed signal
  // alone would hand threads to an already-spent Codex. Observed 2026-09-14.
  if (
    String(provider.driver) === "codex" &&
    isCodexQuotaWindowExhausted(provider.accountUsage, nowEpochMs)
  ) {
    return true;
  }
  const exhaustion = detectProviderUsageLimitExhaustion(provider.driver, provider.accountUsage);
  if (exhaustion === null || exhaustion.resetsAt === null) {
    return exhaustion !== null;
  }
  const resetAtMs = epochMilliseconds(exhaustion.resetsAt);
  // A window that has already rolled over is stale, not exhausted.
  return !(resetAtMs !== null && nowEpochMs !== null && resetAtMs <= nowEpochMs);
}

function targetFromProvider(
  provider: ServerProvider,
  nowEpochMs: number | null,
  skipSlugs?: ReadonlySet<string>,
): ProviderFailoverTarget | null {
  if (isProviderAccountExhausted(provider, nowEpochMs)) {
    return null;
  }
  if (isProviderUsageWindowFull(provider, nowEpochMs)) {
    return null;
  }
  const model = failoverModel(provider, nowEpochMs, skipSlugs);
  if (!model) {
    return null;
  }
  const options: Array<{ readonly id: string; readonly value: string | boolean }> = [];
  for (const descriptor of model.capabilities?.optionDescriptors ?? []) {
    if (descriptor.type === "select") {
      const value =
        descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
      if (value !== undefined) {
        options.push({ id: descriptor.id, value });
      }
      continue;
    }
    if (descriptor.currentValue !== undefined) {
      options.push({ id: descriptor.id, value: descriptor.currentValue });
    }
  }
  return {
    instanceId: provider.instanceId,
    driver: provider.driver,
    modelSelection: {
      instanceId: provider.instanceId,
      model: model.slug,
      ...(options.length > 0 ? { options } : {}),
    },
  };
}

function skippedSlugsForProvider(input: {
  readonly provider: ServerProvider;
  readonly currentInstanceId: ProviderInstanceId;
  readonly currentModel?: string | null;
  readonly excludedModels?: ReadonlySet<string>;
}): Set<string> {
  const skipped = new Set<string>();
  if (
    input.provider.instanceId === input.currentInstanceId &&
    typeof input.currentModel === "string" &&
    input.currentModel.length > 0
  ) {
    skipped.add(input.currentModel);
  }
  if (input.excludedModels) {
    const prefix = `${String(input.provider.instanceId)}\0`;
    for (const key of input.excludedModels) {
      if (key.startsWith(prefix)) {
        skipped.add(key.slice(prefix.length));
      }
    }
  }
  return skipped;
}

/**
 * Remaining models on the exhausted instance are tried first so Claude Fable 5
 * lands on Claude Opus 5 instead of jumping to Codex. Registry order is the
 * stable tie-breaker after that. A different driver is preferred so a second
 * instance backed by the same exhausted subscription does not preempt an
 * independently billed provider. A candidate whose every model is out of quota
 * is passed over rather than ending the search.
 */
export function selectProviderFailoverTarget(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly modelPolicies?: ReadonlyArray<ModelAccessPolicy>;
  readonly currentInstanceId: ProviderInstanceId;
  readonly currentDriver: ProviderDriverKind;
  readonly currentModel?: string | null;
  readonly excludedInstanceIds?: ReadonlySet<string>;
  readonly excludedModels?: ReadonlySet<string>;
  readonly nowEpochMs?: number | null;
}): ProviderFailoverTarget | null {
  const providers = input.providers.map((provider) => ({
    ...provider,
    models: provider.models.filter((model) =>
      modelAccessPoliciesAllow(input.modelPolicies ?? [], {
        instanceId: provider.instanceId,
        model: model.slug,
      }),
    ),
  }));
  const nowEpochMs = input.nowEpochMs ?? null;
  const currentModel =
    typeof input.currentModel === "string" && input.currentModel.length > 0
      ? input.currentModel
      : null;

  const currentProvider = providers.find(
    (provider) => provider.instanceId === input.currentInstanceId,
  );
  if (currentProvider && currentModel && isEligibleTarget(currentProvider)) {
    const currentTarget = targetFromProvider(
      currentProvider,
      nowEpochMs,
      skippedSlugsForProvider({
        provider: currentProvider,
        currentInstanceId: input.currentInstanceId,
        currentModel,
        ...(input.excludedModels ? { excludedModels: input.excludedModels } : {}),
      }),
    );
    if (currentTarget && currentTarget.modelSelection.model !== currentModel) {
      return currentTarget;
    }
  }

  const candidates = providers.filter(
    (provider) =>
      provider.instanceId !== input.currentInstanceId &&
      !input.excludedInstanceIds?.has(String(provider.instanceId)) &&
      isEligibleTarget(provider),
  );
  const ordered = [
    ...candidates.filter((candidate) => candidate.driver !== input.currentDriver),
    ...candidates.filter((candidate) => candidate.driver === input.currentDriver),
  ];
  for (const provider of ordered) {
    const target = targetFromProvider(
      provider,
      nowEpochMs,
      skippedSlugsForProvider({
        provider,
        currentInstanceId: input.currentInstanceId,
        currentModel,
        ...(input.excludedModels ? { excludedModels: input.excludedModels } : {}),
      }),
    );
    if (target) {
      return target;
    }
  }
  return null;
}

function boundedMessageText(text: string): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= PROVIDER_HANDOFF_MAX_MESSAGE_CHARS) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, PROVIDER_HANDOFF_MAX_MESSAGE_CHARS - 1)}…`,
    truncated: true,
  };
}

function latestMessageText(
  messages: ReadonlyArray<OrchestrationMessage>,
  role: OrchestrationMessage["role"],
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== role) continue;
    const text = message.text.trim();
    if (text.length > 0) return boundedMessageText(text).text;
  }
  return null;
}

/**
 * Provider notices that are not work.
 *
 * A handoff usually fires *because* the outgoing provider stopped, so its last
 * assistant message is very often that refusal rather than anything it was
 * doing. Reporting it as `inProgressWork` tells the incoming model the work in
 * flight was an error string, and the real state -- what the thread was
 * halfway through -- is never named at all. Live 2026-09-02: a thread handed
 * over mid-task carried "Our systems have detected unusual activity coming
 * from your system. Please try again later." as its in-progress work, while
 * the actual state (a half-finished recovery change over a red test suite) sat
 * two messages further back, behind a "Too many concurrent requests" notice.
 */
const PROVIDER_NOTICE_PATTERNS: ReadonlyArray<RegExp> = [
  /unusual activity/i,
  /try again (?:later|in a)/i,
  /too many (?:concurrent )?requests/i,
  /usage limit/i,
  // Not a bare /rate limit/: work prose legitimately discusses rate limiting
  // ("Rate limiting the retry loop is the next change") and must not be read
  // as the provider refusing.
  /being rate[- ]limited|rate limit (?:reached|exceeded)/i,
  /at capacity/i,
  /you(?:'|\u2019)?ve reached your/i,
  /stalled request was stopped/i,
];

/** True when an assistant message is the provider talking about itself. */
export function isProviderNotice(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  return PROVIDER_NOTICE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function latestInProgressWork(messages: ReadonlyArray<OrchestrationMessage>): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = message.text.trim();
    if (text.length === 0 || isProviderNotice(text)) continue;
    return boundedMessageText(text).text;
  }
  // Every assistant message was a notice: say nothing rather than hand the
  // next provider a refusal dressed as the work in flight.
  return null;
}

export function deriveProviderHandoffContinuity(messages: ReadonlyArray<OrchestrationMessage>): {
  readonly immediateRequirement: string | null;
  readonly inProgressWork: string | null;
} {
  return {
    immediateRequirement: latestMessageText(messages, "user"),
    inProgressWork: latestInProgressWork(messages),
  };
}

/**
 * Builds valid JSON under a hard post-serialization character cap. Messages
 * are selected from the newest end of the persisted T3 history, then emitted
 * in chronological order. This is a deterministic context digest, not an LLM
 * semantic summary: the exhausted provider is never asked to produce it.
 */
export function buildProviderHandoffSummary(input: ProviderHandoffSummaryInput): string {
  const derivedContinuity = deriveProviderHandoffContinuity(input.messages);
  // Only name the history tool when the target adapter actually mounts it.
  // Deep Code, Antigravity, and external bridges never receive the t3-code MCP
  // server, and a prompt that promises the tool there makes the model stall
  // and ask the user for context instead of working from the digest and the
  // workspace. See providerDriverHasSollaMcpTools.
  const threadHistoryToolAvailable = providerDriverHasSollaMcpTools(input.to.driver);
  const immediateRequirement =
    input.immediateRequirement?.trim() || derivedContinuity.immediateRequirement;
  const inProgressWork = input.inProgressWork?.trim() || derivedContinuity.inProgressWork;
  const selectedMessages = input.messages.slice(-PROVIDER_HANDOFF_MAX_MESSAGES).map((message) => {
    const bounded = boundedMessageText(message.text);
    return {
      id: boundedMetadata(String(message.id)),
      role: message.role,
      text: bounded.text,
      createdAt: boundedMetadata(message.createdAt),
      attachmentCount: message.attachments?.length ?? 0,
      truncated: bounded.truncated,
    };
  });
  const initiallyOmittedMessages = Math.max(0, input.messages.length - selectedMessages.length);

  const serialize = (messages: typeof selectedMessages, omittedForSize: number) =>
    JSON.stringify({
      version: 1,
      kind: "t3.provider-handoff",
      // The digest is bounded, so the incoming provider is otherwise free to
      // assume it is the whole record and answer straight from it. The reminder
      // turns "state any missing context you need" into something the model can
      // act on: it names the query tool for adapters that mount it, and points
      // at the workspace for adapters that never receive it, so neither one is
      // left asking the user for context the digest already carried.
      instruction: `Continue this T3 thread from the bounded persisted context digest. Do not redo work the digest already shows as complete. ${contextRecoveryReminder("provider-handoff", { threadHistoryToolAvailable })}`,
      thread: {
        id: boundedMetadata(String(input.threadId)),
        title: boundedMetadata(input.threadTitle),
      },
      handoff: {
        generatedAt: boundedMetadata(input.generatedAt),
        reason: boundedMetadata(input.exhaustion.reason),
        resetsAt: input.exhaustion.resetsAt,
        from: {
          instanceId: boundedMetadata(String(input.from.instanceId)),
          driver: boundedMetadata(String(input.from.driver)),
        },
        to: {
          instanceId: boundedMetadata(String(input.to.instanceId)),
          driver: boundedMetadata(String(input.to.driver)),
          model: boundedMetadata(input.to.modelSelection.model),
        },
      },
      continuity: {
        immediateRequirement:
          immediateRequirement === null ? null : boundedContinuity(immediateRequirement),
        inProgressWork: inProgressWork === null ? null : boundedContinuity(inProgressWork),
      },
      limits: {
        maxSerializedChars: PROVIDER_HANDOFF_MAX_SERIALIZED_CHARS,
        maxMessages: PROVIDER_HANDOFF_MAX_MESSAGES,
        maxMessageChars: PROVIDER_HANDOFF_MAX_MESSAGE_CHARS,
      },
      history: {
        includedMessages: messages.length,
        omittedMessages: initiallyOmittedMessages + omittedForSize,
        truncatedMessages: messages.filter((message) => message.truncated).length,
        messages,
      },
    });

  let omittedForSize = 0;
  let serialized = serialize(selectedMessages, omittedForSize);
  while (
    serialized.length > PROVIDER_HANDOFF_MAX_SERIALIZED_CHARS &&
    omittedForSize < selectedMessages.length
  ) {
    omittedForSize += 1;
    serialized = serialize(selectedMessages.slice(omittedForSize), omittedForSize);
  }

  if (serialized.length <= PROVIDER_HANDOFF_MAX_SERIALIZED_CHARS) {
    return serialized;
  }

  // Defensive fallback for pathological identifiers containing many escaped
  // control characters. It remains valid JSON and preserves the switch facts.
  return JSON.stringify({
    version: 1,
    kind: "t3.provider-handoff",
    instruction: `Continue this T3 thread. The bounded context digest was omitted for size. ${contextRecoveryReminder("provider-handoff", { threadHistoryToolAvailable })}`,
    handoff: {
      reason: "usage_limit",
      from: boundedMetadata(String(input.from.instanceId)).slice(0, 64),
      to: boundedMetadata(String(input.to.instanceId)).slice(0, 64),
    },
    history: {
      includedMessages: 0,
      omittedMessages: input.messages.length,
      truncatedMessages: 0,
      messages: [],
    },
  });
}

/**
 * Wraps a bounded handoff digest and the user's next request in one valid JSON
 * document. The persisted user message remains unchanged; only the replacement
 * provider receives this transport envelope.
 */
export function buildProviderHandoffTurnInput(input: {
  readonly summary: string;
  readonly currentRequest: string;
}): string {
  const context = JSON.parse(input.summary) as unknown;
  let currentRequest = input.currentRequest;

  // A failed provider switch can be retried from its persisted user message.
  // Older builds wrapped that already-wrapped transport input again, growing
  // the prompt on every attempt until provider validation rejected it. Peel
  // only our exact private envelope; ordinary user-authored JSON is untouched.
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const parsed = asRecord(JSON.parse(currentRequest) as unknown);
      if (
        parsed?.kind !== "t3.provider-handoff-turn" ||
        typeof parsed.currentRequest !== "string"
      ) {
        break;
      }
      currentRequest = parsed.currentRequest;
    } catch {
      break;
    }
  }

  const serialize = (request: string) =>
    JSON.stringify({
      version: 1,
      kind: "t3.provider-handoff-turn",
      context,
      currentRequest: request,
    });
  const serialized = serialize(currentRequest);
  if (serialized.length <= PROVIDER_HANDOFF_TURN_MAX_SERIALIZED_CHARS) {
    return serialized;
  }

  const truncationNotice =
    "\n\n[Request truncated for provider transport. Query persisted thread history for the full text.]";
  let lower = 0;
  let upper = currentRequest.length;
  let bounded = serialize(truncationNotice);
  while (lower <= upper) {
    const midpoint = Math.floor((lower + upper) / 2);
    const candidate = serialize(`${currentRequest.slice(0, midpoint)}${truncationNotice}`);
    if (candidate.length <= PROVIDER_HANDOFF_TURN_MAX_SERIALIZED_CHARS) {
      bounded = candidate;
      lower = midpoint + 1;
    } else {
      upper = midpoint - 1;
    }
  }
  return bounded;
}

/** Activity kinds the failover writes; the restore reads them back. */
export const PROVIDER_FAILOVER_COMPLETED_ACTIVITY_KIND = "provider.failover.completed";
export const PROVIDER_FAILOVER_RESTORED_ACTIVITY_KIND = "provider.failover.restored";

export interface UsageLimitFailoverRestore {
  /** The selection the thread goes back to: what the user had before the failover. */
  readonly modelSelection: ModelSelection;
  readonly sourceInstanceId: ProviderInstanceId;
  readonly sourceDriver: ProviderDriverKind;
  readonly sourceLabel: string;
  /** The failover target the thread is leaving. */
  readonly targetInstanceId: ProviderInstanceId;
  readonly targetModel: string;
  readonly targetLabel: string;
  readonly failoverActivityId: string;
  readonly resetsAtEpochMs: number | null;
}

function modelSelectionOptionsFromPayload(value: unknown): ModelSelection["options"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options: Array<{ readonly id: string; readonly value: string | boolean }> = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record || typeof record.id !== "string") continue;
    if (typeof record.value === "string" || typeof record.value === "boolean") {
      options.push({ id: record.id, value: record.value });
    }
  }
  return options.length > 0 ? options : undefined;
}

function activityOrder(activity: OrchestrationThreadActivity): number {
  return activity.sequence ?? Number.NEGATIVE_INFINITY;
}

/** Whether `later` was recorded after `earlier`; sequence first, then time. */
function activityIsAfter(
  later: OrchestrationThreadActivity,
  earlier: OrchestrationThreadActivity,
): boolean {
  const laterOrder = activityOrder(later);
  const earlierOrder = activityOrder(earlier);
  if (Number.isFinite(laterOrder) && Number.isFinite(earlierOrder) && laterOrder !== earlierOrder) {
    return laterOrder > earlierOrder;
  }
  return later.createdAt >= earlier.createdAt;
}

/**
 * Whether a thread that failed over on a usage limit should go back now.
 *
 * A failover is a stopgap, not a decision: the user picked Claude at max
 * effort and the five-hour window closing under them is not a reason to keep
 * the thread on Antigravity for the rest of the day. Yet that is what
 * happened — the failover rewrote the thread's selection and nothing ever
 * rewrote it back, so every thread that hit a limit stayed on whichever
 * provider was next in the registry until the user noticed and switched by
 * hand (2026-09-04: two threads to Antigravity at 22:38, two more at 23:19,
 * each switched back manually, reported as the client "desyncing" after a
 * mid-turn effort change).
 *
 * The restore is deliberately narrow. It only fires when the thread is still
 * exactly where the failover left it — the same instance and model — so a
 * user who explicitly selected a provider or model since keeps their choice,
 * even when that selection matches the fallback; only once the
 * window the failover recorded has actually reset; only when the provider it
 * would return to is enabled, authenticated, still lists the model, and is
 * not reporting a fresh exhaustion of its own; and never twice for the same
 * failover.
 */
export function resolveUsageLimitFailoverRestore(input: {
  readonly failover: OrchestrationThreadActivity | null | undefined;
  readonly restored: OrchestrationThreadActivity | null | undefined;
  readonly currentSelection: ModelSelection;
  readonly latestClientSelection?: { readonly sequence: number; readonly createdAt: string } | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly nowEpochMs: number;
}): UsageLimitFailoverRestore | null {
  const failover = input.failover;
  if (!failover || failover.kind !== PROVIDER_FAILOVER_COMPLETED_ACTIVITY_KIND) return null;
  if (input.restored && activityIsAfter(input.restored, failover)) return null;
  // Matching values do not imply unchanged intent: explicitly choosing the
  // fallback again retires the old failover, including across restarts.
  if (input.latestClientSelection) {
    const selectedAfterFailover =
      typeof failover.sequence === "number" && Number.isFinite(failover.sequence)
        ? input.latestClientSelection.sequence > failover.sequence
        : input.latestClientSelection.createdAt >= failover.createdAt;
    if (selectedAfterFailover) return null;
  }

  const payload = asRecord(failover.payload);
  if (!payload) return null;
  const sourceInstanceId = payload.sourceInstanceId;
  const sourceModel = payload.sourceModel;
  const targetInstanceId = payload.targetInstanceId;
  const targetModel = payload.targetModel;
  if (
    typeof sourceInstanceId !== "string" ||
    typeof sourceModel !== "string" ||
    typeof targetInstanceId !== "string" ||
    typeof targetModel !== "string" ||
    sourceInstanceId.length === 0 ||
    sourceModel.length === 0
  ) {
    return null;
  }
  // A failover that stayed on the same instance (Fable → Opus) is a model
  // downgrade the user may prefer to keep; only a provider change is undone.
  if (sourceInstanceId === targetInstanceId) return null;
  if (
    String(input.currentSelection.instanceId) !== targetInstanceId ||
    input.currentSelection.model !== targetModel
  ) {
    return null;
  }

  const resetsAtEpochMs = epochMilliseconds(payload.resetsAt);
  if (resetsAtEpochMs === null || resetsAtEpochMs > input.nowEpochMs) return null;

  const provider = input.providers.find(
    (candidate) => String(candidate.instanceId) === sourceInstanceId,
  );
  if (!provider || !isEligibleTarget(provider)) return null;
  if (isProviderAccountExhausted(provider, input.nowEpochMs)) return null;
  if (!provider.models.some((model) => model.slug === sourceModel)) return null;
  if (
    String(provider.driver) === CLAUDE_DRIVER &&
    isClaudeModelExhausted({
      accountUsage: provider.accountUsage,
      modelSlug: sourceModel,
      nowEpochMs: input.nowEpochMs,
    })
  ) {
    return null;
  }

  const options = modelSelectionOptionsFromPayload(payload.sourceOptions);
  const targetProvider = input.providers.find(
    (candidate) => String(candidate.instanceId) === targetInstanceId,
  );
  return {
    modelSelection: {
      instanceId: provider.instanceId,
      model: sourceModel,
      ...(options ? { options } : {}),
    },
    sourceInstanceId: provider.instanceId,
    sourceDriver: provider.driver,
    sourceLabel:
      (typeof payload.sourceLabel === "string" && payload.sourceLabel.trim()) ||
      provider.displayName?.trim() ||
      String(provider.driver),
    targetInstanceId: (targetProvider?.instanceId ??
      input.currentSelection.instanceId) as ProviderInstanceId,
    targetModel,
    targetLabel:
      (typeof payload.targetLabel === "string" && payload.targetLabel.trim()) ||
      targetProvider?.displayName?.trim() ||
      targetInstanceId,
    failoverActivityId: String(failover.id),
    resetsAtEpochMs,
  };
}
