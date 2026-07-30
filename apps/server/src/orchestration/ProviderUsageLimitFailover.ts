import type {
  ModelSelection,
  OrchestrationMessage,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";

export const PROVIDER_HANDOFF_MAX_SERIALIZED_CHARS = 32_000;
export const PROVIDER_HANDOFF_MAX_MESSAGES = 24;
export const PROVIDER_HANDOFF_MAX_MESSAGE_CHARS = 2_000;

const METADATA_STRING_MAX_CHARS = 256;

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
    default:
      return null;
  }
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

function targetFromProvider(provider: ServerProvider): ProviderFailoverTarget | null {
  const model = provider.models.find((entry) => entry.isDefault === true) ?? provider.models[0];
  if (!model) {
    return null;
  }
  return {
    instanceId: provider.instanceId,
    driver: provider.driver,
    modelSelection: {
      instanceId: provider.instanceId,
      model: model.slug,
    },
  };
}

/**
 * Provider registry order is the stable tie-breaker. A different driver is
 * preferred so a second instance backed by the same exhausted subscription
 * does not preempt an independently billed provider.
 */
export function selectProviderFailoverTarget(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly currentInstanceId: ProviderInstanceId;
  readonly currentDriver: ProviderDriverKind;
  readonly excludedInstanceIds?: ReadonlySet<string>;
}): ProviderFailoverTarget | null {
  const candidates = input.providers.filter(
    (provider) =>
      provider.instanceId !== input.currentInstanceId &&
      !input.excludedInstanceIds?.has(String(provider.instanceId)) &&
      isEligibleTarget(provider),
  );
  const provider =
    candidates.find((candidate) => candidate.driver !== input.currentDriver) ?? candidates[0];
  return provider ? targetFromProvider(provider) : null;
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

/**
 * Builds valid JSON under a hard post-serialization character cap. Messages
 * are selected from the newest end of the persisted T3 history, then emitted
 * in chronological order. This is a deterministic context digest, not an LLM
 * semantic summary: the exhausted provider is never asked to produce it.
 */
export function buildProviderHandoffSummary(input: ProviderHandoffSummaryInput): string {
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
      instruction:
        "Continue this T3 thread from the bounded persisted context digest. Do not repeat completed work. State any missing context you need.",
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
    instruction: "Continue this T3 thread. The bounded context digest was omitted for size.",
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
  return JSON.stringify({
    version: 1,
    kind: "t3.provider-handoff-turn",
    context: JSON.parse(input.summary) as unknown,
    currentRequest: input.currentRequest,
  });
}
