import type { OrchestratorEvent, TurnOutcome } from "./events";

/**
 * Turning "Rover finished." into something worth being interrupted for.
 *
 * The announcement used to be one canned sentence per event kind, which told
 * the user only that *something* had happened — they then had to open the
 * thread to find out what, which is exactly the work the orchestrator exists to
 * save. It also called every ending "finished", so a turn that was interrupted
 * or ran out of room was announced as plain success.
 *
 * This builds the instruction the voice model speaks from: the outcome, the
 * agent's own closing words, and any concrete artifacts named in them. The
 * model does the summarising — it is the part that can put it in the user's
 * words — but it is given the material and told what it must not omit.
 */

/** How much of the agent's closing message to hand over. */
const MAX_TAIL_CHARS = 1_200;
const MAX_ARTIFACTS = 6;

export interface ThreadCompletion {
  readonly event: OrchestratorEvent;
  /** The agent's last assistant message, when it could be read in time. */
  readonly lastMessage?: string;
  /** True when the thread is now blocked rather than done. */
  readonly waitingOn?: "approval" | "user-input" | "proposed-plan" | "nothing";
  /**
   * The provider's own error text, when the thread failed. Announcing a failure
   * without it tells the user the one thing they already know — that something
   * broke — and leaves them to go and read the thread to find out what.
   */
  readonly error?: string;
  /** Coarse classification of {@link error}, when the provider gave one. */
  readonly failureKind?: string;
}

/**
 * Concrete things the user can go look at.
 *
 * Deliberately conservative: it names only what the agent itself wrote down, so
 * the orchestrator can say "it touched threadRouting.ts" without inventing a
 * file that was never mentioned. Ordered by how specific each kind is.
 */
export function extractArtifacts(text: string): ReadonlyArray<string> {
  const found: Array<string> = [];
  const seen = new Set<string>();

  const push = (value: string) => {
    const trimmed = value.trim().replace(/[.,;:)\]]+$/, "");
    if (trimmed.length === 0 || seen.has(trimmed)) return;
    seen.add(trimmed);
    found.push(trimmed);
  };

  // URLs, including the PR and issue links agents habitually leave behind.
  for (const match of text.matchAll(/https?:\/\/[^\s<>"')]+/g)) push(match[0]);
  // PR / issue shorthand.
  for (const match of text.matchAll(/\b(?:PR|pull request|issue)\s*#?(\d+)/gi)) push(match[0]);
  // Paths with a file extension — `src/a/b.ts`, `./x.py`, `apps/web/main.tsx`.
  for (const match of text.matchAll(/\b[\w.@-]+(?:\/[\w.@-]+)+\.\w{1,5}\b/g)) push(match[0]);
  // Bare filenames in backticks, which is how most agents write them.
  for (const match of text.matchAll(/`([^`\n]{1,80})`/g)) {
    const inner = match[1];
    if (inner !== undefined && /\.\w{1,5}$/.test(inner.trim())) push(inner);
  }
  // Branch names.
  for (const match of text.matchAll(/\bbranch\s+`?([\w./-]+)`?/gi)) {
    const inner = match[1];
    if (inner !== undefined) push(inner);
  }

  return found.slice(0, MAX_ARTIFACTS);
}

/** The closing part of a message, which is where agents put their summary. */
export function tailOf(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_TAIL_CHARS) return trimmed;
  return `…${trimmed.slice(-MAX_TAIL_CHARS)}`;
}

function outcomeClause(outcome: TurnOutcome, title: string): string {
  switch (outcome) {
    case "completed":
      return `"${title}" finished its turn.`;
    case "partial":
      // Interrupted or out of room. Announcing this as success is how a
      // half-done job gets mistaken for a done one.
      return `"${title}" stopped before finishing — it was interrupted or ran out of room, so its work is incomplete.`;
    case "failed":
      return `"${title}" ended with an error.`;
    case "unknown":
      return `"${title}" is no longer running.`;
  }
}

/**
 * The instruction handed to the voice model for a completion announcement.
 *
 * Written as directions rather than a script: the model has the agent's actual
 * words and turns them into one or two spoken sentences, but the requirements —
 * name the outputs, flag partial work, offer a next step — are not optional.
 */
export function buildCompletionAnnouncement(completion: ThreadCompletion): string {
  const { event } = completion;
  const lines: Array<string> = [outcomeClause(event.outcome, event.title)];

  if (event.projectName.length > 0 && event.projectName !== event.title) {
    lines.push(`It belongs to the ${event.projectName} project.`);
  }

  // Before the closing message: when a thread fails, why it failed is the
  // answer, and the last thing it managed to say is only context.
  const error = completion.error?.trim() ?? "";
  if (error.length > 0) {
    lines.push(`The error it reported, exactly: "${tailOf(error)}"`);
    const failureKind = completion.failureKind?.trim() ?? "";
    if (failureKind.length > 0) {
      lines.push(`The provider classified that as: ${failureKind}.`);
    }
  }

  const message = completion.lastMessage?.trim() ?? "";
  if (message.length > 0) {
    lines.push(`Its closing message read: "${tailOf(message)}"`);
    const artifacts = extractArtifacts(message);
    if (artifacts.length > 0) {
      lines.push(`It named these outputs: ${artifacts.join(", ")}.`);
    }
  }

  if (completion.waitingOn === "approval") {
    lines.push("It is now blocked waiting for you to approve something.");
  } else if (completion.waitingOn === "user-input") {
    lines.push("It is now blocked waiting for an answer from you.");
  } else if (completion.waitingOn === "proposed-plan") {
    lines.push("It has put up a plan for you to accept or change.");
  }

  lines.push(
    "Tell the user, in one or two spoken sentences and in your own words:",
    "what it actually did (not just that it finished),",
    message.length > 0
      ? "the specific outputs by name if there are any,"
      : // Not "say you could not read it": the message is retrievable, and
        // telling the user to go and look is asking them to do the one thing
        // the tools exist to avoid. Fetch it and report it.
        "and — since the result could not be read in time here — call read_thread on that thread now to get what it actually said, then report that. Never tell the user to open the thread or check the messages themselves; you can read them.",
  );

  if (event.outcome === "partial" || event.outcome === "failed") {
    lines.push("that the work is not complete and why,");
  }

  if (error.length > 0) {
    // The whole point of carrying the error through: say what it said.
    lines.push(
      "and the actual reason it failed, in the error's own terms — not 'an error occurred'. If the error names a limit, a credential, a file or a command, say which one.",
    );
  } else if (event.outcome === "failed") {
    lines.push(
      "and say plainly that no error message was recorded, rather than inventing a reason,",
    );
  }

  lines.push(
    "and one concrete next step you would suggest.",
    "Do not read out long file lists or quote the message verbatim.",
  );

  return lines.join(" ");
}

/** One short line per event, for the kinds that are not completions. */
export function describeEventFallback(event: OrchestratorEvent): string {
  switch (event.kind) {
    case "thread-finished":
      return `${event.title} finished.`;
    case "task-completed":
      return `A background task in ${event.title} finished.`;
    case "approval-needed":
      return `${event.title} needs your approval.`;
    case "input-needed":
      return `${event.title} is waiting on an answer from you.`;
    case "thread-failed":
      return `${event.title} hit an error.`;
    case "auto-resume-stuck":
      return `${event.title} has been waiting to auto-resume for a while.`;
  }
}
