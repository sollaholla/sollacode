/**
 * Preview - Schemas for the in-app browser preview surface.
 *
 * Desktop owns the interactive Chromium <webview>, while web and mobile clients
 * can list and control its tabs and request bounded rendered frames through the
 * connected server. Per-thread tab metadata survives reconnects and multi-window;
 * the desktop renderer reports navigation and the server fans events to clients.
 *
 * @module Preview
 */
import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const Url = TrimmedNonEmptyString.check(Schema.isMaxLength(2048));
const Title = Schema.String.check(Schema.isMaxLength(512));

export const PreviewTabId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type PreviewTabId = typeof PreviewTabId.Type;

export const PREVIEW_VIEWPORT_MIN_DIMENSION = 240;
export const PREVIEW_VIEWPORT_MAX_DIMENSION = 3840;
export const PREVIEW_VIEWPORT_MAX_AREA = 3840 * 2160;

const PreviewViewportDimension = Schema.Int.check(
  Schema.isBetween({
    minimum: PREVIEW_VIEWPORT_MIN_DIMENSION,
    maximum: PREVIEW_VIEWPORT_MAX_DIMENSION,
  }),
);

const viewportAreaFilter = Schema.makeFilter(
  ({ width, height }: { readonly width: number; readonly height: number }) =>
    width * height <= PREVIEW_VIEWPORT_MAX_AREA ||
    `Viewport area must not exceed ${PREVIEW_VIEWPORT_MAX_AREA} pixels.`,
);

export const PreviewViewportSize = Schema.Struct({
  width: PreviewViewportDimension,
  height: PreviewViewportDimension,
}).check(viewportAreaFilter);
export type PreviewViewportSize = typeof PreviewViewportSize.Type;

/**
 * The page's measured viewport can be smaller than the minimum selectable
 * fixed size while fill mode follows a narrow panel. Keep measurement
 * validation separate from the stricter user-selectable size constraints.
 */
export const PreviewRenderedViewportSize = Schema.Struct({
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type PreviewRenderedViewportSize = typeof PreviewRenderedViewportSize.Type;

export const PREVIEW_VIEWPORT_PRESET_IDS = [
  "iphone-se",
  "iphone-xr",
  "iphone-12-pro",
  "iphone-14-pro-max",
  "pixel-7",
  "samsung-galaxy-s8-plus",
  "samsung-galaxy-s20-ultra",
  "ipad-mini",
  "ipad-air",
  "ipad-pro",
  "surface-pro-7",
  "surface-duo",
  "galaxy-z-fold-5",
  "asus-zenbook-fold",
  "samsung-galaxy-a51-71",
  "nest-hub",
  "nest-hub-max",
] as const;

export const PreviewViewportPresetId = Schema.Literals(PREVIEW_VIEWPORT_PRESET_IDS);
export type PreviewViewportPresetId = typeof PreviewViewportPresetId.Type;

/**
 * Preset IDs shipped before the Chrome-compatible catalog. Existing sessions
 * can still reconnect with these values, but new resize requests only expose
 * PREVIEW_VIEWPORT_PRESET_IDS.
 */
const LEGACY_PREVIEW_VIEWPORT_PRESET_IDS = [
  "desktop-1920x1080",
  "desktop-1440x900",
  "laptop-1366x768",
  "laptop-1280x800",
  "ipad-pro-11",
  "iphone-15-pro",
  "pixel-8",
  "galaxy-s24",
] as const;

const StoredPreviewViewportPresetId = Schema.Literals([
  ...PREVIEW_VIEWPORT_PRESET_IDS,
  ...LEGACY_PREVIEW_VIEWPORT_PRESET_IDS,
]);

export const PreviewViewportSetting = Schema.Union([
  Schema.TaggedStruct("fill", {}),
  Schema.TaggedStruct("freeform", {
    ...PreviewViewportSize.fields,
  }).check(viewportAreaFilter),
  Schema.TaggedStruct("preset", {
    ...PreviewViewportSize.fields,
    presetId: StoredPreviewViewportPresetId,
  }).check(viewportAreaFilter),
]);
export type PreviewViewportSetting = typeof PreviewViewportSetting.Type;

export const FILL_PREVIEW_VIEWPORT = {
  _tag: "fill",
} as const satisfies PreviewViewportSetting;

export const PreviewNavStatus = Schema.Union([
  Schema.TaggedStruct("Idle", {}),
  Schema.TaggedStruct("Loading", {
    url: Url,
    title: Title,
  }),
  Schema.TaggedStruct("Success", {
    url: Url,
    title: Title,
  }),
  Schema.TaggedStruct("LoadFailed", {
    url: Url,
    title: Title,
    code: Schema.Int,
    description: Schema.String,
  }),
]);
export type PreviewNavStatus = typeof PreviewNavStatus.Type;

export const PreviewSessionSnapshot = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  tabId: PreviewTabId,
  navStatus: PreviewNavStatus,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  /** Missing snapshots from older servers are treated as fill-panel mode. */
  viewport: Schema.optional(PreviewViewportSetting),
  updatedAt: Schema.String,
});
export type PreviewSessionSnapshot = typeof PreviewSessionSnapshot.Type;

