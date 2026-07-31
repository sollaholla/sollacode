export const LONG_FORM_TRANSCRIPTION_OPTIONS = {
  chunk_length_s: 30,
  stride_length_s: 5,
} as const;

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

/** Keep existing draft text and append the completed dictation as one phrase. */
export function mergeVoiceTranscriptPrompt(currentPrompt: string, transcript: string): string {
  const normalizedTranscript = transcript.trim();
  if (normalizedTranscript.length === 0) return currentPrompt;
  if (currentPrompt.length === 0 || /\s$/u.test(currentPrompt)) {
    return `${currentPrompt}${normalizedTranscript}`;
  }
  return `${currentPrompt} ${normalizedTranscript}`;
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
