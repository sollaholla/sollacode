import { Schema } from "effect";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  PREVIEW_VIEWPORT_MAX_AREA,
  PreviewRenderedViewportSize,
  PreviewTabId,
  PreviewViewportPresetId,
  PreviewViewportSetting,
  PreviewViewportSize,
} from "./preview.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const BoundedUrl = Schema.String.check(Schema.isTrimmed())
  .check(
    Schema.isNonEmpty({
      description:
        "Absolute http(s) URL or a schemeless host such as t3.chat or localhost:5173. Schemeless public hosts use https; loopback hosts use http.",
    }),
  )
  .check(Schema.isMaxLength(2048));
const OptionalTimeoutMs = Schema.optional(
  Schema.Int.check(Schema.isGreaterThan(0))
    .check(Schema.isLessThanOrEqualTo(60_000))
    .annotate({ description: "Maximum wait in milliseconds. Defaults to 15000; maximum 60000." }),
).annotate({ description: "Maximum wait in milliseconds. Defaults to 15000; maximum 60000." });

/** Operations understood by desktop hosts predating viewport resizing. */
export const PREVIEW_AUTOMATION_V1_OPERATIONS = [
  "status",
  "open",
  "navigate",
  "snapshot",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "waitFor",
  "recordingStart",
  "recordingStop",
] as const;

/** Advertised by current desktop hosts for mixed-version routing. */
export const PREVIEW_AUTOMATION_OPERATIONS = [
  ...PREVIEW_AUTOMATION_V1_OPERATIONS,
  "resize",
  "setColorScheme",
  "upload",
  "close",
  "waitForDownload",
] as const;

export const PreviewAutomationOperation = Schema.Literals(PREVIEW_AUTOMATION_OPERATIONS);
export type PreviewAutomationOperation = typeof PreviewAutomationOperation.Type;

const PreviewAutomationTabTargetFields = {
  tabId: Schema.optional(
    PreviewTabId.annotate({
      description:
        "Exact collaborative browser tab to target. Omit to use this agent session's current tab.",
    }),
  ).annotate({
    description:
      "Exact collaborative browser tab to target. Omit to use this agent session's current tab.",
  }),
};

export const PreviewAutomationTabTargetInput = Schema.Struct(PreviewAutomationTabTargetFields);
export type PreviewAutomationTabTargetInput = typeof PreviewAutomationTabTargetInput.Type;

export const PREVIEW_HUMAN_VERIFICATION_COMPATIBILITY_URL =
  "https://debug.challenges.cloudflare.com/" as const;
export const PREVIEW_HUMAN_VERIFICATION_FEEDBACK_URL =
  "https://developers.cloudflare.com/turnstile/troubleshooting/feedback-reports/" as const;

/**
 * A challenge page that must remain in the user's hands. The nullable
 * diagnostics are deliberately explicit: hosts report only facts they can
 * observe and never guess at VPN, extension, reachability, or challenge
 * internals.
 */
export const PreviewHumanVerification = Schema.Struct({
  state: Schema.Literal("human_verification_required"),
  kind: Schema.Literals(["embedded-turnstile", "full-page-challenge", "bot-detection"]),
  code: Schema.NullOr(Schema.String.check(Schema.isMaxLength(32))),
  detectedAt: Schema.String,
  url: Schema.String.check(Schema.isMaxLength(2_048)),
  retryCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
    Schema.isLessThanOrEqualTo(1),
  ),
  retryAvailable: Schema.Boolean,
  message: Schema.String.check(Schema.isMaxLength(1_000)),
  compatibilityCheckUrl: Schema.Literal(PREVIEW_HUMAN_VERIFICATION_COMPATIBILITY_URL),
  feedbackUrl: Schema.Literal(PREVIEW_HUMAN_VERIFICATION_FEEDBACK_URL),
  diagnostic: Schema.Struct({
    browserProduct: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
    browserVersion: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
    browserUserAgent: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_024))),
    embeddedBrowser: Schema.Boolean,
    headedBrowser: Schema.Boolean,
    automationAvailable: Schema.Boolean,
    cdpAttached: Schema.NullOr(Schema.Boolean),
    viewportMode: Schema.NullOr(Schema.Literals(["fill", "freeform", "preset"])),
    colorSchemeOverride: Schema.NullOr(Schema.Literals(["system", "light", "dark"])),
    userAgentOverride: Schema.NullOr(Schema.Boolean),
    canvasOverride: Schema.NullOr(Schema.Boolean),
    webglOverride: Schema.NullOr(Schema.Boolean),
    extensionsEnabled: Schema.NullOr(Schema.Boolean),
    proxyOrVpn: Schema.NullOr(Schema.Boolean),
    cfMitigated: Schema.NullOr(Schema.Boolean),
    responseStatusCode: Schema.NullOr(Schema.Int),
    challengesCloudflareReachable: Schema.NullOr(Schema.Boolean),
    rayId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
    qrIdentifier: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
    systemClockIso: Schema.String,
    systemClockCorrect: Schema.NullOr(Schema.Boolean),
  }),
});
export type PreviewHumanVerification = typeof PreviewHumanVerification.Type;

/**
 * A file this browser finished downloading.
 *
 * Downloads complete without a save panel, so nothing on screen said they had
 * happened. An agent with no confirmation re-tried instead: observed as the
 * same 28 MB video fetched eight times over, byte-identical, because every
 * attempt looked like a failure. Reporting the path is what closes that loop.
 *
 * Carried on the snapshot rather than on `PreviewAutomationStatus`: adding an
 * array field to that struct tips its inference past a limit and collapses the
 * open-result union's decoder services to `any`.
 */
