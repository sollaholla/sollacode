import * as Predicate from "effect/Predicate";
import type { RecentConversationEntry } from "./realtimeProtocol";

export interface LiveTranscriptDelta {
  role: "user" | "assistant";
  text: string;
  startMs: number;
  endMs: number;
}

export function parseLiveTranscript(event: unknown): LiveTranscriptDelta | null {
  if (
    !Predicate.isObject(event) ||
    (event.type !== "session.input_transcript.delta" &&
      event.type !== "session.output_transcript.delta") ||
    typeof event.delta !== "string" ||
    event.delta.length > 8_000 ||
    typeof event.start_ms !== "number" ||
    !Number.isFinite(event.start_ms) ||
    event.start_ms < 0 ||
    typeof event.end_ms !== "number" ||
    !Number.isFinite(event.end_ms) ||
    event.end_ms < event.start_ms
  )
    return null;
  return {
    role: event.type === "session.input_transcript.delta" ? "user" : "assistant",
    text: event.delta,
    startMs: event.start_ms,
    endMs: event.end_ms,
  };
}

/** Appends contain at most 500 tokens. A UTF-8 byte ceiling is conservative
 * for every tokenizer, including scripts where one character spans many tokens. */
export function liveAppendChunks(text: string, maxChunks = 8): string[] {
  const chunks: string[] = [];
  const encoder = new TextEncoder();
  let chunk = "";
  let bytes = 0;
  for (const character of text) {
    const length = encoder.encode(character).length;
    if (bytes + length > 480) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    if (chunks.length === maxChunks) return chunks;
    chunk += character;
    bytes += length;
  }
  if (chunk.trim()) chunks.push(chunk);
  return chunks;
}

/** Retains timing and both speakers; a fragment alone never starts work. */
export function createLiveTranscriptContext(history: readonly RecentConversationEntry[] = []) {
  const fragments: LiveTranscriptDelta[] = [];
  let characters = 0;
  return {
    append: (fragment: LiveTranscriptDelta) => {
      fragments.push(fragment);
      characters += fragment.text.length;
      while (fragments.length > 256 || characters > 64_000)
        characters -= fragments.shift()!.text.length;
    },
    hasUserSpeech: () =>
      fragments.some((fragment) => fragment.role === "user" && fragment.text.trim().length > 0),
    context: () =>
      [
        ...history.slice(-12).map((entry) => `${entry.role}: ${entry.text}`),
        ...[...fragments]
          .sort((a, b) => a.startMs - b.startMs)
          .map((entry) => `${entry.role} [${entry.startMs}-${entry.endMs}ms]: ${entry.text}`),
      ]
        .join("\n")
        .slice(-24_000),
  };
}
