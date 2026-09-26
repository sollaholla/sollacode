import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  ProviderDriverError,
} from "./Errors.ts";

const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderAdapterProcessError = Schema.is(ProviderAdapterProcessError);
const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
const isProviderDriverError = Schema.is(ProviderDriverError);

export const CLAUDE_CODE_NOT_INSTALLED_MESSAGE =
  "Claude Code isn't installed. Install Claude Code, or set its path in Settings → Providers.";
export const GROK_CLI_NOT_INSTALLED_MESSAGE =
  "Grok isn't installed. Install the Grok CLI, or set its path in Settings → Providers.";
export const CODEX_CLI_NOT_INSTALLED_MESSAGE =
  "Codex isn't installed. Install the Codex CLI, or set its path in Settings → Providers.";
export const CURSOR_CLI_NOT_INSTALLED_MESSAGE =
  "Cursor isn't installed. Install the Cursor CLI, or set its path in Settings → Providers.";
export const PROVIDER_DISCONNECTED_MESSAGE = "The provider disconnected. Send again to reconnect.";

const STACK_FRAME_LINE = /^\s*at\s+/u;
const EFFECT_FIBER_LINE = /^\s*(?:at catch|at ~effect|at failWithCatch)\b/u;
const TAGGED_ERROR_PREFIX =
  /^(?:ProviderAdapter(?:Process|Request|Validation)Error|Provider(?:Driver|Validation|Unsupported)Error):\s*/u;
const THREAD_PROCESS_ERROR_PREFIX =
  /^Provider adapter process error \([^)]+\) for thread [^:]+:\s*/u;
const REQUEST_ERROR_PREFIX = /^Provider adapter request failed \([^)]+\) for [^:]+:\s*/u;

function collectFailureTexts(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (typeof current === "string") {
      if (current.trim().length > 0) parts.push(current);
      break;
    }
    if (current instanceof Error) {
      if (typeof current.message === "string" && current.message.trim().length > 0) {
        parts.push(current.message);
      }
      current = current.cause;
      continue;
    }
    if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      if (typeof record.detail === "string" && record.detail.trim().length > 0) {
        parts.push(record.detail);
      } else if (typeof record.issue === "string" && record.issue.trim().length > 0) {
        parts.push(record.issue);
      } else if (typeof record.message === "string" && record.message.trim().length > 0) {
        parts.push(record.message);
      }
      current = record.cause;
      continue;
    }
    break;
  }
  return parts.join("\n");
}

