import {
  EnvironmentId,
  type PreviewAutomationHost,
  PreviewHumanVerification,
  PreviewAutomationOperation,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  previewForeignAgentTabErrorMessage,
  PreviewTabId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export interface PreviewAutomationOperationContext {
  readonly requestId: PreviewAutomationRequest["requestId"];
  readonly operation: PreviewAutomationRequest["operation"];
  readonly environmentId: PreviewAutomationHost["environmentId"];
  readonly threadId: PreviewAutomationRequest["threadId"];
  readonly tabId: Exclude<PreviewAutomationRequest["tabId"], undefined> | null;
}

export class PreviewAutomationOverlayTimeoutError extends Schema.TaggedErrorClass<PreviewAutomationOverlayTimeoutError>()(
  "PreviewAutomationOverlayTimeoutError",
  {
    requestId: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    timeoutMs: Schema.Int,
  },
) {
  get responseTag() {
    return "PreviewAutomationTimeoutError" as const;
  }

  override get message(): string {
    return `Preview webview for request ${this.requestId} on environment ${this.environmentId} thread ${this.threadId} did not register within ${this.timeoutMs}ms.`;
  }
}

export class PreviewAutomationNavigationTimeoutError extends Schema.TaggedErrorClass<PreviewAutomationNavigationTimeoutError>()(
  "PreviewAutomationNavigationTimeoutError",
  {
    requestId: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: PreviewTabId,
    readiness: Schema.Literals(["domContentLoaded", "load"]),
    timeoutMs: Schema.Int,
  },
) {
  get responseTag() {
    return "PreviewAutomationTimeoutError" as const;
  }

  override get message(): string {
    return `Preview navigation for request ${this.requestId} on environment ${this.environmentId} thread ${this.threadId} tab ${this.tabId} did not reach ${this.readiness} readiness within ${this.timeoutMs}ms.`;
  }
}

export class PreviewAutomationNavigationLoadFailedHostError extends Schema.TaggedErrorClass<PreviewAutomationNavigationLoadFailedHostError>()(
  "PreviewAutomationNavigationLoadFailedHostError",
  {
    requestId: TrimmedNonEmptyString,
    operation: PreviewAutomationOperation,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: PreviewTabId,
    code: Schema.Number,
    description: Schema.String,
  },
) {
  get responseTag() {
    return "PreviewAutomationExecutionError" as const;
  }

  override get message(): string {
    const reason = this.description.trim() || `network error ${this.code}`;
    return `Preview navigation for ${this.operation} request ${this.requestId} failed in tab ${this.tabId}: ${reason} (${this.code}). Correct the URL or underlying network/site error before retrying.`;
  }
}

export class PreviewAutomationViewportTimeoutError extends Schema.TaggedErrorClass<PreviewAutomationViewportTimeoutError>()(
  "PreviewAutomationViewportTimeoutError",
  {
    requestId: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: PreviewTabId,
    timeoutMs: Schema.Int,
  },
) {
  get responseTag() {
    return "PreviewAutomationTimeoutError" as const;
  }

  override get message(): string {
    return `Preview viewport for request ${this.requestId} on environment ${this.environmentId} thread ${this.threadId} tab ${this.tabId} was not rendered within ${this.timeoutMs}ms.`;
  }
}

export class PreviewAutomationTargetUnavailableError extends Schema.TaggedErrorClass<PreviewAutomationTargetUnavailableError>()(
  "PreviewAutomationTargetUnavailableError",
  {
    requestId: TrimmedNonEmptyString,
    operation: PreviewAutomationOperation,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
    bridgeAvailable: Schema.Boolean,
  },
) {
  get responseTag() {
    return "PreviewAutomationTabNotFoundError" as const;
  }

  override get message(): string {
    return `Preview automation target for ${this.operation} request ${this.requestId} is unavailable on environment ${this.environmentId} thread ${this.threadId} (tab ${this.tabId ?? "unassigned"}, bridge ${this.bridgeAvailable ? "available" : "unavailable"}).`;
  }
}

export class PreviewAutomationForeignAgentTabHostError extends Schema.TaggedErrorClass<PreviewAutomationForeignAgentTabHostError>()(
  "PreviewAutomationForeignAgentTabHostError",
  {
    requestId: TrimmedNonEmptyString,
    operation: PreviewAutomationOperation,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: PreviewTabId,
  },
) {
  get responseTag() {
    return "PreviewAutomationForeignAgentTabError" as const;
  }

  override get message(): string {
    return previewForeignAgentTabErrorMessage(this.tabId, this.operation);
  }
}

export class PreviewAutomationRecordingNotActiveError extends Schema.TaggedErrorClass<PreviewAutomationRecordingNotActiveError>()(
  "PreviewAutomationRecordingNotActiveError",
  {
    requestId: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
  },
) {
  get responseTag() {
    return "PreviewAutomationExecutionError" as const;
  }

  override get message(): string {
    return `Preview automation request ${this.requestId} found no active recording for tab ${this.tabId ?? "unassigned"} on environment ${this.environmentId} thread ${this.threadId}.`;
  }
}

export class PreviewAutomationHumanVerificationHostError extends Schema.TaggedErrorClass<PreviewAutomationHumanVerificationHostError>()(
  "PreviewAutomationHumanVerificationHostError",
  {
    requestId: TrimmedNonEmptyString,
    operation: PreviewAutomationOperation,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: PreviewTabId,
    verification: PreviewHumanVerification,
  },
) {
  get responseTag() {
    return "PreviewAutomationHumanVerificationRequiredError" as const;
  }

  override get message(): string {
    return `Human verification is required in preview tab ${this.tabId}. Automation is paused; keep this tab staged for the user and do not retry the challenge.`;
  }
}

export class PreviewAutomationTargetNotEditableHostError extends Schema.TaggedErrorClass<PreviewAutomationTargetNotEditableHostError>()(
  "PreviewAutomationTargetNotEditableHostError",
  {
    requestId: TrimmedNonEmptyString,
    operation: PreviewAutomationOperation,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
    selectorKind: Schema.optional(Schema.Literals(["focused-element", "locator", "selector"])),
    selectorLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  },
) {
  get responseTag() {
    return "PreviewAutomationTargetNotEditableError" as const;
  }

  override get message(): string {
    return `Preview automation ${this.operation} request ${this.requestId} requires an editable target in tab ${this.tabId ?? "unassigned"}.`;
  }
}

const targetNotEditableDiagnostics = (
  cause: unknown,
): {
  readonly selectorKind?: "focused-element" | "locator" | "selector";
  readonly selectorLength?: number;
} | null => {
  if (
    typeof cause !== "object" ||
    cause === null ||
    !("_tag" in cause) ||
    cause._tag !== "PreviewAutomationTargetNotEditableError"
  ) {
    return null;
  }
  const selectorKind =
    "selectorKind" in cause &&
    (cause.selectorKind === "focused-element" ||
      cause.selectorKind === "locator" ||
      cause.selectorKind === "selector")
      ? cause.selectorKind
      : undefined;
  const selectorLength =
    "selectorLength" in cause &&
    typeof cause.selectorLength === "number" &&
    Number.isInteger(cause.selectorLength) &&
    cause.selectorLength >= 0
      ? cause.selectorLength
      : undefined;
  return {
    ...(selectorKind === undefined ? {} : { selectorKind }),
    ...(selectorLength === undefined ? {} : { selectorLength }),
  };
};

/**
 * The desktop's own reason code for a failed preview operation.
 *
 * Without this the whole cause chain reaching an agent is "request N failed on
 * environment E thread T" — true and useless. The desktop knows exactly which
 * step gave out (`automationType.textDidNotReachGuest`, say), and that string
 * is a fixed internal identifier rather than anything read off the page, so it
 * is safe to carry outward while the page's contents are not.
 */
const REASON_MAX_LENGTH = 400;

const boundedReasonText = (value: unknown, max = REASON_MAX_LENGTH): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (text.length === 0) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const causeText = (cause: unknown): string | undefined => {
  if (cause instanceof Error) return boundedReasonText(cause.message, 200);
  if (typeof cause === "string") return boundedReasonText(cause, 200);
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    return boundedReasonText((cause as { message?: unknown }).message, 200);
  }
  return undefined;
};

