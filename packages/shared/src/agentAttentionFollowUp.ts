export function waitingOnYouFollowUpLeadIn(title: string): string {
  return `Follow-up on “${title.trim()}”: `;
}

export function mergeWaitingOnYouFollowUpDraft(existing: string, title: string): string {
  const leadIn = waitingOnYouFollowUpLeadIn(title);
  if (existing.includes(leadIn.trim())) return existing;
  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n\n";
  return `${existing}${separator}${leadIn}`;
}

/**
 * Quotes the waiting-on-you request above the user's reply.
 *
 * The agent raised the request and then saw a message arrive with no visible
 * connection to it — it could not tell that this was the answer, or that the
 * request had been dealt with. Leading with the quote makes the reply
 * self-explanatory even to a provider that only ever sees the message text.
 *
 * Deliberately a prefix: several context blocks are appended to outgoing
 * messages and have to stay trailing to parse.
 */
export function prependWaitingOnYouReply(text: string, title: string): string {
  const quoted = title.trim();
  if (quoted.length === 0) return text;
  const header = [
    `> **Replying to your request:** ${quoted}`,
    "> This message is the answer to it, and the request is now resolved.",
  ].join("\n");
  return text.length === 0 ? header : `${header}\n\n${text}`;
}