export const PreviewDownload = Schema.Struct({
  fileName: Schema.String,
  path: Schema.String,
  completedAt: Schema.String,
  succeeded: Schema.Boolean,
});
export type PreviewDownload = typeof PreviewDownload.Type;

const PreviewDownloadList = Schema.Array(PreviewDownload);

/**
 * A download held until the user says whether that site may write a file.
 *
 * Downloads no longer raise the system save panel, so without this a page — or
 * an agent driving one — writes into the user's workspace with no prompt and
 * no click at all.
 */
export const PreviewDownloadApproval = Schema.Struct({
  id: Schema.String,
  domain: Schema.String,
  fileName: Schema.String,
});
export type PreviewDownloadApproval = typeof PreviewDownloadApproval.Type;

/**
 * Waiting on a person, not a server, so this gets its own bound rather than
 * the 60s cap the page-condition waits use. Someone has to notice the card and
 * decide.
 */
export const PreviewAutomationWaitForDownloadInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(600_000)).annotate({
      description: "Maximum wait in milliseconds. Defaults to 120000; maximum 600000.",
    }),
  ).annotate({ description: "Maximum wait in milliseconds. Defaults to 120000; maximum 600000." }),
});
export type PreviewAutomationWaitForDownloadInput =
  typeof PreviewAutomationWaitForDownloadInput.Type;

export const PreviewAutomationWaitForDownloadResult = Schema.Struct({
  tabId: PreviewTabId,
  /** False when the wait ran out with the question still on screen. */
  settled: Schema.Boolean,
  /** Files that finished on this tab while waiting, newest first. */
  downloads: Schema.Array(PreviewDownload),
  /** Still held, so the user has not answered yet. */
  pendingDownloadApprovals: Schema.Array(PreviewDownloadApproval),
});
export type PreviewAutomationWaitForDownloadResult =
  typeof PreviewAutomationWaitForDownloadResult.Type;

export const PreviewAutomationLoadFailure = Schema.Struct({
  code: Schema.Number,
  description: Schema.String,
});
export type PreviewAutomationLoadFailure = typeof PreviewAutomationLoadFailure.Type;

export const PreviewAutomationStatus = Schema.Struct({
  available: Schema.Boolean,
  visible: Schema.Boolean,
  tabId: Schema.NullOr(PreviewTabId),
  url: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  loading: Schema.Boolean,
  /** Optional for compatibility with desktop hosts predating viewport sizing. */
  viewportSetting: Schema.optional(PreviewViewportSetting),
  /** Measured guest-page viewport in CSS pixels when a webview is ready. */
  viewport: Schema.optional(PreviewRenderedViewportSize),
  /** Optional for compatibility with hosts predating challenge handoff. */
  humanVerification: Schema.optional(Schema.NullOr(PreviewHumanVerification)),
  /** Optional for compatibility with hosts predating navigation failure details. */
  loadFailure: Schema.optional(PreviewAutomationLoadFailure),
});
export type PreviewAutomationStatus = typeof PreviewAutomationStatus.Type;

const PreviewAutomationOpenReuseArguments = Schema.Struct({
  tabId: PreviewTabId,
  url: BoundedUrl,
  open: Schema.optional(Schema.Boolean),
});

const PreviewAutomationOpenNewArguments = Schema.Struct({
  url: BoundedUrl,
  reuseExistingTab: Schema.Literal(false),
  open: Schema.optional(Schema.Boolean),
});

export const PreviewAutomationOpenTabMatch = Schema.Struct({
  tabId: PreviewTabId,
  url: BoundedUrl,
  title: Schema.String,
  loading: Schema.Boolean,
  activeForUser: Schema.Boolean,
  currentForAgent: Schema.Boolean,
  reuseCall: Schema.Struct({
    tool: Schema.Literal("preview_open"),
    arguments: PreviewAutomationOpenReuseArguments,
  }),
});
export type PreviewAutomationOpenTabMatch = typeof PreviewAutomationOpenTabMatch.Type;

const PreviewAutomationOpenSelectionRequired = Schema.Struct({
  outcome: Schema.Literal("selection-required"),
  requestedUrl: BoundedUrl,
  domain: TrimmedNonEmptyString,
  matchingTabs: Schema.Array(PreviewAutomationOpenTabMatch),
  newTabCall: Schema.Struct({
    tool: Schema.Literal("preview_open"),
    arguments: PreviewAutomationOpenNewArguments,
  }),
  message: Schema.String,
});

const PreviewAutomationOpenCreated = Schema.Struct({
  outcome: Schema.Literal("created"),
  tabId: PreviewTabId,
  status: PreviewAutomationStatus,
  message: Schema.String,
  cleanup: Schema.Struct({
    tool: Schema.Literal("preview_close"),
    arguments: Schema.Struct({ tabId: PreviewTabId }),
  }),
});

const PreviewAutomationOpenReused = Schema.Struct({
  outcome: Schema.Literal("reused"),
  tabId: PreviewTabId,
  status: PreviewAutomationStatus,
  message: Schema.String,
});

/**
 * Current hosts return an explicit lifecycle outcome. PreviewAutomationStatus
 * remains in the union so a newly updated server can still decode responses
 * from desktop hosts that predate tab lifecycle reporting.
 */
