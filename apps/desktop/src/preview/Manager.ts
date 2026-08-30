/**
 * Desktop side of the in-app browser preview.
 *
 * Hosts per-tab Chromium WebContents references (the actual <webview>
 * elements live in the renderer; we only attach listeners and forward state
 * here). Single layer-scoped browser session partition.
 */
import type {
  DesktopPreviewAnnotationTheme,
  DesktopPreviewColorScheme,
  DesktopPreviewPointerEvent,
  DesktopPreviewNewTabRequest,
  PreviewAnnotationPayload,
  PreviewAnnotationRect,
  DesktopPreviewRecordingArtifact,
  DesktopPreviewRecordingFrame,
  DesktopPreviewScreenshotArtifact,
  DesktopPreviewAutomationStatus,
  PreviewDownload,
  PreviewDownloadApproval,
  PreviewAutomationWaitForDownloadResult,
  PreviewAutomationClickInput,
  PreviewAutomationActionEvent,
  PreviewAutomationConsoleEntry,
  PreviewAutomationEvaluateInput,
  PreviewAutomationPressInput,
  PreviewAutomationNetworkEntry,
  PreviewAutomationScrollInput,
  PreviewAutomationDevTools,
  PreviewAutomationFrame,
  PreviewAutomationSnapshot,
  PreviewAutomationTypeInput,
  PreviewAutomationSelectOptionInput,
  PreviewAutomationSelectOptionResult,
  PreviewAutomationUploadInput,
  PreviewAutomationUploadResult,
  PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import {
  collectFrameIdsFromTree,
  isPdfPreviewDocument,
  mergeAccessibilityTrees,
  visibleTextFromAccessibilityTree,
} from "./previewSnapshotText.ts";
import {
  BrowserWindow,
  type Session,
  app,
  clipboard,
  nativeImage,
  shell,
  webContents,
} from "electron";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL } from "../ipc/channels.ts";
import { PreviewActivityConsumer, PreviewActivityLeases } from "./ActivityLeases.ts";
import * as BrowserSession from "./BrowserSession.ts";
import { classifyPreviewNetworkResponse } from "./CloudflareChallenge.ts";
import { devToolsActivePortCandidates, parseDevToolsActivePort } from "./DevToolsEndpoint.ts";
import {
  ANNOTATION_CAPTURED_CHANNEL,
  ANNOTATION_THEME_CHANNEL,
  CANCEL_PICK_CHANNEL,
  ELEMENT_PICKED_CHANNEL,
  HUMAN_INPUT_CHANNEL,
  START_PICK_CHANNEL,
} from "./GuestProtocol.ts";
import { isPreviewAnnotationPayload } from "./PickedElementPayload.ts";
import { playwrightInjectedRuntimeInstallExpression } from "./PlaywrightInjectedRuntime.ts";
import { makePreviewAutomationKeySequence } from "./PreviewKeyboard.ts";

export type PreviewNavStatus =
  | { kind: "Idle" }
  | { kind: "Loading"; url: string; title: string }
  | { kind: "Success"; url: string; title: string }
  | {
      kind: "LoadFailed";
      url: string;
      title: string;
      code: number;
      description: string;
    };

export interface PreviewTabState {
  tabId: string;
  webContentsId: number | null;
  snapshotStageId: string | null;
  navStatus: PreviewNavStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  pictureInPicture: boolean;
  colorScheme: DesktopPreviewColorScheme;
  controller: "human" | "agent" | "none" | "waiting-for-user";
  /** Sticky between an agent's actions — see `markAgentWorkingTab`. */
  agentActive: boolean;
  /** Finished downloads this tab started, newest first. */
  downloads: ReadonlyArray<PreviewDownload>;
  /** Downloads held on this tab until the user allows or denies the site. */
  pendingDownloadApprovals: ReadonlyArray<PreviewDownloadApproval>;
  updatedAt: string;
}

/** Discrete zoom levels mirroring Chrome's preset list. */
const ZOOM_LEVELS: ReadonlyArray<number> = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0,
];

/**
 * A short, actionable reason a screenshot could not be produced.
 *
 * The caller is usually an agent deciding whether to retry. "The page did not
 * load" tells it to fix the page; a stack trace tells it nothing and invites
 * another attempt.
 */
export function describeScreenshotFailure(cause: unknown): string {
  void cause;
  return "The screenshot could not be captured; the rest of this snapshot is complete.";
}

interface AutomationSnapshotPage {
  /** Main-frame generation owned by this live guest, not page-provided data. */
  readonly navigationGeneration: number;
  /** Same generation sampled after the page evaluation completes. */
  readonly navigationGenerationAfterRead: number;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly visibleText: string;
  readonly documentKind?: "page" | "pdf";
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly interactiveElements: PreviewAutomationSnapshot["interactiveElements"];
  readonly editableRegions: NonNullable<PreviewAutomationSnapshot["editableRegions"]>;
  /** Stable page-shell landmarks used only to bracket image/DOM consistency. */
  readonly structuralElements?: ReadonlyArray<{
    readonly tag: string;
    readonly role: string | null;
    readonly selector: string;
  }>;
}

interface NavigationAttempt {
  readonly sequence: number;
  readonly url: string;
  readonly webContentsId: number | null;
  readonly mainFrameStarted: boolean;
  readonly mainFrameCommitted: boolean;
}

type StageSnapshotSurface = <A, E, R>(
  capture: Effect.Effect<A, E, R>,
) => Effect.Effect<
  A,
  E | PreviewOperationError | PreviewTabNotFoundError | PreviewWebContentsNotFoundError,
  R
>;

function describeNavigationLoadFailure(cause: unknown): {
  readonly code: number;
  readonly description: string;
} {
  const parts: string[] = [];
  let current: unknown = cause;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    parts.push(current instanceof Error ? current.message : String(current));
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { readonly cause: unknown }).cause
        : null;
  }
  const detail = parts.join(" ");
  const parsedCode = Number(detail.match(/\((-?\d+)\)/)?.[1]);
  return {
    code: Number.isFinite(parsedCode) ? parsedCode : -2,
    description: detail.match(/\bERR_[A-Z0-9_]+\b/)?.[0] ?? "ERR_FAILED",
  };
}

/**
 * A screenshot and its semantic metadata are one observation. If the live
 * guest changes while Chromium is producing the image, pairing the old pixels
 * with the new DOM is worse than returning no image at all: authentication
 * shells can otherwise look authoritative after the signed-in page has won.
 */
function isSameAutomationSnapshotPage(
  before: AutomationSnapshotPage,
  after: AutomationSnapshotPage,
): boolean {
  if (before.loading || after.loading) return false;
  if (
    before.navigationGeneration !== before.navigationGenerationAfterRead ||
    after.navigationGeneration !== after.navigationGenerationAfterRead ||
    before.navigationGeneration !== after.navigationGeneration ||
    before.url !== after.url ||
    before.title !== after.title ||
    before.visibleText !== after.visibleText ||
    before.documentKind !== after.documentKind ||
    before.viewportWidth !== after.viewportWidth ||
    before.viewportHeight !== after.viewportHeight
  ) {
    return false;
  }
  const normalizeSelector = (selector: string) =>
    // Feed rows are frequently inserted while a frame is captured. The shell
    // is still the same when only an nth-of-type index shifts.
    selector.replace(/:nth-of-type\(\d+\)/g, ":nth-of-type(*)");
  const semanticSignature = (page: AutomationSnapshotPage) => ({
    interactive: page.interactiveElements
      .map(({ tag, role, name, selector, x, y, width, height }) =>
        JSON.stringify({
          tag,
          role,
          name,
          selector: normalizeSelector(selector),
          x,
          y,
          width,
          height,
        }),
      )
      .sort(),
    structural: (page.structuralElements ?? [])
      .map(({ tag, role, selector }) =>
        JSON.stringify({ tag, role, selector: normalizeSelector(selector) }),
      )
      .sort(),
  });
  return JSON.stringify(semanticSignature(before)) === JSON.stringify(semanticSignature(after));
}

const DEFAULT_ZOOM_FACTOR = 1.0;
const ZOOM_EPSILON = 0.001;
const MAX_EVALUATION_BYTES = 64_000;
const MAX_VISIBLE_TEXT_LENGTH = 20_000;
const MAX_INTERACTIVE_ELEMENTS = 200;
const MAX_EDITABLE_REGIONS = 100;
/** Bounds a country or timezone list, which run to hundreds of options. */
const MAX_SELECT_OPTIONS = 200;
const MAX_AUTOMATION_SCREENSHOT_WIDTH = 1024;
const AUTOMATION_SNAPSHOT_JPEG_QUALITY = 78;
const RECORDING_FRAME_INTERVAL_MS = Math.ceil(1_000 / 12);
const RECORDING_JPEG_QUALITY = 80;
const PICTURE_IN_PICTURE_INITIAL_WIDTH = 480;
const PICTURE_IN_PICTURE_INITIAL_HEIGHT = 320;
const PICTURE_IN_PICTURE_MIN_WIDTH = 240;
const PICTURE_IN_PICTURE_MIN_HEIGHT = 160;
const PICTURE_IN_PICTURE_ASPECT_RATIO_EPSILON = 0.002;
const DIAGNOSTIC_BUFFER_LIMIT = 200;
const MAX_ARTIFACT_SITE_SLUG_LENGTH = 80;
/**
 * How long automation waits after the user's last keystroke in the app before it
 * will take focus for itself.
 *
 * The user always wins. An agent click or keystroke that lands mid-sentence
 * moves their caret out of the composer and into a web page, so their next words
 * go to the site — or the site's text arrives in their chat. Restoring focus
 * afterwards does not help, because the damage happens while focus is held.
 * Automation therefore defers instead of competing.
 */
const USER_INPUT_DEFERRAL_MS = 2_000;
/** Re-check cadence while deferring. */
const USER_INPUT_DEFERRAL_POLL_MS = 200;
/**
 * Longest an action waits for the user before going ahead anyway.
 *
 * Not a failure — the action still runs. This exists because the *caller* is
 * not infinitely patient: the MCP preview tools give up at 15s, so a wait with
 * no ceiling did not queue the action, it lost it. An agent click issued while
 * someone was typing a message simply never happened, which is the "dead
 * click" that was reported. Ten seconds keeps the user winning for any normal
 * burst of typing while leaving room for the action to still be delivered.
 */
const USER_INPUT_DEFERRAL_MAX_WAIT_MS = 10_000;

/** Time for a synthetic press's focus change to reach the guest's widget. */
const AUTOMATION_FOCUS_SETTLE_MS = 120;
/**
 * Keep the whole browser fleet foreground-equivalent while preview MCP is in
 * use. The lease is renewed by every request and expires only after a full
 * minute without another preview request.
 */
const AUTOMATION_FOREGROUND_IDLE_MS = 60_000;
const AUTOMATION_FOREGROUND_LEASE_ID = "automation:foreground";

/**
 * Whether automation should wait before taking keyboard focus.
 *
 * `"wait"` while the user has typed recently, `"proceed"` once they have been
 * idle long enough. There is no give-up: an action waits its turn rather than
 * taking the caret out from under someone mid-sentence.
 */
export function resolveUserInputDeferral(input: {
  readonly lastUserInputAtMs: number;
  readonly nowMs: number;
  /** A held dictation chord owns the focus until its physical release. */
  readonly pushToTalkActive?: boolean;
  /** When this action began waiting; omit for a first, un-waited check. */
  readonly waitingSinceMs?: number;
}): "proceed" | "wait" {
  if (input.pushToTalkActive) return "wait";
  if (input.lastUserInputAtMs === 0) return "proceed";
  if (input.nowMs - input.lastUserInputAtMs >= USER_INPUT_DEFERRAL_MS) return "proceed";
  // Held long enough that the caller is about to give up on us. Going ahead
  // delivers the action late; waiting on would discard it entirely.
  if (
    input.waitingSinceMs !== undefined &&
    input.nowMs - input.waitingSinceMs >= USER_INPUT_DEFERRAL_MAX_WAIT_MS
  ) {
    return "proceed";
  }
  return "wait";
}

/**
 * Whether a raw main-window input event means the user is actively working.
 *
 * Deliberately not "any input event": the pointer merely crossing or resting
 * over the window emits a stream of `mouseMove`/`pointerMove`, and counting
 * those would mark the user permanently active and starve every agent. Only
 * events that carry intent — a press, a scroll, a touch — reset the cooldown.
 *
 * This is the other half of the keyboard gate. Clicking into the composer and
 * pausing to think used to leave automation free to take the caret, because
 * `before-input-event` never sees a mouse.
 */
export function isDeliberateUserInputEvent(type: string | undefined): boolean {
  switch (type) {
    case "mouseDown":
    case "mouseUp":
    case "mouseWheel":
    case "contextMenu":
    case "touchStart":
    case "touchEnd":
    case "pointerDown":
    case "pointerUp":
    case "gestureTap":
    case "gestureScrollBegin":
      return true;
    default:
      return false;
  }
}

/**
 * Page-side source for confirming inserted text actually reached the guest.
 *
 * Read back as `(element, inserted) => boolean`, evaluated inside the page so
 * the field's contents never leave the guest — only the verdict comes back.
 *
 * Two normalisations, both load-bearing for rich-text editors:
 *
 * - `innerText`, not `textContent`, for anything that is not an `<input>` or
 *   `<textarea>`. `Input.insertText` turns a newline into DOM structure — a
 *   `<br>` or a block split — so `textContent` reports `line oneline two` for
 *   text typed as `line one\nline two` and the match fails on text that did
 *   land. `innerText` renders that structure back as newlines.
 * - `\u00a0` to a space, because contenteditable stores typed spaces as
 *   non-breaking ones, and CRLF to LF.
 */
export const PREVIEW_TYPED_TEXT_LANDED_JS = `((element, inserted) => {
  const normalize = (text) => text.replace(/\\r\\n?/g, "\\n").replace(/\\u00a0/g, " ");
  const raw =
    element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? element.value
      : (element.innerText ?? element.textContent);
  return typeof raw === "string" && normalize(raw).includes(normalize(inserted));
})`;

/** Modifier keys alone say nothing about where someone means to type. */
const BARE_MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

/**
 * Whether a keystroke that landed in a guest should be handed back to the app.
 *
 * The situation this exists for: an agent click moved the caret into a web
 * page, the user — who last put their focus in the composer — starts typing,
 * and their words go to the site instead. The last *deliberate* click decides
 * who owns the keyboard, so someone who clicked into the page themselves keeps
 * typing there and is never yanked back.
 *
 * `automationInFlight` is the safety interlock. Every agent keystroke happens
 * while that agent holds the automation turn, so a guest key arriving during
 * one is the agent's own and must never be redirected into the user's chat —
 * the exact failure this whole area was built to stop.
 */
export function shouldReclaimGuestKeyForApp(input: {
  readonly focusIntent: "app" | "guest";
  readonly automationInFlight: boolean;
  readonly inputType: string;
  readonly key: string;
}): boolean {
  if (input.focusIntent !== "app") return false;
  if (input.automationInFlight) return false;
  if (input.inputType !== "keyDown") return false;
  return !BARE_MODIFIER_KEYS.has(input.key);
}

const AGENT_CURSOR_MOVE_MS = 160;
const AGENT_CURSOR_CLICK_LEAD_MS = 40;
const AUTOMATION_SNAPSHOT_RETRY_MS = 50;
const AUTOMATION_SNAPSHOT_RETRIES = 2;
const AUTOMATION_SNAPSHOT_COMMAND_TIMEOUT_MS = 1_000;
// The renderer acknowledges only after React has mounted and measured the
// hidden guest. One second was routinely consumed by a long thread catching
// up, causing every remote poll to tear down the stage and begin again before
// it could ever paint.
const AUTOMATION_SNAPSHOT_STAGE_TIMEOUT = "5 seconds";
const AUTOMATION_SNAPSHOT_PRESENTATION_TIMEOUT = "1 second";
const AUTOMATION_SNAPSHOT_SCREENCAST_TIMEOUT = "2 seconds";
const previewActivityLeasesCurrent = Metric.gauge("t3_preview_activity_leases_current", {
  description: "Current desktop preview activity leases grouped by consumer type.",
});

const isRetryableAutomationSnapshotFailure = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return false;
  return [
    "PreviewOperationError",
    "PreviewAutomationEvaluationError",
    "PreviewWebContentsNotFoundError",
    "PreviewWebviewNotInitializedError",
  ].includes(String(error._tag));
};

const isReplacedGuestSnapshotFailure = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return false;
  return String(error._tag) === "PreviewWebContentsNotFoundError";
};
const encodeUnknownJson = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);
const DEFAULT_ANNOTATION_THEME: DesktopPreviewAnnotationTheme = {
  colorScheme: "light",
  radius: "0.625rem",
  background: "white",
  foreground: "oklch(0.269 0 0)",
  popover: "white",
  popoverForeground: "oklch(0.269 0 0)",
  primary: "oklch(0.488 0.217 264)",
  primaryForeground: "white",
  muted: "rgb(0 0 0 / 4%)",
  mutedForeground: "oklch(0.556 0 0)",
  accent: "rgb(0 0 0 / 4%)",
  accentForeground: "oklch(0.269 0 0)",
  border: "rgb(0 0 0 / 8%)",
  input: "rgb(0 0 0 / 10%)",
  ring: "oklch(0.488 0.217 264)",
  fontSans: "system-ui, sans-serif",
  fontMono: "ui-monospace, monospace",
};

export const buildPreviewPictureInPictureDataUrl = (): string => {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    >
    <meta name="color-scheme" content="dark">
    <style>
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #111; }
      body { display: grid; place-items: center; }
      img { width: 100%; height: 100%; object-fit: contain; user-select: none; -webkit-user-drag: none; }
    </style>
  </head>
  <body>
    <img id="preview-frame" alt="Live browser preview">
    <script>
      const frame = document.getElementById("preview-frame");
      window.previewPictureInPicture.onFrame((next) => {
        frame.src = "data:image/jpeg;base64," + next.data;
      });
    </script>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
};

export const fitPictureInPictureContentSize = (
  current: ReadonlyArray<number>,
  aspectRatio: number,
): readonly [width: number, height: number] => {
  const currentWidth = Math.max(1, current[0] ?? PICTURE_IN_PICTURE_INITIAL_WIDTH);
  const currentHeight = Math.max(1, current[1] ?? PICTURE_IN_PICTURE_INITIAL_HEIGHT);
  const currentArea = currentWidth * currentHeight;
  let width = Math.sqrt(currentArea * aspectRatio);
  let height = width / aspectRatio;
  const minimumScale = Math.max(
    1,
    PICTURE_IN_PICTURE_MIN_WIDTH / width,
    PICTURE_IN_PICTURE_MIN_HEIGHT / height,
  );
  width *= minimumScale;
  height *= minimumScale;
  return [Math.round(width), Math.round(height)];
};

const artifactSiteSlug = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl);
    const slug = url.hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_ARTIFACT_SITE_SLUG_LENGTH)
      .replace(/-+$/g, "");
    return slug || "site";
  } catch {
    return "site";
  }
};

interface CdpEvaluationResult {
  readonly result?: {
    readonly value?: unknown;
    readonly description?: string;
    readonly objectId?: string;
  };
  readonly exceptionDetails?: {
    readonly text?: string;
    readonly exception?: { readonly description?: string };
  };
}

export const PreviewAutomationSelectorKind = Schema.Literals([
  "focused-element",
  "selector",
  "locator",
]);
export type PreviewAutomationSelectorKind = typeof PreviewAutomationSelectorKind.Type;

export const PreviewAutomationEvaluationDetailKind = Schema.Literals([
  "exception-description",
  "exception-text",
  "unknown",
]);
export type PreviewAutomationEvaluationDetailKind =
  typeof PreviewAutomationEvaluationDetailKind.Type;

const previewAutomationEvaluationDetail = (exceptionDetails: unknown) => {
  if (typeof exceptionDetails !== "object" || exceptionDetails === null) {
    return { detailKind: "unknown" as const };
  }
  const details = exceptionDetails as Record<string, unknown>;
  const exception = details["exception"];
  const description =
    typeof exception === "object" &&
    exception !== null &&
    typeof (exception as Record<string, unknown>)["description"] === "string"
      ? (exception as Record<string, unknown>)["description"]
      : undefined;
  if (typeof description === "string" && description.length > 0) {
    return { detailKind: "exception-description" as const, detail: description };
  }
  const text = details["text"];
  if (typeof text === "string" && text.length > 0) {
    return { detailKind: "exception-text" as const, detail: text };
  }
  return { detailKind: "unknown" as const };
};

const previewAutomationTargetLabel = (
  selectorKind: PreviewAutomationSelectorKind,
  selectorLength?: number,
) =>
  selectorKind === "focused-element"
    ? "the focused element"
    : `${selectorKind} (${selectorLength ?? 0} characters)`;

interface PreviewOperationContext {
  readonly operation: string;
  readonly tabId?: string;
  readonly webContentsId?: number;
  readonly artifactPath?: string;
}

const normalizeCaptureRect = (value: unknown): PreviewAnnotationRect | null => {
  if (typeof value !== "object" || value === null) return null;
  const rect = value as Record<string, unknown>;
  const x = rect["x"];
  const y = rect["y"];
  const width = rect["width"];
  const height = rect["height"];
  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    typeof y !== "number" ||
    !Number.isFinite(y) ||
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return {
    x: Math.max(0, Math.floor(x)),
    y: Math.max(0, Math.floor(y)),
    width: Math.max(1, Math.ceil(width)),
    height: Math.max(1, Math.ceil(height)),
  };
};

const captureAnnotationScreenshot = (
  tabId: string,
  wc: Electron.WebContents,
  cropRect: PreviewAnnotationRect | null,
): Effect.Effect<PreviewAnnotationPayload["screenshot"], PreviewManagerError> =>
  Effect.tryPromise({
    try: () =>
      wc.capturePage(
        cropRect
          ? {
              x: cropRect.x,
              y: cropRect.y,
              width: cropRect.width,
              height: cropRect.height,
            }
          : undefined,
      ),
    catch: (cause) =>
      new PreviewOperationError({
        operation: "captureAnnotationScreenshot",
        tabId,
        webContentsId: wc.id,
        cause,
      }),
  }).pipe(
    Effect.map((image) => {
      const size = image.getSize();
      return {
        dataUrl: image.toDataURL(),
        width: size.width,
        height: size.height,
        cropRect: cropRect ?? { x: 0, y: 0, width: size.width, height: size.height },
      };
    }),
  );

const findZoomStep = (current: number): number => {
  const index = ZOOM_LEVELS.findIndex(
    (level) => Math.abs(level - current) < ZOOM_EPSILON || level > current,
  );
  if (index < 0) return ZOOM_LEVELS.length - 1;
  return Math.abs(ZOOM_LEVELS[index]! - current) < ZOOM_EPSILON ? index : index - 1;
};

const nextZoomLevel = (current: number, direction: "in" | "out"): number => {
  const step = findZoomStep(current);
  if (direction === "in") {
    return ZOOM_LEVELS[Math.min(step + 1, ZOOM_LEVELS.length - 1)] ?? current;
  }
  return ZOOM_LEVELS[Math.max(step - 1, 0)] ?? current;
};

type Listener = (tabId: string, state: PreviewTabState) => Effect.Effect<void>;
type RecordingFrameListener = (frame: DesktopPreviewRecordingFrame) => Effect.Effect<void>;
type NewTabRequestListener = (request: DesktopPreviewNewTabRequest) => Effect.Effect<void>;

type PreviewInputSignal =
  | { readonly kind: "pointer"; readonly x: number; readonly y: number; readonly button: number }
  | { readonly kind: "key"; readonly key: string; readonly code: string };

interface ManagedListeners {
  readonly scope: Scope.Closeable;
  /** Completes before this guest is detached, replaced, closed, or destroyed. */
  readonly unavailable: Deferred.Deferred<void>;
}

type FrameCaptureConsumer = "picture-in-picture" | "recording";

interface FrameCaptureSession {
  readonly scope: Scope.Closeable;
  readonly consumers: ReadonlySet<FrameCaptureConsumer>;
}

interface PictureInPictureSession {
  readonly window: BrowserWindow;
  readonly webContentsId: number;
  readonly ready: Deferred.Deferred<void, PreviewManagerError>;
  readonly initializationScope: Scope.Closeable;
}

interface PickSession {
  readonly cancel: Effect.Effect<void>;
}

interface BrowserControlSession {
  readonly webContentsId: number;
  readonly semaphore: Semaphore.Semaphore;
  readonly scope: Scope.Closeable;
  debuggerAttachedByManager: boolean;
  detachRequested: boolean;
  readonly onMessage: (
    event: Electron.Event,
    method: string,
    params: Record<string, unknown>,
  ) => void;
  readonly onDetach: (event: Electron.Event, reason: string) => void;
}

interface PlaywrightExecutionContext {
  readonly webContentsId: number;
  readonly executionContextId: number;
}

interface DebuggerEvaluationOptions {
  readonly returnByValue: boolean;
  readonly awaitPromise?: boolean;
  readonly userGesture?: boolean;
  readonly contextId?: number | undefined;
}

interface BrowserDiagnostics {
  readonly consoleEntries: ReadonlyArray<PreviewAutomationConsoleEntry>;
  readonly networkEntries: ReadonlyArray<PreviewAutomationNetworkEntry>;
  readonly requests: ReadonlyMap<string, { url: string; method: string }>;
}

type PointerEventListener = (event: DesktopPreviewPointerEvent) => Effect.Effect<void>;

interface ExpectedAgentInput {
  readonly signal: PreviewInputSignal;
  readonly expiresAt: number;
}

const APP_FORWARDED_SHORTCUTS: ReadonlyArray<{
  key: string;
  meta: boolean;
  shift: boolean;
  control: boolean;
}> = Object.freeze([
  // mod+shift+J → preview.toggle
  { key: "j", meta: true, shift: true, control: false },
  // mod+K → command palette
  { key: "k", meta: true, shift: false, control: false },
  // mod+, → settings (macOS convention)
  { key: ",", meta: true, shift: false, control: false },
  // mod+W → close tab/panel
  { key: "w", meta: true, shift: false, control: false },
]);

const isPreviewInputSignal = (value: unknown): value is PreviewInputSignal => {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  if (value.kind === "pointer") {
    return (
      "x" in value &&
      typeof value.x === "number" &&
      "y" in value &&
      typeof value.y === "number" &&
      "button" in value &&
      typeof value.button === "number"
    );
  }
  return (
    value.kind === "key" &&
    "key" in value &&
    typeof value.key === "string" &&
    "code" in value &&
    typeof value.code === "string"
  );
};

const inputSignalsMatch = (left: PreviewInputSignal, right: PreviewInputSignal): boolean => {
  if (left.kind !== right.kind) return false;
  if (left.kind === "pointer" && right.kind === "pointer") {
    return (
      Math.abs(left.x - right.x) <= 1 &&
      Math.abs(left.y - right.y) <= 1 &&
      left.button === right.button
    );
  }
  return (
    left.kind === "key" &&
    right.kind === "key" &&
    left.key === right.key &&
    left.code === right.code
  );
};

