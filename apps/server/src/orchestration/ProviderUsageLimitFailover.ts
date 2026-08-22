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

function claudeModelFamily(slug: string): ClaudeModelFamily | null {
  const normalized = slug.toLowerCase();
  return CLAUDE_MODEL_FAMILIES.find((family) => normalized.includes(family)) ?? null;
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
): ServerProviderModel | null {
  const usable =
    String(provider.driver) === CLAUDE_DRIVER
      ? provider.models.filter(
          (entry) =>
            !isClaudeModelExhausted({
              accountUsage: provider.accountUsage,
              modelSlug: entry.slug,
              nowEpochMs,
            }),
        )
      : provider.models;
  return usable.find((entry) => entry.isDefault === true) ?? usable[0] ?? null;
}

/**
 * Whether this provider's *account* is out of quota, as opposed to one of its
 * models. Claude meters per model family and is screened in `failoverModel`;
 * Codex meters the whole account, so a per-model screen can never see it.
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
function isProviderAccountExhausted(provider: ServerProvider, nowEpochMs: number | null): boolean {
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
): ProviderFailoverTarget | null {
  if (isProviderAccountExhausted(provider, nowEpochMs)) {
    return null;
  }
  const model = failoverModel(provider, nowEpochMs);
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

/**
 * Provider registry order is the stable tie-breaker. A different driver is
 * preferred so a second instance backed by the same exhausted subscription
 * does not preempt an independently billed provider. A candidate whose every
 * model is out of quota is passed over rather than ending the search.
 */
export function selectProviderFailoverTarget(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly currentInstanceId: ProviderInstanceId;
  readonly currentDriver: ProviderDriverKind;
  readonly excludedInstanceIds?: ReadonlySet<string>;
  readonly nowEpochMs?: number | null;
}): ProviderFailoverTarget | null {
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
    const target = targetFromProvider(provider, input.nowEpochMs ?? null);
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

export function deriveProviderHandoffContinuity(messages: ReadonlyArray<OrchestrationMessage>): {
  readonly immediateRequirement: string | null;
  readonly inProgressWork: string | null;
} {
  return {
    immediateRequirement: latestMessageText(messages, "user"),
    inProgressWork: latestMessageText(messages, "assistant"),
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
