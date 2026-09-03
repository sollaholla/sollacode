import type {
  ModelSelection,
  OrchestrationMessage,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderModel,
  ThreadId,
} from "@t3tools/contracts";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";

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

function detectCodexExhaustion(rateLimits: unknown): ProviderUsageLimitExhaustion | null {
  const envelope = asRecord(rateLimits);
  const snapshot = asRecord(envelope?.rateLimits) ?? envelope;
  if (!snapshot) {
    return null;
  }

  const primary = asRecord(snapshot.primary);
  const secondary = asRecord(snapshot.secondary);
  const rateLimitReachedType =
    typeof snapshot.rateLimitReachedType === "string" ? snapshot.rateLimitReachedType : undefined;
  const primaryUsedPercent = finiteNumber(primary?.usedPercent);
  const secondaryUsedPercent = finiteNumber(secondary?.usedPercent);
  const spendControlReached = snapshot.spendControlReached === true;

  if (
    rateLimitReachedType === undefined &&
    !spendControlReached &&
    (primaryUsedPercent === undefined || primaryUsedPercent < 100) &&
    (secondaryUsedPercent === undefined || secondaryUsedPercent < 100)
  ) {
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
 * Returns an exhaustion signal only for provider adapters that expose a typed,
 * canonical account rate-limit event. Text matching provider errors is
 * intentionally avoided because it would switch providers on unrelated
 * failures and translated CLI output.
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
    default:
      return null;
  }
}

const CLAUDE_DRIVER = "claudeAgent";
const QUOTA_EXHAUSTED_PERCENT = 100;

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
 * must not disqualify Opus 5 on the same instance.
 */
export function isAccountWideProviderExhaustion(
  driver: ProviderDriverKind,
  exhaustion: ProviderUsageLimitExhaustion,
): boolean {
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

/**
 * Registry order is capability order (highest first), so the preferred default
 * is used when it still has quota and otherwise the next-highest usable model
 * takes over. Returns null when every model of this provider is spent.
 */
function failoverModel(
  provider: ServerProvider,
  nowEpochMs: number | null,
  skipSlugs?: ReadonlySet<string>,
): ServerProviderModel | null {
  const usable = provider.models.filter((entry) => {
    if (skipSlugs?.has(entry.slug)) return false;
    if (String(provider.driver) !== CLAUDE_DRIVER) return true;
    return !isClaudeModelExhausted({
      accountUsage: provider.accountUsage,
      modelSlug: entry.slug,
      nowEpochMs,
    });
  });
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

function isProviderAccountExhausted(provider: ServerProvider, nowEpochMs: number | null): boolean {
  if (String(provider.driver) === CLAUDE_DRIVER) {
    return isClaudeAccountExhausted(provider.accountUsage, nowEpochMs);
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
  readonly currentInstanceId: ProviderInstanceId;
  readonly currentDriver: ProviderDriverKind;
  readonly currentModel?: string | null;
  readonly excludedInstanceIds?: ReadonlySet<string>;
  readonly excludedModels?: ReadonlySet<string>;
  readonly nowEpochMs?: number | null;
}): ProviderFailoverTarget | null {
  const nowEpochMs = input.nowEpochMs ?? null;
  const currentModel =
    typeof input.currentModel === "string" && input.currentModel.length > 0
      ? input.currentModel
      : null;

  const currentProvider = input.providers.find(
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

  const candidates = input.providers.filter(
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
      // assume it is the whole record and answer straight from it. Naming the
      // query tool here is what turns "state any missing context you need"
      // into something it can act on without going back to the user.
      instruction: `Continue this T3 thread from the bounded persisted context digest. Do not repeat completed work. ${contextRecoveryReminder("provider-handoff")}`,
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
    instruction: `Continue this T3 thread. The bounded context digest was omitted for size. ${contextRecoveryReminder("provider-handoff")}`,
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
