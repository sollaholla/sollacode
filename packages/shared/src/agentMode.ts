/** Shared Agent-mode protocol used by both the server owner and clients. */

export const AGENT_STOP_TOKEN = "AGENT_STOP";

const AGENT_STOP_TRAILING_WRAPPER_PATTERN = /[\s.!?,;:…*_`~'"“”‘’)\]}>]*/u;
const AGENT_STOP_LINE_PREFIX_PATTERN = /^[\t *_`~'"“”‘’([{<]*$/u;
const AGENT_STOP_PREFIX_WRAPPER_PATTERN = /[\t *_`~'"“”‘’([{<]*$/u;
const AGENT_STOP_INLINE_PREFIX_PATTERN = /[.!?…—–]$/u;
const AGENT_STOP_STREAM_CONTEXT_CHARS = 96;

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
  `and end your message with \`${AGENT_STOP_TOKEN}\` on a new line by itself. Otherwise continue, and do not stop to ask ` +
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

export interface AgentStopStreamState {
  readonly tail: string;
  readonly stopped: boolean;
}

export interface AgentStopStreamResult {
  readonly delta: string;
  readonly emittedStop: boolean;
  readonly state: AgentStopStreamState;
}

export const INITIAL_AGENT_STOP_STREAM_STATE: AgentStopStreamState = {
  tail: "",
  stopped: false,
};

/**
 * A control token must look like a signoff, not like a protocol name inside
 * ordinary progress prose. A standalone line is unambiguous. For older
 * providers that append the token to their closing sentence, accept it only
 * after sentence-ending punctuation. In particular, a path-like mention such
 * as `queued follow-ups/AGENT_STOP` is not a stop command.
 */
function hasAgentStopControlPrefix(text: string, tokenIndex: number): boolean {
  const previousCharacter = text[tokenIndex - 1];
  if (previousCharacter !== undefined && /[A-Za-z0-9_]/u.test(previousCharacter)) {
    return false;
  }

  const lineStart =
    Math.max(text.lastIndexOf("\n", tokenIndex - 1), text.lastIndexOf("\r", tokenIndex - 1)) + 1;
  const linePrefix = text.slice(lineStart, tokenIndex);
  return (
    AGENT_STOP_LINE_PREFIX_PATTERN.test(linePrefix) ||
    AGENT_STOP_INLINE_PREFIX_PATTERN.test(linePrefix.replace(AGENT_STOP_PREFIX_WRAPPER_PATTERN, ""))
  );
}

/**
 * Finds the Agent control token while assistant text is still streaming.
 *
 * Providers may split the token across deltas or immediately concatenate more
 * prose (`AGENT_STOPI'll ...`). Once the token is complete, it owns the stream
 * boundary: retain the token itself, discard anything after it, and suppress
 * later deltas while the provider interruption settles.
 */
export function consumeAgentStopStreamDelta(
  state: AgentStopStreamState,
  delta: string,
): AgentStopStreamResult {
  if (state.stopped || delta.length === 0) {
    return {
      delta: state.stopped ? "" : delta,
      emittedStop: false,
      state,
    };
  }

  const combined = `${state.tail}${delta}`;
  let searchFrom = 0;
  while (searchFrom < combined.length) {
    const tokenIndex = combined.indexOf(AGENT_STOP_TOKEN, searchFrom);
    if (tokenIndex < 0) break;
    if (hasAgentStopControlPrefix(combined, tokenIndex)) {
      const deltaStop = Math.max(
        0,
        Math.min(delta.length, tokenIndex + AGENT_STOP_TOKEN.length - state.tail.length),
      );
      return {
        delta: delta.slice(0, deltaStop),
        emittedStop: true,
        state: { tail: "", stopped: true },
      };
    }
    searchFrom = tokenIndex + AGENT_STOP_TOKEN.length;
  }

  return {
    delta,
    emittedStop: false,
    state: {
      tail: combined.slice(-AGENT_STOP_STREAM_CONTEXT_CHARS),
      stopped: false,
    },
  };
}

/**
 * Keeps a terminal Agent control token separate when a provider later resumes
 * the same assistant segment after a tool call. Some providers stream the
 * token, run more tools, then begin the next prose chunk without a leading
 * newline. A raw string append turns that into `AGENT_STOPNext`, which is
 * neither readable nor recognizable as the control token the model emitted.
 */
export function appendAgentStreamText(existingText: string, delta: string): string {
  const metadataMatch = AGENT_TRAILING_HIDDEN_METADATA_PATTERN.exec(existingText);
  const visibleText = metadataMatch
    ? existingText.slice(0, metadataMatch.index).trimEnd()
    : existingText.trimEnd();
  if (
    existingText.length === 0 ||
    delta.length === 0 ||
    /^[\r\n]/u.test(delta) ||
    !extractTerminalStopSignoff(visibleText, existingText, (body) => body).hasStop
  ) {
    return `${existingText}${delta}`;
  }
  return `${existingText}\n\n${delta}`;
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
  const withMetadata = (body: string): string =>
    metadata.length > 0 ? `${body}${body.length > 0 ? "\n" : ""}${metadata.trimStart()}` : body;

  const terminal = extractTerminalStopSignoff(visibleText, text, withMetadata);
  if (terminal.hasStop) return terminal;
  return extractStandaloneStopLine(visibleText, text, withMetadata);
}

function extractTerminalStopSignoff(
  visibleText: string,
  text: string,
  withMetadata: (body: string) => string,
): AgentStopSignoff {
  const tokenIndex = visibleText.lastIndexOf(AGENT_STOP_TOKEN);
  if (tokenIndex < 0) return { hasStop: false, text };

  if (!hasAgentStopControlPrefix(visibleText, tokenIndex)) {
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
  return { hasStop: true, text: withMetadata(visibleText.slice(0, signoffStart).trimEnd()) };
}

/** A stop token alone on its own line, optionally wrapped in Markdown or quotes. */
const AGENT_STOP_STANDALONE_LINE_PATTERN = new RegExp(
  `^[*_\`~'"“”‘’([{<]*${AGENT_STOP_TOKEN}[\\s.!?,;:…*_\`~'"“”‘’)\\]}>]*$`,
  "u",
);

/**
 * A stop token on a line of its own, with something still following it.
 *
 * The terminal rule only fires when nothing at all comes after the token,
 * which is exactly what one stray trailing line breaks. Observed live on
 * 2026-08-16: the provider's page footer ("ChatGPT is AI and can make
 * mistakes.") was read as the reply's last line, so a signoff the agent really
 * had emitted lost its badge and rendered to the user as the raw word
 * AGENT_STOP. The Agent loop had already stopped on it — only the display
 * disagreed.
 *
 * A token occupying a line by itself is never prose: a reply that *discusses*
 * the protocol keeps it inside a sentence, and that case still falls through
 * untouched. Scoped to the same trailing window the loop uses, so display and
 * behaviour cannot disagree about whether the agent stopped.
 */
function extractStandaloneStopLine(
  visibleText: string,
  text: string,
  withMetadata: (body: string) => string,
): AgentStopSignoff {
  const windowStart = Math.max(0, visibleText.length - AGENT_STOP_LENIENT_WINDOW_CHARS);
  const lines = visibleText.split("\n");
  const starts: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    starts.push(cursor);
    cursor += line.length + 1;
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if ((starts[index] ?? 0) < windowStart) break;
    if (!AGENT_STOP_STANDALONE_LINE_PATTERN.test((lines[index] ?? "").trim())) continue;
    const body = [...lines.slice(0, index), ...lines.slice(index + 1)]
      .join("\n")
      .replace(/\n{3,}/gu, "\n\n")
      .trim();
    return { hasStop: true, text: withMetadata(body) };
  }
  return { hasStop: false, text };
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
  let searchFrom = 0;
  while (searchFrom < windowText.length) {
    const tokenIndex = windowText.indexOf(AGENT_STOP_TOKEN, searchFrom);
    if (tokenIndex < 0) return false;
    if (hasAgentStopControlPrefix(windowText, tokenIndex)) return true;
    searchFrom = tokenIndex + AGENT_STOP_TOKEN.length;
  }
  return false;
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

/**
 * A provider refusing to start any further turn until a human intervenes.
 *
 * Distinct from a transient upstream wobble: the provider is not failing at
 * random, it has tripped its own circuit breaker and is stating that retrying
 * cannot work. Feeding that into the ordinary failure-retry path re-attempts
 * it every 15 seconds, so the thread emits "Provider turn start failed" on a
 * loop while showing "Auto-resuming thread…", and the user has nothing to
 * cancel because each attempt is a fresh one. Reported 2026-08-15 against the
 * LANChat bridge ("this session has failed 5 turns in a row; refusing to start
 * another until the cause is fixed").
 *
 * Retirement is the honest response: the resume stops, the error stays on
 * screen, and the next real user message starts a turn normally.
 */
const PROVIDER_TERMINAL_REFUSAL_SIGNATURES = [
  /\brefus(?:es|ing|ed) to start\b/i,
  /\buntil the cause is fixed\b/i,
  /\bfailed \d+ turns? in a row\b/i,
  /\bis disabled by the operator\b/i,
  /\bisn't installed\b/i,
  /\bis not installed\b/i,
  /\bnative binary not found\b/i,
];

/** Cap for the same reason as the authentication check: prose is not a status. */
const PROVIDER_TERMINAL_REFUSAL_MAX_CHARS = 400;

export function isTerminalProviderRefusal(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > PROVIDER_TERMINAL_REFUSAL_MAX_CHARS) return false;
  return PROVIDER_TERMINAL_REFUSAL_SIGNATURES.some((pattern) => pattern.test(trimmed));
}

/**
 * The live provider process has tripped and will keep refusing until it is
 * replaced. Reusing that process on the next send is how a dismissed banner
 * comes straight back.
 */
export function sessionNeedsProviderReset(
  session:
    | {
        readonly status: string;
        readonly lastError: string | null;
      }
    | null
    | undefined,
): boolean {
  if (!session) return false;
  return session.status === "error" || isTerminalProviderRefusal(session.lastError ?? "");
}