function describeMissingCli(text: string): string | null {
  const spawn = text.match(/\bspawn\s+(\S+)\s+ENOENT\b/iu);
  if (spawn?.[1]) {
    const command = spawn[1].replace(/^['"]|['"]$/gu, "");
    const basename = command.split(/[/\\]/u).pop() ?? command;
    if (/claude/iu.test(basename)) return CLAUDE_CODE_NOT_INSTALLED_MESSAGE;
    if (/grok/iu.test(basename)) return GROK_CLI_NOT_INSTALLED_MESSAGE;
    if (/codex/iu.test(basename)) return CODEX_CLI_NOT_INSTALLED_MESSAGE;
    if (/cursor/iu.test(basename)) return CURSOR_CLI_NOT_INSTALLED_MESSAGE;
    return `Couldn't start ${basename}. Install it, or set its path in Settings → Providers.`;
  }
  if (
    /claude/iu.test(text) &&
    (/native binary not found/iu.test(text) ||
      /not found at /iu.test(text) ||
      /\bENOENT\b/u.test(text) ||
      /isn't installed/iu.test(text) ||
      /is not installed/iu.test(text))
  ) {
    return CLAUDE_CODE_NOT_INSTALLED_MESSAGE;
  }
  if (/native binary not found/iu.test(text)) {
    return CLAUDE_CODE_NOT_INSTALLED_MESSAGE;
  }
  if (/grok/iu.test(text) && (/\bENOENT\b/u.test(text) || /command not found/iu.test(text))) {
    return GROK_CLI_NOT_INSTALLED_MESSAGE;
  }
  return null;
}

function describeDisconnect(text: string): string | null {
  if (
    /\bEPIPE\b/u.test(text) ||
    /\bECONNRESET\b/u.test(text) ||
    /socket hang up/iu.test(text) ||
    /channel closed/iu.test(text) ||
    /closed pipe/iu.test(text) ||
    /write after end/iu.test(text) ||
    /not connected/iu.test(text)
  ) {
    return PROVIDER_DISCONNECTED_MESSAGE;
  }
  return null;
}

export function mapKnownProviderFailure(text: string): string | null {
  return describeMissingCli(text) ?? describeDisconnect(text);
}

export function sanitizeProviderFailureText(text: string): string {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (STACK_FRAME_LINE.test(line) || EFFECT_FIBER_LINE.test(line)) {
      break;
    }
    if (line.trim().startsWith("[cause]")) {
      break;
    }
    lines.push(line);
  }
  let cleaned = lines.join("\n").trim();
  if (cleaned.length === 0) {
    cleaned = text.trim();
  }
  cleaned = cleaned
    .replace(TAGGED_ERROR_PREFIX, "")
    .replace(THREAD_PROCESS_ERROR_PREFIX, "")
    .replace(REQUEST_ERROR_PREFIX, "")
    .trim();
  const mapped = mapKnownProviderFailure(cleaned) ?? mapKnownProviderFailure(text);
  if (mapped) return mapped;
  return cleaned;
}

function describeProviderFailure(error: unknown): string | null {
  if (Cause.isTimeoutError(error)) {
    return typeof error.message === "string" && error.message.trim().length > 0
      ? sanitizeProviderFailureText(error.message)
      : "The provider operation timed out.";
  }
  const combined = collectFailureTexts(error);
  const mapped = mapKnownProviderFailure(combined);
  if (mapped) return mapped;
  if (isProviderAdapterProcessError(error)) {
    return sanitizeProviderFailureText(error.detail);
  }
  if (isProviderAdapterRequestError(error)) {
    return sanitizeProviderFailureText(error.detail);
  }
  if (isProviderAdapterValidationError(error)) {
    return sanitizeProviderFailureText(error.issue);
  }
  if (isProviderDriverError(error)) {
    return sanitizeProviderFailureText(error.detail);
  }
  if (combined.length > 0) {
    return sanitizeProviderFailureText(combined);
  }
  return null;
}

export function formatProviderFailureDetail(cause: Cause.Cause<unknown>): string {
  const failReason = cause.reasons.find(Cause.isFailReason);
  if (failReason && Cause.isFailReason(failReason)) {
    const mapped = describeProviderFailure(failReason.error);
    if (mapped) return mapped;
  }
  for (const error of Cause.prettyErrors(cause)) {
    const mapped = describeProviderFailure(error);
    if (mapped) return mapped;
  }
  return sanitizeProviderFailureText(Cause.pretty(cause));
}

/** Any `SomeError:` lead-in, which names our plumbing rather than the problem. */
const ERROR_CLASS_PREFIX = /^[A-Z][A-Za-z0-9_]*(?:Error|Exception):\s*/u;
/** Longest raw provider sentence worth showing before it stops being readable. */
const MAX_CAUSE_CHARS = 180;

function humanDuration(milliseconds: number): string {
  if (milliseconds >= 60_000) {
    const minutes = Math.round(milliseconds / 60_000);
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

function clampSentence(text: string): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= MAX_CAUSE_CHARS) return collapsed;
  const cut = collapsed.slice(0, MAX_CAUSE_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * One plain sentence for a raw provider failure. Providers hand us their own
 * wording, which ranges from readable to a bundler stack trace, and it used to
 * reach the thread banner verbatim: "model stream idle timeout after 180000ms"
 * and, in one 2026-09-18 case, eleven frames of `/$bunfs/root/chunk-…`. Strip
 * the plumbing, translate the units, and keep it to a sentence.
 */
export function humanizeProviderFailureDetail(detail: string): string {
  const sanitized = sanitizeProviderFailureText(detail).replace(ERROR_CLASS_PREFIX, "").trim();

  const idle = sanitized.match(/stream idle timeout after (\d+)\s*ms/iu);
  if (idle?.[1]) {
    return `The model stopped sending output for ${humanDuration(Number(idle[1]))}.`;
  }
  const missingModel = sanitized.match(/model not found:\s*([^\s.,]+)/iu);
  if (missingModel?.[1]) {
    return `The provider no longer offers the model ${missingModel[1]}.`;
  }
  const timedOut = sanitized.match(/\btimed? ?out after (\d+)\s*ms/iu);
  if (timedOut?.[1]) {
    return `The provider stopped responding after ${humanDuration(Number(timedOut[1]))}.`;
  }

  if (sanitized.length === 0) return "The provider failed without saying why.";
  const clamped = clampSentence(sanitized);
  const capitalized = clamped.charAt(0).toUpperCase() + clamped.slice(1);
  return /[.!?…]$/u.test(capitalized) ? capitalized : `${capitalized}.`;
}

/** Internal marker the reactor uses for a spent retry budget. */
const GAVE_UP_PREFIX = /^Gave up after (\d+) failed attempts?:\s*/u;

/**
 * The thread banner for a paused auto-resume. The old one pasted the internal
 * give-up string straight between two sentences, so users read "Gave up after
 * 8 failed attempts: model stream idle timeout after 180000ms Use Resume to
 * try again" — our retry accounting first, the actual cause in provider
 * jargon second, and no full stop before the instruction. Lead with what
 * happened, keep the retry count as an aside, and end with the one action.
 */
export function formatAutomaticResumptionPausedMessage(reason: string): string {
  const match = reason.match(GAVE_UP_PREFIX);
  const cause = humanizeProviderFailureDetail(match ? reason.slice(match[0].length) : reason);
  const attempts = match?.[1];
  const tries =
    attempts === undefined
      ? ""
      : ` Solla retried ${attempts} ${attempts === "1" ? "time" : "times"}, then paused.`;
  return `${cause}${tries} Use Resume to try again, or switch provider.`;
}