const makeNativeOperations = Effect.fn("PreviewManager.makeOperations")(function* (
  artifactDirectory: string,
  pictureInPicturePreloadPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const browserSession = yield* BrowserSession.BrowserSession;
  const hostPlatform = yield* HostProcessPlatform;
  const path = yield* Path.Path;
  const parentScope = yield* Scope.Scope;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const resolvedArtifactDirectory = path.resolve(artifactDirectory);
  const playwrightInstallExpression = yield* Effect.cached(
    playwrightInjectedRuntimeInstallExpression(),
  );

  const annotationThemeRef = yield* Ref.make(DEFAULT_ANNOTATION_THEME);
  const mainWindowRef = yield* Ref.make<Option.Option<BrowserWindow>>(Option.none());
  const tabsRef = yield* SynchronizedRef.make<ReadonlyMap<string, PreviewTabState>>(new Map());
  const attachedRef = yield* Ref.make<ReadonlyMap<number, ManagedListeners>>(new Map());
  const listenersRef = yield* Ref.make<ReadonlySet<Listener>>(new Set());
  const pointerEventListenersRef = yield* Ref.make<ReadonlySet<PointerEventListener>>(new Set());
  const newTabRequestListenersRef = yield* Ref.make<ReadonlySet<NewTabRequestListener>>(new Set());
  const recordingFrameListenersRef = yield* Ref.make<ReadonlySet<RecordingFrameListener>>(
    new Set(),
  );
  const pickSessionsRef = yield* Ref.make<ReadonlyMap<string, PickSession>>(new Map());
  const controlSessionsRef = yield* SynchronizedRef.make<
    ReadonlyMap<number, BrowserControlSession>
  >(new Map());
  const diagnosticsRef = yield* Ref.make<ReadonlyMap<number, BrowserDiagnostics>>(new Map());
  /**
   * Where the user last deliberately put their keyboard: the app's own window,
   * or a guest page they clicked into. Only their own clicks move this — an
   * agent's do not, so automation cannot quietly reassign the keyboard.
   */
  let userFocusIntent: "app" | "guest" = "app";
  /** Non-zero while an agent holds the automation turn. See {@link shouldReclaimGuestKeyForApp}. */
  let automationTurnsInFlight = 0;
  const expectedAgentInputsRef = yield* Ref.make<
    ReadonlyMap<string, ReadonlyArray<ExpectedAgentInput>>
  >(new Map());
  const controlEpochRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const actionTimelineRef = yield* Ref.make<
    ReadonlyMap<string, ReadonlyArray<PreviewAutomationActionEvent>>
  >(new Map());
  const actionSequenceRef = yield* Ref.make(0);
  const navigationSequenceRef = yield* Ref.make(0);
  const navigationAttemptsByTab = new Map<string, NavigationAttempt>();
  const pointerSequenceRef = yield* Ref.make(0);
  const frameCaptureSessionsRef = yield* SynchronizedRef.make<
    ReadonlyMap<string, FrameCaptureSession>
  >(new Map());
  const snapshotStageRequestsRef = yield* Ref.make<
    ReadonlyMap<
      string,
      {
        readonly tabId: string;
        readonly ready: Deferred.Deferred<void>;
      }
    >
  >(new Map());
  const snapshotStageSequenceRef = yield* Ref.make(0);
  const activityLeases = new PreviewActivityLeases();
  let forwardedPushToTalkActive = false;
  // The renderer releases its visible-surface lease through React + IPC after
  // BrowserWindow blur. Track native focus too so a snapshot cannot mistake
  // that short handoff window for a currently presented compositor surface.
  let mainWindowFocused = true;
  // Kept separate from shortcut forwarding so a forwarded key-up cannot open
  // the automation gate before the main window records its release timestamp.
  let pushToTalkInputActive = false;
  let pushToTalkInputGeneration = 0;
  /** Epoch millis of the last key the user pressed in the app's own window. */
  let lastUserInputAtMs = 0;
  const recordActivityLeaseMetrics = Effect.fn("PreviewManager.recordActivityLeaseMetrics")(
    function* () {
      const snapshot = activityLeases.snapshot();
      for (const consumer of Object.values(PreviewActivityConsumer)) {
        yield* Metric.update(
          Metric.withAttributes(previewActivityLeasesCurrent, [["consumer", consumer]]),
          snapshot.byConsumer.get(consumer) ?? 0,
        );
      }
    },
  );
  const pictureInPictureSessionsRef = yield* SynchronizedRef.make<
    ReadonlyMap<string, PictureInPictureSession>
  >(new Map());
  const pictureInPictureAspectRatiosRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const pictureInPictureMutationSemaphore = yield* Semaphore.make(1);
  /**
   * One agent at a time may hold the keyboard and pointer. Concurrent agents
   * used to interleave their clicks and keystrokes into whichever window
   * happened to be focused at that instant; now they line up and each gets the
   * caret to itself for the length of one action.
   */
  const automationInputMutex = yield* Semaphore.make(1);
  const automationForegroundMutationMutex = yield* Semaphore.make(1);
  let automationForegroundActive = false;
  let automationForegroundExpiryFiber: Fiber.Fiber<void, never> | undefined;
  const automationForegroundWebContentsIds = new Set<number>();
  const closingTabIdsRef = yield* Ref.make<ReadonlySet<string>>(new Set());
  const playwrightExecutionContexts = new Map<string, PlaywrightExecutionContext>();
  const playwrightExecutionContextGenerations = new Map<string, number>();
  const tabLifecycleLocks = new Map<
    string,
    { readonly semaphore: Semaphore.Semaphore; users: number }
  >();
  const tabLifecycleGenerations = new Map<string, number>();
  const attempt = <A>(errorContext: PreviewOperationContext, evaluate: () => A) =>
    Effect.try({
      try: evaluate,
      catch: (cause) => new PreviewOperationError({ ...errorContext, cause }),
    });
  const attemptPromise = <A>(
    errorContext: PreviewOperationContext,
    evaluate: () => PromiseLike<A>,
  ) =>
    Effect.tryPromise({
      try: evaluate,
      catch: (cause) => new PreviewOperationError({ ...errorContext, cause }),
    });
  const attemptPromiseWithin = <A>(
    errorContext: PreviewOperationContext,
    evaluate: () => PromiseLike<A>,
    timeoutMs: number,
  ) =>
    attemptPromise(errorContext, () => {
      const timeout = AbortSignal.timeout(timeoutMs);
      return new Promise<A>((resolve, reject) => {
        const onTimeout = () => reject(timeout.reason);
        timeout.addEventListener("abort", onTimeout, { once: true });
        try {
          Promise.resolve(evaluate()).then(
            (value) => {
              timeout.removeEventListener("abort", onTimeout);
              resolve(value);
            },
            (cause) => {
              timeout.removeEventListener("abort", onTimeout);
              reject(cause);
            },
          );
        } catch (cause) {
          timeout.removeEventListener("abort", onTimeout);
          reject(cause);
        }
      });
    });
  const currentIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const currentMillis = Clock.currentTimeMillis;
  const encodeJson = (errorContext: PreviewOperationContext, value: unknown) =>
    encodeUnknownJson(value).pipe(
      Effect.mapError((cause) => new PreviewOperationError({ ...errorContext, cause })),
    );
  const nextCounter = (ref: Ref.Ref<number>) =>
    Ref.modify(ref, (value) => [value, value + 1] as const);
  const replaceMap = <K, V>(
    source: ReadonlyMap<K, V>,
    update: (copy: Map<K, V>) => void,
  ): ReadonlyMap<K, V> => {
    const copy = new Map(source);
    update(copy);
    return copy;
  };
  const invalidatePlaywrightExecutionContext = (tabId: string, webContentsId?: number): void => {
    const current = playwrightExecutionContexts.get(tabId);
    if (webContentsId !== undefined && current && current.webContentsId !== webContentsId) return;
    playwrightExecutionContexts.delete(tabId);
    playwrightExecutionContextGenerations.set(
      tabId,
      (playwrightExecutionContextGenerations.get(tabId) ?? 0) + 1,
    );
  };
  const invalidateDestroyedPlaywrightExecutionContext = (
    tabId: string,
    webContentsId: number,
    executionContextId: unknown,
  ): void => {
    const current = playwrightExecutionContexts.get(tabId);
    if (
      !current ||
      current.webContentsId !== webContentsId ||
      current.executionContextId !== executionContextId
    ) {
      return;
    }
    invalidatePlaywrightExecutionContext(tabId, webContentsId);
  };
  const withTabLifecycleLock = <A, E, R>(
    tabId: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const lifecycle = tabLifecycleLocks.get(tabId) ?? {
        semaphore: Semaphore.makeUnsafe(1),
        users: 0,
      };
      lifecycle.users += 1;
      tabLifecycleLocks.set(tabId, lifecycle);
      return lifecycle.semaphore.withPermit(effect).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            lifecycle.users -= 1;
            if (lifecycle.users === 0 && tabLifecycleLocks.get(tabId) === lifecycle) {
              tabLifecycleLocks.delete(tabId);
            }
          }),
        ),
      );
    });
  const stopFrameCapture = Effect.fn("PreviewManager.stopFrameCapture")(function* (
    tabId: string,
    consumer: FrameCaptureConsumer,
  ) {
    const captureScope = yield* SynchronizedRef.modify(frameCaptureSessionsRef, (sessions) => {
      const current = sessions.get(tabId);
      if (!current || !current.consumers.has(consumer)) {
        return [undefined, sessions] as const;
      }
      const consumers = new Set(current.consumers);
      consumers.delete(consumer);
      if (consumers.size > 0) {
        return [
          undefined,
          replaceMap(sessions, (copy) => {
            copy.set(tabId, { ...current, consumers });
          }),
        ] as const;
      }
      return [
        current.scope,
        replaceMap(sessions, (copy) => {
          copy.delete(tabId);
        }),
      ] as const;
    });
    if (captureScope) {
      yield* Scope.close(captureScope, Exit.void).pipe(Effect.ignore);
    }
    activityLeases.release(tabId, `frame-capture:${consumer}`);
    yield* recordActivityLeaseMetrics();
  });

  const deliverEvent = (
    eventKind: "state-change" | "recording-frame" | "pointer-event" | "new-tab-request",
    tabId: string,
    delivery: () => Effect.Effect<void>,
  ) =>
    Effect.suspend(delivery).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("Desktop preview event listener failed.", {
              eventKind,
              tabId,
              cause,
            }),
      ),
    );

  const emit = Effect.fn("PreviewManager.emit")(function* (tabId: string, state: PreviewTabState) {
    const listeners = yield* Ref.get(listenersRef);
    yield* Effect.forEach(
      listeners,
      (listener) => deliverEvent("state-change", tabId, () => listener(tabId, state)),
      { discard: true },
    );
  });

  const emitNewTabRequest = Effect.fn("PreviewManager.emitNewTabRequest")(function* (
    request: DesktopPreviewNewTabRequest,
  ) {
    const listeners = yield* Ref.get(newTabRequestListenersRef);
    yield* Effect.forEach(
      listeners,
      (listener) => deliverEvent("new-tab-request", request.sourceTabId, () => listener(request)),
      { discard: true },
    );
  });

  const update = Effect.fn("PreviewManager.update")(function* (
    tabId: string,
    patch: Partial<PreviewTabState>,
  ) {
    const updatedAt = yield* currentIso;
    const next = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
      const current = tabs.get(tabId);
      if (!current) return [Option.none<PreviewTabState>(), tabs] as const;
      const state: PreviewTabState = { ...current, ...patch, updatedAt };
      return [
        Option.some(state),
        replaceMap(tabs, (copy) => {
          copy.set(tabId, state);
        }),
      ] as const;
    });
    if (Option.isSome(next)) yield* emit(tabId, next.value);
  });

  /**
   * Moves the "an agent is working here" mark onto one tab and off every other.
   *
   * Kept separate from `controller`, which is only "agent" while a single CDP
   * command is in flight and is back to "none" between them — a tab strip
   * watching it saw a flicker and nothing else. This mark survives between an
   * agent's actions and is only handed to another tab, so at most one tab ever
   * claims to be the one an agent is in.
   */
  const markAgentWorkingTab = Effect.fn("PreviewManager.markAgentWorkingTab")(function* (
    tabId: string,
  ) {
    const tabs = yield* SynchronizedRef.get(tabsRef);
    if (tabs.get(tabId)?.agentActive !== true) {
      yield* update(tabId, { agentActive: true });
    }
    for (const [otherTabId, tab] of tabs) {
      if (otherTabId !== tabId && tab.agentActive) {
        yield* update(otherTabId, { agentActive: false });
      }
    }
  });

  /** Newest-first, and short: this is a notice, not a download history. */
  const TAB_DOWNLOAD_LIMIT = 5;
  /** Short enough to feel immediate once the user answers. */
  const WAIT_FOR_DOWNLOAD_POLL_MS = 250;
  browserSession.onDownload((webContentsId, download) => {
    runFork(
      Effect.gen(function* () {
        const tabs = yield* SynchronizedRef.get(tabsRef);
        // The guest that started it owns the notice, so it appears on the tab
        // that fetched the file rather than wherever the user happens to be.
        const entry = [...tabs.entries()].find(([, tab]) => tab.webContentsId === webContentsId);
        if (!entry) return;
        const [tabId, tab] = entry;
        yield* update(tabId, {
          downloads: [download, ...tab.downloads].slice(0, TAB_DOWNLOAD_LIMIT),
        });
      }),
    );
  });

  browserSession.onDownloadApproval((webContentsId, event) => {
    runFork(
      Effect.gen(function* () {
        const tabs = yield* SynchronizedRef.get(tabsRef);
        if (event.kind === "pending") {
          // The guest that asked for the file owns the question, so the card
          // appears on that tab rather than wherever the user happens to be.
          const entry = [...tabs.entries()].find(([, tab]) => tab.webContentsId === webContentsId);
          if (!entry) return;
          const [tabId, tab] = entry;
          yield* update(tabId, {
            pendingDownloadApprovals: [...tab.pendingDownloadApprovals, event.approval],
          });
          return;
        }
        // Settling searches every tab: the guest may already be gone by the
        // time an answer lands, and a card that outlives its download would
        // never clear.
        for (const [tabId, tab] of tabs) {
          if (!tab.pendingDownloadApprovals.some((held) => held.id === event.id)) continue;
          yield* update(tabId, {
            pendingDownloadApprovals: tab.pendingDownloadApprovals.filter(
              (held) => held.id !== event.id,
            ),
          });
        }
      }),
    );
  });

  const requireWebContents = Effect.fn("PreviewManager.requireWebContents")(function* (
    tabId: string,
  ) {
    const tabs = yield* SynchronizedRef.get(tabsRef);
    const tab = tabs.get(tabId);
    if (!tab) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    if (tab.webContentsId == null) {
      return yield* new PreviewWebviewNotInitializedError({ tabId });
    }
    const wc = webContents.fromId(tab.webContentsId);
    if (!wc || wc.isDestroyed()) {
      return yield* new PreviewWebContentsNotFoundError({
        tabId,
        webContentsId: tab.webContentsId,
      });
    }
    return wc;
  });

  const ensureCurrentWebContents = Effect.fn("PreviewManager.ensureCurrentWebContents")(function* (
    tabId: string,
    wc: Electron.WebContents,
  ) {
    const webContentsId = wc.id;
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab || (yield* Ref.get(closingTabIdsRef)).has(tabId)) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    if (tab.webContentsId !== webContentsId || wc.isDestroyed()) {
      return yield* new PreviewWebContentsNotFoundError({ tabId, webContentsId });
    }
  });

  const failWhenWebContentsUnavailable = Effect.fn("PreviewManager.failWhenWebContentsUnavailable")(
    function* (tabId: string, webContentsId: number) {
      const managed = (yield* Ref.get(attachedRef)).get(webContentsId);
      if (!managed) {
        return yield* new PreviewWebContentsNotFoundError({ tabId, webContentsId });
      }
      yield* Deferred.await(managed.unavailable);
      return yield* new PreviewWebContentsNotFoundError({ tabId, webContentsId });
    },
  );

  const whileWebContentsAvailable = <A, E, R>(
    tabId: string,
    wc: Electron.WebContents,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | PreviewManagerError, R> =>
    Effect.gen(function* () {
      yield* ensureCurrentWebContents(tabId, wc);
      return yield* Effect.raceFirst(effect, failWhenWebContentsUnavailable(tabId, wc.id));
    });

  const markWebContentsUnavailable = Effect.fn("PreviewManager.markWebContentsUnavailable")(
    function* (webContentsId: number) {
      const managed = (yield* Ref.get(attachedRef)).get(webContentsId);
      if (managed) yield* Deferred.succeed(managed.unavailable, undefined);
    },
  );

  const resolveArtifactPath = (artifactPath: string) =>
    attempt({ operation: "resolveArtifactPath", artifactPath }, () => {
      const resolvedPath = path.resolve(artifactPath);
      const relativePath = path.relative(resolvedArtifactDirectory, resolvedPath);
      if (
        relativePath.length === 0 ||
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
      ) {
        return null;
      }
      return resolvedPath;
    }).pipe(
      Effect.flatMap((resolvedPath) =>
        resolvedPath === null
          ? Effect.fail(
              new PreviewArtifactPathOutsideDirectoryError({
                artifactPath,
                artifactDirectory: resolvedArtifactDirectory,
              }),
            )
          : Effect.succeed(resolvedPath),
      ),
    );

  const tabIdForWebContents = Effect.fnUntraced(function* (webContentsId: number) {
    const tabs = yield* SynchronizedRef.get(tabsRef);
    return (
      Array.from(tabs.entries()).find(([, tab]) => tab.webContentsId === webContentsId)?.[0] ?? null
    );
  });

  const pushBounded = <A>(buffer: ReadonlyArray<A>, entry: A): ReadonlyArray<A> =>
    [...buffer, entry].slice(-DIAGNOSTIC_BUFFER_LIMIT);

  const captureDiagnosticMessage = Effect.fnUntraced(function* (
    webContentsId: number,
    method: string,
    params: Record<string, unknown>,
  ) {
    const timestamp = yield* currentIso;
    yield* Ref.update(diagnosticsRef, (allDiagnostics) => {
      const current = allDiagnostics.get(webContentsId);
      if (!current) return allDiagnostics;
      const requestId = typeof params["requestId"] === "string" ? params["requestId"] : null;
      const next = (() => {
        if (method === "Runtime.consoleAPICalled") {
          const args = Array.isArray(params["args"]) ? params["args"] : [];
          const text = args
            .map((arg) => {
              if (typeof arg !== "object" || arg === null) return String(arg);
              const value = arg as Record<string, unknown>;
              return String(value["value"] ?? value["description"] ?? "");
            })
            .join(" ");
          return {
            ...current,
            consoleEntries: pushBounded(current.consoleEntries, {
              level: typeof params["type"] === "string" ? params["type"] : "log",
              text,
              timestamp,
              source: "console",
            }),
          };
        }
        if (method === "Runtime.exceptionThrown") {
          const details =
            typeof params["exceptionDetails"] === "object" && params["exceptionDetails"] !== null
              ? (params["exceptionDetails"] as Record<string, unknown>)
              : {};
          return {
            ...current,
            consoleEntries: pushBounded(current.consoleEntries, {
              level: "error",
              text: String(details["text"] ?? "Uncaught exception"),
              timestamp,
              source: "exception",
            }),
          };
        }
        if (method === "Log.entryAdded") {
          const entry =
            typeof params["entry"] === "object" && params["entry"] !== null
              ? (params["entry"] as Record<string, unknown>)
              : {};
          return {
            ...current,
            consoleEntries: pushBounded(current.consoleEntries, {
              level: typeof entry["level"] === "string" ? entry["level"] : "info",
              text: String(entry["text"] ?? ""),
              timestamp,
              source: typeof entry["source"] === "string" ? entry["source"] : "log",
            }),
          };
        }
        if (method === "Network.requestWillBeSent" && requestId) {
          const request =
            typeof params["request"] === "object" && params["request"] !== null
              ? (params["request"] as Record<string, unknown>)
              : {};
          return {
            ...current,
            requests: replaceMap(current.requests, (copy) => {
              copy.set(requestId, {
                url: String(request["url"] ?? ""),
                method: String(request["method"] ?? "GET"),
              });
            }),
          };
        }
        if (method === "Network.responseReceived" && requestId) {
          const request = current.requests.get(requestId);
          const response =
            typeof params["response"] === "object" && params["response"] !== null
              ? (params["response"] as Record<string, unknown>)
              : {};
          const status = typeof response["status"] === "number" ? response["status"] : null;
          const classification =
            status === null ? null : classifyPreviewNetworkResponse(status, response["headers"]);
          return request && status !== null && classification?.record
            ? {
                ...current,
                networkEntries: pushBounded(current.networkEntries, {
                  ...request,
                  status,
                  failed: classification.failed,
                  ...(classification.cfMitigated ? { cfMitigated: true } : {}),
                  timestamp,
                }),
              }
            : current;
        }
        if (method === "Network.loadingFailed" && requestId) {
          const request = current.requests.get(requestId);
          return {
            ...current,
            requests: replaceMap(current.requests, (copy) => {
              copy.delete(requestId);
            }),
            networkEntries: request
              ? pushBounded(current.networkEntries, {
                  ...request,
                  status: null,
                  failed: true,
                  errorText: String(params["errorText"] ?? "Network request failed"),
                  timestamp,
                })
              : current.networkEntries,
          };
        }
        if (method === "Network.loadingFinished" && requestId) {
          return {
            ...current,
            requests: replaceMap(current.requests, (copy) => {
              copy.delete(requestId);
            }),
          };
        }
        return current;
      })();
      return replaceMap(allDiagnostics, (copy) => {
        copy.set(webContentsId, next);
      });
    });
  });

  const detachControlSession = Effect.fn("PreviewManager.detachControlSession")(function* (
    webContentsId: number,
  ) {
    const control = yield* SynchronizedRef.modify(controlSessionsRef, (sessions) => [
      sessions.get(webContentsId),
      replaceMap(sessions, (copy) => {
        copy.delete(webContentsId);
      }),
    ]);
    if (control) {
      yield* Scope.close(control.scope, Exit.void).pipe(Effect.ignore);
    }
  });

  const clearWebContentsDiagnostics = (webContentsId: number) =>
    Ref.update(diagnosticsRef, (diagnostics) =>
      replaceMap(diagnostics, (copy) => {
        copy.delete(webContentsId);
      }),
    );

  const hasControlActivity = (tabId: string): boolean =>
    activityLeases.has(tabId, PreviewActivityConsumer.Automation) ||
    activityLeases.has(tabId, PreviewActivityConsumer.Diagnostics);

  const detachControlSessionIfIdle = Effect.fn("PreviewManager.detachControlSessionIfIdle")(
    function* (tabId: string, webContentsId: number) {
      if (hasControlActivity(tabId)) return;
      const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
      if (tab?.webContentsId !== webContentsId || tab.colorScheme !== "system") return;
      yield* detachControlSession(webContentsId);
    },
  );

  const ensureControlSession = Effect.fn("PreviewManager.ensureControlSession")(function* (
    tabId: string,
    wc: Electron.WebContents,
  ) {
    yield* ensureCurrentWebContents(tabId, wc);
    return yield* SynchronizedRef.modifyEffect(
      controlSessionsRef,
      (
        sessions,
      ): Effect.Effect<
        readonly [BrowserControlSession, ReadonlyMap<number, BrowserControlSession>],
        PreviewManagerError
      > => {
        if (wc.isDestroyed()) {
          return Effect.fail(new PreviewWebContentsNotFoundError({ tabId, webContentsId: wc.id }));
        }
        const existing = sessions.get(wc.id);
        if (wc.isDevToolsOpened()) {
          return Effect.fail(
            new PreviewAutomationDevToolsOpenError({
              webContentsId: wc.id,
            }),
          );
        }
        if (existing?.debuggerAttachedByManager) {
          return Effect.succeed([existing, sessions] as const);
        }
        if (wc.debugger.isAttached()) {
          return Effect.fail(
            new PreviewAutomationDebuggerAttachedError({
              webContentsId: wc.id,
            }),
          );
        }
        const createControlSession = Effect.fn("PreviewManager.createControlSession")(function* () {
          if (existing) {
            yield* Scope.close(existing.scope, Exit.void).pipe(Effect.ignore);
          }
          const semaphore = yield* Semaphore.make(1);
          const scope = yield* Scope.fork(parentScope, "sequential");
          const handleDebuggerMessage = Effect.fnUntraced(function* (
            method: string,
            params: Record<string, unknown>,
          ) {
            if (method === "Page.screencastFrame") {
              const sessionId = params["sessionId"];
              if (typeof sessionId === "number") {
                yield* attemptPromise(
                  {
                    operation: "ackScreencastFrame",
                    webContentsId: wc.id,
                  },
                  () => wc.debugger.sendCommand("Page.screencastFrameAck", { sessionId }),
                ).pipe(Effect.ignore);
              }
              const tabId = yield* tabIdForWebContents(wc.id);
              const metadata =
                typeof params["metadata"] === "object" && params["metadata"] !== null
                  ? (params["metadata"] as Record<string, unknown>)
                  : {};
              if (tabId && typeof params["data"] === "string") {
                const captureSession = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(
                  tabId,
                );
                if (captureSession?.consumers.has("recording")) {
                  const receivedAt = yield* currentIso;
                  const listeners = yield* Ref.get(recordingFrameListenersRef);
                  const frame: DesktopPreviewRecordingFrame = {
                    tabId,
                    data: params["data"],
                    width:
                      typeof metadata["deviceWidth"] === "number" ? metadata["deviceWidth"] : 0,
                    height:
                      typeof metadata["deviceHeight"] === "number" ? metadata["deviceHeight"] : 0,
                    receivedAt,
                  };
                  yield* Effect.forEach(
                    listeners,
                    (listener) =>
                      deliverEvent("recording-frame", frame.tabId, () => listener(frame)),
                    { discard: true },
                  );
                }
              }
            }
            yield* captureDiagnosticMessage(wc.id, method, params);
          });
          const onMessage: BrowserControlSession["onMessage"] = (_event, method, params) => {
            if (method === "Runtime.executionContextDestroyed") {
              invalidateDestroyedPlaywrightExecutionContext(
                tabId,
                wc.id,
                params["executionContextId"],
              );
            } else if (method === "Runtime.executionContextsCleared") {
              invalidatePlaywrightExecutionContext(tabId, wc.id);
            }
            runFork(handleDebuggerMessage(method, params));
          };
          const onDetach: BrowserControlSession["onDetach"] = (_event, reason) => {
            control.debuggerAttachedByManager = false;
            if (control.detachRequested) return;
            // Close the availability gap synchronously. Until a replacement
            // control session is attached and focus emulation succeeds, MCP
            // status must treat this guest as not foreground-ready.
            automationForegroundWebContentsIds.delete(wc.id);
            invalidatePlaywrightExecutionContext(tabId, wc.id);
            runFork(
              automationForegroundMutationMutex
                .withPermit(
                  Effect.gen(function* () {
                    if (control.detachRequested) return;
                    const removed = yield* SynchronizedRef.modify(
                      controlSessionsRef,
                      (sessions) => {
                        if (sessions.get(wc.id) !== control) return [false, sessions] as const;
                        return [
                          true,
                          replaceMap(sessions, (copy) => {
                            copy.delete(wc.id);
                          }),
                        ] as const;
                      },
                    );
                    control.detachRequested = true;
                    yield* Scope.close(control.scope, Exit.void).pipe(Effect.ignore);
                    if (!removed) return;
                    if (!automationForegroundActive || wc.isDestroyed()) return;
                    yield* activateAutomationForegroundForTab(tabId, wc);
                    yield* recordActivityLeaseMetrics();
                  }),
                )
                .pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning(
                      "Preview debugger detached and foreground reactivation failed closed.",
                      { tabId, webContentsId: wc.id, reason, cause },
                    ),
                  ),
                ),
            );
          };
          const control: BrowserControlSession = {
            webContentsId: wc.id,
            semaphore,
            scope,
            debuggerAttachedByManager: false,
            detachRequested: false,
            onMessage,
            onDetach,
          };
          yield* Scope.addFinalizer(
            scope,
            attempt({ operation: "detachControlSession", webContentsId: wc.id }, () => {
              control.detachRequested = true;
              if (wc.isDestroyed()) return;
              wc.debugger.off("message", onMessage);
              wc.debugger.off("detach", onDetach);
              if (control.debuggerAttachedByManager && wc.debugger.isAttached()) {
                wc.debugger.detach();
              }
            }).pipe(Effect.ignore),
          );
          const initialize = Effect.fn("PreviewManager.initializeControlSession")(function* () {
            yield* Ref.update(diagnosticsRef, (diagnostics) =>
              replaceMap(diagnostics, (copy) => {
                if (!copy.has(wc.id)) {
                  copy.set(wc.id, {
                    consoleEntries: [],
                    networkEntries: [],
                    requests: new Map(),
                  });
                }
              }),
            );
            const attached = yield* Effect.exit(
              attempt({ operation: "attachDebuggerListeners", webContentsId: wc.id }, () => {
                wc.debugger.on("message", onMessage);
                wc.debugger.on("detach", onDetach);
                wc.debugger.attach("1.3");
                control.debuggerAttachedByManager = true;
              }),
            );
            if (Exit.isFailure(attached)) {
              if (wc.isDevToolsOpened()) {
                return yield* new PreviewAutomationDevToolsOpenError({ webContentsId: wc.id });
              }
              if (wc.debugger.isAttached()) {
                return yield* new PreviewAutomationDebuggerAttachedError({
                  webContentsId: wc.id,
                });
              }
              return yield* Effect.failCause(attached.cause);
            }
            const initialized = yield* Effect.exit(
              Effect.all(
                ["Runtime.enable", "Accessibility.enable", "Network.enable", "Log.enable"].map(
                  (method) =>
                    attemptPromise(
                      { operation: `initializeDebugger.${method}`, webContentsId: wc.id },
                      () => wc.debugger.sendCommand(method),
                    ),
                ),
                { concurrency: "unbounded", discard: true },
              ),
            );
            if (Exit.isFailure(initialized)) {
              if (wc.isDevToolsOpened()) {
                return yield* new PreviewAutomationDevToolsOpenError({ webContentsId: wc.id });
              }
              if (!control.debuggerAttachedByManager) {
                return yield* new PreviewAutomationDebuggerAttachedError({
                  webContentsId: wc.id,
                });
              }
              return yield* Effect.failCause(initialized.cause);
            }
            // CDP may emit detach while resolving an initialization command.
            // Do not publish a control that already lost debugger ownership;
            // the queued detach cleanup can run after this synchronized block.
            if (wc.isDevToolsOpened()) {
              return yield* new PreviewAutomationDevToolsOpenError({ webContentsId: wc.id });
            }
            if (!control.debuggerAttachedByManager) {
              return yield* new PreviewAutomationDebuggerAttachedError({
                webContentsId: wc.id,
              });
            }
            // Present the guest as a normal, non-automated browser. The manager
            // attaches this CDP debugger for screencast/mirroring and agent
            // observation, but attaching it flips navigator.webdriver to true,
            // and Google's sign-in integrity gate refuses any
            // automation-controlled browser ("this browser or app may not be
            // secure"). Because the fleet-foreground path attaches a debugger to
            // EVERY guest whenever an agent is connected, and navigator.webdriver
            // latches at document load, the user's own Google/YouTube sign-in was
            // rejected at the credential step (measured 2026-08-30: clean Chrome
            // UA, yet webdriver=true and every fresh sign-in hit /signin/rejected).
            // Sent only after debugger ownership is confirmed, so a lost init
            // race stays a no-op. Best-effort: a Chromium build without this CDP
            // method must not fail the control session.
            yield* attemptPromise(
              { operation: "initializeDebugger.setAutomationOverride", webContentsId: wc.id },
              () => wc.debugger.sendCommand("Emulation.setAutomationOverride", { enabled: false }),
            ).pipe(Effect.ignore);
            return [
              control,
              replaceMap(sessions, (copy) => {
                copy.set(wc.id, control);
              }),
            ] as const;
          });
          return yield* initialize().pipe(
            Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)),
          );
        });
        return createControlSession();
      },
    );
  });

  const isAutomationDebuggerOwnershipConflict = (
    cause: Cause.Cause<PreviewManagerError>,
  ): boolean => {
    const error = Option.getOrNull(Cause.findErrorOption(cause));
    return (
      error?._tag === "PreviewAutomationDevToolsOpenError" ||
      error?._tag === "PreviewAutomationDebuggerAttachedError"
    );
  };

  const pushAction = (tabId: string, event: PreviewAutomationActionEvent) =>
    Ref.update(actionTimelineRef, (timelines) =>
      replaceMap(timelines, (copy) => {
        copy.set(tabId, [...(timelines.get(tabId) ?? []), event].slice(-200));
      }),
    );
  const replaceAction = (tabId: string, event: PreviewAutomationActionEvent) =>
    Ref.update(actionTimelineRef, (timelines) => {
      const timeline = timelines.get(tabId);
      if (!timeline) return timelines;
      return replaceMap(timelines, (copy) => {
        copy.set(
          tabId,
          timeline.map((candidate) => (candidate.id === event.id ? event : candidate)),
        );
      });
    });

  type SendCommand = (
    method: string,
    commandParams?: Record<string, unknown>,
  ) => Effect.Effect<unknown, PreviewManagerError>;

  const prepareAutomationInput = Effect.fn("PreviewManager.prepareAutomationInput")(function* (
    send: SendCommand,
    enableRuntime: boolean,
  ) {
    yield* Effect.all(
      [
        ...(enableRuntime ? [send("Runtime.enable")] : []),
        send("Input.setIgnoreInputEvents", { ignore: false }),
      ],
      { concurrency: 2, discard: true },
    );
  });

  const withControlSession = Effect.fn("PreviewManager.withControlSession")(function* <A>(
    tabId: string,
    wc: Electron.WebContents,
    action: string,
    use: (send: SendCommand, sendCleanup: SendCommand) => Effect.Effect<A, PreviewManagerError>,
  ) {
    const sequence = yield* nextCounter(actionSequenceRef);
    const startedAt = yield* currentIso;
    const millis = yield* currentMillis;
    const actionEvent: PreviewAutomationActionEvent = {
      id: `browser-action-${millis.toString(36)}-${sequence.toString(36)}`,
      action,
      status: "running",
      startedAt,
    };
    yield* pushAction(tabId, actionEvent);
    const epoch = (yield* Ref.get(controlEpochRef)).get(tabId) ?? 0;
    activityLeases.acquire(tabId, actionEvent.id, PreviewActivityConsumer.Automation);
    yield* recordActivityLeaseMetrics();
    const finalize = Effect.fn("PreviewManager.finalizeControlAction")(function* (
      exit: Exit.Exit<A, PreviewManagerError>,
    ) {
      const completedAt = yield* currentIso;
      if (exit._tag === "Success") {
        yield* replaceAction(tabId, {
          ...actionEvent,
          status: "succeeded",
          completedAt,
        });
      } else {
        const error = Option.getOrNull(Cause.findErrorOption(exit.cause));
        const interrupted = isPreviewAutomationControlInterruptedError(error);
        const errorMessage = isPreviewOperationError(error)
          ? PreviewOperationError.toTimelineMessage(error)
          : isPreviewAutomationEvaluationError(error)
            ? PreviewAutomationEvaluationError.toTimelineMessage(error)
            : isPreviewAutomationInvalidSelectorError(error)
              ? PreviewAutomationInvalidSelectorError.toTimelineMessage(error)
              : error instanceof Error
                ? error.message
                : String(error);
        yield* replaceAction(tabId, {
          ...actionEvent,
          status: interrupted ? "interrupted" : "failed",
          completedAt,
          error: errorMessage,
        });
      }
      const tabs = yield* SynchronizedRef.get(tabsRef);
      if (tabs.has(tabId)) yield* update(tabId, { controller: "none" });
    });
    return yield* Effect.gen(function* () {
      const control = yield* whileWebContentsAvailable(tabId, wc, ensureControlSession(tabId, wc));
      const execute = Effect.fn("PreviewManager.executeControlAction")(function* () {
        yield* update(tabId, { controller: "agent" });
        // `controller` drops back to "none" the moment this command finishes,
        // so on its own it only ever flickers. Keep a sticky mark on the tab an
        // agent is working in, and take it off whichever tab held it before, so
        // exactly one tab ever answers "it is in here".
        yield* markAgentWorkingTab(tabId);
        const send: SendCommand = Effect.fn("PreviewManager.sendCommand")(
          function* (method, commandParams) {
            const before = (yield* Ref.get(controlEpochRef)).get(tabId) ?? 0;
            if (before !== epoch) {
              return yield* new PreviewAutomationControlInterruptedError({
                operation: action,
                tabId,
                webContentsId: wc.id,
              });
            }
            yield* ensureCurrentWebContents(tabId, wc);
            const result = yield* attemptPromise(
              { operation: `${action}.${method}`, tabId, webContentsId: wc.id },
              () => wc.debugger.sendCommand(method, commandParams),
            );
            yield* ensureCurrentWebContents(tabId, wc);
            const after = (yield* Ref.get(controlEpochRef)).get(tabId) ?? 0;
            if (after !== epoch) {
              return yield* new PreviewAutomationControlInterruptedError({
                operation: action,
                tabId,
                webContentsId: wc.id,
              });
            }
            return result;
          },
        );
        // Cleanup commands must still run after human input invalidates the action's
        // control epoch. Otherwise a partially dispatched input can leave Chromium
        // with a held key or focus emulation enabled for subsequent actions.
        const sendCleanup: SendCommand = Effect.fn("PreviewManager.sendCleanupCommand")(
          function* (method, commandParams) {
            yield* ensureCurrentWebContents(tabId, wc);
            return yield* attemptPromise(
              {
                operation: `${action}.cleanup.${method}`,
                tabId,
                webContentsId: wc.id,
              },
              () => wc.debugger.sendCommand(method, commandParams),
            );
          },
        );
        return yield* use(send, sendCleanup);
      });
      return yield* whileWebContentsAvailable(tabId, wc, control.semaphore.withPermit(execute()));
    }).pipe(
      Effect.onExit(finalize),
      Effect.ensuring(
        Effect.gen(function* () {
          activityLeases.release(tabId, actionEvent.id);
          yield* recordActivityLeaseMetrics();
          yield* detachControlSessionIfIdle(tabId, wc.id);
        }),
      ),
    );
  });

  const evaluateWithDebugger = <A = unknown>(
    tabId: string,
    send: SendCommand,
    expression: string,
    options: DebuggerEvaluationOptions,
  ): Effect.Effect<A, PreviewManagerError> =>
    send("Runtime.evaluate", {
      expression,
      awaitPromise: options.awaitPromise ?? true,
      returnByValue: options.returnByValue,
      userGesture: options.userGesture ?? false,
      ...(options.contextId === undefined ? {} : { contextId: options.contextId }),
    }).pipe(
      Effect.flatMap((rawResponse) => {
        const response = rawResponse as CdpEvaluationResult;
        if (!response.exceptionDetails) {
          return Effect.succeed(response.result?.value as A);
        }
        const detail = previewAutomationEvaluationDetail(response.exceptionDetails);
        return Effect.fail(
          new PreviewAutomationEvaluationError({
            tabId,
            detailKind: detail.detailKind,
            detailLength: detail.detail?.length ?? 0,
            cause: response.exceptionDetails,
          }),
        );
      }),
    );

  const automationLocator = (input: {
    readonly selector?: string | undefined;
    readonly locator?: string | undefined;
  }): string | null => input.locator ?? (input.selector ? `css=${input.selector}` : null);

  const automationSelectorDiagnostics = (input: {
    readonly selector?: string | undefined;
    readonly locator?: string | undefined;
  }): {
    readonly selectorKind: PreviewAutomationSelectorKind;
    readonly selectorLength?: number;
  } => {
    if (input.locator !== undefined) {
      return { selectorKind: "locator", selectorLength: input.locator.length };
    }
    if (input.selector !== undefined) {
      return { selectorKind: "selector", selectorLength: input.selector.length };
    }
    return { selectorKind: "focused-element" };
  };

  const ensurePlaywrightInjected = Effect.fn("PreviewManager.ensurePlaywrightInjected")(function* (
    tabId: string,
    send: SendCommand,
  ) {
    while (true) {
      const wc = yield* requireWebContents(tabId);
      const cached = playwrightExecutionContexts.get(tabId);
      if (cached?.webContentsId === wc.id) return cached.executionContextId;
      if (cached) invalidatePlaywrightExecutionContext(tabId);

      const generation = playwrightExecutionContextGenerations.get(tabId) ?? 0;
      yield* send("Page.enable");
      const frameTreeResponse = (yield* send("Page.getFrameTree")) as {
        readonly frameTree?: { readonly frame?: { readonly id?: unknown } };
      };
      const frameId = frameTreeResponse.frameTree?.frame?.id;
      if (typeof frameId !== "string" || frameId.length === 0) {
        return yield* new PreviewOperationError({
          operation: "ensurePlaywrightInjected.getMainFrame",
          tabId,
          webContentsId: wc.id,
          cause: new Error("Chromium did not return a main frame for the preview."),
        });
      }
      const isolatedWorldResponse = (yield* send("Page.createIsolatedWorld", {
        frameId,
        worldName: "t3-preview-playwright",
      })) as { readonly executionContextId?: unknown };
      const executionContextId = isolatedWorldResponse.executionContextId;
      if (typeof executionContextId !== "number") {
        return yield* new PreviewOperationError({
          operation: "ensurePlaywrightInjected.createIsolatedWorld",
          tabId,
          webContentsId: wc.id,
          cause: new Error("Chromium did not create a utility-world execution context."),
        });
      }
      const expression = yield* playwrightInstallExpression.pipe(
        Effect.mapError(
          (cause) =>
            new PreviewOperationError({
              operation: "ensurePlaywrightInjected",
              tabId,
              webContentsId: wc.id,
              cause,
            }),
        ),
      );
      yield* evaluateWithDebugger<boolean>(tabId, send, expression, {
        returnByValue: true,
        contextId: executionContextId,
      });
      yield* ensureCurrentWebContents(tabId, wc);
      if (generation !== (playwrightExecutionContextGenerations.get(tabId) ?? 0)) continue;
      playwrightExecutionContexts.set(tabId, {
        webContentsId: wc.id,
        executionContextId,
      });
      return executionContextId;
    }
  });

  const cancelPickElement = Effect.fn("PreviewManager.cancelPickElement")(function* (
    tabId: string,
  ) {
    const session = (yield* Ref.get(pickSessionsRef)).get(tabId);
    if (session) yield* session.cancel;
  });

  const detachListeners = Effect.fn("PreviewManager.detachListeners")(function* (
    webContentsId: number,
  ) {
    const managed = yield* Ref.modify(attachedRef, (attached) => [
      attached.get(webContentsId),
      replaceMap(attached, (copy) => {
        copy.delete(webContentsId);
      }),
    ]);
    if (managed) {
      yield* Deferred.succeed(managed.unavailable, undefined);
      yield* Scope.close(managed.scope, Exit.void).pipe(Effect.ignore);
    }
  });

  const handleWebContentsDestroyed = Effect.fn("PreviewManager.handleWebContentsDestroyed")(
    function* (tabId: string, webContentsId: number) {
      // Wake any action blocked on Chromium before closing its debugger/listener
      // scopes. This prevents teardown from leaving an in-flight Promise holding
      // the dead Electron wrapper until a command timeout fires.
      invalidatePlaywrightExecutionContext(tabId, webContentsId);
      automationForegroundWebContentsIds.delete(webContentsId);
      yield* markWebContentsUnavailable(webContentsId);
      const updatedAt = yield* currentIso;
      const next = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
        const current = tabs.get(tabId);
        if (current?.webContentsId !== webContentsId) {
          return [Option.none<PreviewTabState>(), tabs] as const;
        }
        const state: PreviewTabState = {
          ...current,
          webContentsId: null,
          snapshotStageId: null,
          controller: "none",
          updatedAt,
        };
        return [
          Option.some(state),
          replaceMap(tabs, (copy) => {
            copy.set(tabId, state);
          }),
        ] as const;
      });
      if (Option.isSome(next)) {
        yield* Ref.update(controlEpochRef, (epochs) =>
          replaceMap(epochs, (copy) => {
            copy.set(tabId, (epochs.get(tabId) ?? 0) + 1);
          }),
        );
      }
      yield* Effect.all(
        [
          detachControlSession(webContentsId),
          detachListeners(webContentsId),
          clearWebContentsDiagnostics(webContentsId),
        ],
        { concurrency: 3, discard: true },
      );
      if (Option.isSome(next)) yield* emit(tabId, next.value);
    },
  );

  const isAppShortcutPress = (input: Electron.Input): boolean =>
    input.type === "keyDown" &&
    APP_FORWARDED_SHORTCUTS.some(
      (shortcut) =>
        shortcut.key.toLowerCase() === input.key.toLowerCase() &&
        shortcut.meta === input.meta &&
        shortcut.shift === input.shift &&
        shortcut.control === input.control,
    );

  const isPushToTalkKey = (input: Electron.Input): boolean =>
    input.code === "KeyD" || input.key.toLowerCase() === "d";

  const isPushToTalkPress = (input: Electron.Input): boolean =>
    input.type === "keyDown" &&
    isPushToTalkKey(input) &&
    !input.shift &&
    !input.alt &&
    (hostPlatform === "darwin" ? input.meta && !input.control : input.control && !input.meta);

  const isPushToTalkRelease = (
    input: Electron.Input,
    active = forwardedPushToTalkActive,
  ): boolean => {
    if (input.type !== "keyUp" || !active) return false;
    const key = input.key.toLowerCase();
    return (
      isPushToTalkKey(input) ||
      (hostPlatform === "darwin"
        ? key === "meta" || input.code === "MetaLeft" || input.code === "MetaRight"
        : key === "control" || input.code === "ControlLeft" || input.code === "ControlRight")
    );
  };

  const beginPushToTalkInput = (): void => {
    // Every physical press owns a generation, including one that arrives while
    // an older release is still recording its timestamp asynchronously.
    pushToTalkInputGeneration += 1;
    pushToTalkInputActive = true;
    forwardedPushToTalkActive = true;
  };

  /** Records the release before reopening the automation gate. */
  const finishPushToTalkInput = (): void => {
    forwardedPushToTalkActive = false;
    if (!pushToTalkInputActive) return;
    const generation = pushToTalkInputGeneration;
    runFork(
      Effect.gen(function* () {
        lastUserInputAtMs = yield* currentMillis;
        // A rapid new press owns a new generation. Its hold must not be cleared
        // by an older release whose clock read happened to resume afterwards.
        if (pushToTalkInputGeneration === generation) pushToTalkInputActive = false;
      }),
    );
  };

  const shouldForwardAppShortcut = (input: Electron.Input): boolean => {
    if (isPushToTalkPress(input)) {
      beginPushToTalkInput();
      return true;
    }
    if (isPushToTalkRelease(input)) {
      finishPushToTalkInput();
      return true;
    }
    return isAppShortcutPress(input);
  };

  const computeNavStatus = (wc: Electron.WebContents): PreviewNavStatus => {
    const url = wc.getURL();
    const title = wc.getTitle();
    if (url === "" || url === "about:blank") return { kind: "Idle" };
    if (wc.isLoading()) return { kind: "Loading", url, title };
    return { kind: "Success", url, title };
  };

  const settleDispatchedNavigation = Effect.fn("PreviewManager.settleDispatchedNavigation")(
    function* (
      tabId: string,
      wc: Electron.WebContents,
      url: string,
      sequence: number,
      failure?: unknown,
    ) {
      const activeAttempt = navigationAttemptsByTab.get(tabId);
      if (
        wc.isDestroyed() ||
        activeAttempt?.sequence !== sequence ||
        activeAttempt.webContentsId !== wc.id
      ) {
        return;
      }
      const attemptState = activeAttempt;
      const navStatus =
        failure === undefined
          ? computeNavStatus(wc)
          : (() => {
              const described = describeNavigationLoadFailure(failure);
              if (
                described.code === -3 &&
                attemptState.mainFrameStarted &&
                !attemptState.mainFrameCommitted
              ) {
                return null;
              }
              return described.code === -3 && attemptState.mainFrameCommitted
                ? computeNavStatus(wc)
                : ({
                    kind: "LoadFailed",
                    url,
                    title: wc.getTitle(),
                    ...described,
                  } satisfies PreviewNavStatus);
            })();
      // Redirects often reject the original loadURL Promise with ERR_ABORTED
      // after the requested main frame has started. That rejection is not a
      // receipt for either success or failure; keep the optimistic target
      // until the redirect chain commits or emits a main-frame load failure.
      if (navStatus === null) return;
      const updatedAt = yield* currentIso;
      const next = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
        const current = tabs.get(tabId);
        if (
          !current ||
          current.webContentsId !== wc.id ||
          current.navStatus.kind !== "Loading" ||
          current.navStatus.url !== url ||
          navigationAttemptsByTab.get(tabId)?.sequence !== sequence ||
          navigationAttemptsByTab.get(tabId)?.webContentsId !== wc.id
        ) {
          return [Option.none<PreviewTabState>(), tabs] as const;
        }
        const state: PreviewTabState = { ...current, navStatus, updatedAt };
        return [
          Option.some(state),
          replaceMap(tabs, (copy) => {
            copy.set(tabId, state);
          }),
        ] as const;
      });
      if (Option.isNone(next)) {
        const current = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
        if (
          navigationAttemptsByTab.get(tabId)?.sequence === sequence &&
          navigationAttemptsByTab.get(tabId)?.webContentsId === wc.id &&
          (!current ||
            (current.webContentsId === wc.id &&
              (current.navStatus.kind !== "Loading" || current.navStatus.url !== url)))
        ) {
          navigationAttemptsByTab.delete(tabId);
        }
        return;
      }
      navigationAttemptsByTab.delete(tabId);
      yield* emit(tabId, next.value);
      if (failure !== undefined) {
        yield* Effect.logWarning("Desktop preview navigation did not complete.", {
          tabId,
          webContentsId: wc.id,
          url,
          cause: failure,
        });
      }
    },
  );

  const dispatchNavigation = Effect.fn("PreviewManager.dispatchNavigation")(function* (
    tabId: string,
    wc: Electron.WebContents,
    url: string,
    sequence: number,
  ) {
    const dispatched = yield* Effect.exit(
      attempt({ operation: "navigate.dispatchLoadURL", tabId, webContentsId: wc.id }, () =>
        wc.loadURL(url),
      ),
    );
    if (Exit.isFailure(dispatched)) {
      const failure = Option.getOrThrow(Cause.findErrorOption(dispatched.cause));
      yield* settleDispatchedNavigation(tabId, wc, url, sequence, failure);
      return;
    }
    const load = dispatched.value;
    runFork(
      whileWebContentsAvailable(
        tabId,
        wc,
        attemptPromise({ operation: "navigate.loadURL", tabId, webContentsId: wc.id }, () => load),
      ).pipe(
        Effect.matchEffect({
          onFailure: (failure) =>
            failure._tag === "PreviewOperationError"
              ? settleDispatchedNavigation(tabId, wc, url, sequence, failure)
              : Effect.void,
          onSuccess: () => settleDispatchedNavigation(tabId, wc, url, sequence),
        }),
        Effect.catchCause((cause) =>
          Effect.logError("Desktop preview navigation watcher failed.", {
            tabId,
            webContentsId: wc.id,
            url,
            cause,
          }),
        ),
      ),
    );
  });

  const consumeExpectedAgentInput = Effect.fn("PreviewManager.consumeExpectedAgentInput")(
    function* (tabId: string, signal: PreviewInputSignal) {
      const now = yield* currentMillis;
      return yield* Ref.modify(expectedAgentInputsRef, (allExpected) => {
        const pending = (allExpected.get(tabId) ?? []).filter(
          (expected) => expected.expiresAt > now,
        );
        const index = pending.findIndex((expected) => inputSignalsMatch(expected.signal, signal));
        const matched = index >= 0;
        const nextPending = matched
          ? pending.filter((_, pendingIndex) => pendingIndex !== index)
          : pending;
        return [
          matched,
          replaceMap(allExpected, (copy) => {
            if (nextPending.length === 0) copy.delete(tabId);
            else copy.set(tabId, nextPending);
          }),
        ] as const;
      });
    },
  );

  const expectAgentInput = Effect.fn("PreviewManager.expectAgentInput")(function* (
    tabId: string,
    signal: PreviewInputSignal,
  ) {
    const now = yield* currentMillis;
    yield* Ref.update(expectedAgentInputsRef, (allExpected) =>
      replaceMap(allExpected, (copy) => {
        const pending = (allExpected.get(tabId) ?? []).filter(
          (expected) => expected.expiresAt > now,
        );
        copy.set(tabId, [...pending, { signal, expiresAt: now + 1_000 }]);
      }),
    );
  });

  const attachListeners = Effect.fn("PreviewManager.attachListeners")(function* (
    tabId: string,
    wc: Electron.WebContents,
  ) {
    const scope = yield* Scope.fork(parentScope, "sequential");
    const unavailable = yield* Deferred.make<void>();
    const webContentsId = wc.id;
    let listenersActive = true;
    let humanInputGeneration = 0;
    const updateCurrentWebContents = Effect.fn("PreviewManager.updateCurrentWebContents")(
      function* (
        patch: Partial<PreviewTabState>,
        predicate: (state: PreviewTabState) => boolean = () => true,
      ) {
        const updatedAt = yield* currentIso;
        const next = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
          const current = tabs.get(tabId);
          if (current?.webContentsId !== webContentsId || !predicate(current)) {
            return [Option.none<PreviewTabState>(), tabs] as const;
          }
          const state: PreviewTabState = { ...current, ...patch, updatedAt };
          return [
            Option.some(state),
            replaceMap(tabs, (copy) => {
              copy.set(tabId, state);
            }),
          ] as const;
        });
        if (Option.isSome(next)) yield* emit(tabId, next.value);
        return next;
      },
    );
    const syncState = Effect.fn("PreviewManager.syncWebContentsState")(function* (
      preserveLoadFailure: boolean,
    ) {
      if (wc.isDestroyed()) return;
      const zoomFactor = yield* attempt(
        { operation: "syncWebContentsState.getZoomFactor", tabId, webContentsId: wc.id },
        () => wc.getZoomFactor(),
      ).pipe(Effect.option);
      if (wc.isDestroyed()) return;
      const computedNavStatus = computeNavStatus(wc);
      const canGoBack = wc.navigationHistory.canGoBack();
      const canGoForward = wc.navigationHistory.canGoForward();
      const updatedAt = yield* currentIso;
      const next = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
        const current = tabs.get(tabId);
        if (!current || current.webContentsId !== webContentsId) {
          return [Option.none<PreviewTabState>(), tabs] as const;
        }
        const candidateNavigation =
          current.navStatus.kind === "Loading" ? navigationAttemptsByTab.get(tabId) : undefined;
        const pendingNavigation =
          candidateNavigation?.webContentsId === webContentsId ? candidateNavigation : undefined;
        // Gmail and similar apps keep `isLoading()` true after the main frame
        // commits (inbox sync, long poll). Requiring Success here froze the
        // chrome and agent on the pre-redirect URL (accounts.google.com)
        // while the guest was already showing the committed page.
        const lifecycleCanSettlePendingNavigation = pendingNavigation?.mainFrameCommitted === true;
        // Electron emits did-stop-loading after did-fail-load. At that point the
        // failed guest is no longer "loading", but it has not successfully
        // navigated anywhere. Keep the failure until a new load actually starts.
        // A title/stop event from the previous page may also already be queued
        // when loadURL is dispatched. It is not a receipt for the requested
        // page and must not replace the optimistic Loading target.
        const navStatus = pendingNavigation
          ? lifecycleCanSettlePendingNavigation
            ? computedNavStatus
            : current.navStatus
          : preserveLoadFailure &&
              current.navStatus.kind === "LoadFailed" &&
              computedNavStatus.kind === "Success"
            ? current.navStatus
            : computedNavStatus;
        const state: PreviewTabState = {
          ...current,
          navStatus,
          canGoBack,
          canGoForward,
          ...(Option.isSome(zoomFactor) ? { zoomFactor: zoomFactor.value } : {}),
          updatedAt,
        };
        return [
          Option.some(state),
          replaceMap(tabs, (copy) => {
            copy.set(tabId, state);
          }),
        ] as const;
      });
      if (Option.isSome(next)) {
        if (next.value.navStatus.kind !== "Loading") navigationAttemptsByTab.delete(tabId);
        yield* emit(tabId, next.value);
      }
    });
    const sync = () => {
      if (listenersActive) runFork(syncState(true));
    };
    const navigationCommitted = (_event: Electron.Event, _url: string): void => {
      if (!listenersActive) return;
      invalidatePlaywrightExecutionContext(tabId, webContentsId);
      const attempt = navigationAttemptsByTab.get(tabId);
      if (attempt?.webContentsId === webContentsId && attempt.mainFrameStarted) {
        navigationAttemptsByTab.set(tabId, { ...attempt, mainFrameCommitted: true });
      }
      runFork(syncState(false));
    };
    const inPageNavigationCommitted = (
      _event: Electron.Event,
      _url: string,
      isMainFrame: boolean,
    ): void => {
      if (!listenersActive || !isMainFrame) return;
      invalidatePlaywrightExecutionContext(tabId, webContentsId);
      const attempt = navigationAttemptsByTab.get(tabId);
      if (attempt?.webContentsId === webContentsId && attempt.mainFrameStarted) {
        navigationAttemptsByTab.set(tabId, { ...attempt, mainFrameCommitted: true });
      }
      runFork(syncState(false));
    };
    const navigationStarted = (
      _event: Electron.Event,
      url: string,
      _isInPlace: boolean,
      isMainFrame: boolean,
    ): void => {
      if (!listenersActive || !isMainFrame) return;
      invalidatePlaywrightExecutionContext(tabId, webContentsId);
      const attempt = navigationAttemptsByTab.get(tabId);
      if (attempt?.webContentsId === webContentsId && attempt.url === url) {
        navigationAttemptsByTab.set(tabId, { ...attempt, mainFrameStarted: true });
      }
    };
    const failed = (
      _event: Event,
      code: number,
      description: string,
      validatedUrl: string,
      isMainFrame: boolean,
    ): void => {
      if (!listenersActive || code === -3 || !isMainFrame || wc.isDestroyed()) return;
      runFork(
        Effect.gen(function* () {
          const current = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
          if (current?.webContentsId !== webContentsId) return;
          const pendingNavigation = navigationAttemptsByTab.get(tabId);
          const matchedNavigationStarted =
            current?.navStatus.kind === "Loading" &&
            pendingNavigation?.webContentsId === webContentsId &&
            pendingNavigation?.url === current.navStatus.url &&
            pendingNavigation.mainFrameStarted;
          if (
            current?.navStatus.kind === "Loading" &&
            validatedUrl.length > 0 &&
            current.navStatus.url !== validatedUrl &&
            !matchedNavigationStarted
          ) {
            return;
          }
          const updatedAt = yield* currentIso;
          const next = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
            const latest = tabs.get(tabId);
            if (latest?.webContentsId !== webContentsId) {
              return [Option.none<PreviewTabState>(), tabs] as const;
            }
            const state: PreviewTabState = {
              ...latest,
              navStatus: {
                kind: "LoadFailed",
                url: validatedUrl || wc.getURL(),
                title: wc.getTitle(),
                code,
                description,
              },
              updatedAt,
            };
            return [
              Option.some(state),
              replaceMap(tabs, (copy) => {
                copy.set(tabId, state);
              }),
            ] as const;
          });
          if (Option.isSome(next)) yield* emit(tabId, next.value);
          if (Option.isSome(next) && navigationAttemptsByTab.get(tabId) === pendingNavigation) {
            navigationAttemptsByTab.delete(tabId);
          }
        }),
      );
    };
    const handleHumanInput = Effect.fn("PreviewManager.handleHumanInput")(function* (
      rawSignal?: unknown,
    ) {
      if (!listenersActive) return;
      const current = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
      if (current?.webContentsId !== webContentsId) return;
      if (isPreviewInputSignal(rawSignal) && (yield* consumeExpectedAgentInput(tabId, rawSignal))) {
        return;
      }
      const marked = yield* updateCurrentWebContents({ controller: "human" });
      if (Option.isNone(marked)) return;
      const generation = ++humanInputGeneration;
      // Anything reaching here is the human, typing or clicking inside a guest.
      // The main window's `before-input-event` cannot see that, so without this
      // the deferral gate goes blind exactly when it matters most: once an agent
      // click has moved their focus into the page, every further keystroke of
      // theirs is invisible and the next automation call steals focus again.
      lastUserInputAtMs = yield* currentMillis;
      // Only their own clicks hand the keyboard to a page. Typing does not:
      // a keystroke that arrives because an agent moved the caret here is the
      // thing being corrected, not a choice to work in this tab.
      if (isPreviewInputSignal(rawSignal) && rawSignal.kind === "pointer") {
        userFocusIntent = "guest";
      }
      yield* Ref.update(controlEpochRef, (epochs) =>
        replaceMap(epochs, (copy) => {
          copy.set(tabId, (epochs.get(tabId) ?? 0) + 1);
        }),
      );
      yield* Effect.sleep(750);
      if (!listenersActive || humanInputGeneration !== generation) return;
      yield* updateCurrentWebContents(
        { controller: "none" },
        (state) => state.controller === "human",
      );
    });
    const humanInput = (_event: unknown, rawSignal?: unknown): void => {
      if (listenersActive) runFork(handleHumanInput(rawSignal));
    };
    const forwardShortcut = Effect.fn("PreviewManager.forwardShortcut")(function* (
      input: Electron.Input,
    ) {
      const mainWindow = yield* Ref.get(mainWindowRef);
      if (Option.isNone(mainWindow) || mainWindow.value.isDestroyed()) {
        return;
      }
      mainWindow.value.webContents.sendInputEvent({
        type: input.type === "keyUp" ? "keyUp" : "keyDown",
        keyCode: input.key,
        modifiers: [
          ...(input.meta ? (["meta"] as const) : []),
          ...(input.shift ? (["shift"] as const) : []),
          ...(input.control ? (["control"] as const) : []),
          ...(input.alt ? (["alt"] as const) : []),
        ],
      });
    });
    /**
     * Hands a keystroke back to the app window and types it there.
     *
     * The guest never sees the character — it is prevented before delivery —
     * so nothing leaks into the page the user was not choosing to type in.
     * `char` is what actually inserts text; the surrounding keyDown/keyUp keep
     * the composer's own key handling (Enter to send, shortcuts) intact.
     */
    const reclaimKeyForApp = Effect.fn("PreviewManager.reclaimKeyForApp")(function* (
      input: Electron.Input,
    ) {
      const mainWindow = yield* Ref.get(mainWindowRef);
      if (Option.isNone(mainWindow) || mainWindow.value.isDestroyed()) return;
      const target = mainWindow.value.webContents;
      yield* attempt(
        { operation: "reclaimKeyForApp.focus", tabId, webContentsId: target.id },
        () => {
          mainWindow.value.focus();
          target.focus();
        },
      ).pipe(Effect.ignore);
      const modifiers = [
        ...(input.meta ? (["meta"] as const) : []),
        ...(input.shift ? (["shift"] as const) : []),
        ...(input.control ? (["control"] as const) : []),
        ...(input.alt ? (["alt"] as const) : []),
      ];
      yield* attempt(
        { operation: "reclaimKeyForApp.send", tabId, webContentsId: target.id },
        () => {
          target.sendInputEvent({ type: "keyDown", keyCode: input.key, modifiers });
          // Only a lone printable character should insert; a chord is a command.
          if (input.key.length === 1 && !input.meta && !input.control && !input.alt) {
            target.sendInputEvent({ type: "char", keyCode: input.key, modifiers });
          }
          target.sendInputEvent({ type: "keyUp", keyCode: input.key, modifiers });
        },
      ).pipe(Effect.ignore);
      yield* Effect.logInfo("Returned a keystroke to the app window.", {
        tabId,
        key: input.key.length === 1 ? "<character>" : input.key,
      });
    });
    const beforeInput = (event: Electron.Event, input: Electron.Input): void => {
      if (!listenersActive) return;
      if (shouldForwardAppShortcut(input)) {
        event.preventDefault();
        runFork(forwardShortcut(input));
        return;
      }
      if (
        shouldReclaimGuestKeyForApp({
          focusIntent: userFocusIntent,
          automationInFlight: automationTurnsInFlight > 0,
          inputType: input.type,
          key: input.key,
        })
      ) {
        event.preventDefault();
        runFork(reclaimKeyForApp(input));
        return;
      }
      // The page keeps the key-up of a chord it already received the key-down
      // for; only the reclaimed key-down is suppressed above.
    };
    const destroyed = (): void => {
      if (listenersActive) runFork(handleWebContentsDestroyed(tabId, webContentsId));
    };
    yield* Scope.addFinalizer(scope, Deferred.succeed(unavailable, undefined).pipe(Effect.asVoid));
    yield* Scope.addFinalizer(
      scope,
      attempt({ operation: "detachListeners", tabId, webContentsId }, () => {
        listenersActive = false;
        if (wc.isDestroyed()) return;
        wc.off("did-navigate", navigationCommitted);
        wc.off("did-navigate-in-page", inPageNavigationCommitted);
        wc.off("did-start-navigation", navigationStarted);
        wc.off("page-title-updated", sync);
        wc.off("did-start-loading", sync);
        wc.off("did-stop-loading", sync);
        wc.off("did-fail-load", failed as never);
        wc.off("before-input-event", beforeInput);
        wc.off("destroyed", destroyed);
        wc.ipc.off(HUMAN_INPUT_CHANNEL, humanInput);
      }).pipe(Effect.ignore),
    );
    const install = Effect.fn("PreviewManager.installWebContentsListeners")(function* () {
      yield* attempt({ operation: "attachListeners", tabId, webContentsId: wc.id }, () => {
        wc.on("did-navigate", navigationCommitted);
        wc.on("did-navigate-in-page", inPageNavigationCommitted);
        wc.on("did-start-navigation", navigationStarted);
        wc.on("page-title-updated", sync);
        wc.on("did-start-loading", sync);
        wc.on("did-stop-loading", sync);
        wc.on("did-fail-load", failed as never);
        wc.on("destroyed", destroyed);
        wc.ipc.on(HUMAN_INPUT_CHANNEL, humanInput);
        wc.setWindowOpenHandler(({ url, disposition, features, frameName, postBody }) => {
          if (!listenersActive) return { action: "deny" };
          // A Chromium `new-window` request needs a real child window. OAuth
          // SDKs commonly open an unnamed/_blank child and retain its
          // WindowProxy so the provider can message the opener and close the
          // child. Some providers also submit POST data to that child. Denying
          // the request and creating a sibling preview later breaks both
          // contracts and turns the sign-in button into an apparent no-op.
          //
          // Window features are the third signal, and the one that matters in
          // practice: a `target="_blank"` link never carries them, while an
          // OAuth popup always sizes itself (`width=…,height=…`). Chromium does
          // not always report those opens as `new-window`, so keying only on
          // disposition denied them — and a denied `window.open()` hands the
          // page a null WindowProxy, which Google Identity Services reports as
          // "Failed to open popup window … Maybe blocked by the browser?" while
          // the user just sees a dead Sign in button.
          const hasWindowFeatures = features.trim().length > 0;
          const isChildWindow =
            disposition === "new-window" || postBody !== undefined || hasWindowFeatures;
          runFork(
            Effect.logInfo("Desktop preview handled a guest window-open request.", {
              tabId,
              webContentsId: wc.id,
              disposition,
              decision: isChildWindow ? "child-window" : "preview-tab",
              hasPostBody: postBody !== undefined,
              hasFeatures: hasWindowFeatures,
              frameTarget:
                frameName.trim().length === 0
                  ? "unnamed"
                  : frameName.toLowerCase() === "_blank"
                    ? "blank"
                    : "named",
            }),
          );
          if (isChildWindow) {
            return {
              action: "allow",
              overrideBrowserWindowOptions: { autoHideMenuBar: true },
            };
          }
          // Browser-style new-tab requests become durable sibling preview
          // sessions in the renderer. Never navigate the source tab as a
          // fallback: that makes target=_blank indistinguishable from a normal
          // link and destroys the page the user intentionally kept open.
          runFork(emitNewTabRequest({ sourceTabId: tabId, url }));
          return { action: "deny" };
        });
        wc.on("before-input-event", beforeInput);
      });
      yield* Ref.update(attachedRef, (attached) =>
        replaceMap(attached, (copy) => {
          copy.set(webContentsId, { scope, unavailable });
        }),
      );
    });
    yield* install().pipe(Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)));
  });

  const setMainWindow = Effect.fn("PreviewManager.setMainWindow")(function* (
    window: BrowserWindow,
  ) {
    yield* Ref.set(mainWindowRef, Option.some(window));
    mainWindowFocused = typeof window.isFocused !== "function" || window.isFocused();
    const mainWebContents = window.webContents;
    // Observe the chord in the main renderer as well as in guest webviews. A
    // live UI update can move focus from the composer into a guest between the
    // press and release; remembering the press here lets that guest forward
    // the release instead of leaving dictation latched on.
    const observePushToTalk = (_event: Electron.Event, input: Electron.Input): void => {
      const pushToTalkPressed = isPushToTalkPress(input);
      const pushToTalkReleased = isPushToTalkRelease(input, pushToTalkInputActive);
      if (pushToTalkPressed) beginPushToTalkInput();
      // Any key the user presses in the app's own window marks them as active,
      // which holds automation off the focus for a moment. Key-ups included: a
      // held push-to-talk chord is exactly when losing focus hurts most.
      if (pushToTalkReleased) finishPushToTalkInput();
      else
        runFork(
          Effect.gen(function* () {
            lastUserInputAtMs = yield* currentMillis;
          }),
        );
    };
    mainWebContents.on("before-input-event", observePushToTalk);
    const stopPushToTalkForWindowDeparture = (): void => {
      mainWindowFocused = false;
      if (!pushToTalkInputActive && !forwardedPushToTalkActive) return;
      finishPushToTalkInput();
    };
    window.on("blur", stopPushToTalkForWindowDeparture);
    const refreshPresentedGuests = (): void => {
      mainWindowFocused = true;
      runFork(
        Effect.gen(function* () {
          const tabs = yield* SynchronizedRef.get(tabsRef);
          yield* Effect.forEach(
            tabs.values(),
            (tab) => {
              if (
                tab.webContentsId === null ||
                !activityLeases.has(tab.tabId, PreviewActivityConsumer.Ui)
              ) {
                return Effect.void;
              }
              const wc = webContents.fromId(tab.webContentsId);
              if (!wc || wc.isDestroyed()) return Effect.void;
              return attempt(
                {
                  operation: "mainWindow.focus.invalidatePresentedGuest",
                  tabId: tab.tabId,
                  webContentsId: wc.id,
                },
                () => wc.invalidate(),
              ).pipe(Effect.ignore);
            },
            { discard: true },
          );
        }),
      );
    };
    window.on("focus", refreshPresentedGuests);
    // `before-input-event` is keyboard-only, so a click into the composer left
    // no trace and automation was free to take the caret from someone who had
    // just placed it. `input-event` carries the pointer too.
    const observeUserPointer = (_event: Electron.Event, input: Electron.InputEvent): void => {
      if (!isDeliberateUserInputEvent(input.type)) return;
      // A click in the app's own window is the user claiming the keyboard back
      // from whatever a preview tab was holding.
      userFocusIntent = "app";
      runFork(
        Effect.gen(function* () {
          lastUserInputAtMs = yield* currentMillis;
        }),
      );
    };
    mainWebContents.on("input-event", observeUserPointer);
    window.once("closed", () => {
      // BrowserWindow.webContents can itself throw after the native window has
      // closed. Keep the captured wrapper and only detach while it is alive;
      // Chromium releases all listeners with a destroyed WebContents anyway.
      if (!mainWebContents.isDestroyed()) {
        mainWebContents.off("before-input-event", observePushToTalk);
        mainWebContents.off("input-event", observeUserPointer);
      }
      window.off("blur", stopPushToTalkForWindowDeparture);
      window.off("focus", refreshPresentedGuests);
      mainWindowFocused = false;
      forwardedPushToTalkActive = false;
      pushToTalkInputActive = false;
      pushToTalkInputGeneration += 1;
      runFork(closeAllPictureInPicture());
    });
  });

  const createTabUnlocked = Effect.fn("PreviewManager.createTabUnlocked")(function* (
    tabId: string,
  ) {
    const updatedAt = yield* currentIso;
    const result = yield* SynchronizedRef.modify(
      tabsRef,
      (
        tabs,
      ): readonly [
        { readonly state: PreviewTabState; readonly created: boolean },
        ReadonlyMap<string, PreviewTabState>,
      ] => {
        const existing = tabs.get(tabId);
        if (existing) return [{ state: existing, created: false }, tabs] as const;
        const initial: PreviewTabState = {
          tabId,
          webContentsId: null,
          snapshotStageId: null,
          navStatus: { kind: "Idle" },
          canGoBack: false,
          canGoForward: false,
          zoomFactor: DEFAULT_ZOOM_FACTOR,
          pictureInPicture: false,
          colorScheme: "system",
          controller: "none",
          agentActive: false,
          downloads: [],
          pendingDownloadApprovals: [],
          updatedAt,
        };
        return [
          { state: initial, created: true },
          replaceMap(tabs, (copy) => {
            copy.set(tabId, initial);
          }),
        ] as const;
      },
    );
    if (result.created) {
      tabLifecycleGenerations.set(tabId, (tabLifecycleGenerations.get(tabId) ?? 0) + 1);
    }
    yield* emit(tabId, result.state);
    return result.state;
  });

  const createTab = Effect.fn("PreviewManager.createTab")(function* (tabId: string) {
    return yield* withTabLifecycleLock(tabId, createTabUnlocked(tabId));
  });

  const closeTabUnlocked = Effect.fn("PreviewManager.closeTabUnlocked")(function* (tabId: string) {
    const initial = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!initial) return;
    navigationAttemptsByTab.delete(tabId);
    // The card asking about a held download lives on this tab, so closing it
    // would leave a question nobody can answer and staged bytes nothing will
    // ever move or remove. Closing the tab is a refusal.
    for (const held of initial.pendingDownloadApprovals) {
      yield* Effect.sync(() => browserSession.answerDownloadApproval(held.id, "deny"));
    }
    invalidatePlaywrightExecutionContext(tabId, initial.webContentsId ?? undefined);
    if (initial.webContentsId != null) {
      yield* markWebContentsUnavailable(initial.webContentsId);
    }
    yield* Effect.all(
      [
        cancelPickElement(tabId),
        closePictureInPicture(tabId),
        stopFrameCapture(tabId, "recording"),
      ],
      {
        concurrency: 3,
        discard: true,
      },
    );
    const tab = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
      const current = tabs.get(tabId);
      if (!current) return [Option.none<PreviewTabState>(), tabs] as const;
      return [
        Option.some(current),
        replaceMap(tabs, (copy) => {
          copy.delete(tabId);
        }),
      ] as const;
    });
    if (Option.isNone(tab)) return;
    const closedTab = tab.value;
    if (closedTab.webContentsId != null) {
      yield* Effect.all(
        [
          detachControlSession(closedTab.webContentsId),
          detachListeners(closedTab.webContentsId),
          clearWebContentsDiagnostics(closedTab.webContentsId),
        ],
        { concurrency: 2, discard: true },
      );
    }
    activityLeases.clearTab(tabId);
    yield* recordActivityLeaseMetrics();
    const updatedAt = yield* currentIso;
    const closed: PreviewTabState = {
      ...closedTab,
      webContentsId: null,
      snapshotStageId: null,
      navStatus: { kind: "Idle" },
      canGoBack: false,
      canGoForward: false,
      zoomFactor: DEFAULT_ZOOM_FACTOR,
      pictureInPicture: false,
      colorScheme: "system",
      controller: "none",
      agentActive: false,
      downloads: [],
      pendingDownloadApprovals: [],
      updatedAt,
    };
    yield* emit(tabId, closed);
  });

  const closeTab = Effect.fn("PreviewManager.closeTab")(function* (tabId: string) {
    const claimed = yield* Ref.modify(closingTabIdsRef, (closingTabIds) => {
      if (closingTabIds.has(tabId)) return [false, closingTabIds] as const;
      return [true, new Set([...closingTabIds, tabId])] as const;
    });
    if (!claimed) return;
    return yield* withTabLifecycleLock(tabId, closeTabUnlocked(tabId)).pipe(
      Effect.ensuring(
        Ref.update(closingTabIdsRef, (closingTabIds) => {
          if (!closingTabIds.has(tabId)) return closingTabIds;
          const next = new Set(closingTabIds);
          next.delete(tabId);
          return next;
        }),
      ),
    );
  });

  const registerWebviewUnlocked = Effect.fn("PreviewManager.registerWebviewUnlocked")(function* (
    tabId: string,
    webContentsId: number,
    expectedGeneration: number | undefined,
  ) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (
      !tab ||
      tabLifecycleGenerations.get(tabId) !== expectedGeneration ||
      (yield* Ref.get(closingTabIdsRef)).has(tabId)
    ) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    const wc = webContents.fromId(webContentsId);
    const mainWindow = yield* Ref.get(mainWindowRef);
    if (
      !wc ||
      wc.isDestroyed() ||
      wc.getType() !== "webview" ||
      (Option.isSome(mainWindow) && wc.hostWebContents !== mainWindow.value.webContents)
    ) {
      return yield* new PreviewWebContentsNotFoundError({ tabId, webContentsId });
    }
    // Which cookie jar a guest actually attached to. The partition handed out
    // by `getConfig` is only a request; this is what Chromium gave the guest,
    // and a mismatch is what "the agent sees a logged-out page" looks like.
    yield* Effect.logInfo("Preview guest attached to a browser session.", {
      tabId,
      webContentsId,
      // Read defensively: this is diagnostics, and a guest whose session is
      // not introspectable is not a reason to fail the attach it describes.
      storagePath: wc.session?.storagePath ?? null,
      isPersistent: wc.session?.isPersistent?.() ?? null,
    });
    const attached = yield* Ref.get(attachedRef);
    const annotationTheme = yield* Ref.get(annotationThemeRef);
    if (tab.webContentsId === webContentsId && attached.has(webContentsId)) {
      const zoomFactor = yield* attempt(
        { operation: "registerWebview.getZoomFactor", tabId, webContentsId },
        () => wc.getZoomFactor(),
      );
      yield* update(tabId, { zoomFactor });
      yield* attempt({ operation: "registerWebview.sendTheme", tabId, webContentsId }, () =>
        wc.send(ANNOTATION_THEME_CHANNEL, annotationTheme),
      );
      const activation = yield* Effect.exit(activateAutomationForegroundIfActiveForTab(tabId, wc));
      if (Exit.isFailure(activation) && !isAutomationDebuggerOwnershipConflict(activation.cause)) {
        return yield* Effect.failCause(activation.cause);
      }
      return;
    }
    const replacedWebContentsId =
      tab.webContentsId != null && tab.webContentsId !== webContentsId ? tab.webContentsId : null;
    const currentTab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (
      !currentTab ||
      tabLifecycleGenerations.get(tabId) !== expectedGeneration ||
      (yield* Ref.get(closingTabIdsRef)).has(tabId)
    ) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    const zoomFactor =
      replacedWebContentsId !== null
        ? yield* attempt(
            { operation: "registerWebview.restoreZoomFactor", tabId, webContentsId },
            () => {
              wc.setZoomFactor(currentTab.zoomFactor);
              return currentTab.zoomFactor;
            },
          )
        : yield* attempt({ operation: "registerWebview.getZoomFactor", tabId, webContentsId }, () =>
            wc.getZoomFactor(),
          );
    yield* attachListeners(tabId, wc);
    if (wc.isDestroyed()) {
      yield* detachListeners(webContentsId);
      return yield* new PreviewWebContentsNotFoundError({ tabId, webContentsId });
    }
    const registeredAt = yield* currentIso;
    const registrationBarrier = yield* automationForegroundMutationMutex.withPermit(
      Effect.gen(function* () {
        const registered = yield* SynchronizedRef.modifyEffect(tabsRef, (tabs) =>
          Effect.gen(function* () {
            const current = tabs.get(tabId);
            if (
              !current ||
              tabLifecycleGenerations.get(tabId) !== expectedGeneration ||
              (yield* Ref.get(closingTabIdsRef)).has(tabId) ||
              wc.isDestroyed()
            ) {
              return [
                Option.none<{
                  readonly state: PreviewTabState;
                  readonly pendingUrl: string | null;
                }>(),
                tabs,
              ] as const;
            }
            const pendingUrl = current.navStatus.kind === "Loading" ? current.navStatus.url : null;
            const next: PreviewTabState = {
              ...current,
              webContentsId,
              snapshotStageId: replacedWebContentsId === null ? current.snapshotStageId : null,
              controller: replacedWebContentsId === null ? current.controller : "none",
              navStatus: pendingUrl === null ? computeNavStatus(wc) : current.navStatus,
              canGoBack: wc.navigationHistory.canGoBack(),
              canGoForward: wc.navigationHistory.canGoForward(),
              zoomFactor,
              updatedAt: registeredAt,
            };
            return [
              Option.some({
                state: next,
                pendingUrl,
              }),
              replaceMap(tabs, (copy) => {
                copy.set(tabId, next);
              }),
            ] as const;
          }),
        );
        if (Option.isSome(registered) && replacedWebContentsId !== null) {
          // Publish the successor before retiring its predecessor. If the new
          // guest dies during the publication check, the old guest remains
          // authoritative and attached instead of leaving the tab stranded.
          // Both operations stay inside the foreground mutation barrier, so a
          // fleet renewal cannot re-activate the predecessor between them.
          invalidatePlaywrightExecutionContext(tabId, replacedWebContentsId);
          automationForegroundWebContentsIds.delete(replacedWebContentsId);
          yield* markWebContentsUnavailable(replacedWebContentsId);
          yield* Effect.all(
            [
              detachControlSession(replacedWebContentsId),
              detachListeners(replacedWebContentsId),
              clearWebContentsDiagnostics(replacedWebContentsId),
              cancelPickElement(tabId),
            ],
            { concurrency: 4, discard: true },
          );
        }
        const activation =
          Option.isSome(registered) && automationForegroundActive
            ? yield* Effect.exit(
                Effect.gen(function* () {
                  // Publishing and foregrounding are one closed registration
                  // barrier: a renewal either sees this guest in its fleet
                  // snapshot, or this registration itself activates it before
                  // the barrier opens.
                  yield* activateAutomationForegroundForTab(tabId, wc);
                  yield* recordActivityLeaseMetrics();
                }),
              )
            : Exit.void;
        return { activation, registration: registered };
      }),
    );
    const { activation, registration } = registrationBarrier;
    if (Option.isNone(registration)) {
      yield* Effect.all(
        [
          detachControlSession(webContentsId),
          detachListeners(webContentsId),
          clearWebContentsDiagnostics(webContentsId),
        ],
        {
          concurrency: 3,
          discard: true,
        },
      );
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    const { state: registered, pendingUrl } = registration.value;
    runFork(restoreControlSession(tabId, wc));
    yield* emit(tabId, registered);
    yield* attempt({ operation: "registerWebview.sendTheme", tabId, webContentsId }, () =>
      wc.send(ANNOTATION_THEME_CHANNEL, annotationTheme),
    );
    if (activityLeases.has(tabId, PreviewActivityConsumer.Ui)) {
      yield* attempt(
        { operation: "registerWebview.invalidatePresentedGuest", tabId, webContentsId },
        () => wc.invalidate(),
      ).pipe(Effect.ignore);
    }
    const latestNavStatus = (yield* SynchronizedRef.get(tabsRef)).get(tabId)?.navStatus;
    if (pendingUrl && latestNavStatus?.kind === "Loading" && latestNavStatus.url === pendingUrl) {
      const sequence =
        navigationAttemptsByTab.get(tabId)?.sequence ?? (yield* nextCounter(navigationSequenceRef));
      navigationAttemptsByTab.set(tabId, {
        sequence,
        url: pendingUrl,
        webContentsId: wc.id,
        mainFrameStarted: false,
        mainFrameCommitted: false,
      });
      if (wc.getURL() === pendingUrl) {
        const reload = yield* Effect.exit(
          attempt(
            { operation: "registerWebview.reloadPendingUrl", tabId, webContentsId: wc.id },
            () => wc.reload(),
          ),
        );
        if (Exit.isFailure(reload)) {
          yield* settleDispatchedNavigation(
            tabId,
            wc,
            pendingUrl,
            sequence,
            Option.getOrThrow(Cause.findErrorOption(reload.cause)),
          );
        }
      } else {
        runFork(
          dispatchNavigation(tabId, wc, pendingUrl, sequence).pipe(
            Effect.catch((failure) =>
              settleDispatchedNavigation(tabId, wc, pendingUrl, sequence, failure),
            ),
          ),
        );
      }
    }
    if (Exit.isFailure(activation) && !isAutomationDebuggerOwnershipConflict(activation.cause)) {
      // Registration is already coherently published (and pending navigation
      // has been dispatched), but genuine activation failures must still fail
      // closed so an MCP operation cannot continue with a partially
      // foregrounded fleet. Debugger ownership only makes this tab unavailable.
      return yield* Effect.failCause(activation.cause);
    }
  });

  const registerWebview = Effect.fn("PreviewManager.registerWebview")(function* (
    tabId: string,
    webContentsId: number,
  ) {
    const expectedGeneration = tabLifecycleGenerations.get(tabId);
    return yield* withTabLifecycleLock(
      tabId,
      registerWebviewUnlocked(tabId, webContentsId, expectedGeneration),
    );
  });

  const setUiActivity = Effect.fn("PreviewManager.setUiActivity")(function* (
    tabId: string,
    leaseId: string,
    active: boolean,
  ) {
    const stableLeaseId = `ui:${leaseId}`;
    if (active) {
      const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
      if (!tab) {
        return yield* new PreviewTabNotFoundError({ tabId });
      }
      const leaseAcquired = activityLeases.acquire(
        tabId,
        stableLeaseId,
        PreviewActivityConsumer.Ui,
      );
      if (leaseId.startsWith("snapshot-stage:")) {
        const stageId = leaseId.slice("snapshot-stage:".length);
        const latestTab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
        const request = (yield* Ref.get(snapshotStageRequestsRef)).get(stageId);
        if (latestTab?.snapshotStageId !== stageId || request?.tabId !== tabId) {
          // A renderer receipt can arrive after the stage timed out and its
          // cleanup released the lease. Reject that stale generation so it
          // cannot resurrect a permanent Ui lease for a background guest.
          activityLeases.release(tabId, stableLeaseId);
          yield* recordActivityLeaseMetrics();
          return;
        }
        yield* Deferred.succeed(request.ready, undefined);
      }
      if (leaseId === "visible-surface" && leaseAcquired && tab.webContentsId !== null) {
        const wc = webContents.fromId(tab.webContentsId);
        if (wc && !wc.isDestroyed()) {
          // A guest can finish navigation while its thread is backgrounded,
          // leaving Chromium's last presented frame from the previous page.
          // The URL and live DOM are already current in that state, but the
          // user (and a native screenshot) still sees the old pixels until a
          // reload happens to schedule another paint. Invalidating on the
          // hidden-to-presented transition makes the live surface catch up
          // without reloading it or disturbing its authenticated JS state.
          yield* attempt(
            {
              operation: "setUiActivity.invalidatePresentedGuest",
              tabId,
              webContentsId: wc.id,
            },
            () => wc.invalidate(),
          ).pipe(Effect.ignore);
        }
      }
    } else {
      activityLeases.release(tabId, stableLeaseId);
      if (leaseId === "visible-surface" && mainWindowFocused) {
        const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
        const focused = yield* attempt(
          {
            operation: "setUiActivity.getFocusedWebContents",
            tabId,
            ...(tab?.webContentsId != null ? { webContentsId: tab.webContentsId } : {}),
          },
          () => webContents.getFocusedWebContents(),
        ).pipe(Effect.orElseSucceed(() => null));
        if (focused && focused.id === tab?.webContentsId) {
          userFocusIntent = "app";
          const mainWindow = yield* Ref.get(mainWindowRef);
          if (Option.isSome(mainWindow) && !mainWindow.value.webContents.isDestroyed()) {
            yield* attempt(
              {
                operation: "setUiActivity.restoreAppFocus",
                tabId,
                webContentsId: focused.id,
              },
              () => mainWindow.value.webContents.focus(),
            ).pipe(Effect.ignore);
          }
        }
      }
    }
    yield* recordActivityLeaseMetrics();
  });

  const navigate = Effect.fn("PreviewManager.navigate")(function* (tabId: string, rawUrl: string) {
    const url = yield* attempt({ operation: "navigate.normalizeUrl", tabId }, () =>
      normalizePreviewUrl(rawUrl),
    );
    const sequence = yield* nextCounter(navigationSequenceRef);
    const updatedAt = yield* currentIso;
    const pending = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
      const current = tabs.get(tabId);
      const next: PreviewTabState = {
        tabId,
        webContentsId: current?.webContentsId ?? null,
        snapshotStageId: current?.snapshotStageId ?? null,
        navStatus: {
          kind: "Loading",
          url,
          title: current?.navStatus.kind === "Idle" || !current ? "" : current.navStatus.title,
        },
        canGoBack: current?.canGoBack ?? false,
        canGoForward: current?.canGoForward ?? false,
        zoomFactor: current?.zoomFactor ?? DEFAULT_ZOOM_FACTOR,
        pictureInPicture: current?.pictureInPicture ?? false,
        colorScheme: current?.colorScheme ?? "system",
        controller: current?.controller ?? "none",
        agentActive: current?.agentActive ?? false,
        downloads: current?.downloads ?? [],
        pendingDownloadApprovals: current?.pendingDownloadApprovals ?? [],
        updatedAt,
      };
      return [
        next,
        replaceMap(tabs, (copy) => {
          copy.set(tabId, next);
        }),
      ] as const;
    });
    navigationAttemptsByTab.set(tabId, {
      sequence,
      url,
      webContentsId: pending.webContentsId,
      mainFrameStarted: false,
      mainFrameCommitted: false,
    });
    yield* emit(tabId, pending);
    if (pending.webContentsId == null) return;
    const wc = webContents.fromId(pending.webContentsId);
    if (!wc) {
      const detached = { ...pending, webContentsId: null };
      yield* SynchronizedRef.update(tabsRef, (tabs) =>
        tabs.get(tabId)?.webContentsId !== pending.webContentsId
          ? tabs
          : replaceMap(tabs, (copy) => {
              copy.set(tabId, detached);
            }),
      );
      yield* emit(tabId, detached);
      return;
    }
    if (wc.getURL() === url) {
      const reload = yield* Effect.exit(
        attempt({ operation: "navigate.reload", tabId, webContentsId: wc.id }, () => wc.reload()),
      );
      if (Exit.isFailure(reload)) {
        yield* settleDispatchedNavigation(
          tabId,
          wc,
          url,
          sequence,
          Option.getOrThrow(Cause.findErrorOption(reload.cause)),
        );
      }
      return;
    }
    yield* dispatchNavigation(tabId, wc, url, sequence);
  });

  const withWebContents = Effect.fn("PreviewManager.withWebContents")(function* (
    operation: string,
    tabId: string,
    use: (wc: Electron.WebContents) => void,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* attempt({ operation, tabId, webContentsId: wc.id }, () => use(wc));
  });

  const goBack = (tabId: string) =>
    withWebContents("goBack", tabId, (wc) => {
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    });
  const goForward = (tabId: string) =>
    withWebContents("goForward", tabId, (wc) => {
      if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    });
  const refresh = (tabId: string) => withWebContents("refresh", tabId, (wc) => wc.reload());
  const hardReload = (tabId: string) =>
    withWebContents("hardReload", tabId, (wc) => wc.reloadIgnoringCache());

  const openDevTools = Effect.fn("PreviewManager.openDevTools")(function* (tabId: string) {
    const wc = yield* requireWebContents(tabId);
    if (wc.isDevToolsOpened()) {
      yield* attempt({ operation: "openDevTools.focus", tabId, webContentsId: wc.id }, () =>
        wc.devToolsWebContents?.focus(),
      );
      return;
    }
    automationForegroundWebContentsIds.delete(wc.id);
    yield* detachControlSession(wc.id);
    yield* attempt({ operation: "openDevTools", tabId, webContentsId: wc.id }, () => {
      wc.once("devtools-closed", () => {
        if (wc.isDestroyed()) return;
        runFork(
          activateAutomationForegroundIfActiveForTab(tabId, wc).pipe(
            Effect.andThen(restoreControlSession(tabId, wc)),
            Effect.ignore,
          ),
        );
      });
      wc.openDevTools({ mode: "detach" });
    });
  });

  const setAnnotationTheme = Effect.fn("PreviewManager.setAnnotationTheme")(function* (
    theme: DesktopPreviewAnnotationTheme,
  ) {
    yield* Ref.set(annotationThemeRef, theme);
    const tabs = yield* SynchronizedRef.get(tabsRef);
    yield* Effect.forEach(
      tabs.values(),
      (tab) => {
        if (tab.webContentsId == null) return Effect.void;
        const wc = webContents.fromId(tab.webContentsId);
        return !wc || wc.isDestroyed()
          ? Effect.void
          : attempt(
              {
                operation: "setAnnotationTheme",
                tabId: tab.tabId,
                webContentsId: tab.webContentsId,
              },
              () => wc.send(ANNOTATION_THEME_CHANNEL, theme),
            ).pipe(Effect.ignore);
      },
      { discard: true },
    );
  });

  const pickElement = Effect.fn("PreviewManager.pickElement")(function* (tabId: string) {
    const wc = yield* requireWebContents(tabId);
    yield* cancelPickElement(tabId);
    const annotationTheme = yield* Ref.get(annotationThemeRef);
    return yield* Effect.callback<PreviewAnnotationPayload | null, PreviewManagerError>(
      (resume) => {
        const cleanup = Effect.fn("PreviewManager.cleanupPickElement")(function* () {
          yield* attempt({ operation: "pickElement.cleanup", tabId, webContentsId: wc.id }, () => {
            wc.ipc.removeListener(ELEMENT_PICKED_CHANNEL, onMessage);
            wc.off("destroyed", onDestroyed);
            wc.off("did-start-navigation", onNavigated);
          }).pipe(Effect.ignore);
          yield* Ref.update(pickSessionsRef, (sessions) =>
            replaceMap(sessions, (copy) => {
              copy.delete(tabId);
            }),
          );
        });
        const settlePick = Effect.fn("PreviewManager.settlePickElement")(function* (
          payload: PreviewAnnotationPayload | null,
        ) {
          const active = (yield* Ref.get(pickSessionsRef)).get(tabId);
          if (!active || active.cancel !== cancel) return;
          yield* cleanup();
          resume(Effect.succeed(payload));
        });
        const settle = (payload: PreviewAnnotationPayload | null) => {
          runFork(settlePick(payload));
        };
        const cancelPickSession = Effect.fn("PreviewManager.cancelPickSession")(function* () {
          yield* cleanup();
          const tabs = yield* SynchronizedRef.get(tabsRef);
          const activeTab = tabs.get(tabId);
          if (activeTab?.webContentsId != null) {
            const activeWc = webContents.fromId(activeTab.webContentsId);
            if (activeWc && !activeWc.isDestroyed()) {
              yield* attempt(
                {
                  operation: "cancelPickElement",
                  tabId,
                  webContentsId: activeWc.id,
                },
                () => activeWc.send(CANCEL_PICK_CHANNEL),
              ).pipe(Effect.ignore);
            }
          }
          resume(Effect.succeed(null));
        });
        const cancel = cancelPickSession();
        const onMessage = (_event: Electron.IpcMainEvent, ...args: unknown[]): void => {
          const payload = args[0];
          if (!isPreviewAnnotationPayload(payload)) {
            settle(null);
            return;
          }
          const cropRect = normalizeCaptureRect(args[1]);
          runFork(
            captureAnnotationScreenshot(tabId, wc, cropRect).pipe(
              Effect.matchEffect({
                onFailure: () => Effect.sync(() => settle(payload)),
                onSuccess: (screenshot) => Effect.sync(() => settle({ ...payload, screenshot })),
              }),
              Effect.ensuring(
                attempt(
                  { operation: "pickElement.captureComplete", tabId, webContentsId: wc.id },
                  () => {
                    if (!wc.isDestroyed()) wc.send(ANNOTATION_CAPTURED_CHANNEL);
                  },
                ).pipe(Effect.ignore),
              ),
            ),
          );
        };
        const onDestroyed = () => settle(null);
        const onNavigated = (
          _event: Electron.Event,
          _url: string,
          _isInPlace: boolean,
          isMainFrame: boolean,
        ) => {
          if (isMainFrame) settle(null);
        };
        const registerPickElement = Effect.fn("PreviewManager.registerPickElement")(function* () {
          yield* attempt({ operation: "pickElement.register", tabId, webContentsId: wc.id }, () => {
            wc.ipc.on(ELEMENT_PICKED_CHANNEL, onMessage);
            wc.once("destroyed", onDestroyed);
            wc.once("did-start-navigation", onNavigated);
            if (!wc.isFocused()) wc.focus();
            wc.send(START_PICK_CHANNEL, annotationTheme);
          });
          yield* Ref.update(pickSessionsRef, (sessions) =>
            replaceMap(sessions, (copy) => {
              copy.set(tabId, { cancel });
            }),
          );
        });
        runFork(
          registerPickElement().pipe(
            Effect.catch((error: PreviewManagerError) => {
              resume(Effect.fail(error));
              return cleanup();
            }),
          ),
        );
        return cancel;
      },
    );
  });

  const applyZoom = Effect.fn("PreviewManager.applyZoom")(function* (
    tabId: string,
    transform: (current: number) => number,
  ) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab) return;
    const next = transform(tab.zoomFactor);
    if (Math.abs(next - tab.zoomFactor) < ZOOM_EPSILON) return;
    if (tab.webContentsId != null) {
      const wc = webContents.fromId(tab.webContentsId);
      if (wc && !wc.isDestroyed()) {
        yield* attempt({ operation: "applyZoom", tabId, webContentsId: wc.id }, () =>
          wc.setZoomFactor(next),
        );
      }
    }
    yield* update(tabId, { zoomFactor: next });
  });

  // Emulated media lives on the CDP debugger session, not the WebContents, so
  // it is lost whenever the session detaches (webview swap, DevTools
  // open/close) and must be re-applied after every (re)attach.
  const applyColorScheme = Effect.fn("PreviewManager.applyColorScheme")(function* (
    tabId: string,
    wc: Electron.WebContents,
    colorScheme: DesktopPreviewColorScheme,
  ) {
    yield* ensureControlSession(tabId, wc);
    yield* attemptPromise({ operation: "applyColorScheme", tabId, webContentsId: wc.id }, () =>
      wc.debugger.sendCommand("Emulation.setEmulatedMedia", {
        features: [
          {
            name: "prefers-color-scheme",
            // An empty value clears the override so the page follows the OS.
            value: colorScheme === "system" ? "" : colorScheme,
          },
        ],
      }),
    );
  });

  // Re-establish the control session after a detach, restoring any
  // color-scheme override the tab carries. The scheme is read after the
  // session attaches so a concurrent setColorScheme is not overwritten with
  // a stale snapshot.
  const restoreControlSession = (tabId: string, wc: Electron.WebContents) =>
    Effect.gen(function* () {
      const beforeAttach = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
      if (beforeAttach?.webContentsId !== wc.id) return;
      if (beforeAttach.colorScheme === "system" && !hasControlActivity(tabId)) return;
      yield* ensureControlSession(tabId, wc);
      const afterAttach = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
      if (afterAttach?.webContentsId !== wc.id) {
        yield* detachControlSession(wc.id);
        return;
      }
      if (afterAttach.colorScheme !== "system") {
        yield* attemptPromise({ operation: "applyColorScheme", tabId, webContentsId: wc.id }, () =>
          wc.debugger.sendCommand("Emulation.setEmulatedMedia", {
            features: [
              {
                name: "prefers-color-scheme",
                value: afterAttach.colorScheme,
              },
            ],
          }),
        );
      }
    }).pipe(Effect.ignore);

  /**
   * Makes one live guest behave like a foreground page without moving the
   * user's keyboard focus or surfacing its thread. Disabling background
   * throttling also keeps the Page Visibility API foreground-visible, which
   * is required by auth SDKs that defer session hydration while hidden.
   */
  const activateAutomationForegroundForTab = Effect.fn(
    "PreviewManager.activateAutomationForegroundForTab",
  )(function* (tabId: string, wc: Electron.WebContents) {
    yield* ensureCurrentWebContents(tabId, wc);
    if (automationForegroundWebContentsIds.has(wc.id)) return;
    yield* attempt(
      {
        operation: "automationForeground.setBackgroundThrottling",
        tabId,
        webContentsId: wc.id,
      },
      () => wc.setBackgroundThrottling(false),
    );
    activityLeases.acquire(
      tabId,
      AUTOMATION_FOREGROUND_LEASE_ID,
      PreviewActivityConsumer.Automation,
    );

    const control = yield* ensureControlSession(tabId, wc);
    const focused = yield* Effect.exit(
      control.semaphore
        .withPermit(
          attemptPromiseWithin(
            {
              operation: "automationForeground.enableFocusEmulation",
              tabId,
              webContentsId: wc.id,
            },
            () =>
              wc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", {
                enabled: true,
              }),
            AUTOMATION_SNAPSHOT_COMMAND_TIMEOUT_MS,
          ),
        )
        .pipe(
          Effect.timeout(AUTOMATION_SNAPSHOT_COMMAND_TIMEOUT_MS),
          Effect.mapError((cause) =>
            isPreviewOperationError(cause)
              ? cause
              : new PreviewOperationError({
                  operation: "automationForeground.waitForControlSession",
                  tabId,
                  webContentsId: wc.id,
                  cause,
                }),
          ),
        ),
    );
    if (Exit.isFailure(focused)) {
      if (wc.isDevToolsOpened()) {
        return yield* new PreviewAutomationDevToolsOpenError({ webContentsId: wc.id });
      }
      if (!control.debuggerAttachedByManager) {
        return yield* new PreviewAutomationDebuggerAttachedError({ webContentsId: wc.id });
      }
      return yield* Effect.failCause(focused.cause);
    }
    yield* attempt(
      {
        operation: "automationForeground.invalidateGuest",
        tabId,
        webContentsId: wc.id,
      },
      () => wc.invalidate(),
    );
    // Detach can fire during focus emulation or invalidate even when the
    // Chromium command itself resolves. Check after the last callback-capable
    // operation and publish readiness in the same JavaScript turn. A later
    // detach synchronously removes the id again in onDetach.
    if (wc.isDevToolsOpened()) {
      return yield* new PreviewAutomationDevToolsOpenError({ webContentsId: wc.id });
    }
    if (!control.debuggerAttachedByManager) {
      return yield* new PreviewAutomationDebuggerAttachedError({ webContentsId: wc.id });
    }
    automationForegroundWebContentsIds.add(wc.id);
  });

  /**
   * Tabs can attach or regain their debugger while the one-minute foreground
   * lease is expiring. Serialize that handoff with fleet renewal/release so a
   * late activation cannot leave a stale id behind after the lease was
   * cleared. The active flag is deliberately checked inside the permit.
   */
  const activateAutomationForegroundIfActiveForTab = Effect.fn(
    "PreviewManager.activateAutomationForegroundIfActiveForTab",
  )(function* (tabId: string, wc: Electron.WebContents) {
    yield* automationForegroundMutationMutex.withPermit(
      Effect.gen(function* () {
        if (!automationForegroundActive) return;
        yield* activateAutomationForegroundForTab(tabId, wc);
        yield* recordActivityLeaseMetrics();
      }),
    );
  });

  const activateAutomationForegroundFleet = Effect.fn(
    "PreviewManager.activateAutomationForegroundFleet",
  )(function* () {
    const tabs = yield* SynchronizedRef.get(tabsRef);
    const results = yield* Effect.forEach(
      tabs.values(),
      (tab) => {
        if (tab.webContentsId === null) return Effect.succeed(null);
        const wc = webContents.fromId(tab.webContentsId);
        if (!wc || wc.isDestroyed()) return Effect.succeed(null);
        return Effect.exit(activateAutomationForegroundForTab(tab.tabId, wc)).pipe(
          Effect.map((exit) => ({ tabId: tab.tabId, webContentsId: wc.id, exit })),
        );
      },
      { concurrency: "unbounded" },
    );
    yield* recordActivityLeaseMetrics();
    for (const failure of results) {
      if (failure === null || Exit.isSuccess(failure.exit)) continue;
      if (isAutomationDebuggerOwnershipConflict(failure.exit.cause)) continue;
      yield* Effect.logWarning("Could not foreground one preview automation guest.", {
        tabId: failure.tabId,
        webContentsId: failure.webContentsId,
        cause: failure.exit.cause,
      });
    }
  });

  const releaseAutomationForegroundFleet = Effect.fn(
    "PreviewManager.releaseAutomationForegroundFleet",
  )(function* () {
    automationForegroundActive = false;
    automationForegroundWebContentsIds.clear();
    const tabs = yield* SynchronizedRef.get(tabsRef);
    yield* Effect.forEach(
      tabs.values(),
      (tab) =>
        Effect.gen(function* () {
          activityLeases.release(tab.tabId, AUTOMATION_FOREGROUND_LEASE_ID);
          if (tab.webContentsId === null) return;
          const wc = webContents.fromId(tab.webContentsId);
          if (!wc || wc.isDestroyed()) return;

          // A request that itself outlives the fleet lease still owns its own
          // Automation activity lease. Let that action keep focus emulation;
          // its normal cleanup disables it when the action actually finishes.
          if (!activityLeases.has(tab.tabId, PreviewActivityConsumer.Automation)) {
            const control = (yield* SynchronizedRef.get(controlSessionsRef)).get(wc.id);
            if (control) {
              yield* control.semaphore
                .withPermit(
                  attemptPromiseWithin(
                    {
                      operation: "automationForeground.disableFocusEmulation",
                      tabId: tab.tabId,
                      webContentsId: wc.id,
                    },
                    () =>
                      wc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", {
                        enabled: false,
                      }),
                    AUTOMATION_SNAPSHOT_COMMAND_TIMEOUT_MS,
                  ),
                )
                .pipe(Effect.timeout(AUTOMATION_SNAPSHOT_COMMAND_TIMEOUT_MS), Effect.ignore);
            }
          }
          yield* detachControlSessionIfIdle(tab.tabId, wc.id);
        }),
      { concurrency: "unbounded", discard: true },
    );
    yield* recordActivityLeaseMetrics();
  });

  const renewAutomationForeground = Effect.fn("PreviewManager.renewAutomationForeground")(
    function* () {
      yield* automationForegroundMutationMutex.withPermit(
        Effect.gen(function* () {
          const previousExpiry = automationForegroundExpiryFiber;
          automationForegroundExpiryFiber = undefined;
          if (previousExpiry) yield* Fiber.interrupt(previousExpiry);

          automationForegroundActive = true;
          // Fleet renewal is target-agnostic: one unavailable hidden guest
          // must not reject an operation for another tab. Each failed guest
          // remains unavailable in automationStatus, where the actual target
          // still fails closed. Arm expiry so every acquired lease is released.
          yield* activateAutomationForegroundFleet();
          automationForegroundExpiryFiber = yield* Effect.forkIn(
            Effect.sleep(AUTOMATION_FOREGROUND_IDLE_MS).pipe(
              Effect.andThen(
                automationForegroundMutationMutex.withPermit(
                  Effect.gen(function* () {
                    automationForegroundExpiryFiber = undefined;
                    yield* releaseAutomationForegroundFleet();
                  }),
                ),
              ),
            ),
            parentScope,
          );
        }),
      );
    },
  );

  const setColorScheme = Effect.fn("PreviewManager.setColorScheme")(function* (
    tabId: string,
    colorScheme: DesktopPreviewColorScheme,
  ) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    if (tab.colorScheme !== colorScheme) {
      // Record the choice even when the CDP call below can't run yet (no
      // webview, DevTools holding the debugger) — it is re-applied on the
      // next control-session (re)attach.
      yield* update(tabId, { colorScheme });
    }
    // Re-read after the update: registerWebview may have swapped the guest
    // in the meantime and the override must land on the current one.
    const webContentsId = (yield* SynchronizedRef.get(tabsRef)).get(tabId)?.webContentsId;
    if (webContentsId == null) return;
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return;
    yield* applyColorScheme(tabId, wc, colorScheme);
    if (colorScheme === "system") {
      yield* detachControlSessionIfIdle(tabId, wc.id);
    }
  });

  const captureScreenshot = Effect.fn("PreviewManager.captureScreenshot")(function* (
    tabId: string,
  ) {
    const wc = yield* requireWebContents(tabId);
    const [createdAt, millis, image] = yield* Effect.all([
      currentIso,
      currentMillis,
      attemptPromise(
        {
          operation: "captureScreenshot.capturePage",
          tabId,
          webContentsId: wc.id,
        },
        () => wc.capturePage(),
      ),
    ]);
    const id = `browser-screenshot-${artifactSiteSlug(wc.getURL())}-${millis.toString(36)}`;
    const artifactPath = path.join(resolvedArtifactDirectory, `${id}.png`);
    const data = image.toPNG();
    yield* fileSystem.makeDirectory(resolvedArtifactDirectory, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({
            operation: "captureScreenshot.makeDirectory",
            tabId,
            webContentsId: wc.id,
            artifactPath,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFile(artifactPath, data).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({
            operation: "captureScreenshot.writeFile",
            tabId,
            webContentsId: wc.id,
            artifactPath,
            cause,
          }),
      ),
    );
    return {
      id,
      tabId,
      path: artifactPath,
      mimeType: "image/png" as const,
      sizeBytes: data.byteLength,
      createdAt,
    };
  });

  const capturePreviewFrame = Effect.fn("PreviewManager.capturePreviewFrame")(function* (
    tabId: string,
  ) {
    const captureSession = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(tabId);
    if (!captureSession) return;
    const wc = yield* requireWebContents(tabId);
    const image = yield* attemptPromise(
      {
        operation: "frameCapture.capturePage",
        tabId,
        webContentsId: wc.id,
      },
      () => wc.capturePage(),
    );
    const currentCaptureSession = yield* Effect.all(
      [SynchronizedRef.get(frameCaptureSessionsRef), SynchronizedRef.get(tabsRef)],
      { concurrency: 2 },
    ).pipe(
      Effect.map(([captureSessions, tabs]) => {
        const current = captureSessions.get(tabId);
        return current?.scope === captureSession.scope &&
          tabs.get(tabId)?.webContentsId === wc.id &&
          !wc.isDestroyed()
          ? current
          : undefined;
      }),
    );
    if (!currentCaptureSession) return;
    const size = yield* attempt(
      {
        operation: "frameCapture.measureFrame",
        tabId,
        webContentsId: wc.id,
      },
      () => image.getSize(),
    );
    if (
      !Number.isFinite(size.width) ||
      !Number.isFinite(size.height) ||
      size.width <= 0 ||
      size.height <= 0
    ) {
      return;
    }
    const encoded = yield* attempt(
      {
        operation: "frameCapture.encodeFrame",
        tabId,
        webContentsId: wc.id,
      },
      () => image.toJPEG(RECORDING_JPEG_QUALITY).toString("base64"),
    );
    const receivedAt = yield* currentIso;
    const frame: DesktopPreviewRecordingFrame = {
      tabId,
      data: encoded,
      width: size.width,
      height: size.height,
      receivedAt,
    };
    const deliveries: Array<Effect.Effect<void>> = [];
    if (currentCaptureSession.consumers.has("recording")) {
      const listeners = yield* Ref.get(recordingFrameListenersRef);
      deliveries.push(
        Effect.forEach(
          listeners,
          (listener) => deliverEvent("recording-frame", frame.tabId, () => listener(frame)),
          { discard: true },
        ),
      );
    }
    if (currentCaptureSession.consumers.has("picture-in-picture")) {
      const pictureInPictureWindow = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(
        tabId,
      )?.window;
      if (pictureInPictureWindow && !pictureInPictureWindow.isDestroyed()) {
        deliveries.push(
          Effect.gen(function* () {
            const previousAspectRatio = (yield* Ref.get(pictureInPictureAspectRatiosRef)).get(
              tabId,
            );
            const aspectRatio = frame.width / frame.height;
            if (
              previousAspectRatio === undefined ||
              Math.abs(previousAspectRatio - aspectRatio) > PICTURE_IN_PICTURE_ASPECT_RATIO_EPSILON
            ) {
              yield* attempt(
                {
                  operation: "pictureInPicture.setAspectRatio",
                  tabId,
                  webContentsId: wc.id,
                },
                () => {
                  const contentSize = fitPictureInPictureContentSize(
                    pictureInPictureWindow.getContentSize(),
                    aspectRatio,
                  );
                  pictureInPictureWindow.setAspectRatio(0);
                  pictureInPictureWindow.setContentSize(contentSize[0], contentSize[1], false);
                  pictureInPictureWindow.setAspectRatio(aspectRatio);
                },
              );
              yield* Ref.update(pictureInPictureAspectRatiosRef, (aspectRatios) =>
                replaceMap(aspectRatios, (copy) => {
                  copy.set(tabId, aspectRatio);
                }),
              );
            }
            yield* attempt(
              {
                operation: "pictureInPicture.deliverFrame",
                tabId,
                webContentsId: wc.id,
              },
              () => {
                pictureInPictureWindow.webContents.send(
                  PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL,
                  frame,
                );
              },
            );
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Picture-in-picture frame delivery failed.", {
                tabId,
                error,
              }),
            ),
          ),
        );
      }
    }
    yield* Effect.all(deliveries, { concurrency: 2, discard: true });
  });

  const startFrameCapture = Effect.fn("PreviewManager.startFrameCapture")(function* (
    tabId: string,
    consumer: FrameCaptureConsumer,
  ) {
    // Validate the tab synchronously, but treat capturePage failures as
    // transient. Chromium can return UnknownVizError while a hidden guest is
    // warming its first compositor frame; the scheduled loop should keep the
    // consumer alive and recover instead of tearing recording/PiP back down.
    yield* requireWebContents(tabId);
    const captureNextFrame = Effect.sleep(RECORDING_FRAME_INTERVAL_MS).pipe(
      Effect.andThen(capturePreviewFrame(tabId)),
      Effect.catch((error) =>
        Effect.logWarning("Background preview frame capture failed.", {
          tabId,
          error,
        }),
      ),
    );
    const created = yield* SynchronizedRef.modifyEffect(frameCaptureSessionsRef, (sessions) => {
      return Effect.gen(function* () {
        const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
        if (!tab || (yield* Ref.get(closingTabIdsRef)).has(tabId)) {
          return yield* new PreviewTabNotFoundError({ tabId });
        }
        const current = sessions.get(tabId);
        if (current) {
          if (current.consumers.has(consumer)) {
            return [false, sessions] as const;
          }
          return [
            false,
            replaceMap(sessions, (copy) => {
              copy.set(tabId, {
                ...current,
                consumers: new Set([...current.consumers, consumer]),
              });
            }),
          ] as const;
        }
        const scope = yield* Scope.fork(parentScope, "sequential");
        yield* Effect.forkIn(Effect.forever(captureNextFrame), scope);
        return [
          true,
          replaceMap(sessions, (copy) => {
            copy.set(tabId, {
              scope,
              consumers: new Set([consumer]),
            });
          }),
        ] as const;
      });
    });
    activityLeases.acquire(
      tabId,
      `frame-capture:${consumer}`,
      consumer === "recording"
        ? PreviewActivityConsumer.Recording
        : PreviewActivityConsumer.PictureInPicture,
    );
    yield* recordActivityLeaseMetrics();
    if (!created) return;
    yield* capturePreviewFrame(tabId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Initial background preview frame was not ready; capture will retry.", {
          tabId,
          consumer,
          error,
        }),
      ),
    );
  });

  const releasePictureInPicture = Effect.fn("PreviewManager.releasePictureInPicture")(function* (
    tabId: string,
    expectedSession: PictureInPictureSession,
    closeWindow: boolean,
  ) {
    const removed = yield* SynchronizedRef.modify(pictureInPictureSessionsRef, (sessions) => {
      if (sessions.get(tabId) !== expectedSession) {
        return [false, sessions] as const;
      }
      return [
        true,
        replaceMap(sessions, (copy) => {
          copy.delete(tabId);
        }),
      ] as const;
    });
    if (!removed) return;
    yield* Deferred.interrupt(expectedSession.ready);
    yield* Scope.close(expectedSession.initializationScope, Exit.void).pipe(Effect.ignore);
    yield* Ref.update(pictureInPictureAspectRatiosRef, (aspectRatios) =>
      replaceMap(aspectRatios, (copy) => {
        copy.delete(tabId);
      }),
    );
    yield* stopFrameCapture(tabId, "picture-in-picture");
    const tabs = yield* SynchronizedRef.get(tabsRef);
    if (tabs.has(tabId)) {
      yield* update(tabId, { pictureInPicture: false });
    }
    if (closeWindow && !expectedSession.window.isDestroyed()) {
      yield* attempt({ operation: "pictureInPicture.close", tabId }, () =>
        expectedSession.window.close(),
      ).pipe(Effect.ignore);
    }
  });

  const closePictureInPictureUnlocked = Effect.fn("PreviewManager.closePictureInPictureUnlocked")(
    function* (tabId: string) {
      const pictureInPictureSession = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(
        tabId,
      );
      if (!pictureInPictureSession) {
        yield* stopFrameCapture(tabId, "picture-in-picture");
        const tabs = yield* SynchronizedRef.get(tabsRef);
        if (tabs.has(tabId)) {
          yield* update(tabId, { pictureInPicture: false });
        }
        return;
      }
      yield* releasePictureInPicture(tabId, pictureInPictureSession, true);
    },
  );

  const closePictureInPicture = Effect.fn("PreviewManager.closePictureInPicture")(function* (
    tabId: string,
  ) {
    yield* pictureInPictureMutationSemaphore.withPermit(closePictureInPictureUnlocked(tabId));
  });

  const closeAllPictureInPicture = Effect.fn("PreviewManager.closeAllPictureInPicture")(
    function* () {
      const sessions = yield* SynchronizedRef.get(pictureInPictureSessionsRef);
      yield* Effect.forEach(sessions.keys(), closePictureInPicture, {
        concurrency: "unbounded",
        discard: true,
      });
    },
  );

  const openPictureInPicture = Effect.fn("PreviewManager.openPictureInPicture")(function* (
    tabId: string,
  ) {
    const claim = yield* pictureInPictureMutationSemaphore.withPermit(
      Effect.gen(function* () {
        const existing = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(tabId);
        if (existing && !existing.window.isDestroyed()) {
          return { kind: "existing" as const, session: existing };
        }
        if (existing) {
          yield* releasePictureInPicture(tabId, existing, false);
        }
        const wc = yield* requireWebContents(tabId);
        const title = yield* attempt(
          {
            operation: "pictureInPicture.readTitle",
            tabId,
            webContentsId: wc.id,
          },
          () => wc.getTitle().trim(),
        );
        const pictureInPictureWindow = yield* attempt(
          {
            operation: "pictureInPicture.create",
            tabId,
            webContentsId: wc.id,
          },
          () =>
            new BrowserWindow({
              width: PICTURE_IN_PICTURE_INITIAL_WIDTH,
              height: PICTURE_IN_PICTURE_INITIAL_HEIGHT,
              minWidth: PICTURE_IN_PICTURE_MIN_WIDTH,
              minHeight: PICTURE_IN_PICTURE_MIN_HEIGHT,
              title: title.length > 0 ? `Preview · ${title}` : "Browser preview",
              show: false,
              alwaysOnTop: true,
              autoHideMenuBar: true,
              fullscreenable: false,
              maximizable: false,
              minimizable: false,
              resizable: true,
              skipTaskbar: true,
              backgroundColor: "#111111",
              ...(hostPlatform === "darwin" ? { type: "panel" as const } : {}),
              webPreferences: {
                preload: pictureInPicturePreloadPath,
                backgroundThrottling: false,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
              },
            }),
        );
        const initializationScope = yield* Scope.fork(parentScope, "sequential");
        const ready = yield* Deferred.make<void, PreviewManagerError>();
        const session: PictureInPictureSession = {
          window: pictureInPictureWindow,
          webContentsId: wc.id,
          ready,
          initializationScope,
        };
        const onClosed = () => {
          runFork(
            pictureInPictureMutationSemaphore.withPermit(
              releasePictureInPicture(tabId, session, false),
            ),
          );
        };
        yield* attempt(
          {
            operation: "pictureInPicture.configure",
            tabId,
            webContentsId: wc.id,
          },
          () => {
            pictureInPictureWindow.once("closed", onClosed);
            pictureInPictureWindow.setAlwaysOnTop(
              true,
              hostPlatform === "darwin" ? "floating" : "normal",
            );
            if (hostPlatform === "darwin") {
              pictureInPictureWindow.setVisibleOnAllWorkspaces(true, {
                visibleOnFullScreen: true,
                // Electron otherwise temporarily transforms the entire app into
                // a UIElement process, which removes the owning app from the Dock.
                skipTransformProcessType: true,
              });
            }
          },
        ).pipe(
          Effect.onError(() =>
            Effect.all(
              [
                Scope.close(initializationScope, Exit.void).pipe(Effect.ignore),
                attempt({ operation: "pictureInPicture.close", tabId }, () =>
                  pictureInPictureWindow.close(),
                ).pipe(Effect.ignore),
              ],
              { discard: true },
            ),
          ),
        );
        yield* SynchronizedRef.update(pictureInPictureSessionsRef, (sessions) =>
          replaceMap(sessions, (copy) => {
            copy.set(tabId, session);
          }),
        );
        return { kind: "created" as const, session };
      }),
    );
    const pictureInPictureSession = claim.session;
    if (claim.kind === "existing") {
      yield* Deferred.await(pictureInPictureSession.ready);
      return yield* pictureInPictureMutationSemaphore.withPermit(
        Effect.gen(function* () {
          const current = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(tabId);
          if (current !== pictureInPictureSession || pictureInPictureSession.window.isDestroyed()) {
            return yield* new PreviewOperationError({
              operation: "pictureInPicture.showExisting",
              tabId,
              webContentsId: pictureInPictureSession.webContentsId,
              cause: new Error("Picture-in-picture session closed before it became visible."),
            });
          }
          yield* attempt(
            {
              operation: "pictureInPicture.showExisting",
              tabId,
              webContentsId: pictureInPictureSession.webContentsId,
            },
            () => pictureInPictureSession.window.showInactive(),
          );
        }),
      );
    }

    const initialize = Effect.gen(function* () {
      yield* attemptPromise(
        {
          operation: "pictureInPicture.load",
          tabId,
          webContentsId: pictureInPictureSession.webContentsId,
        },
        () => pictureInPictureSession.window.loadURL(buildPreviewPictureInPictureDataUrl()),
      );
      const currentWebContents = yield* requireWebContents(tabId);
      if (
        currentWebContents.id !== pictureInPictureSession.webContentsId ||
        currentWebContents.isDestroyed()
      ) {
        return yield* new PreviewOperationError({
          operation: "pictureInPicture.validateWebContents",
          tabId,
          webContentsId: pictureInPictureSession.webContentsId,
          cause: new Error("Preview webview changed while picture-in-picture was opening."),
        });
      }
      yield* startFrameCapture(tabId, "picture-in-picture");
      yield* attempt(
        {
          operation: "pictureInPicture.show",
          tabId,
          webContentsId: pictureInPictureSession.webContentsId,
        },
        () => pictureInPictureSession.window.showInactive(),
      );
    });
    const initializationExit = yield* Effect.gen(function* () {
      const initializationFiber = yield* Effect.forkIn(
        initialize,
        pictureInPictureSession.initializationScope,
      );
      return yield* Fiber.await(initializationFiber);
    }).pipe(
      Effect.onInterrupt(() =>
        pictureInPictureMutationSemaphore.withPermit(
          releasePictureInPicture(tabId, pictureInPictureSession, true),
        ),
      ),
    );
    if (Exit.isSuccess(initializationExit)) {
      const published = yield* pictureInPictureMutationSemaphore.withPermit(
        Effect.gen(function* () {
          const current = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(tabId);
          if (current !== pictureInPictureSession || pictureInPictureSession.window.isDestroyed()) {
            if (current === pictureInPictureSession) {
              yield* releasePictureInPicture(tabId, pictureInPictureSession, false);
            }
            return false;
          }
          yield* update(tabId, { pictureInPicture: true });
          yield* Deferred.done(pictureInPictureSession.ready, initializationExit);
          return true;
        }),
      );
      if (published) return;
      return yield* Deferred.await(pictureInPictureSession.ready);
    }
    yield* Deferred.done(pictureInPictureSession.ready, initializationExit);
    const current = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(tabId);
    if (current === pictureInPictureSession) {
      yield* pictureInPictureMutationSemaphore.withPermit(
        releasePictureInPicture(tabId, pictureInPictureSession, true),
      );
    }
    return yield* Effect.failCause(initializationExit.cause);
  });

  const startRecording = Effect.fn("PreviewManager.startRecording")(function* (tabId: string) {
    yield* startFrameCapture(tabId, "recording");
  });

  const stopRecording = Effect.fn("PreviewManager.stopRecording")(function* (tabId: string) {
    yield* stopFrameCapture(tabId, "recording");
  });

  const saveRecording = Effect.fn("PreviewManager.saveRecording")(function* (
    tabId: string,
    mimeType: string,
    data: Uint8Array,
  ) {
    const [createdAt, millis] = yield* Effect.all([currentIso, currentMillis]);
    const id = `browser-recording-${millis.toString(36)}`;
    const extension = mimeType.includes("mp4") ? "mp4" : "webm";
    const artifactPath = path.join(resolvedArtifactDirectory, `${id}.${extension}`);
    yield* fileSystem.makeDirectory(resolvedArtifactDirectory, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({
            operation: "saveRecording.makeDirectory",
            tabId,
            artifactPath,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFile(artifactPath, data).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({
            operation: "saveRecording.writeFile",
            tabId,
            artifactPath,
            cause,
          }),
      ),
    );
    return {
      id,
      tabId,
      path: artifactPath,
      mimeType,
      sizeBytes: data.byteLength,
      createdAt,
    };
  });

  const automationStatus = Effect.fn("PreviewManager.automationStatus")(function* (tabId: string) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    const downloadApprovalRequired = (tab?.pendingDownloadApprovals.length ?? 0) > 0;
    if (!tab || tab.webContentsId == null) {
      const navStatus = tab?.navStatus;
      return {
        available: false,
        visible: true,
        tabId,
        url: !navStatus || navStatus.kind === "Idle" ? null : navStatus.url,
        title: !navStatus || navStatus.kind === "Idle" ? null : navStatus.title,
        loading: navStatus?.kind === "Loading",
        ...(navStatus?.kind === "LoadFailed"
          ? { loadFailure: { code: navStatus.code, description: navStatus.description } }
          : {}),
        ...(downloadApprovalRequired ? { downloadApprovalRequired: true } : {}),
      };
    }
    const wc = webContents.fromId(tab.webContentsId);
    const foregroundReady =
      !automationForegroundActive || automationForegroundWebContentsIds.has(tab.webContentsId);
    if (tab.navStatus.kind === "LoadFailed") {
      return {
        available: Boolean(wc && !wc.isDestroyed() && foregroundReady),
        visible: true,
        tabId,
        url: tab.navStatus.url,
        title: tab.navStatus.title || null,
        loading: false,
        loadFailure: {
          code: tab.navStatus.code,
          description: tab.navStatus.description,
        },
        ...(downloadApprovalRequired ? { downloadApprovalRequired: true } : {}),
      };
    }
    if (wc && !wc.isDestroyed() && tab.navStatus.kind === "Loading") {
      // loadURL can remain pending before a background renderer emits its
      // first navigation event. During that gap Electron still exposes the
      // previous page as idle; reporting it as ready lets automation capture
      // stale pixels while the tab model already advertises the target URL.
      return {
        available: foregroundReady,
        visible: true,
        tabId,
        url: tab.navStatus.url,
        title: tab.navStatus.title || null,
        loading: true,
        ...(downloadApprovalRequired ? { downloadApprovalRequired: true } : {}),
      };
    }
    return !wc || wc.isDestroyed()
      ? {
          available: false,
          visible: true,
          tabId,
          url: null,
          title: null,
          loading: false,
          ...(downloadApprovalRequired ? { downloadApprovalRequired: true } : {}),
        }
      : {
          available: foregroundReady,
          visible: true,
          tabId,
          url: wc.getURL() || null,
          title: wc.getTitle() || null,
          loading: wc.isLoading(),
          ...(downloadApprovalRequired ? { downloadApprovalRequired: true } : {}),
        };
  });

  const captureAutomationSnapshot = Effect.fn("PreviewManager.captureAutomationSnapshot")(
    function* (
      tabId: string,
      wc: Electron.WebContents,
      stageSnapshotSurface: StageSnapshotSurface | null,
    ) {
      const send: SendCommand = (method, commandParams) =>
        attemptPromiseWithin(
          {
            operation: `automationSnapshot.${method}`,
            tabId,
            webContentsId: wc.id,
          },
          () => wc.debugger.sendCommand(method, commandParams),
          AUTOMATION_SNAPSHOT_COMMAND_TIMEOUT_MS,
        );
      yield* Effect.all(
        [send("Page.enable"), send("Runtime.enable"), send("Accessibility.enable")],
        {
          concurrency: 3,
          discard: true,
        },
      );
      const readPage = Effect.fn("PreviewManager.readAutomationSnapshotPage")(function* () {
        const navigationGeneration = playwrightExecutionContextGenerations.get(tabId) ?? 0;
        const snapshotPage = yield* evaluateWithDebugger<
          Omit<AutomationSnapshotPage, "navigationGeneration" | "navigationGenerationAfterRead">
        >(
          tabId,
          send,
          `(() => {
          const selectorFor = (element) => {
            if (element.id) return "#" + CSS.escape(element.id);
            for (const attribute of ["data-testid", "name"]) {
              const value = element.getAttribute(attribute);
              if (value) return element.tagName.toLowerCase() + "[" + attribute + "=" + JSON.stringify(value) + "]";
            }
            const buildParts = (current, parts = []) => {
              if (!current || current.nodeType !== Node.ELEMENT_NODE || parts.length >= 8) {
                return parts;
              }
              const parent = current.parentElement;
              const siblings = parent
                ? Array.from(parent.children).filter((child) => child.tagName === current.tagName)
                : [];
              const base = current.tagName.toLowerCase();
              const part = siblings.length > 1
                ? base + ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")"
                : base;
              return buildParts(parent, [part, ...parts]);
            };
            return buildParts(element).join(" > ");
          };
          const visible = (element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
          };
          const editableInputMode = (element) => {
            if (!(element instanceof HTMLElement) ||
                element.matches(":disabled,[readonly],[aria-disabled=true]") ||
                (element.hasAttribute("contenteditable") && !element.isContentEditable)) {
              return null;
            }
            const requestedMode = (element.getAttribute("inputmode") || "").toLowerCase();
            if (requestedMode === "none") return null;
            const supportedModes = new Set(["text", "decimal", "numeric", "tel", "search", "email", "url"]);
            if (supportedModes.has(requestedMode)) return requestedMode;
            if (element instanceof HTMLInputElement) {
              const type = (element.type || "text").toLowerCase();
              if (["hidden", "button", "checkbox", "color", "date", "datetime-local", "file", "image", "month", "radio", "range", "reset", "submit", "time", "week"].includes(type)) return null;
              if (["email", "search", "tel", "url"].includes(type)) return type;
              if (type === "number") return "decimal";
              return "text";
            }
            return element instanceof HTMLTextAreaElement || element.isContentEditable || element.getAttribute("role") === "textbox"
              ? "text"
              : null;
          };
          const editableRegions = Array.from(document.querySelectorAll(
            "input,textarea,[contenteditable],[role=textbox]"
          )).filter(visible).map((element) => ({ element, inputMode: editableInputMode(element) }))
            .filter((entry) => entry.inputMode !== null)
            .slice(0, ${MAX_EDITABLE_REGIONS})
            .map(({ element, inputMode }) => {
              const rect = element.getBoundingClientRect();
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, inputMode };
            });
          const elements = Array.from(document.querySelectorAll(
            "a[href],button,input,textarea,select,[role],[tabindex]"
          )).filter(visible).slice(0, ${MAX_INTERACTIVE_ELEMENTS}).map((element) => {
            const rect = element.getBoundingClientRect();
            const select = element instanceof HTMLSelectElement ? element : null;
            return {
              tag: element.tagName.toLowerCase(),
              role: element.getAttribute("role"),
              // A select's innerText is every option run together, which reads
              // as a name and is not one. Its label belongs to the control.
              name: element.getAttribute("aria-label") ||
                (select ? (element.getAttribute("name") || "") : (element.innerText || element.getAttribute("name") || "")),
              selector: selectorFor(element),
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              ...(typeof element.value === "string" ? { value: element.value } : {}),
              ...(element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")
                ? { checked: element.checked }
                : {}),
              // The only way these ever reach a caller: the menu that shows
              // them is drawn outside the page.
              ...(select
                ? {
                    options: Array.from(select.options).slice(0, ${MAX_SELECT_OPTIONS}).map((option) => ({
                      label: (option.label || option.text || "").trim(),
                      value: option.value,
                      selected: option.selected
                    }))
                  }
                : {})
            };
          });
          const structuralElements = Array.from(document.querySelectorAll(
            "main,nav,form,dialog,[role=dialog],[role=main],[role=navigation],input[type=password]"
          )).filter(visible).slice(0, ${MAX_INTERACTIVE_ELEMENTS}).map((element) => ({
            tag: element.tagName.toLowerCase(),
            role: element.getAttribute("role"),
            selector: selectorFor(element)
          }));
          return {
            url: location.href,
            title: document.title,
            loading: document.readyState !== "complete",
            visibleText: (document.body?.innerText || "").slice(0, ${MAX_VISIBLE_TEXT_LENGTH}),
            documentKind: (document.contentType || "").toLowerCase().includes("pdf") ||
              /\\.pdf(?:$|[?#])/i.test(location.pathname) ||
              /\\.pdf\\b/i.test(document.title)
              ? "pdf"
              : "page",
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            interactiveElements: elements,
            editableRegions,
            structuralElements
          };
          })()`,
          { returnByValue: true },
        );
        const { documentKind, ...snapshotPageWithoutDocumentKind } = snapshotPage;
        return {
          ...snapshotPageWithoutDocumentKind,
          ...(typeof documentKind === "string" ? { documentKind } : {}),
          navigationGeneration,
          navigationGenerationAfterRead: playwrightExecutionContextGenerations.get(tabId) ?? 0,
        };
      });
      let page = yield* readPage();
      const encodeNativeScreenshot = (operation: string, sourceImage: Electron.NativeImage) =>
        attempt({ operation, tabId, webContentsId: wc.id }, () => {
          const sourceSize = sourceImage.getSize();
          if (sourceSize.width <= 0 || sourceSize.height <= 0) {
            throw new Error("Chromium returned an empty preview frame.");
          }
          const image =
            sourceSize.width > MAX_AUTOMATION_SCREENSHOT_WIDTH
              ? sourceImage.resize({ width: MAX_AUTOMATION_SCREENSHOT_WIDTH })
              : sourceImage;
          const size = image.getSize();
          return {
            mimeType: "image/jpeg" as const,
            data: image.toJPEG(AUTOMATION_SNAPSHOT_JPEG_QUALITY).toString("base64"),
            width: size.width,
            height: size.height,
          };
        });
      const capturePresentedFrame = Effect.fn("PreviewManager.capturePresentedFrame")(function* () {
        const frameReady = yield* Deferred.make<Electron.NativeImage>();
        let acceptFrame = false;
        let presentationBoundarySeen = false;
        const onFrame = (image: Electron.NativeImage): void => {
          // beginFrameSubscription may immediately replay Chromium's cached
          // frame. That is exactly the stale pre-navigation/login image this
          // path exists to reject; only accept callbacks after we are ready to
          // invalidate the live guest below.
          if (!acceptFrame) return;
          const size = image.getSize();
          if (size.width <= 0 || size.height <= 0) return;
          if (!presentationBoundarySeen) {
            // A cached callback can already be queued when subscription
            // returns. Discard the first full frame, then schedule a second
            // repaint from inside that presentation boundary. The next frame
            // therefore cannot be the pre-subscription replay.
            presentationBoundarySeen = true;
            try {
              if (!wc.isDestroyed()) wc.invalidate();
            } catch {
              // Destruction wakes the surrounding availability race/timeout.
            }
            return;
          }
          runFork(Deferred.succeed(frameReady, image));
        };
        yield* attempt(
          {
            operation: "automationSnapshot.beginFrameSubscription",
            tabId,
            webContentsId: wc.id,
          },
          () => wc.beginFrameSubscription(false, onFrame),
        );
        const cleanup = attempt(
          {
            operation: "automationSnapshot.endFrameSubscription",
            tabId,
            webContentsId: wc.id,
          },
          () => {
            if (!wc.isDestroyed()) wc.endFrameSubscription();
          },
        ).pipe(Effect.ignore);
        return yield* Effect.gen(function* () {
          // Subscription establishes a hidden capturer before invalidation,
          // so the callback is proof that the staged guest actually painted.
          acceptFrame = true;
          yield* attempt(
            {
              operation: "automationSnapshot.invalidatePresentedFrame",
              tabId,
              webContentsId: wc.id,
            },
            () => wc.invalidate(),
          );
          const image = yield* Deferred.await(frameReady).pipe(
            Effect.timeout(AUTOMATION_SNAPSHOT_PRESENTATION_TIMEOUT),
            Effect.mapError(
              (cause) =>
                new PreviewOperationError({
                  operation: "automationSnapshot.presentationFrame",
                  tabId,
                  webContentsId: wc.id,
                  cause,
                }),
            ),
          );
          return yield* encodeNativeScreenshot(
            "automationSnapshot.presentationFrame.encode",
            image,
          );
        }).pipe(Effect.ensuring(cleanup));
      });
      const nativeScreenshot = () =>
        Effect.suspend(() =>
          activityLeases.has(tabId, PreviewActivityConsumer.Ui)
            ? capturePresentedFrame()
            : Effect.fail(
                new PreviewOperationError({
                  operation: "automationSnapshot.presentationFrame",
                  tabId,
                  webContentsId: wc.id,
                  cause: new Error("The preview has no visible compositor surface."),
                }),
              ),
        );
      const captureDebuggerScreenshot = (fromSurface: boolean) => {
        return send("Page.captureScreenshot", {
          format: "jpeg",
          quality: AUTOMATION_SNAPSHOT_JPEG_QUALITY,
          fromSurface,
          captureBeyondViewport: false,
        }).pipe(
          Effect.flatMap((result) => {
            const data =
              typeof result === "object" &&
              result !== null &&
              "data" in result &&
              typeof result.data === "string"
                ? result.data
                : null;
            if (!data) {
              return Effect.fail(
                new PreviewOperationError({
                  operation: "automationSnapshot.Page.captureScreenshot",
                  tabId,
                  webContentsId: wc.id,
                  cause: new Error("Chromium returned an invalid debugger screenshot."),
                }),
              );
            }
            return attempt(
              {
                operation: "automationSnapshot.Page.captureScreenshot.decode",
                tabId,
                webContentsId: wc.id,
              },
              () => {
                const image = nativeImage.createFromBuffer(Buffer.from(data, "base64"));
                const sourceSize = image.getSize();
                if (sourceSize.width <= 0 || sourceSize.height <= 0) {
                  throw new Error("Chromium returned an empty debugger screenshot.");
                }
                if (sourceSize.width <= MAX_AUTOMATION_SCREENSHOT_WIDTH) {
                  // Page.captureScreenshot already produced the requested JPEG.
                  // Preserve those exact bytes instead of applying a second
                  // lossy encode that blurs small text and wastes CPU.
                  return {
                    mimeType: "image/jpeg" as const,
                    data,
                    width: sourceSize.width,
                    height: sourceSize.height,
                  };
                }
                const resized = image.resize({ width: MAX_AUTOMATION_SCREENSHOT_WIDTH });
                const size = resized.getSize();
                return {
                  mimeType: "image/jpeg" as const,
                  data: resized.toJPEG(AUTOMATION_SNAPSHOT_JPEG_QUALITY).toString("base64"),
                  width: size.width,
                  height: size.height,
                };
              },
            );
          }),
        );
      };
      const captureDebuggerScreencast = Effect.fn("PreviewManager.captureDebuggerScreencast")(
        function* () {
          const scale =
            page.viewportWidth > MAX_AUTOMATION_SCREENSHOT_WIDTH
              ? MAX_AUTOMATION_SCREENSHOT_WIDTH / page.viewportWidth
              : 1;
          const frameReady = yield* Deferred.make<string>();
          const onMessage = (
            _event: Electron.Event,
            method: string,
            params: Record<string, unknown>,
          ): void => {
            if (method !== "Page.screencastFrame" || typeof params["data"] !== "string") return;
            runFork(Deferred.succeed(frameReady, params["data"]));
          };
          yield* attempt(
            {
              operation: "automationSnapshot.Page.listenForScreencastFrame",
              tabId,
              webContentsId: wc.id,
            },
            () => wc.debugger.on("message", onMessage),
          );
          const cleanup = Effect.all(
            [
              attempt(
                {
                  operation: "automationSnapshot.Page.removeScreencastListener",
                  tabId,
                  webContentsId: wc.id,
                },
                () => wc.debugger.off("message", onMessage),
              ).pipe(Effect.ignore),
              attemptPromiseWithin(
                {
                  operation: "automationSnapshot.Page.stopScreencast",
                  tabId,
                  webContentsId: wc.id,
                },
                () => wc.debugger.sendCommand("Page.stopScreencast"),
                AUTOMATION_SNAPSHOT_COMMAND_TIMEOUT_MS,
              ).pipe(Effect.ignore),
            ],
            { concurrency: 2, discard: true },
          );
          return yield* Effect.gen(function* () {
            yield* send("Page.startScreencast", {
              format: "jpeg",
              quality: AUTOMATION_SNAPSHOT_JPEG_QUALITY,
              maxWidth: Math.max(1, Math.round(page.viewportWidth * scale)),
              maxHeight: Math.max(1, Math.round(page.viewportHeight * scale)),
              everyNthFrame: 1,
            });
            const data = yield* Deferred.await(frameReady).pipe(
              Effect.timeout(AUTOMATION_SNAPSHOT_SCREENCAST_TIMEOUT),
              Effect.mapError(
                (cause) =>
                  new PreviewOperationError({
                    operation: "automationSnapshot.Page.screencastFrame",
                    tabId,
                    webContentsId: wc.id,
                    cause,
                  }),
              ),
            );
            return {
              mimeType: "image/jpeg" as const,
              data,
              width: Math.max(1, Math.round(page.viewportWidth * scale)),
              height: Math.max(1, Math.round(page.viewportHeight * scale)),
            };
          }).pipe(Effect.ensuring(cleanup));
        },
      );
      const debuggerScreenshot = () =>
        captureDebuggerScreenshot(true).pipe(Effect.catch(() => captureDebuggerScreenshot(false)));
      const debuggerScreenshotWithScreencast = () =>
        debuggerScreenshot().pipe(Effect.catch(() => captureDebuggerScreencast()));
      const captureHiddenFallback = (debuggerCause: unknown) =>
        stageSnapshotSurface!(
          nativeScreenshot().pipe(
            Effect.tap(() =>
              Effect.logWarning(
                "Live renderer capture was unavailable; a staged native frame succeeded.",
                { tabId, debuggerCause },
              ),
            ),
            Effect.catch((nativeCause) =>
              captureDebuggerScreenshot(false).pipe(
                Effect.catch((viewCause) =>
                  captureDebuggerScreencast().pipe(
                    Effect.tap(() =>
                      Effect.logWarning(
                        "Direct and native capture were unavailable; a live screencast frame succeeded.",
                        { tabId, debuggerCause, nativeCause, viewCause },
                      ),
                    ),
                  ),
                ),
                Effect.tapError((screencastCause) =>
                  Effect.logWarning(
                    "Preview screenshot capture was unavailable from the hidden live guest.",
                    { tabId, debuggerCause, nativeCause, screencastCause },
                  ),
                ),
              ),
            ),
          ),
        );
      const captureVisibleScreenshot = () =>
        nativeScreenshot().pipe(
          Effect.catch((nativeCause) =>
            debuggerScreenshotWithScreencast().pipe(
              Effect.tap(() =>
                Effect.logWarning(
                  "Native preview capture was unavailable; a live background frame succeeded.",
                  { tabId, nativeCause },
                ),
              ),
              Effect.tapError((debuggerCause) =>
                Effect.logWarning(
                  "Preview screenshot capture was unavailable from the live guest.",
                  { tabId, nativeCause, debuggerCause },
                ),
              ),
            ),
          ),
        );
      const captureSameRendererScreenshot = () =>
        (stageSnapshotSurface === null
          ? captureVisibleScreenshot()
          : captureDebuggerScreenshot(true).pipe(Effect.catch(captureHiddenFallback))
        ).pipe(
          // A picture is one field of a snapshot. Failing the whole call for
          // it throws away the live URL, text, accessibility tree and
          // diagnostics. Never re-load the URL in a second renderer as a
          // fallback: cookies alone do not reproduce in-memory auth or
          // sessionStorage, so those pixels can lie about the live tab.
          // A replaced guest is different: the rest of the snapshot is also
          // from the predecessor, so retry the whole operation against the
          // successor instead of mixing its pixels with the old DOM.
          Effect.catch((cause) =>
            isReplacedGuestSnapshotFailure(cause)
              ? Effect.fail(cause)
              : Effect.succeed({
                  screenshotError: describeScreenshotFailure(cause),
                } as const),
          ),
        );
      const captureFrameAccessibility = (frameId?: string) =>
        send("Accessibility.getFullAXTree", frameId === undefined ? undefined : { frameId }).pipe(
          Effect.catch(() => Effect.succeed({ nodes: [] })),
        );
      const captureAccessibility = () =>
        Effect.gen(function* () {
          // Chromium's PDF viewer (and other plugins) keep the page text in a
          // child frame. Main-frame getFullAXTree is then just an empty iframe.
          const frameTreeResult = yield* send("Page.getFrameTree").pipe(
            Effect.catch(() => Effect.succeed({})),
          );
          const frameIds = collectFrameIdsFromTree(frameTreeResult).slice(0, 16);
          const trees =
            frameIds.length === 0
              ? [yield* captureFrameAccessibility()]
              : yield* Effect.forEach(frameIds, (frameId) => captureFrameAccessibility(frameId));
          return mergeAccessibilityTrees(trees);
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning(
              "Preview accessibility capture was unavailable; returning the DOM snapshot.",
              { tabId, cause },
            ).pipe(Effect.as({ nodes: [] })),
          ),
        );
      const captureBracket = Effect.fn("PreviewManager.captureAutomationSnapshotBracket")(
        function* (openingPage: AutomationSnapshotPage) {
          page = openingPage;
          const screenshot = yield* captureSameRendererScreenshot();
          const accessibility = yield* captureAccessibility();
          const closingPage = yield* readPage();
          return { accessibility, closingPage, openingPage, screenshot };
        },
      );

      let bracket = yield* captureBracket(page);
      if (!isSameAutomationSnapshotPage(bracket.openingPage, bracket.closingPage)) {
        // Auth hydration and SPA navigation can legitimately win during a
        // capture. Retry the whole semantic interval once against the same
        // live guest; never mix the first image or AX tree with the new DOM.
        const retryOpeningPage = yield* readPage();
        bracket = yield* captureBracket(retryOpeningPage);
      }

      const remainedUnstable = !isSameAutomationSnapshotPage(
        bracket.openingPage,
        bracket.closingPage,
      );
      if (remainedUnstable) {
        yield* Effect.logWarning(
          "The live preview changed throughout both snapshot capture intervals.",
          { tabId },
        );
      }
      page = bracket.closingPage;
      const accessibilityTree = remainedUnstable ? { nodes: [] } : bracket.accessibility;
      const axText = visibleTextFromAccessibilityTree(accessibilityTree, MAX_VISIBLE_TEXT_LENGTH);
      const pdfDocument =
        page.documentKind === "pdf" || isPdfPreviewDocument({ url: page.url, title: page.title });
      if (axText.length > 0 && (pdfDocument || page.visibleText.trim().length === 0)) {
        page = pdfDocument
          ? { ...page, visibleText: axText, documentKind: "pdf" }
          : { ...page, visibleText: axText };
      } else if (pdfDocument && page.documentKind !== "pdf") {
        page = { ...page, documentKind: "pdf" };
      }
      if (!remainedUnstable) {
        const updatedAt = yield* currentIso;
        const reconciledNavigation = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
          const current = tabs.get(tabId);
          if (current?.webContentsId !== wc.id) {
            return [Option.none<PreviewTabState>(), tabs] as const;
          }
          const pendingNavigation = navigationAttemptsByTab.get(tabId);
          if (
            current.navStatus.kind === "Loading" &&
            pendingNavigation?.webContentsId === wc.id &&
            pendingNavigation.url === current.navStatus.url &&
            page.url !== pendingNavigation.url
          ) {
            // A snapshot of the previous page is not a lifecycle receipt for
            // a just-dispatched navigation. Keep the optimistic target until
            // that guest starts or settles its own main-frame load.
            return [Option.none<PreviewTabState>(), tabs] as const;
          }
          const navStatus: PreviewNavStatus = page.loading
            ? { kind: "Loading", url: page.url, title: page.title }
            : { kind: "Success", url: page.url, title: page.title };
          if (
            current.navStatus.kind === navStatus.kind &&
            current.navStatus.url === navStatus.url &&
            current.navStatus.title === navStatus.title
          ) {
            return [Option.none<PreviewTabState>(), tabs] as const;
          }
          const state: PreviewTabState = { ...current, navStatus, updatedAt };
          return [
            Option.some(state),
            replaceMap(tabs, (copy) => {
              copy.set(tabId, state);
            }),
          ] as const;
        });
        if (Option.isSome(reconciledNavigation)) {
          yield* emit(tabId, reconciledNavigation.value);
        }
      }
      const screenshot = remainedUnstable
        ? ({
            screenshotError:
              "The live page changed while its frame was being captured, so no screenshot was returned. The URL, text, and controls below are from the latest page state; wait for the page to settle before relying on its visual state.",
          } as const)
        : bracket.screenshot;
      const accessibility = remainedUnstable ? { nodes: [] } : bracket.accessibility;
      const [diagnostics, timelines] = yield* Effect.all([
        Ref.get(diagnosticsRef),
        Ref.get(actionTimelineRef),
      ]);
      const snapshotTabs = yield* SynchronizedRef.get(tabsRef);
      const browserDiagnostics = diagnostics.get(wc.id);
      const {
        navigationGeneration: _navigationGeneration,
        navigationGenerationAfterRead: _navigationGenerationAfterRead,
        structuralElements: _structuralElements,
        viewportWidth,
        viewportHeight,
        ...snapshotPage
      } = page;
      return {
        ...snapshotPage,
        // The picture is in device pixels; this is what lets a caller map a
        // point in it back onto the page.
        ...(Number.isFinite(viewportWidth) && Number.isFinite(viewportHeight)
          ? { viewport: { width: Math.round(viewportWidth), height: Math.round(viewportHeight) } }
          : {}),
        accessibilityTree: accessibility,
        consoleEntries: [...(browserDiagnostics?.consoleEntries ?? [])],
        networkEntries: [...(browserDiagnostics?.networkEntries ?? [])],
        actionTimeline: [...(timelines.get(tabId) ?? [])],
        // Downloads finish with no save panel and no on-screen trace, so an
        // agent that asked for one has no other way to learn it arrived — or
        // where. Without this, a silent success is indistinguishable from a
        // failure, and the agent simply asks again.
        downloads: browserSession.recentDownloads(),
        // A held download looks exactly like a failed one from inside the
        // page, so say it is waiting on a person rather than letting the
        // agent conclude nothing happened and fetch it again.
        pendingDownloadApprovals: [...(snapshotTabs.get(tabId)?.pendingDownloadApprovals ?? [])],
        ...("screenshotError" in screenshot
          ? { screenshotError: screenshot.screenshotError }
          : { screenshot }),
      };
    },
  );

  const withStagedSnapshotSurface = <A, E, R>(
    tabId: string,
    wc: Electron.WebContents,
    capture: Effect.Effect<A, E, R>,
  ): Effect.Effect<
    A,
    E | PreviewOperationError | PreviewTabNotFoundError | PreviewWebContentsNotFoundError,
    R
  > =>
    Effect.gen(function* () {
      const sequence = yield* nextCounter(snapshotStageSequenceRef);
      const stageId = `${wc.id}:${sequence}`;
      const ready = yield* Deferred.make<void>();
      yield* Ref.update(snapshotStageRequestsRef, (requests) =>
        replaceMap(requests, (copy) => {
          copy.set(stageId, { tabId, ready });
        }),
      );

      const cleanup = Effect.gen(function* () {
        activityLeases.release(tabId, `ui:snapshot-stage:${stageId}`);
        yield* recordActivityLeaseMetrics();
        yield* Ref.update(snapshotStageRequestsRef, (requests) =>
          replaceMap(requests, (copy) => {
            copy.delete(stageId);
          }),
        );
        const current = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
        if (current?.webContentsId === wc.id && current.snapshotStageId === stageId) {
          const updatedAt = yield* currentIso;
          const cleared = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
            const latest = tabs.get(tabId);
            if (latest?.webContentsId !== wc.id || latest.snapshotStageId !== stageId) {
              return [Option.none<PreviewTabState>(), tabs] as const;
            }
            const state: PreviewTabState = { ...latest, snapshotStageId: null, updatedAt };
            return [
              Option.some(state),
              replaceMap(tabs, (copy) => {
                copy.set(tabId, state);
              }),
            ] as const;
          });
          if (Option.isSome(cleared)) yield* emit(tabId, cleared.value);
        }
      });

      return yield* Effect.gen(function* () {
        const updatedAt = yield* currentIso;
        const staged = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
          const current = tabs.get(tabId);
          if (current?.webContentsId !== wc.id) {
            return [Option.none<PreviewTabState>(), tabs] as const;
          }
          const state: PreviewTabState = { ...current, snapshotStageId: stageId, updatedAt };
          return [
            Option.some(state),
            replaceMap(tabs, (copy) => {
              copy.set(tabId, state);
            }),
          ] as const;
        });
        if (Option.isNone(staged)) {
          return yield* new PreviewWebContentsNotFoundError({
            tabId,
            webContentsId: wc.id,
          });
        }
        yield* emit(tabId, staged.value);
        yield* Deferred.await(ready).pipe(
          Effect.timeout(AUTOMATION_SNAPSHOT_STAGE_TIMEOUT),
          Effect.mapError(
            (cause) =>
              new PreviewOperationError({
                operation: "automationSnapshot.stageBackgroundTab",
                tabId,
                webContentsId: wc.id,
                cause,
              }),
          ),
        );
        yield* ensureCurrentWebContents(tabId, wc);
        // The renderer receipt proves the guest is attached at compositor-
        // eligible geometry. The staged capture then subscribes before its
        // invalidate call and waits for an actual presentation callback.
        return yield* capture;
      }).pipe(Effect.ensuring(cleanup));
    });

  const automationSnapshot = Effect.fn("PreviewManager.automationSnapshot")(function* (
    tabId: string,
  ) {
    return yield* Effect.gen(function* () {
      // Navigation can replace a guest or its JavaScript context between the
      // host readiness check and the first CDP command. Snapshot is read-only,
      // so retry the whole operation and resolve WebContents again instead of
      // retrying capturePage alone against a stale guest.
      const wc = yield* requireWebContents(tabId);
      return yield* withControlSession(tabId, wc, "snapshot", () => {
        const stageSnapshotSurface: StageSnapshotSurface | null =
          mainWindowFocused && activityLeases.has(tabId, PreviewActivityConsumer.Ui)
            ? null
            : (capture) => withStagedSnapshotSurface(tabId, wc, capture);
        return captureAutomationSnapshot(tabId, wc, stageSnapshotSurface);
      });
    }).pipe(
      Effect.retry({
        times: AUTOMATION_SNAPSHOT_RETRIES,
        schedule: Schedule.spaced(AUTOMATION_SNAPSHOT_RETRY_MS),
        while: isRetryableAutomationSnapshotFailure,
      }),
    );
  });

  /**
   * The picture and nothing else.
   *
   * Deliberately not a trimmed snapshot: it skips the DOM reads and the
   * accessibility tree that exist to keep a snapshot's *text* consistent with
   * its image, because there is no text here to be inconsistent with.
   *
   * `fromSurface` must be true. The non-surface capture was chosen so a frame
   * would not require this machine to be showing the tab — but on macOS a
   * hidden guest's non-surface capture can return pixels of a DIFFERENT
   * surface entirely. Observed 2026-08-29: a guest whose own URL read
   * suno.com/create was served to mirror viewers as a live picture of this
   * app's main window, native traffic lights included, matching a screenshot
   * of the actual screen. The snapshot ladder learned the same lesson and
   * pins fromSurface: true throughout. When the composited surface is not
   * available the command fails instead of lying, and the server falls back
   * to the snapshot path, which stages hidden guests properly.
   */
  const automationFrame = Effect.fn("PreviewManager.automationFrame")(function* (tabId: string) {
    const wc = yield* requireWebContents(tabId);
    return yield* withControlSession(tabId, wc, "frame", (send) =>
      Effect.gen(function* () {
        const captured = yield* send("Page.captureScreenshot", {
          format: "jpeg",
          quality: AUTOMATION_SNAPSHOT_JPEG_QUALITY,
          fromSurface: true,
          captureBeyondViewport: false,
        });
        const data =
          typeof captured === "object" &&
          captured !== null &&
          "data" in captured &&
          typeof captured.data === "string"
            ? captured.data
            : null;
        if (data === null) {
          return yield* Effect.fail(
            new PreviewOperationError({
              operation: "automationFrame.Page.captureScreenshot",
              tabId,
              webContentsId: wc.id,
              cause: new Error("The renderer returned no image data."),
            }),
          );
        }
        const metrics = yield* send("Page.getLayoutMetrics").pipe(
          Effect.catch(() => Effect.succeed({})),
        );
        const cssViewport =
          typeof metrics === "object" && metrics !== null && "cssLayoutViewport" in metrics
            ? (metrics.cssLayoutViewport as Record<string, unknown>)
            : {};
        const width = cssViewport["clientWidth"];
        const height = cssViewport["clientHeight"];
        const viewport =
          typeof width === "number" && typeof height === "number" && width > 0 && height > 0
            ? { width: Math.round(width), height: Math.round(height) }
            : undefined;
        const reportedEditableRegions = yield* evaluateWithDebugger<
          NonNullable<PreviewAutomationFrame["editableRegions"]>
        >(
          tabId,
          send,
          `(() => {
            const visible = (element) => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return style.visibility !== "hidden" && style.display !== "none" &&
                rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 &&
                rect.left < window.innerWidth && rect.top < window.innerHeight;
            };
            const inputMode = (element) => {
              if (!(element instanceof HTMLElement) ||
                  element.matches(":disabled,[readonly],[aria-disabled=true]") ||
                  (element.hasAttribute("contenteditable") && !element.isContentEditable)) return null;
              const requested = (element.getAttribute("inputmode") || "").toLowerCase();
              if (requested === "none") return null;
              if (["text", "decimal", "numeric", "tel", "search", "email", "url"].includes(requested)) return requested;
              if (element instanceof HTMLInputElement) {
                const type = (element.type || "text").toLowerCase();
                if (["hidden", "button", "checkbox", "color", "date", "datetime-local", "file", "image", "month", "radio", "range", "reset", "submit", "time", "week"].includes(type)) return null;
                if (["email", "search", "tel", "url"].includes(type)) return type;
                return type === "number" ? "decimal" : "text";
              }
              return element instanceof HTMLTextAreaElement || element.isContentEditable || element.getAttribute("role") === "textbox"
                ? "text"
                : null;
            };
            return Array.from(document.querySelectorAll("input,textarea,[contenteditable],[role=textbox]"))
              .filter(visible)
              .map((element) => ({ element, inputMode: inputMode(element) }))
              .filter((entry) => entry.inputMode !== null)
              .slice(0, ${MAX_EDITABLE_REGIONS})
              .map(({ element, inputMode }) => {
                const rect = element.getBoundingClientRect();
                return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, inputMode };
              });
          })()`,
          { returnByValue: true },
        ).pipe(Effect.catch(() => Effect.succeed([])));
        const editableRegions = Array.isArray(reportedEditableRegions)
          ? reportedEditableRegions
          : [];
        // The frame is a remote viewer's only feed, so a download held for
        // approval has to travel in it — the desktop's Allow/Deny overlay
        // never leaves this machine, and without this line a person watching
        // from another device cannot learn the download exists at all.
        const heldApprovals =
          (yield* SynchronizedRef.get(tabsRef)).get(tabId)?.pendingDownloadApprovals ?? [];
        return {
          url: wc.getURL(),
          title: wc.getTitle(),
          loading: wc.isLoading(),
          screenshot: {
            mimeType: "image/jpeg" as const,
            data,
            // The capture is the layout viewport at a uniform scale, so these
            // carry its shape rather than a guess at the device pixel ratio.
            // Consumers letterbox by this ratio and scale by the CSS viewport
            // below, both of which this states exactly.
            width: viewport?.width ?? 0,
            height: viewport?.height ?? 0,
          },
          ...(viewport === undefined ? {} : { viewport }),
          ...(editableRegions.length === 0 ? {} : { editableRegions }),
          ...(heldApprovals.length === 0 ? {} : { pendingDownloadApprovals: [...heldApprovals] }),
        } satisfies PreviewAutomationFrame;
      }),
    );
  });

  /**
   * Where this machine's DevTools endpoint is, and which target on it is this
   * guest.
   *
   * The target id comes from the guest's own debugger session rather than by
   * matching URLs in the endpoint's target list: two tabs can sit on the same
   * URL, and a mistake here would hand a caller DevTools for the wrong page —
   * or for one of the app's own windows, which are targets on that endpoint
   * too. Whoever proxies this treats the id as the only target it may reach.
   */
  /**
   * Chromium writes the port it bound to once, at startup. A build launched
   * without the switch has no file, and DevTools is simply unavailable rather
   * than aimed at whatever else might be listening on a guessed port.
   */
  const readDevToolsEndpoint = Effect.gen(function* () {
    const directories = devToolsActivePortCandidates(app.getPath("userData"));
    for (const directory of directories) {
      const activePortFile = path.join(directory, "DevToolsActivePort");
      const contents = yield* fileSystem
        .readFileString(activePortFile)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (contents === null) continue;
      const endpoint = parseDevToolsActivePort(contents);
      if (endpoint !== null) return endpoint;
    }
    return yield* Effect.fail(
      new PreviewOperationError({
        operation: "devtools.readActivePort",
        artifactPath: directories.join(", "),
        cause: new Error("This build did not open a DevTools endpoint."),
      }),
    );
  });

  /**
   * Where this machine's DevTools endpoint is, and which target on it is this
   * guest.
   *
   * The target id comes from the guest's own debugger session rather than by
   * matching URLs against the endpoint's target list: two tabs can sit on the
   * same URL, and the endpoint also exposes the app's own windows, so a
   * mistake here would hand a caller DevTools for the wrong page entirely.
   * Whoever proxies this treats the returned id as the only target it may
   * reach.
   */
  const automationDevTools = Effect.fn("PreviewManager.automationDevTools")(function* (
    tabId: string,
  ) {
    const endpoint = yield* readDevToolsEndpoint;
    const wc = yield* requireWebContents(tabId);
    const targetId = yield* withControlSession(tabId, wc, "devtools", (send) =>
      send("Target.getTargetInfo").pipe(
        Effect.flatMap((info) => {
          const targetInfo =
            typeof info === "object" && info !== null && "targetInfo" in info
              ? (info.targetInfo as Record<string, unknown>)
              : {};
          const id = targetInfo["targetId"];
          return typeof id === "string" && id.length > 0
            ? Effect.succeed(id)
            : Effect.fail(
                new PreviewOperationError({
                  operation: "automationDevTools.Target.getTargetInfo",
                  tabId,
                  webContentsId: wc.id,
                  cause: new Error("The guest reported no target id."),
                }),
              );
        }),
      ),
    );
    return { port: endpoint.port, targetId } satisfies PreviewAutomationDevTools;
  });

  const resolveClickPoint = Effect.fn("PreviewManager.resolveClickPoint")(function* (
    tabId: string,
    send: SendCommand,
    input: PreviewAutomationClickInput,
  ) {
    if (!("selector" in input) && !("locator" in input)) {
      return { x: input.x!, y: input.y! };
    }
    const locator = automationLocator(input)!;
    const executionContextId = yield* ensurePlaywrightInjected(tabId, send);
    const locatorJson = yield* encodeJson(
      { operation: "automationClick.encodeLocator", tabId },
      locator,
    );
    const point = yield* evaluateWithDebugger<
      | { x: number; y: number }
      | { invalidSelector: true; message: string }
      | { notFound: true }
      | { nativeMenu: true }
    >(
      tabId,
      send,
      `(() => {
          try {
            const injected = globalThis.__t3PlaywrightInjected;
            const parsed = injected.parseSelector(${locatorJson});
            const element = injected.querySelector(parsed, document, true);
            if (!element) return { notFound: true };
            // Clicking one opens a menu the browser draws outside the page.
            // Nothing can observe or dismiss it from here, so refuse rather
            // than report a success that leaves it open on the user's screen.
            if (element instanceof HTMLSelectElement) return { nativeMenu: true };
            const visible = injected.elementState(element, "visible");
            const enabled = injected.elementState(element, "enabled");
            if (!visible.matches || !enabled.matches) return { notFound: true };
            element.scrollIntoView({ block: "center", inline: "center" });
            const rect = element.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          } catch (error) {
            return { invalidSelector: true, message: String(error) };
          }
        })()`,
      { returnByValue: true, contextId: executionContextId },
    );
    if ("invalidSelector" in point) {
      return yield* new PreviewAutomationInvalidSelectorError({
        operation: "click",
        tabId,
        ...automationSelectorDiagnostics(input),
        reasonLength: point.message.length,
        cause: point,
      });
    }
    if ("nativeMenu" in point) {
      return yield* new PreviewAutomationTargetNotEditableError({
        tabId,
        ...automationSelectorDiagnostics(input),
        nativeMenu: true,
      });
    }
    if ("notFound" in point) {
      return yield* new PreviewAutomationTargetNotFoundError({
        operation: "click",
        tabId,
        ...automationSelectorDiagnostics(input),
      });
    }
    return point;
  });

  const emitPointerEvent = Effect.fn("PreviewManager.emitPointerEvent")(function* (
    event: DesktopPreviewPointerEvent,
  ) {
    const listeners = yield* Ref.get(pointerEventListenersRef);
    yield* Effect.forEach(
      listeners,
      (listener) => deliverEvent("pointer-event", event.tabId, () => listener(event)),
      { discard: true },
    );
  });
  /** Drop the "waiting for you" badge once the wait ends, however it ended. */
  const clearWaitingForUser = Effect.fn("PreviewManager.clearWaitingForUser")(function* (
    tabId: string,
    deferred: boolean,
  ) {
    if (!deferred) return;
    const tabs = yield* SynchronizedRef.get(tabsRef);
    if (tabs.get(tabId)?.controller === "waiting-for-user") {
      yield* update(tabId, { controller: "none" });
    }
  });

  /**
   * Hold automation off the keyboard while the user is actively using it.
   *
   * The action waits its turn rather than failing: taking the caret out from
   * under someone mid-sentence cannot be undone, whereas waiting costs a
   * moment. Their typing inside a guest counts too, which is what makes this
   * hold after an agent click has moved their focus into a page.
   */
  const deferToUserInput = Effect.fn("PreviewManager.deferToUserInput")(function* (
    operation: string,
    tabId: string,
  ) {
    const startedAt = yield* currentMillis;
    // Time spent holding push-to-talk does not consume the ordinary 10-second
    // delivery budget. The budget restarts on release, after which the normal
    // idle cooldown still has to elapse in full.
    let maxWaitStartedAt = startedAt;
    let deferred = false;
    while (true) {
      const now = yield* currentMillis;
      if (pushToTalkInputActive) maxWaitStartedAt = now;
      if (
        resolveUserInputDeferral({
          lastUserInputAtMs,
          nowMs: now,
          pushToTalkActive: pushToTalkInputActive,
          waitingSinceMs: maxWaitStartedAt,
        }) === "proceed"
      ) {
        break;
      }
      if (!deferred) {
        // Say why nothing is happening: waiting silently looks identical to the
        // agent being stuck.
        const tabs = yield* SynchronizedRef.get(tabsRef);
        if (tabs.has(tabId)) yield* update(tabId, { controller: "waiting-for-user" });
      }
      deferred = true;
      yield* Effect.sleep(USER_INPUT_DEFERRAL_POLL_MS);
    }
    if (deferred) {
      const settledAt = yield* currentMillis;
      yield* Effect.logInfo("Preview automation deferred to user input.", {
        operation,
        tabId,
        waitedMs: settledAt - startedAt,
      });
    }
  });

  /**
   * Serialises everything that takes the caret so queued actions run one at a
   * time in arrival order, and the wait for the user happens inside that turn.
   * Without this, two agents racing the same window fight over focus.
   */
  const withAutomationInputTurn = <A, E, R>(
    operation: string,
    tabId: string,
    action: Effect.Effect<A, E, R>,
  ) =>
    automationInputMutex.withPermits(1)(
      Effect.gen(function* () {
        yield* deferToUserInput(operation, tabId);
        automationTurnsInFlight += 1;
        return yield* action.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              automationTurnsInFlight -= 1;
            }),
          ),
        );
      }).pipe(
        // Also runs when the wait is interrupted, so the badge can never
        // outlive the thing it describes.
        Effect.ensuring(clearWaitingForUser(tabId, true)),
      ),
    );

  const performAutomationClick = Effect.fn("PreviewManager.performAutomationClick")(function* (
    tabId: string,
    input: PreviewAutomationClickInput,
    send: SendCommand,
  ) {
    yield* prepareAutomationInput(send, true);
    const point = yield* resolveClickPoint(tabId, send, input);
    const viewport = yield* evaluateWithDebugger<{ width: number; height: number }>(
      tabId,
      send,
      "({ width: window.innerWidth, height: window.innerHeight })",
      { returnByValue: true },
    );
    if (point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height) {
      return yield* new PreviewAutomationCoordinatesOutsideViewportError({
        tabId,
        x: point.x,
        y: point.y,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      });
    }
    const moveSequence = yield* nextCounter(pointerSequenceRef);
    const moveCreatedAt = yield* currentIso;
    yield* emitPointerEvent({
      tabId,
      phase: "move",
      ...point,
      sequence: moveSequence,
      createdAt: moveCreatedAt,
    });
    yield* Effect.sleep(AGENT_CURSOR_MOVE_MS);
    const clickSequence = yield* nextCounter(pointerSequenceRef);
    const clickCreatedAt = yield* currentIso;
    yield* emitPointerEvent({
      tabId,
      phase: "click",
      ...point,
      sequence: clickSequence,
      createdAt: clickCreatedAt,
    });
    yield* Effect.sleep(AGENT_CURSOR_CLICK_LEAD_MS);
    yield* send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...point,
      button: "none",
    });
    // A right press travels through the renderer's real input pipeline, so
    // the page sees mousedown/mouseup and its contextmenu event exactly as it
    // would from a physical mouse — which is what lets a remote viewer's
    // long-press open the guest's own context menus.
    const button = input.button ?? "left";
    yield* expectAgentInput(tabId, {
      kind: "pointer",
      ...point,
      button: button === "right" ? 2 : 0,
    });
    yield* send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
      button,
      clickCount: 1,
    });
    yield* send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...point,
      button,
      clickCount: 1,
    });
  });

  const automationClickUnlocked = Effect.fn("PreviewManager.automationClickUnlocked")(function* (
    tabId: string,
    input: PreviewAutomationClickInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    // A synthetic mouse press focuses the guest exactly like a real one, and
    // that focus outlives the click. Every agent click therefore moved the
    // user's caret out of the chat composer into the page, and their next
    // keystroke went to the site instead of their message. Put focus back
    // where they left it.
    const previouslyFocused = yield* attempt(
      { operation: "automationClick.getFocusedWebContents", tabId, webContentsId: wc.id },
      () => webContents.getFocusedWebContents(),
    ).pipe(Effect.catch(() => Effect.succeed(null)));
    yield* withControlSession(tabId, wc, "click", (send) =>
      performAutomationClick(tabId, input, send),
    );
    if (previouslyFocused && previouslyFocused.id !== wc.id && !previouslyFocused.isDestroyed()) {
      // Only if the click is what moved focus. If the user clicked into the
      // preview themselves meanwhile, leave their focus alone.
      const focusedNow = yield* attempt(
        {
          operation: "automationClick.getFocusedWebContentsAfterDispatch",
          tabId,
          webContentsId: wc.id,
        },
        () => webContents.getFocusedWebContents(),
      ).pipe(Effect.catch(() => Effect.succeed(null)));
      if (focusedNow === null || focusedNow.id === wc.id) {
        yield* attempt(
          {
            operation: "automationClick.restoreFocusedWebContents",
            tabId,
            webContentsId: previouslyFocused.id,
          },
          () => previouslyFocused.focus(),
        ).pipe(Effect.ignore);
      }
    }
  });

  const automationClick = Effect.fn("PreviewManager.automationClick")(function* (
    tabId: string,
    input: PreviewAutomationClickInput,
  ) {
    yield* withAutomationInputTurn("click", tabId, automationClickUnlocked(tabId, input));
  });

  const typeIntoAutomationTarget = Effect.fn("PreviewManager.typeIntoAutomationTarget")(function* (
    tabId: string,
    send: SendCommand,
    input: PreviewAutomationTypeInput,
  ) {
    const locator = automationLocator(input);
    const executionContextId = locator ? yield* ensurePlaywrightInjected(tabId, send) : undefined;
    const locatorJson = locator
      ? yield* encodeJson({ operation: "automationType.encodeLocator", tabId }, locator)
      : null;
    const result = yield* evaluateWithDebugger<
      | { ok: true }
      | { invalidSelector: true; message: string }
      | { notEditable: true }
      | { notFound: true }
    >(
      tabId,
      send,
      `(() => {
          try {
            const element = ${locatorJson ? `(() => { const injected = globalThis.__t3PlaywrightInjected; return injected.querySelector(injected.parseSelector(${locatorJson}), document, true); })()` : "document.activeElement"};
            if (!element) return { notFound: true };
            const textControl =
              element instanceof HTMLTextAreaElement ||
              (element instanceof HTMLInputElement &&
                !new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]).has(element.type));
            const editable = textControl || element.isContentEditable;
            if (!editable || element.disabled || element.readOnly) return { notEditable: true };
            element.focus();
            if (document.activeElement !== element) return { notEditable: true };
            const clear = ${input.clear ?? false};
            if (clear) {
              if (textControl) {
                element.select();
              } else {
                const range = document.createRange();
                range.selectNodeContents(element);
                const selection = document.getSelection();
                selection?.removeAllRanges();
                selection?.addRange(range);
              }
            }
            return { ok: true };
          } catch (error) {
            return { invalidSelector: true, message: String(error) };
          }
        })()`,
      { returnByValue: true, contextId: executionContextId },
    );
    if ("invalidSelector" in result) {
      return yield* new PreviewAutomationInvalidSelectorError({
        operation: "type",
        tabId,
        ...automationSelectorDiagnostics(input),
        reasonLength: result.message.length,
        cause: result,
      });
    }
    if ("notFound" in result) {
      return yield* new PreviewAutomationTargetNotFoundError({
        operation: "type",
        tabId,
        ...automationSelectorDiagnostics(input),
      });
    }
    if ("notEditable" in result) {
      return yield* new PreviewAutomationTargetNotEditableError({
        tabId,
        ...automationSelectorDiagnostics(input),
      });
    }
  });

  const performAutomationType = Effect.fn("PreviewManager.performAutomationType")(function* (
    tabId: string,
    wc: Electron.WebContents,
    input: PreviewAutomationTypeInput,
    send: SendCommand,
    sendCleanup: SendCommand,
  ) {
    yield* prepareAutomationInput(send, true);
    const previouslyFocused = yield* attempt(
      { operation: "automationType.getFocusedWebContents", tabId, webContentsId: wc.id },
      () => webContents.getFocusedWebContents(),
    );
    const clearSequence = makePreviewAutomationKeySequence(
      { key: "Backspace" },
      { isMac: hostPlatform === "darwin" },
    );
    let clearKeyDownAttempted = false;
    const releaseInput = Effect.gen(function* () {
      if (clearKeyDownAttempted) {
        yield* sendCleanup("Input.dispatchKeyEvent", clearSequence.keyUp).pipe(Effect.ignore);
      }
      yield* sendCleanup("Emulation.setFocusEmulationEnabled", {
        enabled: automationForegroundActive,
      }).pipe(Effect.ignore);
      if (previouslyFocused && previouslyFocused.id !== wc.id && !previouslyFocused.isDestroyed()) {
        // Only hand focus back if the guest we borrowed still holds it. When the
        // user moves focus mid-dispatch — typically by clicking into the visible
        // preview — restoring would pull the caret out from under them, and the
        // next thing they type or paste lands in the composer instead of the
        // page they are looking at.
        const focusedNow = yield* attempt(
          {
            operation: "automationType.getFocusedWebContentsAfterDispatch",
            tabId,
            webContentsId: wc.id,
          },
          () => webContents.getFocusedWebContents(),
        ).pipe(Effect.catch(() => Effect.succeed(null)));
        if (focusedNow === null || focusedNow.id === wc.id) {
          yield* attempt(
            {
              operation: "automationType.restoreFocusedWebContents",
              tabId,
              webContentsId: previouslyFocused.id,
            },
            () => previouslyFocused.focus(),
          ).pipe(Effect.ignore);
        }
      }
    });

    // Native CDP input only reaches a hidden/background guest after Chromium has
    // activated that WebContents. `setFocusEmulationEnabled` alone is NOT enough
    // — dropping the `focus()` call was tried and `Input.insertText` silently did
    // nothing against a hidden guest, so agent typing never reached the page.
    // Focus it without surfacing its thread, emulate renderer focus for the
    // dispatch, then hand focus back below.
    yield* Effect.gen(function* () {
      yield* attempt(
        { operation: "automationType.focusWebContents", tabId, webContentsId: wc.id },
        () => wc.focus(),
      );
      yield* send("Page.bringToFront");
      yield* send("Emulation.setFocusEmulationEnabled", { enabled: true });
      // Give the guest's widget keyboard focus the way a real click does.
      // Focusing the WebContents is not enough for a `<webview>`: without a
      // press, Chromium keeps routing keys to whichever widget the app has
      // focused — the chat composer — so the agent's text lands in the user's
      // conversation instead of the page. Only editable targets reach here, so
      // the press cannot activate a control.
      if (automationLocator(input)) {
        const focusPoint = yield* resolveClickPoint(
          tabId,
          send,
          input as unknown as PreviewAutomationClickInput,
        );
        // Mirror the click path exactly: Chromium hit-tests from the last
        // pointer position, and the focus change it triggers propagates to the
        // widget asynchronously. Skipping the move, or inserting text in the
        // same tick as the release, leaves focus where it was.
        yield* send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...focusPoint,
          button: "none",
        });
        // Register the press as agent input before dispatching it, exactly as
        // the click path does. The guest reports each input back and unattributed
        // synthetic events are not honoured, so an unregistered press never
        // moves focus.
        yield* expectAgentInput(tabId, { kind: "pointer", ...focusPoint, button: 0 });
        yield* send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          ...focusPoint,
          button: "left",
          clickCount: 1,
        });
        yield* send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          ...focusPoint,
          button: "left",
          clickCount: 1,
        });
        yield* Effect.sleep(AUTOMATION_FOCUS_SETTLE_MS);
      }
      yield* typeIntoAutomationTarget(tabId, send, input);
      if (input.text.length > 0) {
        yield* send("Input.insertText", { text: input.text });
        // `Input.insertText` is delivered to whichever widget Chromium considers
        // focused, which is not necessarily this guest: focusing a `<webview>`'s
        // WebContents does not move the embedder's focus into it, so the text can
        // land in the app's own chat composer while this call still reports
        // success. Read it back from the guest so a misdelivery fails loudly
        // instead of silently typing into the user's conversation.
        const insertedJson = yield* encodeJson(
          { operation: "automationType.encodeVerification", tabId },
          input.text,
        );
        const landedInGuest = yield* evaluateWithDebugger<unknown>(
          tabId,
          send,
          `(() => {
            const element = document.activeElement;
            if (!element) return false;
            return ${PREVIEW_TYPED_TEXT_LANDED_JS}(element, ${insertedJson});
          })()`,
          { returnByValue: true },
        );
        if (!landedInGuest) {
          return yield* new PreviewOperationError({
            operation: "automationType.textDidNotReachGuest",
            tabId,
            webContentsId: wc.id,
            cause: new Error(
              "Typed text was not found in the focused element after insertion; the guest never took keyboard focus, or the field rejected the text.",
            ),
          });
        }
      } else if (input.clear) {
        yield* expectAgentInput(tabId, clearSequence.signal);
        clearKeyDownAttempted = true;
        yield* send("Input.dispatchKeyEvent", clearSequence.keyDown);
      }
    }).pipe(Effect.ensuring(releaseInput));
  });

  const automationType = Effect.fn("PreviewManager.automationType")(function* (
    tabId: string,
    input: PreviewAutomationTypeInput,
  ) {
    yield* withAutomationInputTurn(
      "type",
      tabId,
      Effect.gen(function* () {
        const wc = yield* requireWebContents(tabId);
        yield* withControlSession(tabId, wc, "type", (send, sendCleanup) =>
          performAutomationType(tabId, wc, input, send, sendCleanup),
        );
      }),
    );
  });

  const performAutomationUpload = Effect.fn("PreviewManager.performAutomationUpload")(function* (
    tabId: string,
    input: PreviewAutomationUploadInput,
    send: SendCommand,
  ) {
    const files = yield* Effect.forEach(
      input.paths,
      (filePath) =>
        Effect.gen(function* () {
          if (!path.isAbsolute(filePath)) {
            return yield* new PreviewOperationError({
              operation: "automationUpload.validatePath",
              tabId,
              cause: new Error(`Upload path must be absolute: ${filePath}`),
            });
          }
          const stat = yield* fileSystem.stat(filePath).pipe(
            Effect.mapError(
              (cause) =>
                new PreviewOperationError({
                  operation: "automationUpload.statPath",
                  tabId,
                  cause,
                }),
            ),
          );
          if (stat.type !== "File") {
            return yield* new PreviewOperationError({
              operation: "automationUpload.validatePath",
              tabId,
              cause: new Error(`Upload path is not a regular file: ${filePath}`),
            });
          }
          return path.resolve(filePath);
        }),
      { concurrency: 4 },
    );

    const locator = automationLocator(input);
    const executionContextId = locator ? yield* ensurePlaywrightInjected(tabId, send) : undefined;
    const locatorJson = locator
      ? yield* encodeJson({ operation: "automationUpload.encodeLocator", tabId }, locator)
      : null;
    const elementExpression = locatorJson
      ? `(() => { const injected = globalThis.__t3PlaywrightInjected; return injected.querySelector(injected.parseSelector(${locatorJson}), document, true); })()`
      : `document.querySelector('input[type="file"]')`;
    const validation = yield* evaluateWithDebugger<
      | { ok: true }
      | { invalidSelector: true; message: string }
      | { notFileInput: true }
      | { notFound: true }
    >(
      tabId,
      send,
      `(() => {
          try {
            const element = ${elementExpression};
            if (!element) return { notFound: true };
            if (!(element instanceof HTMLInputElement) || element.type !== "file" || element.disabled) {
              return { notFileInput: true };
            }
            return { ok: true };
          } catch (error) {
            return { invalidSelector: true, message: String(error) };
          }
        })()`,
      { returnByValue: true, contextId: executionContextId },
    );
    if ("invalidSelector" in validation) {
      return yield* new PreviewAutomationInvalidSelectorError({
        operation: "upload",
        tabId,
        ...automationSelectorDiagnostics(input),
        reasonLength: validation.message.length,
        cause: validation,
      });
    }
    if ("notFound" in validation) {
      return yield* new PreviewAutomationTargetNotFoundError({
        operation: "upload",
        tabId,
        ...automationSelectorDiagnostics(input),
      });
    }
    if ("notFileInput" in validation) {
      return yield* new PreviewAutomationTargetNotEditableError({
        tabId,
        ...automationSelectorDiagnostics(input),
      });
    }

    const rawTarget = (yield* send("Runtime.evaluate", {
      expression: elementExpression,
      awaitPromise: true,
      returnByValue: false,
      userGesture: false,
      ...(executionContextId === undefined ? {} : { contextId: executionContextId }),
    })) as CdpEvaluationResult;
    if (rawTarget.exceptionDetails || typeof rawTarget.result?.objectId !== "string") {
      const detail = previewAutomationEvaluationDetail(rawTarget.exceptionDetails ?? rawTarget);
      return yield* new PreviewAutomationEvaluationError({
        tabId,
        detailKind: detail.detailKind,
        detailLength: detail.detail?.length ?? 0,
        cause: rawTarget.exceptionDetails ?? rawTarget,
      });
    }
    yield* send("DOM.setFileInputFiles", {
      files,
      objectId: rawTarget.result.objectId,
    });
    return {
      fileCount: files.length,
      fileNames: files.map((filePath) => path.basename(filePath)),
    } satisfies PreviewAutomationUploadResult;
  });

  const automationUpload = Effect.fn("PreviewManager.automationUpload")(function* (
    tabId: string,
    input: PreviewAutomationUploadInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    return yield* withControlSession(tabId, wc, "upload", (send) =>
      performAutomationUpload(tabId, input, send),
    );
  });

  const performAutomationSelectOption = Effect.fn("PreviewManager.performAutomationSelectOption")(
    function* (tabId: string, input: PreviewAutomationSelectOptionInput, send: SendCommand) {
      const locator = automationLocator(input);
      const executionContextId = locator ? yield* ensurePlaywrightInjected(tabId, send) : undefined;
      const locatorJson = locator
        ? yield* encodeJson({ operation: "automationSelectOption.encodeLocator", tabId }, locator)
        : null;
      const elementExpression = locatorJson
        ? `(() => { const injected = globalThis.__t3PlaywrightInjected; return injected.querySelector(injected.parseSelector(${locatorJson}), document, true); })()`
        : `document.querySelector("select")`;
      const choiceJson = yield* encodeJson(
        { operation: "automationSelectOption.encodeChoice", tabId },
        { value: input.value, label: input.label, index: input.index },
      );
      // Resolve, match and commit in one page turn. Splitting them would let the
      // option list change between deciding and choosing.
      const outcome = yield* evaluateWithDebugger<
        | { ok: true; value: string; label: string; index: number }
        | { invalidSelector: true; message: string }
        | { notSelect: true }
        | { notFound: true }
        | { noSuchOption: true; available: ReadonlyArray<string> }
      >(
        tabId,
        send,
        `(() => {
          try {
            const element = ${elementExpression};
            if (!element) return { notFound: true };
            if (!(element instanceof HTMLSelectElement) || element.disabled) return { notSelect: true };
            const choice = ${choiceJson};
            const options = Array.from(element.options);
            const labelOf = (option) => (option.label || option.text || "").trim();
            let index = -1;
            if (choice.index !== undefined && choice.index !== null) {
              index = choice.index < options.length ? choice.index : -1;
            } else if (choice.value !== undefined && choice.value !== null) {
              index = options.findIndex((option) => option.value === choice.value);
            } else {
              index = options.findIndex((option) => labelOf(option) === String(choice.label).trim());
            }
            const option = index >= 0 ? options[index] : undefined;
            if (!option || option.disabled) {
              return { noSuchOption: true, available: options.map(labelOf).slice(0, 50) };
            }
            if (element.selectedIndex !== index) {
              element.selectedIndex = index;
              // What a real choice fires. Frameworks listen for one or both,
              // so a bare value assignment leaves their state stale.
              element.dispatchEvent(new Event("input", { bubbles: true }));
              element.dispatchEvent(new Event("change", { bubbles: true }));
            }
            return { ok: true, value: option.value, label: labelOf(option), index };
          } catch (error) {
            return { invalidSelector: true, message: String(error) };
          }
        })()`,
        { returnByValue: true, contextId: executionContextId },
      );
      if ("invalidSelector" in outcome) {
        return yield* new PreviewAutomationInvalidSelectorError({
          operation: "selectOption",
          tabId,
          ...automationSelectorDiagnostics(input),
          reasonLength: outcome.message.length,
          cause: outcome,
        });
      }
      if ("notFound" in outcome) {
        return yield* new PreviewAutomationTargetNotFoundError({
          operation: "selectOption",
          tabId,
          ...automationSelectorDiagnostics(input),
        });
      }
      if ("notSelect" in outcome || "noSuchOption" in outcome) {
        return yield* new PreviewAutomationTargetNotEditableError({
          tabId,
          ...automationSelectorDiagnostics(input),
        });
      }
      return {
        value: outcome.value,
        label: outcome.label,
        index: outcome.index,
      } satisfies PreviewAutomationSelectOptionResult;
    },
  );

  const automationSelectOption = Effect.fn("PreviewManager.automationSelectOption")(function* (
    tabId: string,
    input: PreviewAutomationSelectOptionInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    return yield* withControlSession(tabId, wc, "selectOption", (send) =>
      performAutomationSelectOption(tabId, input, send),
    );
  });

  const performAutomationPress = Effect.fn("PreviewManager.performAutomationPress")(function* (
    tabId: string,
    wc: Electron.WebContents,
    input: PreviewAutomationPressInput,
    send: SendCommand,
    sendCleanup: SendCommand,
  ) {
    yield* prepareAutomationInput(send, false);
    const keySequence = makePreviewAutomationKeySequence(input, {
      isMac: hostPlatform === "darwin",
    });
    const previouslyFocused = yield* attempt(
      { operation: "automationPress.getFocusedWebContents", tabId, webContentsId: wc.id },
      () => webContents.getFocusedWebContents(),
    );
    let keyDownAttempted = false;
    const releaseInput = Effect.gen(function* () {
      if (keyDownAttempted) {
        yield* sendCleanup("Input.dispatchKeyEvent", keySequence.keyUp).pipe(Effect.ignore);
      }
      yield* sendCleanup("Emulation.setFocusEmulationEnabled", {
        enabled: automationForegroundActive,
      }).pipe(Effect.ignore);
      if (previouslyFocused && previouslyFocused.id !== wc.id && !previouslyFocused.isDestroyed()) {
        // Only hand focus back if the guest we borrowed still holds it. When the
        // user moves focus mid-dispatch — typically by clicking into the visible
        // preview — restoring would pull the caret out from under them, and the
        // next thing they type or paste lands in the composer instead of the
        // page they are looking at.
        const focusedNow = yield* attempt(
          {
            operation: "automationPress.getFocusedWebContentsAfterDispatch",
            tabId,
            webContentsId: wc.id,
          },
          () => webContents.getFocusedWebContents(),
        ).pipe(Effect.catch(() => Effect.succeed(null)));
        if (focusedNow === null || focusedNow.id === wc.id) {
          yield* attempt(
            {
              operation: "automationPress.restoreFocusedWebContents",
              tabId,
              webContentsId: previouslyFocused.id,
            },
            () => previouslyFocused.focus(),
          ).pipe(Effect.ignore);
        }
      }
    });

    // Focus the guest WebContents itself, not its containing BrowserWindow. This
    // activates native keyboard behavior for hidden/background previews without
    // changing which thread is mounted in the UI. Focus emulation alone does not
    // substitute for it: without this call `Input.insertText` lands nowhere.
    // Focus is handed back after the dispatch.
    yield* Effect.gen(function* () {
      yield* attempt(
        { operation: "automationPress.focusWebContents", tabId, webContentsId: wc.id },
        () => wc.focus(),
      );
      yield* send("Page.bringToFront");
      yield* send("Emulation.setFocusEmulationEnabled", { enabled: true });
      yield* expectAgentInput(tabId, keySequence.signal);
      keyDownAttempted = true;
      yield* send("Input.dispatchKeyEvent", keySequence.keyDown);
    }).pipe(Effect.ensuring(releaseInput));
  });

  const automationPress = Effect.fn("PreviewManager.automationPress")(function* (
    tabId: string,
    input: PreviewAutomationPressInput,
  ) {
    yield* withAutomationInputTurn(
      "press",
      tabId,
      Effect.gen(function* () {
        const wc = yield* requireWebContents(tabId);
        yield* withControlSession(tabId, wc, "press", (send, sendCleanup) =>
          performAutomationPress(tabId, wc, input, send, sendCleanup),
        );
      }),
    );
  });

  const performAutomationScroll = Effect.fn("PreviewManager.performAutomationScroll")(function* (
    tabId: string,
    input: PreviewAutomationScrollInput,
    send: SendCommand,
  ) {
    yield* send("Runtime.enable");
    const locator = automationLocator(input);
    const executionContextId = locator ? yield* ensurePlaywrightInjected(tabId, send) : undefined;
    const locatorJson = locator
      ? yield* encodeJson({ operation: "automationScroll.encodeLocator", tabId }, locator)
      : null;
    const result = yield* evaluateWithDebugger<
      { ok: true } | { invalidSelector: true; message: string } | { notFound: true }
    >(
      tabId,
      send,
      `(() => {
        try {
          const target = ${locatorJson ? `(() => { const injected = globalThis.__t3PlaywrightInjected; return injected.querySelector(injected.parseSelector(${locatorJson}), document, true); })()` : "window"};
          if (!target) return { notFound: true };
          target.scrollBy({ left: ${input.deltaX ?? 0}, top: ${input.deltaY ?? 0}, behavior: "instant" });
          return { ok: true };
        } catch (error) {
          return { invalidSelector: true, message: String(error) };
        }
      })()`,
      { returnByValue: true, contextId: executionContextId },
    );
    if ("invalidSelector" in result) {
      return yield* new PreviewAutomationInvalidSelectorError({
        operation: "scroll",
        tabId,
        ...automationSelectorDiagnostics(input),
        reasonLength: result.message.length,
        cause: result,
      });
    }
    if ("notFound" in result) {
      return yield* new PreviewAutomationTargetNotFoundError({
        operation: "scroll",
        tabId,
        ...automationSelectorDiagnostics(input),
      });
    }
  });

  const automationScroll = Effect.fn("PreviewManager.automationScroll")(function* (
    tabId: string,
    input: PreviewAutomationScrollInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* withControlSession(tabId, wc, "scroll", (send) =>
      performAutomationScroll(tabId, input, send),
    );
  });

  const performAutomationEvaluate = Effect.fn("PreviewManager.performAutomationEvaluate")(
    function* (tabId: string, input: PreviewAutomationEvaluateInput, send: SendCommand) {
      yield* send("Runtime.enable");
      const value = yield* evaluateWithDebugger(tabId, send, input.expression, {
        returnByValue: input.returnByValue ?? true,
        awaitPromise: input.awaitPromise ?? true,
      });
      const serialized = yield* encodeJson(
        { operation: "automationEvaluate.encodeResult", tabId },
        value,
      );
      const actualBytes = Buffer.byteLength(serialized, "utf8");
      if (actualBytes > MAX_EVALUATION_BYTES) {
        return yield* new PreviewAutomationResultTooLargeError({
          tabId,
          actualBytes,
          maximumBytes: MAX_EVALUATION_BYTES,
        });
      }
      return value;
    },
  );

  const automationEvaluate = Effect.fn("PreviewManager.automationEvaluate")(function* (
    tabId: string,
    input: PreviewAutomationEvaluateInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    return yield* withControlSession(tabId, wc, "evaluate", (send) =>
      performAutomationEvaluate(tabId, input, send),
    );
  });

  const performAutomationWaitFor = Effect.fn("PreviewManager.performAutomationWaitFor")(function* (
    tabId: string,
    input: PreviewAutomationWaitForInput,
    send: SendCommand,
  ) {
    const timeoutMs = input.timeoutMs ?? 15_000;
    yield* send("Runtime.enable");
    const locator = automationLocator(input);
    const [locatorJson, textJson, urlIncludesJson] = yield* Effect.all([
      locator
        ? encodeJson({ operation: "automationWaitFor.encodeLocator", tabId }, locator)
        : Effect.succeed(null),
      input.text
        ? encodeJson({ operation: "automationWaitFor.encodeText", tabId }, input.text)
        : Effect.succeed(null),
      input.urlIncludes
        ? encodeJson({ operation: "automationWaitFor.encodeUrl", tabId }, input.urlIncludes)
        : Effect.succeed(null),
    ]);
    const deadline = (yield* currentMillis) + timeoutMs;
    while ((yield* currentMillis) <= deadline) {
      const executionContextId = locator ? yield* ensurePlaywrightInjected(tabId, send) : undefined;
      const result = yield* evaluateWithDebugger<
        { matched: boolean } | { invalidSelector: true; message: string }
      >(
        tabId,
        send,
        `(() => {
              try {
                const selectorMatched = ${locatorJson ? `(() => { const injected = globalThis.__t3PlaywrightInjected; return injected.querySelector(injected.parseSelector(${locatorJson}), document, false) !== null; })()` : "true"};
                const textMatched = ${
                  textJson ? `(document.body?.innerText || "").includes(${textJson})` : "true"
                };
                const urlMatched = ${
                  urlIncludesJson ? `location.href.includes(${urlIncludesJson})` : "true"
                };
                return { matched: selectorMatched && textMatched && urlMatched };
              } catch (error) {
                return { invalidSelector: true, message: String(error) };
              }
            })()`,
        { returnByValue: true, contextId: executionContextId },
      );
      if ("invalidSelector" in result) {
        return yield* new PreviewAutomationInvalidSelectorError({
          operation: "waitFor",
          tabId,
          ...automationSelectorDiagnostics(input),
          reasonLength: result.message.length,
          cause: result,
        });
      }
      if (result.matched) return;
      yield* Effect.sleep(100);
    }
    return yield* new PreviewAutomationTimeoutError({
      tabId,
      timeoutMs,
    });
  });

  const automationWaitFor = Effect.fn("PreviewManager.automationWaitFor")(function* (
    tabId: string,
    input: PreviewAutomationWaitForInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* withControlSession(tabId, wc, "waitFor", (send) =>
      performAutomationWaitFor(tabId, input, send),
    );
  });

  /**
   * Waits for a download this tab started to finish, including the time a
   * held one spends waiting for the user to allow it.
   *
   * Without this an agent has to poll snapshots, and a hold looks the same as
   * a slow server on every poll. Waiting on a person is why the bound is
   * minutes rather than the seconds the page-condition waits use.
   */
  const automationWaitForDownload = Effect.fn("PreviewManager.automationWaitForDownload")(
    function* (tabId: string, input: { readonly timeoutMs?: number | undefined }) {
      const deadlineMs = Math.min(Math.max(input.timeoutMs ?? 120_000, 1), 600_000);
      const readTab = Effect.map(SynchronizedRef.get(tabsRef), (tabs) => tabs.get(tabId));
      const initial = yield* readTab;
      if (!initial) return yield* new PreviewTabNotFoundError({ tabId });
      const known = new Set(initial.downloads.map((download) => download.path));
      const startedAtMs = yield* Clock.currentTimeMillis;
      // Empty pending at t=0 is the gap between click and the hold appearing,
      // not a denial. Wait until a hold shows, a file lands, or the bound runs
      // out — otherwise click-then-wait looks like "settled, nothing happened"
      // and the agent fetches again.
      let seenHold = initial.pendingDownloadApprovals.length > 0;

      while (true) {
        const tab = yield* readTab;
        if (!tab) return yield* new PreviewTabNotFoundError({ tabId });
        if (tab.pendingDownloadApprovals.length > 0) seenHold = true;
        const arrived = tab.downloads.filter((download) => !known.has(download.path));
        if (arrived.length > 0) {
          return {
            tabId,
            settled: true,
            outcome: "downloaded" as const,
            downloads: arrived,
            pendingDownloadApprovals: [...tab.pendingDownloadApprovals],
          };
        }
        if (seenHold && tab.pendingDownloadApprovals.length === 0) {
          return {
            tabId,
            settled: true,
            outcome: "denied" as const,
            downloads: [],
            pendingDownloadApprovals: [],
          };
        }
        if ((yield* Clock.currentTimeMillis) - startedAtMs >= deadlineMs) {
          const waiting = tab.pendingDownloadApprovals.length > 0 || seenHold;
          return {
            tabId,
            settled: false,
            outcome: waiting ? ("waiting" as const) : ("none" as const),
            ...(waiting
              ? {
                  message:
                    "The user still has to Allow or Deny this download. Do not retry the fetch. End the turn now; in Agent mode emit AGENT_STOP.",
                }
              : {}),
            downloads: [],
            pendingDownloadApprovals: [...tab.pendingDownloadApprovals],
          };
        }
        yield* Effect.sleep(WAIT_FOR_DOWNLOAD_POLL_MS);
      }
    },
  );

  const revealArtifact = Effect.fn("PreviewManager.revealArtifact")(function* (
    artifactPath: string,
  ) {
    const resolvedPath = yield* resolveArtifactPath(artifactPath);
    yield* attempt({ operation: "revealArtifact", artifactPath: resolvedPath }, () =>
      shell.showItemInFolder(resolvedPath),
    );
  });

  /**
   * Reveals a finished download in the OS file manager.
   *
   * Separate from `revealArtifact`, which sandboxes to the artifacts folder:
   * downloads now land in the thread's own workspace, so that check would
   * refuse them. Rather than widen it to a directory prefix, only paths this
   * manager actually recorded as completed downloads are accepted — an
   * allow-list of known files rather than a writable region.
   */
  const revealDownload = Effect.fn("PreviewManager.revealDownload")(function* (
    downloadPath: string,
  ) {
    const known = browserSession.recentDownloads().some((entry) => entry.path === downloadPath);
    if (!known) {
      return yield* new PreviewOperationError({
        operation: "revealDownload.unknownPath",
        cause: downloadPath,
      });
    }
    yield* attempt({ operation: "revealDownload", artifactPath: downloadPath }, () =>
      shell.showItemInFolder(downloadPath),
    );
  });

  /**
   * Answers a download held for the user's approval.
   *
   * The tab card is cleared by the session's settled event rather than here,
   * so an answer arriving from anywhere — a second window, a reload — clears
   * every copy of the card rather than only the one that was clicked.
   */
  const answerDownloadApproval = Effect.fn("PreviewManager.answerDownloadApproval")(function* (
    id: string,
    decision: "allow-domain" | "allow-once" | "deny",
  ) {
    yield* Effect.sync(() => browserSession.answerDownloadApproval(id, decision));
  });

  const copyArtifactToClipboard = Effect.fn("PreviewManager.copyArtifactToClipboard")(function* (
    artifactPath: string,
  ) {
    const resolvedPath = yield* resolveArtifactPath(artifactPath);
    const image = yield* attempt(
      { operation: "copyArtifactToClipboard.load", artifactPath: resolvedPath },
      () => nativeImage.createFromPath(resolvedPath),
    );
    if (image.isEmpty()) {
      return yield* new PreviewArtifactImageLoadError({ artifactPath: resolvedPath });
    }
    yield* attempt({ operation: "copyArtifactToClipboard.write", artifactPath: resolvedPath }, () =>
      clipboard.writeImage(image),
    );
  });

  const subscribe = <A>(
    ref: Ref.Ref<ReadonlySet<A>>,
    listener: A,
  ): Effect.Effect<void, never, Scope.Scope> =>
    Effect.acquireRelease(
      Ref.update(ref, (listeners) => new Set([...listeners, listener])),
      () =>
        Ref.update(ref, (listeners) => {
          const next = new Set(listeners);
          next.delete(listener);
          return next;
        }),
    ).pipe(Effect.asVoid);

  const destroy = Effect.fn("PreviewManager.destroy")(function* () {
    const foregroundExpiry = automationForegroundExpiryFiber;
    automationForegroundExpiryFiber = undefined;
    automationForegroundActive = false;
    if (foregroundExpiry) yield* Fiber.interrupt(foregroundExpiry);
    const tabs = yield* SynchronizedRef.get(tabsRef);
    yield* Effect.forEach(tabs.keys(), closeTab, { discard: true });
    yield* Effect.all(
      [
        Ref.set(listenersRef, new Set()),
        Ref.set(expectedAgentInputsRef, new Map()),
        Ref.set(pointerEventListenersRef, new Set()),
        Ref.set(newTabRequestListenersRef, new Set()),
        Ref.set(recordingFrameListenersRef, new Set()),
      ],
      { discard: true },
    );
  });

  yield* Effect.addFinalizer(() => destroy().pipe(Effect.ignore));

  return {
    automationClick,
    automationEvaluate,
    automationPress,
    automationScroll,
    automationDevTools,
    automationFrame,
    automationSnapshot,
    automationStatus,
    automationType,
    automationUpload,
    automationSelectOption,
    automationWaitFor,
    automationWaitForDownload,
    cancelPickElement,
    captureScreenshot,
    closeTab,
    copyArtifactToClipboard,
    createTab,
    goBack,
    goForward,
    hardReload,
    navigate,
    openPictureInPicture,
    openDevTools,
    pickElement,
    refresh,
    registerWebview,
    renewAutomationForeground,
    setUiActivity,
    resetZoom: (tabId: string) => applyZoom(tabId, () => DEFAULT_ZOOM_FACTOR),
    revealArtifact,
    revealDownload,
    answerDownloadApproval,
    saveRecording,
    setAnnotationTheme,
    setColorScheme,
    setMainWindow,
    startRecording,
    closePictureInPicture,
    stopRecording,
    subscribePointerEvents: (listener: PointerEventListener) =>
      subscribe(pointerEventListenersRef, listener),
    subscribeNewTabRequests: (listener: NewTabRequestListener) =>
      subscribe(newTabRequestListenersRef, listener),
    subscribeRecordingFrames: (listener: RecordingFrameListener) =>
      subscribe(recordingFrameListenersRef, listener),
    subscribeStateChanges: (listener: Listener) => subscribe(listenersRef, listener),
    zoomIn: (tabId: string) => applyZoom(tabId, (current) => nextZoomLevel(current, "in")),
    zoomOut: (tabId: string) => applyZoom(tabId, (current) => nextZoomLevel(current, "out")),
  };
});