export const PreviewOpenInput = Schema.Struct({
  threadId: ThreadId,
  /** Omit to create an empty (Idle) tab the user can type into. */
  url: Schema.optional(Url),
});
export type PreviewOpenInput = typeof PreviewOpenInput.Type;

export const PreviewNavigateInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  url: Url,
  resolvedTitle: Schema.optional(Title),
});
export type PreviewNavigateInput = typeof PreviewNavigateInput.Type;

export const PreviewReportStatusInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  navStatus: PreviewNavStatus,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
});
export type PreviewReportStatusInput = typeof PreviewReportStatusInput.Type;

export const PreviewRefreshInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
});
export type PreviewRefreshInput = typeof PreviewRefreshInput.Type;

export const PreviewResizeInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  viewport: PreviewViewportSetting,
});
export type PreviewResizeInput = typeof PreviewResizeInput.Type;

export const PreviewCloseInput = Schema.Struct({
  threadId: ThreadId,
  tabId: Schema.optional(PreviewTabId),
});
export type PreviewCloseInput = typeof PreviewCloseInput.Type;

export const PreviewListInput = Schema.Struct({
  /** Omit to catch up every persisted tab in the environment. */
  threadId: Schema.optional(ThreadId),
});
export type PreviewListInput = typeof PreviewListInput.Type;

export const PreviewListResult = Schema.Struct({
  sessions: Schema.Array(PreviewSessionSnapshot),
  /** Identifies the current server process so revision resets are safe. */
  serverEpoch: TrimmedNonEmptyString,
  /** Monotonic server state revision used to reject stale list responses. */
  revision: NonNegativeInt,
});
export type PreviewListResult = typeof PreviewListResult.Type;

/** Requests a bounded rendered frame from the desktop host that owns a tab. */
export const PreviewRemoteSnapshotInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
});
export type PreviewRemoteSnapshotInput = typeof PreviewRemoteSnapshotInput.Type;

/**
 * Mobile only needs the visible browser frame and navigation identity. Keep
 * console/network/accessibility payloads out of this high-frequency path.
 */
export const PreviewRemoteSnapshotResult = Schema.Struct({
  tabId: PreviewTabId,
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  capturedAt: Schema.String,
  screenshot: Schema.Struct({
    mimeType: Schema.Literal("image/jpeg"),
    data: Schema.String,
    width: Schema.Int,
    height: Schema.Int,
  }),
  /**
   * The guest's viewport in CSS pixels, when the host reports it. The
   * screenshot is in device pixels, so a viewer cannot turn a point in the
   * picture into a point on the page without this. Absent from older hosts,
   * which is what makes a mirror view-only rather than wrongly aimed.
   */
  viewport: Schema.optional(
    Schema.Struct({
      width: Schema.Int,
      height: Schema.Int,
    }),
  ),
});
export type PreviewRemoteSnapshotResult = typeof PreviewRemoteSnapshotResult.Type;

/**
 * One thing a person did to a mirrored guest.
 *
 * Deliberately the small set a viewer can express — a point in the frame, a
 * wheel, a key, some text, a step through history — rather than a general
 * remote-execution surface. Each maps onto an automation operation the host
 * already performs for agents, so nothing new runs on the guest's machine.
 * Coordinates are CSS pixels on the page, which the viewer derives from the
 * viewport reported alongside the frame.
 */
