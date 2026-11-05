import type {
  ModelSelection,
  OrchestrationMessage,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";

import { providerDriverHasSollaMcpTools } from "@t3tools/shared/providerDrivers";

import { contextRecoveryReminder } from "../provider/contextRecovery.ts";

export const PROVIDER_HANDOFF_MAX_SERIALIZED_CHARS = 32_000;
export const PROVIDER_HANDOFF_MAX_MESSAGES = 24;
export const PROVIDER_HANDOFF_MAX_MESSAGE_CHARS = 2_000;
export const PROVIDER_HANDOFF_TURN_MAX_SERIALIZED_CHARS = PROVIDER_SEND_TURN_MAX_INPUT_CHARS;

const METADATA_STRING_MAX_CHARS = 256;
const CONTINUITY_STRING_MAX_CHARS = 512;

export interface ProviderHandoffTarget {
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
  readonly to: ProviderHandoffTarget;
  /** Why the thread is changing hands: a person's switch, or a session recovery. */
  readonly reason: string;
  readonly generatedAt: string;
  readonly immediateRequirement?: string | null;
  readonly inProgressWork?: string | null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
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
 * semantic summary: the outgoing provider is never asked to produce it.
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
        reason: boundedMetadata(input.reason),
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
      reason: boundedMetadata(input.reason).slice(0, 64),
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
