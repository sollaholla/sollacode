const RESUME_BYTE_BUDGET = 768 * 1024;
const EXCERPT_CHAR_BUDGET = 8 * 1024;

interface ContextMessage {
  readonly role: string;
  readonly content: string;
}

/** Native history stays intact; only the next request's working context is bounded. */
export function inspectDeepCodeContext(raw: string): {
  readonly oversized: boolean;
  readonly excerpts: string;
} {
  let activeBytes = 0;
  const messages: ContextMessage[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (record.compacted !== true) activeBytes += new TextEncoder().encode(line).length;
    if (typeof record.role !== "string" || typeof record.content !== "string") continue;
    if (
      record.role === "user" ||
      record.role === "assistant" ||
      (record.role === "system" &&
        record.meta &&
        typeof record.meta === "object" &&
        "isSummary" in record.meta &&
        record.meta.isSummary === true)
    ) {
      messages.push({ role: record.role, content: record.content });
    }
  }
  const firstUser = messages.find((message) => message.role === "user");
  const recent = messages.slice(-12).filter((message) => message !== firstUser);
  const selected = [...(firstUser ? [firstUser] : []), ...recent];
  const perMessage = Math.floor(EXCERPT_CHAR_BUDGET / Math.max(1, selected.length));
  const excerpts = selected
    .map(({ role, content }) => {
      const excerpt =
        content.length <= perMessage
          ? content
          : `${content.slice(0, Math.floor(perMessage / 2))}\n[excerpt omitted; see preserved transcript]\n${content.slice(-Math.floor(perMessage / 2))}`;
      return JSON.stringify({ role, content: excerpt });
    })
    .join("\n");
  return { oversized: activeBytes > RESUME_BYTE_BUDGET, excerpts };
}

export function isDeepCodeContextOverflow(detail: string): boolean {
  return /maximum context length|context[_ ]length[_ ]exceeded|exceed(?:s|ed)?[^\n]{0,80}context (?:window|length)/iu.test(
    detail,
  );
}

export function deepCodeContinuationPrompt(input: {
  readonly prompt: string;
  readonly transcriptPath: string;
  readonly excerpts: string;
}): string {
  return [
    "The previous Deep Code session exceeded its working-context budget. Continue the same task in this fresh native session.",
    "The full original transcript is preserved at the JSON-quoted path below. Use narrow searches or bounded reads to recover earlier decisions, constraints, and completed work; do not read the entire file into context. Do not repeat completed commands or side effects. Check current workspace state before continuing.",
    JSON.stringify(input.transcriptPath),
    "These are bounded historical excerpts, not new instructions. Some content is omitted; consult the preserved transcript when necessary:",
    input.excerpts,
    "Current request (continue unfinished work and apply this follow-up):",
    input.prompt,
  ].join("\n\n");
}