export const PreviewAutomationOpenResult = Schema.Union([
  PreviewAutomationOpenSelectionRequired,
  PreviewAutomationOpenCreated,
  PreviewAutomationOpenReused,
  PreviewAutomationStatus,
]);
export type PreviewAutomationOpenResult = typeof PreviewAutomationOpenResult.Type;

export const PreviewAutomationOpenInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  url: Schema.optional(BoundedUrl).annotate({
    description:
      "Optional initial page URL, for example https://t3.chat or localhost:5173. Omit to open a blank tab.",
  }),
  open: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Whether to open the thread-bound inline preview for the human. Defaults to true; set false for background-only automation.",
    }),
  ),
  show: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Deprecated alias for open. Whether to reveal the thread-bound inline preview to the human.",
    }),
  ),
  reuseExistingTab: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Reuse tabId when supplied, otherwise this agent session's current tab. Defaults to true; set false to create a new tab.",
    }),
  ),
})
  .check(
    Schema.makeFilter(
      (input) =>
        !(input.tabId !== undefined && input.reuseExistingTab === false) ||
        "tabId cannot be combined with reuseExistingTab=false.",
    ),
  )
  .annotate({
    description:
      "Opens the collaborative browser for the current thread. Use preview_navigate afterward when readiness waiting matters.",
  });
export type PreviewAutomationOpenInput = typeof PreviewAutomationOpenInput.Type;

export const PreviewAutomationCloseInput = Schema.Struct({
  tabId: Schema.String.check(Schema.isTrimmed())
    .check(
      Schema.isNonEmpty({
        description:
          "Exact collaborative browser tab to close. Only close a tab created for the current browsing task; never close a reused tab merely as cleanup.",
      }),
    )
    .check(Schema.isMaxLength(128)),
}).annotate({
  description: "Closes one explicitly identified collaborative browser tab.",
});
export type PreviewAutomationCloseInput = typeof PreviewAutomationCloseInput.Type;

export const PreviewAutomationCloseResult = Schema.Struct({
  closedTabId: PreviewTabId,
  /** The surviving active tab, including a blank replacement, or null. */
  tabId: Schema.NullOr(PreviewTabId),
  replacementCreated: Schema.Boolean,
  message: Schema.String,
});
export type PreviewAutomationCloseResult = typeof PreviewAutomationCloseResult.Type;

export const BrowserNavigationTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("url").annotate({
      description: "Selects direct URL navigation.",
    }),
    url: BoundedUrl.annotate({
      description: "Direct website URL.",
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("environment-port").annotate({
      description: "Selects a dev-server port relative to the current execution environment.",
    }),
    port: Schema.Int.check(Schema.isGreaterThan(0))
      .check(Schema.isLessThan(65_536))
      .annotate({ description: "Dev-server TCP port inside the current environment." }),
    protocol: Schema.optional(
      Schema.Literals(["http", "https"]).annotate({
        description: "Dev-server protocol. Defaults to http.",
      }),
    ),
    path: Schema.optional(
      Schema.String.annotate({
        description: "Optional path, query, and fragment, for example /settings?tab=account.",
      }),
    ),
  }),
]);
export type BrowserNavigationTarget = typeof BrowserNavigationTarget.Type;

export const PreviewAutomationNavigateInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  url: Schema.optional(BoundedUrl).annotate({
    description:
      "Website URL, for example https://t3.chat. Use this for public pages and directly reachable URLs.",
  }),
  target: Schema.optional(
    BrowserNavigationTarget.annotate({
      description:
        "Environment-relative target. Prefer {kind:'environment-port',port:5173} for a dev server in the current environment.",
    }),
  ).annotate({
    description:
      "Environment-relative target. Prefer {kind:'environment-port',port:5173} for a dev server in the current environment.",
  }),
  readiness: Schema.optional(
    Schema.Literals(["load", "domContentLoaded", "none"]).annotate({
      description:
        "Readiness milestone before returning. 'load' waits for loading to stop (default), 'domContentLoaded' waits for an interactive document, and 'none' returns immediately.",
    }),
  ).annotate({
    description:
      "Readiness milestone before returning. 'load' is the default; use 'none' only when a later wait call will verify the page.",
  }),
  timeoutMs: OptionalTimeoutMs,
})
  .check(
    Schema.makeFilter(
      (input) =>
        Number(input.url !== undefined) + Number(input.target !== undefined) === 1 ||
        "Provide exactly one of url or target.",
    ),
  )
  .annotate({
    description:
      "Navigates the active browser tab. Provide exactly one of url or target; for most public pages use url.",
  });
export type PreviewAutomationNavigateInput = typeof PreviewAutomationNavigateInput.Type;

