export function waitingOnYouFollowUpLeadIn(title: string): string {
  return `Follow-up on “${title.trim()}”: `;
}

export function mergeWaitingOnYouFollowUpDraft(existing: string, title: string): string {
  const leadIn = waitingOnYouFollowUpLeadIn(title);
  if (existing.includes(leadIn.trim())) return existing;
  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n\n";
  return `${existing}${separator}${leadIn}`;
}
