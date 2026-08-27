import type { ModelSelection } from "@t3tools/contracts";

export const VOICE_TRANSCRIPT_CORRECTION_DEADLINE_MS = 8_000;
export const VOICE_TRANSCRIPT_CONTEXT_MAX_CHARS = 4_000;
export const VOICE_TRANSCRIPT_CONTEXT_MAX_MESSAGES = 8;

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
 * Best-effort contextual correction. Failure, timeout, or implausible output
 * all preserve the local transcription byte-for-byte so dictation can never
 * be blocked by an app-owned model request.
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
  readonly timeoutMs?: number;
}): Promise<string> {
  if (!input.enabled || input.transcript.trim().length === 0 || input.cwd.trim().length === 0) {
    return input.transcript;
  }

  const timeoutMs = input.timeoutMs ?? VOICE_TRANSCRIPT_CORRECTION_DEADLINE_MS;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
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
    ]);
    const normalized = corrected.trim();
    return correctedTranscriptIsPlausible(input.transcript, normalized)
      ? normalized
      : input.transcript;
  } catch {
    return input.transcript;
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}