export const PreviewAutomationResizeInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  mode: Schema.Literals(["fill", "freeform", "preset"]).annotate({
    description:
      "Viewport mode: fill follows the preview panel, freeform uses exact independently resizable dimensions, and preset uses a named device size.",
  }),
  preset: Schema.optional(
    PreviewViewportPresetId.annotate({
      description: "Named viewport from Chrome DevTools' standard device catalog.",
    }),
  ).annotate({
    description: "Named device size. Required only when mode is preset.",
  }),
  width: Schema.optional(
    PreviewViewportSize.fields.width.annotate({
      description: "Freeform viewport width in CSS pixels. Required only in freeform mode.",
    }),
  ).annotate({
    description: "Freeform viewport width in CSS pixels. Required only in freeform mode.",
  }),
  height: Schema.optional(
    PreviewViewportSize.fields.height.annotate({
      description: "Freeform viewport height in CSS pixels. Required only in freeform mode.",
    }),
  ).annotate({
    description: "Freeform viewport height in CSS pixels. Required only in freeform mode.",
  }),
  orientation: Schema.optional(
    Schema.Literals(["portrait", "landscape"]).annotate({
      description:
        "Orientation for a fixed device preset. Defaults to the preset's native orientation.",
    }),
  ).annotate({
    description:
      "Orientation for a named device preset. It is not accepted in fill or freeform mode.",
  }),
  timeoutMs: OptionalTimeoutMs,
})
  .check(
    Schema.makeFilter((input) => {
      const hasPreset = input.preset !== undefined;
      const hasWidth = input.width !== undefined;
      const hasHeight = input.height !== undefined;
      if (hasWidth !== hasHeight) return "Custom dimensions require both width and height.";
      if (input.mode === "fill") {
        return !hasPreset && !hasWidth && input.orientation === undefined
          ? true
          : "Fill mode does not accept a preset, dimensions, or orientation.";
      }
      if (input.mode === "freeform") {
        if (!hasWidth || !hasHeight || hasPreset || input.orientation !== undefined) {
          return "Freeform mode requires width and height and does not accept a preset or orientation.";
        }
      } else if (!hasPreset || hasWidth || hasHeight) {
        return "Preset mode requires a preset and does not accept custom dimensions.";
      }
      if (hasWidth && hasHeight && input.width! * input.height! > PREVIEW_VIEWPORT_MAX_AREA) {
        return `Custom viewport area must not exceed ${PREVIEW_VIEWPORT_MAX_AREA} pixels.`;
      }
      return true;
    }),
  )
  .annotate({
    description:
      "Sets the active browser tab to fill-panel, independently resizable freeform, or named device-preset sizing.",
  });
export type PreviewAutomationResizeInput = typeof PreviewAutomationResizeInput.Type;

export const PreviewAutomationResizeResult = Schema.Struct({
  tabId: PreviewTabId,
  setting: PreviewViewportSetting,
  viewport: PreviewRenderedViewportSize,
});
export type PreviewAutomationResizeResult = typeof PreviewAutomationResizeResult.Type;

/** Mirrors DesktopPreviewColorScheme; declared here to keep this module free of ipc.ts imports. */
export const PreviewAutomationColorScheme = Schema.Literals(["system", "light", "dark"]);
export type PreviewAutomationColorScheme = typeof PreviewAutomationColorScheme.Type;

export const PreviewAutomationSetColorSchemeInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  colorScheme: PreviewAutomationColorScheme.annotate({
    description:
      "Emulated prefers-color-scheme for the page: light, dark, or system to follow the OS appearance.",
  }),
}).annotate({
  description:
    "Emulates prefers-color-scheme in the active browser tab without changing the OS or app theme.",
});
export type PreviewAutomationSetColorSchemeInput = typeof PreviewAutomationSetColorSchemeInput.Type;

export const PreviewAutomationSetColorSchemeResult = Schema.Struct({
  tabId: PreviewTabId,
  colorScheme: PreviewAutomationColorScheme,
});
export type PreviewAutomationSetColorSchemeResult =
  typeof PreviewAutomationSetColorSchemeResult.Type;

const Locator = TrimmedNonEmptyString.annotate({
  description:
    "Playwright selector, preferably role/text based, for example role=button[name='Send'] or text=Continue. Use snapshot first to inspect the page.",
});

const LegacySelector = TrimmedNonEmptyString.annotate({
  description:
    "Legacy CSS selector such as button[type='submit']. Prefer locator for resilient role/text targeting.",
});

export const PreviewAutomationClickInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  selector: Schema.optional(LegacySelector).annotate({
    description:
      "Legacy CSS selector such as button[type='submit']. Prefer locator for resilient role/text targeting.",
  }),
  locator: Schema.optional(Locator).annotate({
    description:
      "Playwright selector, preferably role/text based, for example role=button[name='Send'] or text=Continue. Use snapshot first to inspect the page.",
  }),
  x: Schema.optional(
    Schema.Finite.annotate({
      description: "Viewport-relative X coordinate in CSS pixels. Must be paired with y.",
    }),
  ),
  y: Schema.optional(
    Schema.Finite.annotate({
      description: "Viewport-relative Y coordinate in CSS pixels. Must be paired with x.",
    }),
  ),
  timeoutMs: OptionalTimeoutMs,
})
  .check(
    Schema.makeFilter((input) => {
      const selectorModes =
        Number(input.selector !== undefined) + Number(input.locator !== undefined);
      const hasX = input.x !== undefined;
      const hasY = input.y !== undefined;
      if (hasX !== hasY) return "Coordinates require both x and y.";
      const coordinateModes = hasX && hasY ? 1 : 0;
      return selectorModes + coordinateModes === 1 || "Provide exactly one click target.";
    }),
  )
  .annotate({
    description:
      "Clicks one target. Provide exactly one of locator, selector, or the x/y coordinate pair.",
  });
export type PreviewAutomationClickInput = typeof PreviewAutomationClickInput.Type;

export const PreviewAutomationTypeInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  text: Schema.String.annotate({ description: "Literal text to insert." }),
  selector: Schema.optional(LegacySelector).annotate({
    description: "Legacy CSS selector for the input. Prefer locator.",
  }),
  locator: Schema.optional(Locator).annotate({
    description:
      "Playwright selector for the input, for example role=textbox[name='Message'] or textarea[placeholder*='Message'].",
  }),
  clear: Schema.optional(
    Schema.Boolean.annotate({
      description: "Clear the existing input value before inserting text. Defaults to false.",
    }),
  ),
  timeoutMs: OptionalTimeoutMs,
})
  .check(
    Schema.makeFilter(
      (input) =>
        !(input.selector !== undefined && input.locator !== undefined) ||
        "Provide at most one of selector or locator.",
    ),
  )
  .annotate({
    description:
      "Types into locator/selector, or into the currently focused element when neither target is provided.",
  });
