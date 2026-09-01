/**
 * Telling the agent — and the user — that sending cancelled work in flight.
 *
 * Sending a message interrupts the turn that owns any background tasks, so they
 * die with it. The app already asks before doing that, but once the user says
 * yes the tasks simply vanish: the agent's next turn has no idea its build was
 * killed, and the transcript shows an ordinary message with no hint that
 * anything was lost. People re-read the conversation later and cannot tell why
 * a task stopped.
 *
 * So the message carries the fact with it. The block is appended to the prompt,
 * which means the agent reads it and can restart what still matters, and the UI
 * strips it back off and shows it as a badge on the message that caused it.
 * Deliberately on the message rather than in a separate activity: it is a
 * consequence *of that message*, and anywhere else it would be a floating event
 * the user has to correlate by timestamp.
 *
 * Marker-block format matches `previewAnnotation.ts` and `elementContext.ts` —
 * a trailing tagged block, stripped at render — so the round-trip rules are the
 * ones already proven here rather than a second scheme to keep in step.
 */

const INTERRUPTED_TASKS_TAG = "interrupted_background_tasks";

const TRAILING_INTERRUPTED_TASKS_PATTERN = new RegExp(
  `\\n*<${INTERRUPTED_TASKS_TAG}>\\n([\\s\\S]*?)\\n</${INTERRUPTED_TASKS_TAG}>\\s*$`,
);

/**
 * Addressed to the agent, and the reason this lives in the prompt at all.
 *
 * Kept inside the block rather than in the visible message so it never reads as
 * something the user typed.
 *
 * It has to say the tasks did not *fail*, not merely that they stopped. A
 * cancelled process still reports a kill signal — exit 137 for a SIGKILLed
 * build — and an agent that only knows "the task ended" reads that as a crash:
 * observed 2026-09-01, where three cancelled builds were diagnosed as the
 * machine running out of memory, and time went into checking memory pressure
 * that nothing had ever consumed.
 */
const INTERRUPTED_TASKS_INSTRUCTION =
  "The user sent this message, which deliberately cancelled the background tasks listed below. " +
  "They were killed on purpose and did not fail: ignore any non-zero exit code, kill signal, " +
  "or truncated output they reported, and do not investigate those as errors or draw conclusions " +
  "about the machine from them. Restart any that are still needed.";

export interface ExtractedInterruptedTasks {
  /** The prompt with the block removed. */
  readonly promptText: string;
  /** Titles of the tasks that were cancelled, in the order they were running. */
  readonly titles: ReadonlyArray<string>;
}

/** Task titles are one-per-line, so a title spanning lines would break parsing. */
function flatten(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

export function buildInterruptedTasksNotice(titles: ReadonlyArray<string>): string {
  const entries = titles.map(flatten).filter((title) => title.length > 0);
  if (entries.length === 0) return "";
  return [
    `<${INTERRUPTED_TASKS_TAG}>`,
    INTERRUPTED_TASKS_INSTRUCTION,
    ...entries.map((title) => `- ${title}`),
    `</${INTERRUPTED_TASKS_TAG}>`,
  ].join("\n");
}

/**
 * Appends the notice to a prompt.
 *
 * Must be the *last* block appended: `deriveDisplayedUserMessageState` requires
 * `<element_context>` to be trailing, so anything added after it has to be
 * stripped again first — which is exactly what the render path does.
 */
export function appendInterruptedTasksNotice(
  prompt: string,
  titles: ReadonlyArray<string>,
): string {
  const block = buildInterruptedTasksNotice(titles);
  if (block.length === 0) return prompt;
  const trimmed = prompt.trim();
  return trimmed.length > 0 ? `${trimmed}\n\n${block}` : block;
}

export function extractTrailingInterruptedTasksNotice(prompt: string): ExtractedInterruptedTasks {
  const match = TRAILING_INTERRUPTED_TASKS_PATTERN.exec(prompt);
  if (!match) return { promptText: prompt, titles: [] };
  const titles = (match[1] ?? "")
    .split("\n")
    // Only the list is data; the instruction line is for the agent, not the UI.
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0);
  return { promptText: prompt.slice(0, match.index).replace(/\n+$/, ""), titles };
}

/** What the badge says. The count is the part people actually read. */
export function describeInterruptedTasks(titles: ReadonlyArray<string>): string {
  return titles.length === 1
    ? "1 background task interrupted"
    : `${titles.length} background tasks interrupted`;
}
