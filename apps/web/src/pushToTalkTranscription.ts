/**
 * Distil-small.en (and every other `.en` Whisper) is English-only. Passing
 * `language` or `task` throws:
 * "Cannot specify `task` or `language` for an English-only model."
 * Observed on Windows where the local fallback is the only dictation path.
 */
export const LONG_FORM_TRANSCRIPTION_OPTIONS = {
  chunk_length_s: 30,
  stride_length_s: 5,
} as const;

/**
 * Free local fallback for web, non-Mac clients, and Macs where SpeechAnalyzer
 * is unavailable. Distil-small is still practical on-device but is trained
 * from Whisper large-v2 supervision; tiny.en was fast but routinely lost
 * names, clauses, and technical terms in ordinary dictation.
 */
export const LOCAL_TRANSCRIPTION_MODEL = {
  id: "onnx-community/distil-small.en",
  revision: "69be759f982d1d4c5b8a987d4140752742619bd0",
  dtype: "q4",
} as const;

/** Baseline coding vocabulary for Apple's context-aware DictationTranscriber. */
export const DEFAULT_NATIVE_TRANSCRIPTION_CONTEXT = [
  "Solla Code",
  "T3 Code",
  "Codex",
  "Claude",
  "Grok",
  "OpenCode",
  "GitHub",
  "TypeScript",
  "JavaScript",
  "React",
  "Electron",
  "WebSocket",
  "macOS",
] as const;

interface TranscriptionResult {
  readonly text?: string;
}

/**
 * Whisper normally returns one merged result for a single audio input. Join
 * every result defensively so a pipeline returning multiple segments cannot
 * silently discard everything after its first segment.
 */
export function assembleTranscriptionText(
  result: TranscriptionResult | ReadonlyArray<TranscriptionResult>,
): string {
  const segments = Array.isArray(result) ? result : [result];
  return segments
    .map((segment) => segment.text?.trim() ?? "")
    .filter((segment) => segment.length > 0)
    .join(" ")
    .trim();
}

/** One-line preview for the away-from-chat transcription toast. */
export const VOICE_TRANSCRIPT_TOAST_PREVIEW_CHARS = 160;

export function previewVoiceTranscript(
  transcript: string,
  maxChars = VOICE_TRANSCRIPT_TOAST_PREVIEW_CHARS,
): string {
  const collapsed = transcript.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

/** Keep existing draft text and append the completed dictation as one phrase. */
export function mergeVoiceTranscriptPrompt(currentPrompt: string, transcript: string): string {
  const normalizedTranscript = transcript.trim();
  if (normalizedTranscript.length === 0) return currentPrompt;
  if (currentPrompt.length === 0 || /\s$/u.test(currentPrompt)) {
    return `${currentPrompt}${normalizedTranscript}`;
  }
  return `${currentPrompt} ${normalizedTranscript}`;
}

export type VoiceTranscriptInputTarget =
  | { readonly kind: "composer-draft" }
  | { readonly kind: "pending-user-input"; readonly questionId: string };

/**
 * Resolve dictation against the input the composer is visibly presenting.
 * A provider question temporarily replaces the normal thread draft, so voice
 * input must follow that same ownership boundary instead of writing behind it.
 */
export function resolveVoiceTranscriptInputUpdate(input: {
  readonly currentPrompt: string;
  readonly transcript: string;
  readonly pendingQuestionId: string | null;
}): {
  readonly prompt: string;
  readonly target: VoiceTranscriptInputTarget;
} {
  return {
    prompt: mergeVoiceTranscriptPrompt(input.currentPrompt, input.transcript),
    target:
      input.pendingQuestionId === null
        ? { kind: "composer-draft" }
        : { kind: "pending-user-input", questionId: input.pendingQuestionId },
  };
}

export function shouldTranscribeStoppedRecording(input: {
  readonly audioByteLength: number;
  readonly reachedRecordingLimit: boolean;
}): boolean {
  if (input.audioByteLength <= 0) return false;
  // Reaching the limit is a normal stop condition, not an error. The full
  // captured blob must still take the same transcription path as a key-up.
  return input.reachedRecordingLimit || input.audioByteLength > 0;
}