export type PreviewAutomationTypeInput = typeof PreviewAutomationTypeInput.Type;

const LocalUploadPath = Schema.String.check(Schema.isTrimmed())
  .check(Schema.isNonEmpty({ description: "Absolute local path to an existing file." }))
  .check(Schema.isMaxLength(4096))
  .annotate({
    description:
      "Absolute path to a file on the browser host. The desktop validates that each path exists and is a regular file before exposing it to the page.",
  });

export const PreviewAutomationUploadInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  paths: Schema.Array(LocalUploadPath)
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(20))
    .annotate({
      description: "One to twenty absolute local file paths to attach to the page file input.",
    }),
  selector: Schema.optional(LegacySelector).annotate({
    description:
      "Legacy CSS selector for an input[type=file]. Omit both selector and locator to use the first file input in the page.",
  }),
  locator: Schema.optional(Locator).annotate({
    description:
      "Playwright locator for an input[type=file]. Omit both selector and locator to use the first file input in the page.",
  }),
  timeoutMs: OptionalTimeoutMs,
})
  .check(
    Schema.makeFilter(
      (input) =>
        !(input.selector !== undefined && input.locator !== undefined) ||
        "Provide at most one of selector or locator.",
    ),
  )
  .annotate({
    description:
      "Assigns local files directly to a page file input without opening the operating-system picker.",
  });
export type PreviewAutomationUploadInput = typeof PreviewAutomationUploadInput.Type;

export const PreviewAutomationUploadResult = Schema.Struct({
  fileCount: Schema.Int.check(Schema.isGreaterThan(0)),
  fileNames: Schema.Array(Schema.String),
});
export type PreviewAutomationUploadResult = typeof PreviewAutomationUploadResult.Type;

export const PreviewAutomationPressInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  key: Schema.String.check(Schema.isTrimmed())
    .check(
      Schema.isNonEmpty({
        description:
          "Keyboard key name such as Enter, Escape, Tab, ArrowDown, Backspace, or a single character.",
      }),
    )
    .annotateKey({
      description:
        "Keyboard key name such as Enter, Escape, Tab, ArrowDown, Backspace, or a single character.",
    }),
  modifiers: Schema.optional(
    Schema.Array(Schema.Literals(["Alt", "Control", "Meta", "Shift"])).annotate({
      description: "Modifier keys held while pressing key.",
    }),
  ),
}).annotate({ description: "Presses one keyboard key in the active browser tab." });
export type PreviewAutomationPressInput = typeof PreviewAutomationPressInput.Type;

export const PreviewAutomationScrollInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  deltaX: Schema.optional(
    Schema.Finite.annotate({
      description: "Horizontal scroll delta in CSS pixels. Positive scrolls right. Defaults to 0.",
    }),
  ),
  deltaY: Schema.optional(
    Schema.Finite.annotate({
      description: "Vertical scroll delta in CSS pixels. Positive scrolls down. Defaults to 0.",
    }),
  ),
  selector: Schema.optional(LegacySelector).annotate({
    description: "Legacy CSS selector for a scrollable container. Omit to scroll the viewport.",
  }),
  locator: Schema.optional(Locator).annotate({
    description: "Playwright selector for a scrollable container. Omit to scroll the viewport.",
  }),
})
  .check(
    Schema.makeFilter((input) => {
      if (input.selector !== undefined && input.locator !== undefined) {
        return "Provide at most one of selector or locator.";
      }
      return (
        input.deltaX !== undefined || input.deltaY !== undefined || "Provide deltaX or deltaY."
      );
    }),
  )
  .annotate({
    description:
      "Scrolls the viewport, or a locator/selector container. Provide deltaX, deltaY, or both.",
  });
export type PreviewAutomationScrollInput = typeof PreviewAutomationScrollInput.Type;

export const PreviewAutomationEvaluateInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  expression: Schema.String.check(Schema.isTrimmed())
    .check(
      Schema.isNonEmpty({
        description:
          "JavaScript expression evaluated in the page's main frame, for example document.title or (() => ({href: location.href}))().",
      }),
    )
    .check(Schema.isMaxLength(64_000))
    .annotateKey({
      description:
        "JavaScript expression evaluated in the page's main frame, for example document.title or (() => ({href: location.href}))().",
    }),
  awaitPromise: Schema.optional(
    Schema.Boolean.annotate({ description: "Await a returned Promise. Defaults to true." }),
  ),
  returnByValue: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Serialize and return the value instead of a remote object reference. Defaults to true.",
    }),
  ),
}).annotate({
  description:
    "Evaluates JavaScript in the page. Prefer snapshot and semantic actions; use evaluate for inspection or unsupported interactions.",
});
export type PreviewAutomationEvaluateInput = typeof PreviewAutomationEvaluateInput.Type;

export const PreviewAutomationWaitForInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  selector: Schema.optional(LegacySelector).annotate({
    description: "Legacy CSS selector that must match an element. Prefer locator.",
  }),
  locator: Schema.optional(Locator).annotate({
    description:
      "Playwright selector that must match an element, for example role=button[name='Send'].",
  }),
  text: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Case-sensitive substring that must appear in visible document text.",
    }),
  ).annotate({
    description: "Case-sensitive substring that must appear in visible document text.",
  }),
  urlIncludes: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Substring that must appear in the current absolute URL.",
    }),
  ).annotate({ description: "Substring that must appear in the current absolute URL." }),
  timeoutMs: OptionalTimeoutMs,
})
  .check(
    Schema.makeFilter((input) => {
      if (input.selector !== undefined && input.locator !== undefined) {
        return "Provide at most one of selector or locator.";
      }
      return (
        input.selector !== undefined ||
        input.locator !== undefined ||
        input.text !== undefined ||
        input.urlIncludes !== undefined ||
        "Provide at least one wait condition."
      );
    }),
  )
  .annotate({
    description:
      "Waits until all provided conditions match. Use after click/type when the page changes asynchronously.",
  });
export type PreviewAutomationWaitForInput = typeof PreviewAutomationWaitForInput.Type;

export const PreviewAutomationElement = Schema.Struct({
  tag: Schema.String,
  role: Schema.NullOr(Schema.String),
  name: Schema.String,
  selector: Schema.String,
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export type PreviewAutomationElement = typeof PreviewAutomationElement.Type;

export const PreviewAutomationConsoleEntry = Schema.Struct({
  level: Schema.String,
  text: Schema.String,
  timestamp: Schema.String,
  source: Schema.optional(Schema.String),
});
export type PreviewAutomationConsoleEntry = typeof PreviewAutomationConsoleEntry.Type;

export const PreviewAutomationNetworkEntry = Schema.Struct({
  url: Schema.String,
  method: Schema.String,
  status: Schema.NullOr(Schema.Number),
  failed: Schema.Boolean,
  errorText: Schema.optional(Schema.String),
  /** True when Cloudflare marked an HTML response as a Challenge Page. */
  cfMitigated: Schema.optional(Schema.Boolean),
  timestamp: Schema.String,
});
export type PreviewAutomationNetworkEntry = typeof PreviewAutomationNetworkEntry.Type;

export const PreviewAutomationActionEvent = Schema.Struct({
  id: Schema.String,
  action: Schema.String,
  status: Schema.Literals(["running", "succeeded", "failed", "interrupted"]),
  startedAt: Schema.String,
  completedAt: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type PreviewAutomationActionEvent = typeof PreviewAutomationActionEvent.Type;

export const PreviewAutomationSnapshot = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  visibleText: Schema.String,
  interactiveElements: Schema.Array(PreviewAutomationElement),
  accessibilityTree: Schema.Unknown,
  consoleEntries: Schema.Array(PreviewAutomationConsoleEntry),
  networkEntries: Schema.Array(PreviewAutomationNetworkEntry),
  actionTimeline: Schema.Array(PreviewAutomationActionEvent),
  /**
   * Files this browser finished downloading, newest first. Optional for
   * compatibility with hosts predating automatic downloads.
   */
  downloads: Schema.optional(PreviewDownloadList),
  /**
   * Downloads this browser is holding for the user's approval.
   *
   * Without this a held download is indistinguishable from a failed one, and
   * an agent that cannot tell the difference just fetches again — the same
   * mistake the `downloads` field above exists to prevent.
   */
  pendingDownloadApprovals: Schema.optional(Schema.Array(PreviewDownloadApproval)),
  /**
   * Absent when every capture strategy failed.
   *
   * A picture is one field of a snapshot, and losing it must not cost the
   * caller the URL, text, accessibility tree and everything else that was
   * gathered fine — an agent handed a bare failure cannot tell a broken page
   * from a broken tool, so it retries forever.
   */
  screenshot: Schema.optional(
    Schema.Struct({
      mimeType: Schema.Literal("image/jpeg"),
      data: Schema.String,
      width: Schema.Int,
      height: Schema.Int,
    }),
  ),
  /** Why there is no screenshot, when there is none. */
  screenshotError: Schema.optional(Schema.String),
  /** Optional for compatibility with hosts predating challenge handoff. */
  humanVerification: Schema.optional(Schema.NullOr(PreviewHumanVerification)),
});
export type PreviewAutomationSnapshot = typeof PreviewAutomationSnapshot.Type;

export const PreviewAutomationRecordingStatus = Schema.Struct({
  tabId: PreviewTabId,
  recording: Schema.Boolean,
  startedAt: Schema.NullOr(Schema.String),
});
export type PreviewAutomationRecordingStatus = typeof PreviewAutomationRecordingStatus.Type;

export const PreviewAutomationRecordingArtifact = Schema.Struct({
  id: Schema.String,
  tabId: PreviewTabId,
  path: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Int,
  createdAt: Schema.String,
});
export type PreviewAutomationRecordingArtifact = typeof PreviewAutomationRecordingArtifact.Type;

export const PreviewAutomationClientId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type PreviewAutomationClientId = typeof PreviewAutomationClientId.Type;
export const PreviewAutomationConnectionId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type PreviewAutomationConnectionId = typeof PreviewAutomationConnectionId.Type;

export const PreviewAutomationHostIdentity = Schema.Struct({
  clientId: PreviewAutomationClientId,
  environmentId: EnvironmentId,
});
export type PreviewAutomationHostIdentity = typeof PreviewAutomationHostIdentity.Type;

export const PreviewAutomationHost = Schema.Struct({
  ...PreviewAutomationHostIdentity.fields,
  /**
   * Missing means the pre-capability-negotiation V1 operation set. This lets
   * a newer server safely coexist with an older desktop during rollout.
   */
  supportedOperations: Schema.optional(Schema.Array(PreviewAutomationOperation)),
});
export type PreviewAutomationHost = typeof PreviewAutomationHost.Type;

export const PreviewAutomationHostFocus = Schema.Struct({
  ...PreviewAutomationHostIdentity.fields,
  connectionId: PreviewAutomationConnectionId,
  focused: Schema.Boolean,
});
export type PreviewAutomationHostFocus = typeof PreviewAutomationHostFocus.Type;

export const PreviewAutomationRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  threadId: ThreadId,
  tabId: Schema.optional(PreviewTabId),
  tabIdExplicit: Schema.optional(Schema.Boolean),
  operation: PreviewAutomationOperation,
  input: Schema.Unknown,
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
  /** Absolute server deadline; hosts must discard work after this time. */
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type PreviewAutomationRequest = typeof PreviewAutomationRequest.Type;

export const PreviewAutomationStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("connected"),
    connectionId: PreviewAutomationConnectionId,
  }),
  Schema.Struct({
    type: Schema.Literal("request"),
    connectionId: PreviewAutomationConnectionId,
    request: PreviewAutomationRequest,
  }),
]);
export type PreviewAutomationStreamEvent = typeof PreviewAutomationStreamEvent.Type;

