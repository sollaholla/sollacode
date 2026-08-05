/**
 * Context-recovery reminders.
 *
 * Two events drop a model into a thread it cannot fully see: an auto-compaction
 * replaces earlier turns with a summary, and a provider handoff starts a fresh
 * runtime holding only a bounded digest. In both cases the *full* transcript is
 * still on disk and queryable, but a model that was never told so treats the
 * summary as the whole record — answering from the digest instead of reading
 * what actually happened.
 *
 * These strings are the reminder. They name the tool explicitly, because a
 * vague "you may have lost context" prompts an apology rather than a lookup.
 */

export const CONTEXT_RECOVERY_TOOL_NAME = "mcp__t3-code__thread_history_query";

export type ContextRecoveryReason = "compaction" | "provider-handoff";

const REASON_PREAMBLE: Record<ContextRecoveryReason, string> = {
  compaction:
    "This thread was just compacted, so earlier turns are no longer in your context window verbatim.",
  "provider-handoff":
    "You were just handed this thread from another provider. The digest above is a bounded excerpt, not the full record.",
};

/**
 * The reminder text for a given loss-of-context event.
 *
 * Phrased as a standing capability rather than an instruction to search now:
 * most turns after a compaction do not need history, and a hard "look this up
 * first" would burn a tool call on every one of them.
 */
export function contextRecoveryReminder(reason: ContextRecoveryReason): string {
  return [
    REASON_PREAMBLE[reason],
    `The complete thread history is still stored and searchable — call the \`${CONTEXT_RECOVERY_TOOL_NAME}\` tool to read any earlier message, tool call, or decision verbatim.`,
    "Prefer querying it over guessing, asking the user to repeat themselves, or assuming work was never done.",
  ].join(" ");
}

/**
 * Wraps the reminder so it reads as an out-of-band note rather than something
 * the user typed. Mirrors the `<system-reminder>` convention the runtime
 * already uses for injected context.
 */
export function contextRecoveryReminderBlock(reason: ContextRecoveryReason): string {
  return `<system-reminder>\n${contextRecoveryReminder(reason)}\n</system-reminder>`;
}

/**
 * Prepends the reminder to the next outgoing prompt.
 *
 * Returns the prompt untouched when no reminder is pending, so the common path
 * allocates nothing. An empty prompt still carries the reminder: a turn with
 * only attachments is exactly the kind that benefits from the model knowing it
 * can go read what came before.
 */
export function withContextRecoveryReminder(
  promptText: string,
  reason: ContextRecoveryReason | undefined,
): string {
  if (reason === undefined) return promptText;
  const block = contextRecoveryReminderBlock(reason);
  return promptText.length > 0 ? `${block}\n\n${promptText}` : block;
}
