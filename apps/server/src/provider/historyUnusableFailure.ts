/**
 * Failures that say the session's *history* can no longer be sent, not that
 * this attempt was unlucky.
 *
 * Retrying such a turn on the same session is pointless: the next request
 * carries the same history and fails the same way. Seen live on 2026-09-12:
 *
 * - Deep Code answered `HTTP 413: Failed to buffer the request body: length
 *   limit exceeded` after 15 tool calls -- the CLI ships the whole session
 *   transcript with every request, and it had outgrown the endpoint.
 * - Muse Code answered `provider-private history is incompatible with the
 *   active route: reasoning replay \`rs_…\`` on a resumed session whose
 *   earlier reasoning records were minted under a route the account no
 *   longer runs on. Every retry replayed the same records.
 *
 * The recovery is the one already built for a resume that cannot be
 * completed: start a fresh session with a bounded digest of the thread and
 * a reminder that the full record is still on disk.
 */
const HISTORY_UNUSABLE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bHTTP 413\b/i,
  /\b413\b.*\b(request body|payload|entity)\b.*\b(too large|length limit)/i,
  /\bfailed to buffer the request body\b/i,
  /\brequest body\b.*\btoo large\b/i,
  /\bpayload too large\b/i,
  /\bprovider-private history is incompatible with the active route\b/i,
  /\bcontext[_ ]length[_ ]exceeded\b/i,
  /\bmaximum context length\b/i,
  /\bprompt is too long\b/i,
  /\binput (?:length|tokens?) (?:and|plus) .*exceeds? the context window\b/i,
  /\bexceeds? the (?:model's )?context window\b/i,
  // Claude Code gives up when its own compaction cannot keep up: "Autocompact
  // is thrashing: the context refilled to the limit within 3 turns of the
  // previous compact, 3 times in a row." (2026-09-22, the same oversized
  // AGENTS.md on a 1M-token model).
  /\bautocompact is thrashing\b/i,
];

/** True when the message names a history the provider can no longer accept. */
export function isHistoryUnusableFailure(message: string | null | undefined): boolean {
  if (typeof message !== "string" || message.length === 0) return false;
  return HISTORY_UNUSABLE_PATTERNS.some((pattern) => pattern.test(message));
}