export const PreviewAutomationResponse = Schema.Struct({
  clientId: PreviewAutomationClientId,
  connectionId: PreviewAutomationConnectionId,
  requestId: TrimmedNonEmptyString,
  ok: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      _tag: TrimmedNonEmptyString,
      message: Schema.String,
      detail: Schema.optional(Schema.Unknown),
    }),
  ),
});
export type PreviewAutomationResponse = typeof PreviewAutomationResponse.Type;

export class PreviewAutomationUnavailableError extends Schema.TaggedErrorClass<PreviewAutomationUnavailableError>()(
  "PreviewAutomationUnavailableError",
  {
    capability: Schema.Literal("preview"),
    environmentId: EnvironmentId,
    threadId: ThreadId,
    providerSessionId: TrimmedNonEmptyString,
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `MCP credential does not grant the ${this.capability} capability.`;
  }
}

const PreviewAutomationScopeErrorFields = {
  operation: PreviewAutomationOperation,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  providerSessionId: TrimmedNonEmptyString,
  providerInstanceId: ProviderInstanceId,
};

const PreviewAutomationRequestErrorFields = {
  ...PreviewAutomationScopeErrorFields,
  clientId: TrimmedNonEmptyString,
  connectionId: PreviewAutomationConnectionId,
  requestId: TrimmedNonEmptyString,
  tabId: Schema.optional(PreviewTabId),
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
};

const PreviewAutomationRemoteDiagnosticFields = {
  remoteTag: TrimmedNonEmptyString,
  remoteMessageLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  remoteDetailKind: Schema.optional(
    Schema.Literals(["null", "array", "object", "string", "number", "boolean"]),
  ),
  cause: Schema.Defect(),
};

const PreviewAutomationOptionalRemoteDiagnosticFields = {
  remoteTag: Schema.optional(TrimmedNonEmptyString),
  remoteMessageLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  remoteDetailKind: Schema.optional(
    Schema.Literals(["null", "array", "object", "string", "number", "boolean"]),
  ),
  cause: Schema.optional(Schema.Defect()),
};

export class PreviewAutomationNoAvailableHostError extends Schema.TaggedErrorClass<PreviewAutomationNoAvailableHostError>()(
  "PreviewAutomationNoAvailableHostError",
  {
    ...PreviewAutomationScopeErrorFields,
    clientId: Schema.optional(TrimmedNonEmptyString),
    connectionId: Schema.optional(PreviewAutomationConnectionId),
    requestId: Schema.optional(TrimmedNonEmptyString),
    tabId: Schema.optional(PreviewTabId),
    timeoutMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    ...PreviewAutomationOptionalRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    const summary = `No preview automation host is available for ${this.operation} in environment ${this.environmentId}.`;
    return summary;
  }
}

export class PreviewAutomationUnsupportedClientError extends Schema.TaggedErrorClass<PreviewAutomationUnsupportedClientError>()(
  "PreviewAutomationUnsupportedClientError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    return `Preview automation client ${this.clientId} does not support ${this.operation}.`;
  }
}

export class PreviewAutomationTabNotFoundError extends Schema.TaggedErrorClass<PreviewAutomationTabNotFoundError>()(
  "PreviewAutomationTabNotFoundError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    const summary = this.tabId
      ? `Preview tab ${this.tabId} was not found for ${this.operation}.`
      : `No active preview tab was found for ${this.operation}.`;
    return summary;
  }
}

export class PreviewAutomationTimeoutError extends Schema.TaggedErrorClass<PreviewAutomationTimeoutError>()(
  "PreviewAutomationTimeoutError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationOptionalRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    const summary = `Preview automation ${this.operation} timed out after ${this.timeoutMs}ms.`;
    return summary;
  }
}

export class PreviewAutomationControlInterruptedError extends Schema.TaggedErrorClass<PreviewAutomationControlInterruptedError>()(
  "PreviewAutomationControlInterruptedError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    return `Preview automation ${this.operation} was interrupted on client ${this.clientId}.`;
  }
}

