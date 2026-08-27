import type { ModelSelection } from "@t3tools/contracts";

export const VOICE_TRANSCRIPT_CORRECTION_DEADLINE_MS = 20_000;
export const VOICE_TRANSCRIPT_CONTEXT_MAX_CHARS = 4_000;
export const VOICE_TRANSCRIPT_CONTEXT_MAX_MESSAGES = 8;

let activeVoiceTranscriptCorrectionController: AbortController | null = null;

export interface VoiceTranscriptContextMessage {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly streaming?: boolean;
}

/**
 * Keep only the tail of the conversation that can disambiguate names and
 * terms in the next utterance. The correction model does not need the full
 * thread, and a small request keeps this middleware out of the send path for
 * as little time as possible.
 */
export function buildVoiceTranscriptConversationContext(
  messages: ReadonlyArray<VoiceTranscriptContextMessage>,
  options: {
    readonly maxChars?: number;
    readonly maxMessages?: number;
  } = {},
): string {
  const maxChars = options.maxChars ?? VOICE_TRANSCRIPT_CONTEXT_MAX_CHARS;
  const maxMessages = options.maxMessages ?? VOICE_TRANSCRIPT_CONTEXT_MAX_MESSAGES;
  if (maxChars <= 0 || maxMessages <= 0) return "";

  const lines: string[] = [];
  let remaining = maxChars;
  for (let index = messages.length - 1; index >= 0 && lines.length < maxMessages; index -= 1) {
    const message = messages[index];
    if (!message || message.streaming === true) continue;
    const text = message.text.trim().replace(/\s+/g, " ");
    if (text.length === 0) continue;

    const label =
      message.role === "assistant" ? "Assistant" : message.role === "user" ? "User" : "System";
    const prefix = `${label}: `;
    if (remaining <= prefix.length) break;
    const availableText = remaining - prefix.length;
    const boundedText =
      text.length <= availableText
        ? text
        : availableText > 1
          ? `${text.slice(0, availableText - 1).trimEnd()}…`
          : text.slice(0, availableText);
    const line = `${prefix}${boundedText}`;
    lines.unshift(line);
    remaining -= line.length + 1;
  }
  return lines.join("\n");
}

function correctedTranscriptIsPlausible(original: string, corrected: string): boolean {
  if (corrected.length === 0 || corrected.length > 8_000) return false;
  // Correction should be a light edit, not a second assistant response. Leave
  // generous room for punctuation and expanded names while rejecting a model
  // that unexpectedly returns paragraphs for a short utterance.
  return corrected.length <= Math.max(256, original.length * 3);
}

/**
 * Repair `.2` as spoken "point two" at sentence/list boundaries and as "point
 * to" only in near-unambiguous grammatical verb slots. Keep decimal evidence
 * such as units, series, versions, and in-sentence numeric values unchanged.
 */
export function normalizeVoiceTranscriptSpeechArtifacts(transcript: string): string {
  const normalized = transcript
    .replace(
      /(^|[.!?]\s+)((?:and|also|then)\s+)?\.2(?=\s*(?:$|[.!?]))/gi,
      (_match, boundary: string, lead: string | undefined) => `${boundary}${lead ?? ""}point two`,
    )
    .replace(
      /(^|[.!?]\s+)((?:and|also|then)\s+)?\.2(?=\s+(?!(?:seconds?|secs?|milliseconds?|minutes?|hours?|percent|percentage|pixels?|px|em|rem|volts?|amps?|meters?|metres?|inches?|degrees?|kb|mb|gb|hz|fps)\b)[a-z])/gi,
      (_match, boundary: string, lead: string | undefined) => `${boundary}${lead ?? ""}point two,`,
    )
    .replace(
      /\b((?:can|could|would|will|should|must)\s+you|please)\s+\.2(?=\s+(?:the|this|that|these|those|it|them|him|her|me|us|my|your|our|their|its|his)\b)/gi,
      "$1 point to",
    )
    .replace(
      /\b((?:need|want)\s+you)\s+\.2(?=\s+(?:the|this|that|these|those|it|them|him|her|me|us|my|your|our|their|its|his)\b)/gi,
      "$1 to point to",
    );

  const hasEllipsisContext = (value: string) =>
    /\b(?:content|description|label|message|notification|preview|text|title|transcript(?:ion)?)\b[^.!?\n]{0,180}\b(?:short(?:ened)?(?:\s+(?:form|preview|version))?|truncat(?:e|ed|es|ing|ion))\b[^.!?\n]{0,80}\bwith\s+(?:a\s+)?lip\b[^.!?\n]{0,140}\b(?:expand(?:s|ed|ing)?|hover(?:s|ed|ing)?)\b/i.test(
      value,
    );
  if (!hasEllipsisContext(transcript) && !hasEllipsisContext(normalized)) return normalized;

  return normalized
    .replace(
      /\b((?:short(?:ened)?(?:\s+(?:form|preview|version))?|truncat(?:e|ed|es|ing|ion))[^.!?\n]{0,48}\bwith)\s+(?:a\s+)?lip\b/gi,
      "$1 an ellipsis",
    )
    .replace(/\ban ellipsis\s*,?\s+but then\b/gi, "an ellipsis, but then")
    .replace(/\bwhen\s+hover\s+over\b/gi, "when you hover over")
    .replace(/\bwhen you hover over it\s*,?\s+(expands?\b)/gi, "when you hover over it, it $1");
}