export class PreviewTabNotFoundError extends Schema.TaggedErrorClass<PreviewTabNotFoundError>()(
  "PreviewTabNotFoundError",
  { tabId: Schema.String },
) {
  override get message(): string {
    return `Preview tab not found: ${this.tabId}`;
  }
}

export class PreviewWebContentsNotFoundError extends Schema.TaggedErrorClass<PreviewWebContentsNotFoundError>()(
  "PreviewWebContentsNotFoundError",
  { tabId: Schema.String, webContentsId: Schema.Number },
) {
  override get message(): string {
    return `WebContents ${this.webContentsId} not found for preview tab ${this.tabId}`;
  }
}

export class PreviewWebviewNotInitializedError extends Schema.TaggedErrorClass<PreviewWebviewNotInitializedError>()(
  "PreviewWebviewNotInitializedError",
  { tabId: Schema.String },
) {
  override get message(): string {
    return `Preview tab "${this.tabId}" has no webview registered`;
  }
}

export class PreviewOperationError extends Schema.TaggedErrorClass<PreviewOperationError>()(
  "PreviewOperationError",
  {
    operation: Schema.String,
    tabId: Schema.optional(Schema.String),
    webContentsId: Schema.optional(Schema.Number),
    artifactPath: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  static toTimelineMessage(error: PreviewOperationError): string {
    return error.cause instanceof Error ? error.cause.message : String(error.cause);
  }

  override get message(): string {
    const context = [
      this.tabId === undefined ? undefined : `tab ${this.tabId}`,
      this.webContentsId === undefined ? undefined : `WebContents ${this.webContentsId}`,
      this.artifactPath === undefined ? undefined : `artifact ${this.artifactPath}`,
    ].filter((value): value is string => value !== undefined);
    return `Desktop preview operation failed: ${this.operation}${context.length === 0 ? "" : ` (${context.join(", ")})`}`;
  }
}

export const isPreviewOperationError = Schema.is(PreviewOperationError);

export class PreviewArtifactPathOutsideDirectoryError extends Schema.TaggedErrorClass<PreviewArtifactPathOutsideDirectoryError>()(
  "PreviewArtifactPathOutsideDirectoryError",
  {
    artifactPath: Schema.String,
    artifactDirectory: Schema.String,
  },
) {
  override get message(): string {
    return `Preview artifact path ${this.artifactPath} is outside ${this.artifactDirectory}`;
  }
}

export class PreviewArtifactImageLoadError extends Schema.TaggedErrorClass<PreviewArtifactImageLoadError>()(
  "PreviewArtifactImageLoadError",
  { artifactPath: Schema.String },
) {
  override get message(): string {
    return `Preview artifact could not be loaded as an image: ${this.artifactPath}`;
  }
}

export class PreviewAutomationDevToolsOpenError extends Schema.TaggedErrorClass<PreviewAutomationDevToolsOpenError>()(
  "PreviewAutomationDevToolsOpenError",
  { webContentsId: Schema.Number },
) {
  override get message(): string {
    return `Close preview DevTools before using agent browser control for WebContents ${this.webContentsId}`;
  }
}

export class PreviewAutomationDebuggerAttachedError extends Schema.TaggedErrorClass<PreviewAutomationDebuggerAttachedError>()(
  "PreviewAutomationDebuggerAttachedError",
  { webContentsId: Schema.Number },
) {
  override get message(): string {
    return `Preview control cannot attach to WebContents ${this.webContentsId} because another debugger owns it`;
  }
}

export class PreviewAutomationEvaluationError extends Schema.TaggedErrorClass<PreviewAutomationEvaluationError>()(
  "PreviewAutomationEvaluationError",
  {
    tabId: Schema.String,
    detailKind: PreviewAutomationEvaluationDetailKind,
    detailLength: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  static toTimelineMessage(error: PreviewAutomationEvaluationError): string {
    return previewAutomationEvaluationDetail(error.cause).detail ?? error.message;
  }

  override get message(): string {
    return `Preview JavaScript evaluation failed in tab ${this.tabId}`;
  }
}

export class PreviewAutomationTargetNotFoundError extends Schema.TaggedErrorClass<PreviewAutomationTargetNotFoundError>()(
  "PreviewAutomationTargetNotFoundError",
  {
    operation: Schema.String,
    tabId: Schema.String,
    selectorKind: PreviewAutomationSelectorKind,
    selectorLength: Schema.optionalKey(Schema.Number),
  },
) {
  override get message(): string {
    const target = previewAutomationTargetLabel(this.selectorKind, this.selectorLength);
    return `Preview automation ${this.operation} could not find ${target} in tab ${this.tabId}`;
  }
}

export class PreviewAutomationTargetNotEditableError extends Schema.TaggedErrorClass<PreviewAutomationTargetNotEditableError>()(
  "PreviewAutomationTargetNotEditableError",
  {
    tabId: Schema.String,
    selectorKind: PreviewAutomationSelectorKind,
    selectorLength: Schema.optionalKey(Schema.Number),
    /** The target opens a menu Chromium draws outside the page. */
    nativeMenu: Schema.optionalKey(Schema.Boolean),
  },
) {
  override get message(): string {
    const target = previewAutomationTargetLabel(this.selectorKind, this.selectorLength);
    if (this.nativeMenu === true) {
      return `Preview automation found ${target} in tab ${this.tabId}, but it is a <select> whose menu the browser draws outside the page. Use selectOption instead.`;
    }
    return `Preview automation type found ${target}, but it is not editable in tab ${this.tabId}`;
  }
}

export class PreviewAutomationCoordinatesOutsideViewportError extends Schema.TaggedErrorClass<PreviewAutomationCoordinatesOutsideViewportError>()(
  "PreviewAutomationCoordinatesOutsideViewportError",
  {
    tabId: Schema.String,
    x: Schema.Number,
    y: Schema.Number,
    viewportWidth: Schema.Number,
    viewportHeight: Schema.Number,
  },
) {
  override get message(): string {
    return `Click coordinates (${this.x}, ${this.y}) are outside the ${this.viewportWidth}x${this.viewportHeight} preview viewport for tab ${this.tabId}`;
  }
}

export class PreviewAutomationInvalidSelectorError extends Schema.TaggedErrorClass<PreviewAutomationInvalidSelectorError>()(
  "PreviewAutomationInvalidSelectorError",
  {
    operation: Schema.String,
    tabId: Schema.String,
    selectorKind: PreviewAutomationSelectorKind,
    selectorLength: Schema.optionalKey(Schema.Number),
    reasonLength: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  static toTimelineMessage(error: PreviewAutomationInvalidSelectorError): string {
    if (typeof error.cause !== "object" || error.cause === null) return error.message;
    const reason = (error.cause as Record<string, unknown>)["message"];
    return typeof reason === "string" && reason.length > 0 ? reason : error.message;
  }

  get detail(): {
    readonly selectorKind: PreviewAutomationSelectorKind;
    readonly selectorLength?: number;
  } {
    return {
      selectorKind: this.selectorKind,
      ...(this.selectorLength === undefined ? {} : { selectorLength: this.selectorLength }),
    };
  }

  override get message(): string {
    const target = previewAutomationTargetLabel(this.selectorKind, this.selectorLength);
    return `Preview automation ${this.operation} rejected ${target} in tab ${this.tabId}`;
  }
}

export class PreviewAutomationResultTooLargeError extends Schema.TaggedErrorClass<PreviewAutomationResultTooLargeError>()(
  "PreviewAutomationResultTooLargeError",
  {
    tabId: Schema.String,
    actualBytes: Schema.Number,
    maximumBytes: Schema.Number,
  },
) {
  get detail(): { readonly maximumBytes: number } {
    return { maximumBytes: this.maximumBytes };
  }

  override get message(): string {
    return `Preview evaluation result in tab ${this.tabId} was ${this.actualBytes} bytes; maximum is ${this.maximumBytes} bytes`;
  }
}

export class PreviewAutomationTimeoutError extends Schema.TaggedErrorClass<PreviewAutomationTimeoutError>()(
  "PreviewAutomationTimeoutError",
  {
    tabId: Schema.String,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Preview condition did not match within ${this.timeoutMs}ms in tab ${this.tabId}`;
  }
}

export class PreviewAutomationControlInterruptedError extends Schema.TaggedErrorClass<PreviewAutomationControlInterruptedError>()(
  "PreviewAutomationControlInterruptedError",
  {
    operation: Schema.String,
    tabId: Schema.String,
    webContentsId: Schema.Number,
  },
) {
  override get message(): string {
    return `Preview automation ${this.operation} was interrupted by human input in tab ${this.tabId}`;
  }
}

export const PreviewManagerError = Schema.Union([
  PreviewTabNotFoundError,
  PreviewWebContentsNotFoundError,
  PreviewWebviewNotInitializedError,
  PreviewOperationError,
  PreviewArtifactPathOutsideDirectoryError,
  PreviewArtifactImageLoadError,
  PreviewAutomationDevToolsOpenError,
  PreviewAutomationDebuggerAttachedError,
  PreviewAutomationEvaluationError,
  PreviewAutomationTargetNotFoundError,
  PreviewAutomationTargetNotEditableError,
  PreviewAutomationCoordinatesOutsideViewportError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationTimeoutError,
  PreviewAutomationControlInterruptedError,
]);
export type PreviewManagerError = typeof PreviewManagerError.Type;

export const isPreviewManagerError = Schema.is(PreviewManagerError);
export const isPreviewAutomationControlInterruptedError = Schema.is(
  PreviewAutomationControlInterruptedError,
);
export const isPreviewAutomationEvaluationError = Schema.is(PreviewAutomationEvaluationError);
export const isPreviewAutomationInvalidSelectorError = Schema.is(
  PreviewAutomationInvalidSelectorError,
);

export class PreviewManager extends Context.Service<
  PreviewManager,
  {
    readonly setMainWindow: (window: BrowserWindow) => Effect.Effect<void, PreviewManagerError>;
    readonly getBrowserSession: (scope: string) => Effect.Effect<Session, PreviewManagerError>;
    readonly isBrowserPartition: (partition: string) => boolean;
    readonly createTab: (tabId: string) => Effect.Effect<PreviewTabState, PreviewManagerError>;
    readonly closeTab: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly registerWebview: (
      tabId: string,
      webContentsId: number,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly renewAutomationForeground: () => Effect.Effect<void, PreviewManagerError>;
    readonly setUiActivity: (
      tabId: string,
      leaseId: string,
      active: boolean,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly navigate: (tabId: string, url: string) => Effect.Effect<void, PreviewManagerError>;
    readonly goBack: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly goForward: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly refresh: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly zoomIn: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly zoomOut: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly resetZoom: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly hardReload: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly setColorScheme: (
      tabId: string,
      colorScheme: DesktopPreviewColorScheme,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly openDevTools: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly clearCookies: () => Effect.Effect<void, PreviewManagerError>;
    readonly clearCache: () => Effect.Effect<void, PreviewManagerError>;
    readonly getBrowserPartition: (scope: string) => Effect.Effect<string, PreviewManagerError>;
    readonly adoptLegacyBrowserProfile: (scope: string) => Effect.Effect<void, PreviewManagerError>;
    readonly setDownloadDirectory: (
      scope: string,
      directory: string,
    ) => Effect.Effect<void, PreviewOperationError>;
    readonly revealDownload: (downloadPath: string) => Effect.Effect<void, PreviewManagerError>;
    readonly answerDownloadApproval: (
      id: string,
      decision: "allow-domain" | "allow-once" | "deny",
    ) => Effect.Effect<void>;
    readonly setAnnotationTheme: (
      theme: DesktopPreviewAnnotationTheme,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly pickElement: (
      tabId: string,
    ) => Effect.Effect<PreviewAnnotationPayload | null, PreviewManagerError>;
    readonly cancelPickElement: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly captureScreenshot: (
      tabId: string,
    ) => Effect.Effect<DesktopPreviewScreenshotArtifact, PreviewManagerError>;
    readonly revealArtifact: (path: string) => Effect.Effect<void, PreviewManagerError>;
    readonly copyArtifactToClipboard: (path: string) => Effect.Effect<void, PreviewManagerError>;
    readonly openPictureInPicture: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly closePictureInPicture: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly startRecording: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly stopRecording: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly saveRecording: (
      tabId: string,
      mimeType: string,
      data: Uint8Array,
    ) => Effect.Effect<DesktopPreviewRecordingArtifact, PreviewManagerError>;
    readonly automationStatus: (
      tabId: string,
    ) => Effect.Effect<DesktopPreviewAutomationStatus, PreviewManagerError>;
    readonly automationSnapshot: (
      tabId: string,
    ) => Effect.Effect<PreviewAutomationSnapshot, PreviewManagerError>;
    readonly automationFrame: (
      tabId: string,
    ) => Effect.Effect<PreviewAutomationFrame, PreviewManagerError>;
    readonly automationDevTools: (
      tabId: string,
    ) => Effect.Effect<PreviewAutomationDevTools, PreviewManagerError>;
    readonly automationClick: (
      tabId: string,
      input: PreviewAutomationClickInput,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly automationType: (
      tabId: string,
      input: PreviewAutomationTypeInput,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly automationUpload: (
      tabId: string,
      input: PreviewAutomationUploadInput,
    ) => Effect.Effect<PreviewAutomationUploadResult, PreviewManagerError>;
    readonly automationSelectOption: (
      tabId: string,
      input: PreviewAutomationSelectOptionInput,
    ) => Effect.Effect<PreviewAutomationSelectOptionResult, PreviewManagerError>;
    readonly automationPress: (
      tabId: string,
      input: PreviewAutomationPressInput,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly automationScroll: (
      tabId: string,
      input: PreviewAutomationScrollInput,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly automationEvaluate: (
      tabId: string,
      input: PreviewAutomationEvaluateInput,
    ) => Effect.Effect<unknown, PreviewManagerError>;
    readonly automationWaitFor: (
      tabId: string,
      input: PreviewAutomationWaitForInput,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly automationWaitForDownload: (
      tabId: string,
      input: { readonly timeoutMs?: number | undefined },
    ) => Effect.Effect<PreviewAutomationWaitForDownloadResult, PreviewManagerError>;
    readonly subscribeStateChanges: (listener: Listener) => Effect.Effect<void, never, Scope.Scope>;
    readonly subscribePointerEvents: (
      listener: PointerEventListener,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly subscribeNewTabRequests: (
      listener: NewTabRequestListener,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly subscribeRecordingFrames: (
      listener: RecordingFrameListener,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/preview/Manager/PreviewManager") {}

export const make = Effect.gen(function* PreviewManagerMake() {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const browserSession = yield* BrowserSession.BrowserSession;
  const operations = yield* makeNativeOperations(
    environment.browserArtifactsDir,
    environment.path.join(environment.dirname, "preview-pip-preload.cjs"),
  );

  return PreviewManager.of({
    setMainWindow: operations.setMainWindow,
    getBrowserSession: Effect.fn("PreviewManager.getBrowserSession")(function* (scope) {
      return yield* browserSession
        .getSession(scope)
        .pipe(
          Effect.mapError(
            (cause) => new PreviewOperationError({ operation: "getBrowserSession", cause }),
          ),
        );
    }),
    isBrowserPartition: browserSession.isPartition,
    setDownloadDirectory: Effect.fn("PreviewManager.setDownloadDirectory")(
      function* (scope, directory) {
        yield* browserSession
          .setDownloadDirectory(scope, directory)
          .pipe(
            Effect.mapError(
              (cause) => new PreviewOperationError({ operation: "setDownloadDirectory", cause }),
            ),
          );
      },
    ),
    createTab: operations.createTab,
    closeTab: operations.closeTab,
    registerWebview: operations.registerWebview,
    renewAutomationForeground: operations.renewAutomationForeground,
    setUiActivity: operations.setUiActivity,
    navigate: operations.navigate,
    goBack: operations.goBack,
    goForward: operations.goForward,
    refresh: operations.refresh,
    zoomIn: operations.zoomIn,
    zoomOut: operations.zoomOut,
    resetZoom: operations.resetZoom,
    hardReload: operations.hardReload,
    setColorScheme: operations.setColorScheme,
    openDevTools: operations.openDevTools,
    clearCookies: Effect.fn("PreviewManager.clearCookies")(function* () {
      yield* browserSession
        .clearCookies()
        .pipe(
          Effect.mapError(
            (cause) => new PreviewOperationError({ operation: "clearCookies", cause }),
          ),
        );
    }),
    clearCache: Effect.fn("PreviewManager.clearCache")(function* () {
      yield* browserSession
        .clearCache()
        .pipe(
          Effect.mapError((cause) => new PreviewOperationError({ operation: "clearCache", cause })),
        );
    }),
    adoptLegacyBrowserProfile: Effect.fn("PreviewManager.adoptLegacyBrowserProfile")(
      function* (scope) {
        yield* browserSession
          .adoptLegacyProfile(scope)
          .pipe(
            Effect.mapError(
              (cause) =>
                new PreviewOperationError({ operation: "adoptLegacyBrowserProfile", cause }),
            ),
          );
      },
    ),
    getBrowserPartition: Effect.fn("PreviewManager.getBrowserPartition")(function* (scope) {
      return yield* browserSession
        .getPartition(scope)
        .pipe(
          Effect.mapError(
            (cause) => new PreviewOperationError({ operation: "getBrowserPartition", cause }),
          ),
        );
    }),
    setAnnotationTheme: operations.setAnnotationTheme,
    pickElement: operations.pickElement,
    cancelPickElement: operations.cancelPickElement,
    captureScreenshot: operations.captureScreenshot,
    revealArtifact: operations.revealArtifact,
    revealDownload: operations.revealDownload,
    answerDownloadApproval: operations.answerDownloadApproval,
    copyArtifactToClipboard: operations.copyArtifactToClipboard,
    openPictureInPicture: operations.openPictureInPicture,
    closePictureInPicture: operations.closePictureInPicture,
    startRecording: operations.startRecording,
    stopRecording: operations.stopRecording,
    saveRecording: operations.saveRecording,
    automationStatus: operations.automationStatus,
    automationDevTools: operations.automationDevTools,
    automationFrame: operations.automationFrame,
    automationSnapshot: operations.automationSnapshot,
    automationClick: operations.automationClick,
    automationType: operations.automationType,
    automationUpload: operations.automationUpload,
    automationSelectOption: operations.automationSelectOption,
    automationPress: operations.automationPress,
    automationScroll: operations.automationScroll,
    automationEvaluate: operations.automationEvaluate,
    automationWaitFor: operations.automationWaitFor,
    automationWaitForDownload: operations.automationWaitForDownload,
    subscribeStateChanges: operations.subscribeStateChanges,
    subscribePointerEvents: operations.subscribePointerEvents,
    subscribeNewTabRequests: operations.subscribeNewTabRequests,
    subscribeRecordingFrames: operations.subscribeRecordingFrames,
  });
}).pipe(Effect.withSpan("PreviewManager.make"));

export const layer = Layer.effect(PreviewManager, make);