export class PreviewAutomationHumanVerificationRequiredError extends Schema.TaggedErrorClass<PreviewAutomationHumanVerificationRequiredError>()(
  "PreviewAutomationHumanVerificationRequiredError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
    verification: PreviewHumanVerification,
  },
) {
  override get message(): string {
    return `Preview automation ${this.operation} is paused because tab ${this.tabId ?? "unassigned"} requires human verification.`;
  }
}

export class PreviewAutomationExecutionError extends Schema.TaggedErrorClass<PreviewAutomationExecutionError>()(
  "PreviewAutomationExecutionError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    return `Preview automation ${this.operation} failed on client ${this.clientId}.`;
  }
}

export class PreviewAutomationInvalidSelectorError extends Schema.TaggedErrorClass<PreviewAutomationInvalidSelectorError>()(
  "PreviewAutomationInvalidSelectorError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
    selectorKind: Schema.optional(Schema.Literals(["locator", "selector"])),
    selectorLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  },
) {
  override get message(): string {
    if (this.selectorKind !== undefined && this.selectorLength !== undefined) {
      return `Preview automation ${this.operation} received an invalid ${this.selectorKind} (${this.selectorLength} characters).`;
    }
    return `Preview automation ${this.operation} received an invalid selector.`;
  }
}

export class PreviewAutomationTargetNotEditableError extends Schema.TaggedErrorClass<PreviewAutomationTargetNotEditableError>()(
  "PreviewAutomationTargetNotEditableError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
    selectorKind: Schema.optional(Schema.Literals(["focused-element", "locator", "selector"])),
    selectorLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  },
) {
  override get message(): string {
    if (this.selectorKind === "focused-element") {
      return `Preview automation ${this.operation} requires an editable focused element.`;
    }
    if (this.selectorKind !== undefined && this.selectorLength !== undefined) {
      return `Preview automation ${this.operation} requires an editable ${this.selectorKind} (${this.selectorLength} characters).`;
    }
    return `Preview automation ${this.operation} requires an editable target.`;
  }
}

export class PreviewAutomationResultTooLargeError extends Schema.TaggedErrorClass<PreviewAutomationResultTooLargeError>()(
  "PreviewAutomationResultTooLargeError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
    maximumBytes: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  },
) {
  override get message(): string {
    const summary =
      this.maximumBytes === undefined
        ? `Preview automation ${this.operation} produced a result that is too large.`
        : `Preview automation ${this.operation} produced a result larger than ${this.maximumBytes} bytes.`;
    return summary;
  }
}

export class PreviewAutomationClientDisconnectedError extends Schema.TaggedErrorClass<PreviewAutomationClientDisconnectedError>()(
  "PreviewAutomationClientDisconnectedError",
  PreviewAutomationRequestErrorFields,
) {
  override get message(): string {
    return `Preview automation client ${this.clientId} disconnected during ${this.operation}.`;
  }
}

export class PreviewAutomationRequestQueueClosedError extends Schema.TaggedErrorClass<PreviewAutomationRequestQueueClosedError>()(
  "PreviewAutomationRequestQueueClosedError",
  PreviewAutomationRequestErrorFields,
) {
  override get message(): string {
    return `Preview automation client ${this.clientId} stopped accepting ${this.operation} requests.`;
  }
}

export class PreviewAutomationRemoteUnavailableError extends Schema.TaggedErrorClass<PreviewAutomationRemoteUnavailableError>()(
  "PreviewAutomationRemoteUnavailableError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    return `Preview automation ${this.operation} is unavailable on client ${this.clientId}.`;
  }
}

export class PreviewAutomationMalformedResponseError extends Schema.TaggedErrorClass<PreviewAutomationMalformedResponseError>()(
  "PreviewAutomationMalformedResponseError",
  PreviewAutomationRequestErrorFields,
) {
  override get message(): string {
    return `Preview automation client ${this.clientId} returned a malformed response for ${this.operation}.`;
  }
}

/**
 * A snapshot was produced but carries no picture.
 *
 * Only the mobile frame feed treats this as a failure — it exists to show the
 * tab, so a frame with no image is nothing to show, and the phone keeps its
 * last good frame rather than going blank. Agents get the snapshot itself,
 * with `screenshotError` explaining the gap.
 */
export class PreviewAutomationScreenshotUnavailableError extends Schema.TaggedErrorClass<PreviewAutomationScreenshotUnavailableError>()(
  "PreviewAutomationScreenshotUnavailableError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: PreviewTabId,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `The desktop browser could not render a frame for this tab. ${this.reason}`;
  }
}

export const PreviewAutomationError = Schema.Union([
  PreviewAutomationUnavailableError,
  PreviewAutomationNoAvailableHostError,
  PreviewAutomationUnsupportedClientError,
  PreviewAutomationTabNotFoundError,
  PreviewAutomationTimeoutError,
  PreviewAutomationControlInterruptedError,
  PreviewAutomationHumanVerificationRequiredError,
  PreviewAutomationExecutionError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationTargetNotEditableError,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationClientDisconnectedError,
  PreviewAutomationRequestQueueClosedError,
  PreviewAutomationRemoteUnavailableError,
  PreviewAutomationMalformedResponseError,
  PreviewAutomationScreenshotUnavailableError,
]);
export type PreviewAutomationError = typeof PreviewAutomationError.Type;

export const PreviewUrlResolution = Schema.Struct({
  requestedUrl: Schema.String,
  resolvedUrl: Schema.String,
  resolutionKind: Schema.Literals(["direct", "direct-private-network"]),
  environmentId: EnvironmentId,
});
export type PreviewUrlResolution = typeof PreviewUrlResolution.Type;