/**
 * Turn a desktop-side failure into one sentence the model can act on.
 *
 * Every branch is composed from the error's own structured fields (numbers,
 * tab ids, selector kinds and lengths, operation names), never from anything
 * the page produced: a page-thrown evaluation message is deliberately withheld
 * and the model is told how to read it as a value instead. Chromium and
 * Electron messages wrapped by `PreviewOperationError` are the desktop's own
 * words and are carried bounded.
 */
/**
 * What to do next, per desktop error tag. Appended to the desktop's own
 * sentence whether that sentence arrived with structured fields or, as it
 * does over Electron IPC, as text ("Error invoking remote method '…':
 * PreviewAutomationCoordinatesOutsideViewportError: Click coordinates …").
 */
const DESKTOP_FAILURE_GUIDANCE: Readonly<Record<string, string>> = {
  PreviewAutomationCoordinatesOutsideViewportError:
    "Only on-screen points can be clicked: scroll the target into view with preview_scroll (or window.scrollTo via preview_evaluate), re-read its position from a fresh preview_snapshot, or click it by locator instead of coordinates",
  PreviewAutomationTargetNotFoundError:
    "Take a fresh preview_snapshot and use a locator it lists; the page may have changed since the last snapshot",
  PreviewAutomationInvalidSelectorError:
    "Use a Playwright locator such as role=button[name='Send'] or text=Continue, or a plain CSS selector",
  PreviewAutomationTargetNotEditableError:
    "Focus or locate a textbox, textarea, or contenteditable and retry; for a <select> use preview_select_option",
  PreviewAutomationDevToolsOpenError: "Ask the user to close DevTools on that tab, then retry",
  PreviewAutomationDebuggerAttachedError:
    "Retry after a moment; if it persists, close and reopen the tab with preview_close and preview_open",
  PreviewTabNotFoundError:
    "Call preview_status for the current tab list, or preview_open to create one",
  PreviewWebContentsNotFoundError:
    "The tab is closing, crashed, or being replaced: call preview_status and retry on a listed tab",
  PreviewWebviewNotInitializedError: "Wait a second and retry",
  PreviewAutomationEvaluationError:
    "The page's own error text is withheld from this message: wrap the expression in try/catch and return the error message as a value to read it",
  PreviewAutomationResultTooLargeError: "Return a summary, a slice, or specific fields instead",
  PreviewAutomationTimeoutError: "Check the page with preview_snapshot before waiting again",
  PreviewAutomationControlInterruptedError: "The user is using the tab; retry after a moment",
  PreviewAutomationDeferredToUserInputError:
    "The user is typing or clicking right now, so the action was held and never reached the page; nothing on the page failed. Wait about ten seconds and retry the same action unchanged rather than changing approach",
};

