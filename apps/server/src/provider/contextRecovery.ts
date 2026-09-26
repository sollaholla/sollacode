/**
 * Context-recovery reminders.
 *
 * Two events drop a model into a thread it cannot fully see: an auto-compaction
 * replaces earlier turns with a summary, and a provider handoff starts a fresh
 * runtime holding only a bounded digest. In both cases the *full* transcript is
 * still on disk, but a model that was never told so treats the summary as the
 * whole record — answering from the digest instead of reading what actually
 * happened.
 *
 * These strings are the reminder. Where the runtime exposes Solla's history
 * tool they name it explicitly, because a vague "you may have lost context"
 * prompts an apology rather than a lookup. Where it does not — Deep Code,
 * Antigravity, external bridges — they point at the workspace instead, so the
 * model verifies from files, git history, and tests rather than stalling on a
 * tool that is not on the wire.
 */

export const CONTEXT_RECOVERY_TOOL_NAME = "mcp__t3-code__thread_history_query";

export type ContextRecoveryReason = "compaction" | "provider-handoff";

/**
 * Whether the runtime being reminded can actually call the history tool.
 *
 * Only some adapters mount Solla's credential-bound MCP server (Codex, Claude,
 * Cursor, Grok, OpenCode). Deep Code, Antigravity, and external/custom bridges
 * spawn their own CLI and never receive it. Naming a tool that is not on the
 * wire reads as a broken or denied integration: the model stops working, tells
 * the user it is blocked, and asks them to paste history the digest already
 * carries. Defaults to available; pass false only for a runtime that really
 * lacks the tool. See `providerDriverHasSollaMcpTools`.
 */
export interface ContextRecoveryOptions {
  readonly threadHistoryToolAvailable?: boolean;
}

const REASON_PREAMBLE: Record<ContextRecoveryReason, string> = {
  compaction:
    "This thread was just compacted, so earlier turns are no longer in your context window verbatim.",
  "provider-handoff":
    "You were just handed this thread from another provider. The digest above is a bounded excerpt of the newest messages, not the full record, and you hold no other context for this thread.",
};

/**
 * The closing line, which differs by how much the model can safely assume.
 *
 * After a compaction the model still has a summary of its own thread and most
 * turns need no lookup, so the reminder stays a standing capability. A handoff
 * is not that: the incoming model has *nothing* but the digest, the digest is
 * silent on everything the excerpt cut, and "Do not repeat completed work"
 * pushes it to treat that silence as completion. Reported 2026-09-02 -- models
 * "just trust the handoff completely rather than verifying a decent range of
 * messages prior to the handoff", losing outstanding requests and scheduled
 * work. So the handoff line is an instruction, not an offer, and it says which
 * way to resolve doubt: an earlier ask is still owed until the record shows it
 * delivered. Handoffs are rare, so the tool call it costs is cheap.
 */
const REASON_CLOSING: Record<ContextRecoveryReason, string> = {
  compaction:
    "Prefer querying it over guessing, asking the user to repeat themselves, or assuming work was never done.",
  "provider-handoff":
    "Read that history before you treat any task as finished or any instruction as satisfied: the digest cannot tell you what was left undone, and the messages it omitted are where that usually lives. Verify the current state yourself rather than trusting the summary, and treat anything the user asked for earlier as still owed unless the record shows it delivered.",
};

/**
 * The handoff closing line for a runtime that has no history tool.
 *
 * The tool-directed closing above cannot be followed there, and asking for a
 * tool that is not on the wire is what made Deep Code answer a handoff with
 * "I am blocked" and a request that the user re-supply context the digest
 * already held (reported 2026-09-10). Point at the record it *can* inspect
 * instead, and say plainly not to stall while that inspection is still
 * possible.
 */
const HANDOFF_CLOSING_WITHOUT_TOOL =
  "Do not ask the user to paste, repeat, or summarize earlier context, and do not report yourself blocked while the workspace can still be inspected. The digest cannot tell you what was left undone, so verify the current state yourself from the files, git history, and tests. Treat anything the user asked for earlier as still owed unless that evidence shows it delivered; if one concrete decision is genuinely undeterminable, ask exactly that question instead of stopping.";

const HISTORY_TOOL_LINE = `The complete thread history is still stored and searchable — call the \`${CONTEXT_RECOVERY_TOOL_NAME}\` tool to read any earlier message, tool call, or decision verbatim.`;

const WORKSPACE_ONLY_HISTORY_LINE =
  "The complete thread history is still stored on the environment host, but this runtime does not expose a tool to read it. The workspace is the record you can inspect, so read the files the digest names, check git log/status/diff, and run the focused tests.";

const STALE_FAILURE_LINE_WITH_TOOL =
  "Earlier reports of missing tools, rejected credentials, or unavailable integrations describe that earlier session. Check the tools exposed in this session and make a fresh read-only call before treating an old failure as a current blocker. If the call fails, report the current error; do not assume access either way from the digest.";

const STALE_FAILURE_LINE_WITHOUT_TOOL =
  "Earlier reports of missing tools, rejected credentials, or unavailable integrations describe that earlier session. Check the tools exposed in this session and actually attempt the read-only work before calling anything blocked; if a call fails, report that concrete error instead of assuming the capability is absent.";

/**
 * The reminder text for a given loss-of-context event.
 *
 * Compaction phrases it as a standing capability rather than an instruction to
 * search now: most turns after a compaction do not need history, and a hard
 * "look this up first" would burn a tool call on every one of them. A handoff
 * gets the directive form instead — see REASON_CLOSING — and swaps in the
 * workspace-directed lines when the incoming runtime has no history tool.
 */
export function contextRecoveryReminder(
  reason: ContextRecoveryReason,
  options: ContextRecoveryOptions = {},
): string {
  const toolAvailable = options.threadHistoryToolAvailable !== false;
  const closing =
    reason === "provider-handoff" && !toolAvailable
      ? HANDOFF_CLOSING_WITHOUT_TOOL
      : REASON_CLOSING[reason];
  return [
    REASON_PREAMBLE[reason],
    toolAvailable ? HISTORY_TOOL_LINE : WORKSPACE_ONLY_HISTORY_LINE,
    toolAvailable ? STALE_FAILURE_LINE_WITH_TOOL : STALE_FAILURE_LINE_WITHOUT_TOOL,
    closing,
  ].join(" ");
}

/**
 * Wraps the reminder so it reads as an out-of-band note rather than something
 * the user typed. Mirrors the `<system-reminder>` convention the runtime
 * already uses for injected context.
 */
export function contextRecoveryReminderBlock(
  reason: ContextRecoveryReason,
  options: ContextRecoveryOptions = {},
): string {
  return `<system-reminder>\n${contextRecoveryReminder(reason, options)}\n</system-reminder>`;
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

/**
 * Prepended to the recovery prompt when the previous session was abandoned
 * for a *named* reason (context overflow, an oversized tool result). Without
 * it the fresh session sees only the digest, repeats the same step, overflows
 * again, and the thread loops through reset after reset -- an image read that
 * exceeded the window did exactly that five times in a row on 2026-09-17.
 */
export function historyResetReminderBlock(reason: string): string {
  const trimmed = reason.trim().replace(/\s+/g, " ");
  const sentence = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  return `<system-reminder>\nThis session was restarted with a summary because the provider rejected the previous session's context: ${sentence} Do not repeat the step that caused it. Read large files in slices (head, grep, jq, offsets), downscale or crop images before viewing them, and keep every single tool result well under the model's context window; one result that exceeds it ends the session again.\n</system-reminder>`;
}