function createVoiceTranscriptCorrectionCancellationError(): Error {
  const error = new Error("Voice transcript correction was cancelled.");
  error.name = "AbortError";
  return error;
}

/** Stop waiting for the active editorial pass so Cancel remains immediate. */
export function cancelActiveVoiceTranscriptCorrection(): boolean {
  const controller = activeVoiceTranscriptCorrectionController;
  if (!controller) return false;
  controller.abort(createVoiceTranscriptCorrectionCancellationError());
  return true;
}

/**
 * Best-effort contextual correction. Failure, timeout, or implausible output
 * preserves the local transcription except for the narrow, grammar-safe speech
 * artifact repair above, so dictation can never be blocked by an app-owned
 * model request.
 */
export async function correctVoiceTranscriptWithFallback(input: {
  readonly enabled: boolean;
  readonly transcript: string;
  readonly cwd: string;
  readonly conversationContext: string;
  readonly modelSelection: ModelSelection;
  readonly request: (input: {
    readonly cwd: string;
    readonly transcript: string;
    readonly conversationContext: string;
    readonly modelSelection: ModelSelection;
  }) => Promise<string>;
  readonly onRefining?: () => void;
  readonly timeoutMs?: number;
}): Promise<string> {
  const localFallback = normalizeVoiceTranscriptSpeechArtifacts(input.transcript);
  if (input.transcript.trim().length === 0) return input.transcript;
  // The switch controls the contextual AI pass. Narrow, grammar-safe repairs
  // for recognition artifacts remain part of local transcription itself so a
  // disabled or unavailable provider cannot leak known-bad output.
  if (!input.enabled) return localFallback;
  if (input.cwd.trim().length === 0) return localFallback;

  activeVoiceTranscriptCorrectionController?.abort(
    createVoiceTranscriptCorrectionCancellationError(),
  );
  const controller = new AbortController();
  activeVoiceTranscriptCorrectionController = controller;
  const timeoutMs = input.timeoutMs ?? VOICE_TRANSCRIPT_CORRECTION_DEADLINE_MS;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let removeCancellationListener: () => void = () => undefined;
  try {
    input.onRefining?.();
    const cancelled = new Promise<never>((_resolve, reject) => {
      const onAbort = () =>
        reject(
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : createVoiceTranscriptCorrectionCancellationError(),
        );
      controller.signal.addEventListener("abort", onAbort, { once: true });
      removeCancellationListener = () => controller.signal.removeEventListener("abort", onAbort);
    });
    const corrected = await Promise.race([
      input.request({
        cwd: input.cwd,
        transcript: input.transcript,
        conversationContext: input.conversationContext,
        modelSelection: input.modelSelection,
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Voice transcript correction timed out.")),
          timeoutMs,
        );
      }),
      cancelled,
    ]);
    const normalized = normalizeVoiceTranscriptSpeechArtifacts(corrected.trim());
    return correctedTranscriptIsPlausible(input.transcript, normalized)
      ? normalized
      : localFallback;
  } catch (cause) {
    if (controller.signal.aborted) throw cause;
    return localFallback;
  } finally {
    if (timeout !== null) clearTimeout(timeout);
    removeCancellationListener();
    if (activeVoiceTranscriptCorrectionController === controller) {
      activeVoiceTranscriptCorrectionController = null;
    }
  }
}