const IPC_PREFIX = /^Error invoking remote method '[^']*':\s*/;
const TAG_PREFIX = /^(Preview[A-Za-z]*Error):\s*/;
// The desktop keys a tab by a JSON tuple; the model only knows its tab_ id.
const TAB_TUPLE = /tab \["[^\]]*"(tab_[0-9a-f-]+)"\]/g;

/** Reason from a desktop error that arrived as text, plus what to do next. */
const desktopMessageReason = (message: string): string | undefined => {
  let text = message
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .replace(IPC_PREFIX, "");
  const tagMatch = TAG_PREFIX.exec(text);
  const tag = tagMatch === null ? undefined : tagMatch[1];
  if (tagMatch !== null) text = text.slice(tagMatch[0].length);
  text = text.replace(TAB_TUPLE, "tab $1").trim();
  if (text.length === 0) return undefined;
  const guidance = tag === undefined ? undefined : DESKTOP_FAILURE_GUIDANCE[tag];
  const sentence = boundedReasonText(text, guidance === undefined ? REASON_MAX_LENGTH : 220);
  if (sentence === undefined) return undefined;
  const body = tag === undefined || guidance !== undefined ? sentence : `${tag}: ${sentence}`;
  return guidance === undefined ? body : `${body.replace(/[.\s]+$/, "")}. ${guidance}`;
};

/**
 * Whether a cause identifies itself as one of our preview failures.
 *
 * Curated causes carry a `Preview*Error` tag - as a `_tag` field, or as the
 * message prefix that survives the trip over Electron IPC - and everything we
 * say about them comes from the switch below rather than from their text.
 * Anything else is an arbitrary Error whose message is unknown content.
 */
export function isCuratedPreviewFailureCause(cause: unknown): boolean {
  const message =
    typeof cause === "string"
      ? cause
      : typeof cause === "object" && cause !== null
        ? (() => {
            const record = cause as Record<string, unknown>;
            if (typeof record._tag === "string" && TAG_PREFIX.test(`${record._tag}: x`)) return "";
            return typeof record.message === "string" ? record.message : null;
          })()
        : null;
  if (message === null) return false;
  if (message === "") return true;
  return TAG_PREFIX.test(message.replace(IPC_PREFIX, "").trim());
}

const desktopFailureReason = (cause: unknown): string | undefined => {
  if (typeof cause === "string") return desktopMessageReason(cause);
  if (typeof cause !== "object" || cause === null) return undefined;
  const record = cause as Record<string, unknown>;
  const num = (key: string): number | undefined =>
    typeof record[key] === "number" && Number.isFinite(record[key])
      ? (record[key] as number)
      : undefined;
  const str = (key: string, max = 128): string | undefined => boundedReasonText(record[key], max);
  const tag = typeof record._tag === "string" ? record._tag : undefined;
  if (tag === undefined) {
    // Over Electron IPC the desktop's tagged error arrives as a plain Error
    // whose message still starts with the tag; read it from there.
    const message = record.message;
    return typeof message === "string" ? desktopMessageReason(message) : undefined;
  }
  const tab = str("tabId");
  const target = (): string => {
    const kind = str("selectorKind");
    const length = num("selectorLength");
    if (kind === "focused-element") return "the focused element";
    return `the ${kind ?? "selector"} (${length ?? 0} characters)`;
  };
  switch (tag) {
    case "PreviewAutomationCoordinatesOutsideViewportError": {
      const x = num("x");
      const y = num("y");
      const width = num("viewportWidth");
      const height = num("viewportHeight");
      const where =
        x !== undefined && y !== undefined && width !== undefined && height !== undefined
          ? `coordinates (${x}, ${y}) are outside the ${width}x${height} viewport`
          : "the coordinates are outside the viewport";
      return `${where}. Only on-screen points can be clicked: scroll the target into view with preview_scroll (or window.scrollTo via preview_evaluate), re-read its position from a fresh preview_snapshot, or click it by locator instead of coordinates`;
    }
    case "PreviewAutomationTargetNotFoundError":
      return `no element matched ${target()}${tab ? ` in tab ${tab}` : ""}. Take a fresh preview_snapshot and use a locator it lists; the page may have changed since the last snapshot`;
    case "PreviewAutomationInvalidSelectorError":
      return `${target()} is not a valid selector. Use a Playwright locator such as role=button[name='Send'] or text=Continue, or a plain CSS selector`;
    case "PreviewAutomationTargetNotEditableError":
      return record.nativeMenu === true
        ? `${target()} is a <select> whose menu the browser draws outside the page. Use preview_select_option instead`
        : `${target()} is not editable. Focus or locate a textbox/textarea/contenteditable and retry`;
    case "PreviewAutomationDevToolsOpenError":
      return "preview DevTools are open on this tab; browser control cannot attach until they are closed. Ask the user to close DevTools, then retry";
    case "PreviewAutomationDebuggerAttachedError":
      return "another debugger owns this tab's WebContents, so browser control cannot attach. Retry after a moment; if it persists, close and reopen the tab with preview_close and preview_open";
    case "PreviewTabNotFoundError":
      return `tab ${tab ?? "(unknown)"} no longer exists. Call preview_status for the current tab list, or preview_open to create one`;
    case "PreviewWebContentsNotFoundError":
      return `tab ${tab ?? "(unknown)"} has no live web contents (it is closing, crashed, or being replaced). Call preview_status and retry on a listed tab`;
    case "PreviewWebviewNotInitializedError":
      return `tab ${tab ?? "(unknown)"} has not finished initializing its webview. Wait a second and retry`;
    case "PreviewAutomationEvaluationError": {
      const kind = str("detailKind");
      const length = num("detailLength");
      return `the page's JavaScript threw while evaluating the expression (${kind ?? "error"}${length === undefined ? "" : `, ${length} characters`}). The page's own error text is withheld from this message: wrap the expression in try/catch and return the error message as a value to read it`;
    }
    case "PreviewAutomationResultTooLargeError": {
      const actual = num("actualBytes");
      const maximum = num("maximumBytes");
      return `the evaluation result was ${actual ?? "too many"} bytes; the maximum is ${maximum ?? "smaller"}. Return a summary, a slice, or specific fields instead`;
    }
    case "PreviewAutomationTimeoutError": {
      const timeout = num("timeoutMs");
      return `the condition did not match within ${timeout ?? "the"} ms${tab ? ` in tab ${tab}` : ""}. Check the page with preview_snapshot before waiting again`;
    }
    case "PreviewAutomationControlInterruptedError":
      return `browser control was interrupted by human input${tab ? ` in tab ${tab}` : ""}. The user is using the tab; retry after a moment`;
    case "PreviewAutomationDeferredToUserInputError": {
      const waited = num("waitedMs");
      return `the action was held for ${waited === undefined ? "the whole request" : `${Math.round(waited / 1000)}s`} because the user is typing or clicking, and never reached the page${tab ? ` (tab ${tab})` : ""}. Nothing on the page failed. Wait about ten seconds and retry the same action unchanged rather than changing approach`;
    }
    case "PreviewOperationError": {
      const operation =
        typeof record.operation === "string" && record.operation.trim().length <= 128
          ? str("operation")
          : undefined;
      if (operation === undefined) return undefined;
      const detail = causeText(record.cause);
      return detail === undefined ? operation : `${operation}: ${detail}`;
    }
    default: {
      const detail = causeText(cause);
      if (detail === undefined) return undefined;
      const guidance = DESKTOP_FAILURE_GUIDANCE[tag];
      return guidance === undefined ? `${tag}: ${detail}` : `${detail}. ${guidance}`;
    }
  }
};

export class PreviewAutomationOperationError extends Schema.TaggedErrorClass<PreviewAutomationOperationError>()(
  "PreviewAutomationOperationError",
  {
    requestId: TrimmedNonEmptyString,
    operation: PreviewAutomationOperation,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
    reason: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  static fromCause(
    input: PreviewAutomationOperationContext & { readonly cause: unknown },
  ): PreviewAutomationHostError {
    if (isPreviewAutomationHostError(input.cause)) return input.cause;
    const reason = desktopFailureReason(input.cause);
    const diagnostics = targetNotEditableDiagnostics(input.cause);
    return diagnostics
      ? new PreviewAutomationTargetNotEditableHostError({
          requestId: input.requestId,
          operation: input.operation,
          environmentId: input.environmentId,
          threadId: input.threadId,
          tabId: input.tabId,
          ...diagnostics,
        })
      : new PreviewAutomationOperationError({
          ...input,
          ...(reason === undefined ? {} : { reason }),
        });
  }

  get responseTag() {
    return "PreviewAutomationExecutionError" as const;
  }

  override get message(): string {
    const reason = this.reason === undefined ? "" : ` [${this.reason}]`;
    return `Preview automation ${this.operation} request ${this.requestId} failed on environment ${this.environmentId} thread ${this.threadId} (tab ${this.tabId ?? "unassigned"})${reason}.`;
  }
}

export const PreviewAutomationHostError = Schema.Union([
  PreviewAutomationOverlayTimeoutError,
  PreviewAutomationNavigationTimeoutError,
  PreviewAutomationNavigationLoadFailedHostError,
  PreviewAutomationViewportTimeoutError,
  PreviewAutomationTargetUnavailableError,
  PreviewAutomationForeignAgentTabHostError,
  PreviewAutomationRecordingNotActiveError,
  PreviewAutomationHumanVerificationHostError,
  PreviewAutomationTargetNotEditableHostError,
  PreviewAutomationOperationError,
]);
export type PreviewAutomationHostError = typeof PreviewAutomationHostError.Type;

export const isPreviewAutomationHostError = Schema.is(PreviewAutomationHostError);

export function serializePreviewAutomationHostError(
  error: PreviewAutomationHostError,
): NonNullable<PreviewAutomationResponse["error"]> {
  const detail = Object.fromEntries(
    Object.entries(error).filter(
      ([key]) =>
        key !== "_tag" && key !== "cause" && key !== "name" && key !== "message" && key !== "stack",
    ),
  );
  return {
    _tag: error.responseTag,
    message: error.message,
    ...(Object.keys(detail).length === 0 ? {} : { detail }),
  };
}