export const PreviewRemoteInputAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("click"),
    x: Schema.Finite,
    y: Schema.Finite,
  }),
  Schema.Struct({
    kind: Schema.Literal("scroll"),
    deltaX: Schema.Finite,
    deltaY: Schema.Finite,
  }),
  Schema.Struct({
    kind: Schema.Literal("type"),
    text: Schema.String.check(Schema.isMaxLength(4_096)),
  }),
  Schema.Struct({
    kind: Schema.Literal("press"),
    key: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
    modifiers: Schema.optional(Schema.Array(Schema.Literals(["Alt", "Control", "Meta", "Shift"]))),
  }),
  Schema.Struct({
    kind: Schema.Literal("history"),
    direction: Schema.Literals(["back", "forward"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("navigate"),
    url: Url,
  }),
  Schema.Struct({
    kind: Schema.Literal("reload"),
  }),
]);
export type PreviewRemoteInputAction = typeof PreviewRemoteInputAction.Type;

/** Applies one viewer action to the guest on whichever machine is hosting it. */
export const PreviewRemoteInputInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  action: PreviewRemoteInputAction,
});
export type PreviewRemoteInputInput = typeof PreviewRemoteInputInput.Type;

/**
 * Starts the guest's own element picker on the machine hosting it.
 *
 * The picker draws its overlay inside the page, so it arrives in the mirrored
 * frames and is driven by the same forwarded input as anything else — only
 * starting it needed a way in from off-machine. Resolves when the person
 * submits or cancels, so callers allow a human-length wait rather than a
 * request timeout.
 */
export const PreviewRemotePickInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
});
export type PreviewRemotePickInput = typeof PreviewRemotePickInput.Type;

/** Authoritative tab set committed by a close operation. */
export const PreviewCloseResult = Schema.Struct({
  ...PreviewListResult.fields,
  closedTabIds: Schema.Array(PreviewTabId),
});
export type PreviewCloseResult = typeof PreviewCloseResult.Type;

const PreviewEventBaseSchema = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  tabId: PreviewTabId,
  createdAt: Schema.String,
  /** Identifies the server process that emitted this event. */
  serverEpoch: TrimmedNonEmptyString,
  /** Monotonic server state revision shared with PreviewListResult. */
  revision: PositiveInt,
});

const PreviewOpenedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("opened"),
  snapshot: PreviewSessionSnapshot,
});

const PreviewNavigatedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("navigated"),
  snapshot: PreviewSessionSnapshot,
});

const PreviewResizedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("resized"),
  snapshot: PreviewSessionSnapshot,
});

const PreviewFailedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("failed"),
  url: Url,
  title: Title,
  code: Schema.Int,
  description: Schema.String,
});

const PreviewClosedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("closed"),
});

export const PreviewEvent = Schema.Union([
  PreviewOpenedEvent,
  PreviewNavigatedEvent,
  PreviewResizedEvent,
  PreviewFailedEvent,
  PreviewClosedEvent,
]);
export type PreviewEvent = typeof PreviewEvent.Type;

/**
 * A localhost server detected by the port scanner. Used to populate the
 * "Local" recommendations in the empty-state of the preview panel.
 */
export const DiscoveredLocalServer = Schema.Struct({
  host: TrimmedNonEmptyString,
  port: Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThan(65536)),
  url: Url,
  processName: Schema.NullOr(TrimmedNonEmptyString),
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  terminal: Schema.NullOr(
    Schema.Struct({
      threadId: ThreadId,
      terminalId: TrimmedNonEmptyString,
    }),
  ),
});
export type DiscoveredLocalServer = typeof DiscoveredLocalServer.Type;

export const DiscoveredLocalServerList = Schema.Struct({
  servers: Schema.Array(DiscoveredLocalServer),
  scannedAt: Schema.String,
});
export type DiscoveredLocalServerList = typeof DiscoveredLocalServerList.Type;

export class PreviewSessionLookupError extends Schema.TaggedErrorClass<PreviewSessionLookupError>()(
  "PreviewSessionLookupError",
  {
    threadId: Schema.String,
    tabId: Schema.String,
  },
) {
  override get message() {
    return `Unknown preview session: thread=${this.threadId}, tab=${this.tabId}`;
  }
}

export class PreviewInvalidUrlError extends Schema.TaggedErrorClass<PreviewInvalidUrlError>()(
  "PreviewInvalidUrlError",
  {
    inputLength: Schema.Number,
    reason: Schema.Literals(["empty", "parse", "unsupported-protocol", "unexpected"]),
    protocol: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    const protocol = this.protocol === undefined ? "" : `: ${this.protocol}`;
    return `Invalid preview URL (${this.reason}${protocol}; input length ${this.inputLength}).`;
  }
}

export const PreviewError = Schema.Union([PreviewSessionLookupError, PreviewInvalidUrlError]);
export type PreviewError = typeof PreviewError.Type;
