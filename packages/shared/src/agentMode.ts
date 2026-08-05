/** Shared Agent-mode protocol used by both the server owner and clients. */

export const AGENT_STOP_TOKEN = "AGENT_STOP";

const AGENT_STOP_TRAILING_WRAPPER_PATTERN = /[\s.!?,;:…*_`~'"“”‘’)\]}>]*/u;

const AGENT_TRAILING_HIDDEN_METADATA_PATTERN =
  /\s*<oai-mem-citation\b[^>]*>[\s\S]*?<\/oai-mem-citation>\s*$/u;

export const AGENT_CONTINUE_PROMPT =
  "The user wants you to continue working autonomously without returning control to them. " +
  `\`${AGENT_STOP_TOKEN}\` is a strict completion signal, not a pause button. Before using it, ` +
  "re-read the user's full request and your plan or checklist, then verify that every requested " +
  "deliverable and acceptance criterion is actually complete. Do not use it because a sweep, " +
  "iteration, phase, or milestone ended; because further work has diminishing returns; because " +
  "you want feedback; or because context, time, or token budget is inconvenient. If any requested " +
  "work, known defect, failed check, unverified claim, or planned step remains, keep working on the " +
  "next concrete action. Only when all requested work is fully finished and verified, or a concrete " +
  "blocker truly requires user input after you have exhausted safe alternatives, summarize the final state " +
  `and end your message with \`${AGENT_STOP_TOKEN}\`. Otherwise continue, and do not stop to ask ` +
  "questions you can resolve yourself. The app honors that stop signal immediately, so never emit it until " +
  "this completion check is genuinely satisfied.";

/** True only for the app-authored prompt that advances Agent mode. */
export function isAgentContinuePrompt(text: string): boolean {
  return text === AGENT_CONTINUE_PROMPT;
}

/** True when the assistant uses the terminal Agent-mode signoff. */
export function containsAgentStopToken(text: string): boolean {
  return extractAgentStopSignoff(text).hasStop;
}

export interface AgentStopSignoff {
  readonly hasStop: boolean;
  readonly text: string;
}

/**
 * Removes only a terminal Agent stop control token while preserving the rest
 * of the reply. Providers commonly wrap the token in Markdown, quotes, or
 * brackets, so those adjacent wrappers are treated as part of the signoff.
 */
export function extractAgentStopSignoff(text: string): AgentStopSignoff {
  const metadataMatch = AGENT_TRAILING_HIDDEN_METADATA_PATTERN.exec(text);
  const metadata = metadataMatch?.[0] ?? "";
  const visibleText = metadataMatch ? text.slice(0, metadataMatch.index).trimEnd() : text.trimEnd();
  const tokenIndex = visibleText.lastIndexOf(AGENT_STOP_TOKEN);
  if (tokenIndex < 0) return { hasStop: false, text };

  const previousCharacter = visibleText[tokenIndex - 1];
  if (previousCharacter !== undefined && /[A-Za-z0-9_]/u.test(previousCharacter)) {
    return { hasStop: false, text };
  }
  const trailing = visibleText.slice(tokenIndex + AGENT_STOP_TOKEN.length);
  if (
    trailing.replace(AGENT_STOP_TRAILING_WRAPPER_PATTERN, "").length > 0 ||
    !AGENT_STOP_TRAILING_WRAPPER_PATTERN.test(trailing)
  ) {
    return { hasStop: false, text };
  }

  let signoffStart = tokenIndex;
  while (signoffStart > 0 && /[*_`~'"“‘([{<]/u.test(visibleText[signoffStart - 1] ?? "")) {
    signoffStart -= 1;
  }
  const body = visibleText.slice(0, signoffStart).trimEnd();
  return {
    hasStop: true,
    text:
      metadata.length > 0 ? `${body}${body.length > 0 ? "\n" : ""}${metadata.trimStart()}` : body,
  };
}

/**
 * How far back from the end of a reply a bare stop token still reads as a
 * signoff rather than as prose that merely mentions the token.
 */
const AGENT_STOP_LENIENT_WINDOW_CHARS = 300;

/**
 * Deliberately lenient stop detector used only to gate Agent continuation.
 * The strict `extractAgentStopSignoff` still governs display stripping; here
 * a false positive merely ends the loop (the user can continue it), while a
 * false negative kept the agent running straight over an explicit stop —
 * models wrap the token, add a closing sentence after it, or append a footer,
 * and every one of those continued the loop.
 */
export function emittedAgentStop(text: string): boolean {
  if (containsAgentStopToken(text)) return true;
  const windowText = text.trimEnd().slice(-AGENT_STOP_LENIENT_WINDOW_CHARS);
  return new RegExp(`(^|[^A-Za-z0-9_])${AGENT_STOP_TOKEN}([^A-Za-z0-9_]|$)`, "u").test(windowText);
}

/** Strips the control token before assistant text is reused as prompt context. */
export function stripAgentStopToken(text: string): string {
  return text.replaceAll(new RegExp(`(^|[^A-Za-z0-9_])${AGENT_STOP_TOKEN}`, "gu"), "$1").trimEnd();
}

const PROVIDER_AUTHENTICATION_FAILURE_SIGNATURES = [
  /\bfailed to authenticate\b/i,
  /\bnot logged in\b/i,
  /\bplease run\s+\/login\b/i,
  /\b(log ?in|sign ?in|auth\w*|oauth|token|credential)\b[\s\S]{0,80}\bsession (has )?expired\b/i,
  /\bsession (has )?expired\b[\s\S]{0,80}\b(log ?in|sign ?in|auth\w*|oauth|token|credential)\b/i,
  // Deliberately NOT a bare "unauthorized": this heuristic also scans
  // assistant prose, and an agent discussing ADB devices, HTTP APIs, or
  // permissions says "unauthorized" constantly. A real credential failure
  // arrives as a status-shaped phrase.
  /\b(401|http)\s*unauthorized\b/i,
  // Anchored to the start: a terse provider error leads with the status word,
  // prose about unauthorized devices/requests does not.
  /^unauthorized\b[:.]?(\s|$)/i,
  /^(your )?session (has )?expired\b/i,
  /\bauthentication (failed|required)\b/i,
  /\binvalid api key\b/i,
];

/**
 * Real provider credential failures are short, status-shaped strings. Anything
 * longer is prose — an agent *talking about* authentication — and matching it
 * once stopped a healthy session mid-turn because its answer contained the
 * word "unauthorized" (an ADB device state).
 */
const PROVIDER_AUTHENTICATION_FAILURE_MAX_CHARS = 300;

const AGENT_LOOP_FATAL_SIGNATURES = [
  ...PROVIDER_AUTHENTICATION_FAILURE_SIGNATURES,
  /\bcredit balance is too low\b/i,
  /\busage credits? (?:are )?required for fast mode\b/i,
  /\bfast mode\b[^.]*\busage credits? exhausted\b/i,
  /\b(quota|rate limit) exceeded\b/i,
];

const AGENT_LOOP_TRANSIENT_SIGNATURES = [
  /\bapi error\b/i,
  /\bserver-side issue\b/i,
  /\binference gateway\b/i,
  /\b(bad gateway|service unavailable|gateway time-?out)\b/i,
  /\b(overloaded|temporarily unavailable)\b/i,
  /\b5\d{2}\b[^.]*\bterminated\b/i,
];

const AGENT_LOOP_BLOCKING_MAX_CHARS = 200;

export type AgentLoopReplyFailure = "transient" | "fatal";

/** True when provider output says its login or OAuth credentials are unusable. */
export function isProviderAuthenticationFailure(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= PROVIDER_AUTHENTICATION_FAILURE_MAX_CHARS &&
    PROVIDER_AUTHENTICATION_FAILURE_SIGNATURES.some((pattern) => pattern.test(trimmed))
  );
}

/** Classifies a short provider failure that arrived as assistant prose. */
export function classifyAgentLoopReplyFailure(text: string): AgentLoopReplyFailure | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > AGENT_LOOP_BLOCKING_MAX_CHARS) return null;
  if (AGENT_LOOP_FATAL_SIGNATURES.some((pattern) => pattern.test(trimmed))) return "fatal";
  if (AGENT_LOOP_TRANSIENT_SIGNATURES.some((pattern) => pattern.test(trimmed))) return "transient";
  return null;
}

/** Whether a cleanly completed assistant reply asks the Agent loop to continue. */
export function shouldAgentContinueAfterReply(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length > 0 &&
    classifyAgentLoopReplyFailure(trimmed) === null &&
    !emittedAgentStop(trimmed)
  );
}
