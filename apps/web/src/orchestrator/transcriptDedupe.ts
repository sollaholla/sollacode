/**
 * Dropping an assistant line the session has just said.
 *
 * The realtime API can produce two responses for one turn — a `response.create`
 * racing the server's own, or a second tool result arriving after the first
 * reply was queued — and the guards against that live in the session's frame
 * handling, where they depend on getting every ordering right. This is the
 * backstop underneath them: whatever the cause, the same sentence appearing
 * twice in a row is never something the orchestrator meant to say, and the
 * duplicate reaches both the on-screen transcript and the stored thread.
 *
 * Assistant copies are always dropped. Identical user copies in the same
 * window are dropped too: Grok Voice repeats one spoken sentence as several
 * `completed` events seconds apart, and each one used to become a real
 * message. A second "yes" after the assistant has spoken still lands, because
 * that path sees an assistant line in between.
 */

export interface TranscriptLine {
  readonly role: "user" | "assistant";
  readonly text: string;
  /** When it was recorded, for the recency window. */
  readonly atMs: number;
}

/**
 * How long a line stays "just said".
 *
 * Short on purpose. A true duplicate is two responses racing for one turn, so
 * the copies arrive seconds apart. Thirty seconds was the first guess and it
 * was wrong in a way that mattered: the orchestrator is instructed to say a
 * short acknowledgement before *every* tool call, so "Checking that." twice in
 * half a minute is the system working, not repeating itself.
 */
export const REPEAT_WINDOW_MS = 8_000;

export function isRepeatedAssistantLine(input: {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly previous: TranscriptLine | null;
  readonly nowMs: number;
  readonly windowMs?: number;
}): boolean {
  if (input.role !== "assistant") return false;
  const previous = input.previous;
  // A user turn in between makes an identical line a fresh acknowledgement of a
  // fresh question, however similar it sounds. Only two assistant lines with
  // nothing spoken between them can be the same line twice.
  if (previous === null || previous.role !== "assistant") return false;
  const window = input.windowMs ?? REPEAT_WINDOW_MS;
  if (input.nowMs - previous.atMs > window) return false;
  return normalize(previous.text) === normalize(input.text);
}

/**
 * Whether this user line is the same spoken turn arriving again.
 *
 * Grok Voice has committed "Hey, what's up?" three times over ~4s, each as
 * its own message. Two identical user lines with nothing from the assistant
 * between them, inside the window, are that — not someone answering twice.
 */
export function isRepeatedUserLine(input: {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly previous: TranscriptLine | null;
  readonly nowMs: number;
  readonly windowMs?: number;
}): boolean {
  if (input.role !== "user") return false;
  const previous = input.previous;
  if (previous === null || previous.role !== "user") return false;
  const window = input.windowMs ?? REPEAT_WINDOW_MS;
  if (input.nowMs - previous.atMs > window) return false;
  return normalize(previous.text) === normalize(input.text);
}

/**
 * Compared on words, not characters: the two copies can differ in trailing
 * punctuation or spacing when they come from separate synthesis passes, and a
 * duplicate that differs by a full stop is still a duplicate.
 */
function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?…]+$/u, "");
}
