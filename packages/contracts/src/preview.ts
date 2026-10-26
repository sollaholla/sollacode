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

/** Video watches have their own lifetime; legacy JPEG subscribers stay unchanged. */
export const PreviewMediaDemand = Schema.Struct({ threadId: ThreadId, tabId: PreviewTabId });
export type PreviewMediaDemand = typeof PreviewMediaDemand.Type;
export const PreviewMediaWatchInput = PreviewMediaDemand;
export type PreviewMediaWatchInput = typeof PreviewMediaWatchInput.Type;
const PreviewMediaWatchId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export const PreviewMediaWatchEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready"), watchId: PreviewMediaWatchId }),
  Schema.Struct({ type: Schema.Literal("unavailable"), reason: Schema.String }),
]);
export type PreviewMediaWatchEvent = typeof PreviewMediaWatchEvent.Type;
export const PreviewMediaTicketInput = Schema.Struct({ watchId: PreviewMediaWatchId });
export type PreviewMediaTicketInput = typeof PreviewMediaTicketInput.Type;
export const PREVIEW_MEDIA_PAGE_STATE_KEY = "preview-page";
export const PREVIEW_MEDIA_CAPTURE_STATE_KEY = "preview-capture";
/** Explicit capture interruption lets JPEG cover retries without ending the media watch. */
export const PreviewMediaCaptureState = Schema.Struct({ capturing: Schema.Boolean });
export type PreviewMediaCaptureState = typeof PreviewMediaCaptureState.Type;
export class PreviewMediaAccessDeniedError extends Schema.TaggedErrorClass<PreviewMediaAccessDeniedError>()(
  "PreviewMediaAccessDeniedError",
  { message: Schema.String },
) {}

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

/**
 * Who is driving a tab on the desktop that renders it. Clients that only see
 * the tab remotely (a phone) have no other way to learn it; "none" covers a
 * person using the tab as well as nobody.
 */
export const PreviewAgentControl = Schema.Literals(["none", "agent", "waiting-for-user"]);
export type PreviewAgentControl = typeof PreviewAgentControl.Type;

/** The agent's latest pointer in a tab, as fractions (0..1) of the rendered frame. */
export const PreviewAgentPointer = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  phase: Schema.Literals(["move", "click"]),
  /** Increases with every pointer event, so a viewer can tell a new click from an old one. */
  sequence: Schema.Int,
});
export type PreviewAgentPointer = typeof PreviewAgentPointer.Type;

export const PreviewSessionSnapshot = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  tabId: PreviewTabId,
  navStatus: PreviewNavStatus,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  /** Missing snapshots from older servers are treated as fill-panel mode. */
  viewport: Schema.optional(PreviewViewportSetting),
  /** Meaningful user/agent activity, independent of navigation/status updates. */
  lastActivityAt: Schema.optional(Schema.String),
  /** A browser approval or human-verification gate is still unresolved. */
  attentionRequired: Schema.optional(Schema.Boolean),
  /** Reported by the rendering desktop; absent is "none". Never persisted. */
  agentControl: Schema.optional(PreviewAgentControl),
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

export const PreviewReportActivityInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  interacted: Schema.Boolean,
  attentionRequired: Schema.optional(Schema.Boolean),
  agentControl: Schema.optional(PreviewAgentControl),
});
export type PreviewReportActivityInput = typeof PreviewReportActivityInput.Type;

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
  /**
   * The `frameId` of the frame the caller already holds. A capture that is
   * byte-identical to it is answered without its screenshot (see
   * `PreviewRemoteSnapshotUnchangedResult`). A server that predates this
   * ignores it and sends the frame, so it is always safe to send.
   */
  unchangedSince: Schema.optionalKey(Schema.String),
});

/** Asks the desktop to add the agent's latest pointer to a snapshot for a remote viewer. */
export const PreviewRemoteViewSnapshotInput = Schema.Struct({
  includeAgentPointer: Schema.Literal(true),
});
export type PreviewRemoteViewSnapshotInput = typeof PreviewRemoteViewSnapshotInput.Type;
export type PreviewRemoteSnapshotInput = typeof PreviewRemoteSnapshotInput.Type;

/**
 * Mobile only needs the visible browser frame and navigation identity. Keep
 * console/network/accessibility payloads out of this high-frequency path.
 */
const previewRemoteSnapshotFields = {
  tabId: PreviewTabId,
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  capturedAt: Schema.String,
  /**
   * Downloads the desktop is holding for an answer. Optional so hosts that
   * predate remote approval still decode. Without this a remote client could
   * see the page but not the one card blocking it, and the user had to walk to
   * the machine to press a single button.
   */
  pendingDownloadApprovals: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        domain: Schema.String,
        fileName: Schema.String,
      }),
    ),
  ),
  /** Where the agent last pointed, so a remote viewer can draw its cursor. */
  agentPointer: Schema.optional(PreviewAgentPointer),
  /** Who the rendering desktop last reported driving the tab; absent is "none". */
  agentControl: Schema.optional(PreviewAgentControl),
};

export const PreviewRemoteSnapshotResult = Schema.Struct({
  ...previewRemoteSnapshotFields,
  screenshot: Schema.Struct({
    mimeType: Schema.Literal("image/jpeg"),
    data: Schema.String,
    width: Schema.Int,
    height: Schema.Int,
  }),
  /** Identifies this exact picture, for the caller's next `unchangedSince`. */
  frameId: Schema.optionalKey(Schema.String),
});
export type PreviewRemoteSnapshotResult = typeof PreviewRemoteSnapshotResult.Type;

/**
 * Answer to a snapshot whose picture is the one the caller said it holds. A
 * phone watching a page that is not moving used to download the same JPEG
 * every couple of seconds; this is the few hundred bytes around it. Everything
 * but the picture is current, so the caller keeps its frame and takes these.
 */
export const PreviewRemoteSnapshotUnchangedResult = Schema.Struct({
  ...previewRemoteSnapshotFields,
  unchanged: Schema.Literal(true),
  frameId: Schema.String,
});
export type PreviewRemoteSnapshotUnchangedResult = typeof PreviewRemoteSnapshotUnchangedResult.Type;

/**
 * Remote frame stream. Instead of asking for a picture every few seconds, a
 * remote viewer subscribes to a tab and the desktop that renders it pushes a
 * picture whenever the page changes: one whole picture (a keyframe), then only
 * the rectangles that changed (patches), sized to the largest viewer watching.
 * A page that is not moving costs nothing; a blinking caret costs a few
 * hundred bytes a blink. Viewers that cannot draw patches get keyframes only.
 * Clients that predate the stream keep polling `previewRemoteSnapshot`.
 */
export const PREVIEW_REMOTE_FRAME_MIN_DIMENSION = 64;
export const PREVIEW_REMOTE_FRAME_MAX_DIMENSION = 4096;
/** Rectangles in one patch event; a change that needs more is sent as a keyframe. */
export const PREVIEW_REMOTE_FRAME_MAX_PATCHES = 64;

const PreviewRemoteFrameRequestDimension = Schema.Int.check(
  Schema.isBetween({
    minimum: PREVIEW_REMOTE_FRAME_MIN_DIMENSION,
    maximum: PREVIEW_REMOTE_FRAME_MAX_DIMENSION,
  }),
);
const PreviewRemoteFramePixelSize = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 2 * PREVIEW_REMOTE_FRAME_MAX_DIMENSION }),
);

/** A viewer watching one tab, and the largest picture it can show. */
export const PreviewRemoteFrameWatchInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  /** The viewer's picture box in device pixels; the desktop never sends larger. */
  maxWidth: PreviewRemoteFrameRequestDimension,
  maxHeight: PreviewRemoteFrameRequestDimension,
  /** Changes after a decode failure to force a fresh subscription and base picture. */
  resync: Schema.optional(NonNegativeInt),
  /** Whether the viewer can draw patches over its picture. Absent means keyframes only. */
  patches: Schema.optional(Schema.Boolean),
});
export type PreviewRemoteFrameWatchInput = typeof PreviewRemoteFrameWatchInput.Type;

/** Everything about the page a viewer shows besides its pixels. */
export const PreviewRemoteFramePageState = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  pendingDownloadApprovals: previewRemoteSnapshotFields.pendingDownloadApprovals,
  agentPointer: Schema.optional(PreviewAgentPointer),
});
export type PreviewRemoteFramePageState = typeof PreviewRemoteFramePageState.Type;

/** One changed rectangle, in the pixels of the picture it is drawn over. */
export const PreviewRemoteFramePatch = Schema.Struct({
  x: NonNegativeInt,
  y: NonNegativeInt,
  width: PreviewRemoteFramePixelSize,
  height: PreviewRemoteFramePixelSize,
  /** Base64 JPEG of exactly this rectangle. */
  data: Schema.String,
});
export type PreviewRemoteFramePatch = typeof PreviewRemoteFramePatch.Type;

export const PreviewRemoteFrameKeyframe = Schema.Struct({
  type: Schema.Literal("keyframe"),
  /** Counts every picture the desktop published for this tab; patches name the one they follow. */
  sequence: NonNegativeInt,
  width: PreviewRemoteFramePixelSize,
  height: PreviewRemoteFramePixelSize,
  mimeType: Schema.Literal("image/jpeg"),
  /** Base64 JPEG of the whole picture. */
  data: Schema.String,
});
export type PreviewRemoteFrameKeyframe = typeof PreviewRemoteFrameKeyframe.Type;

export const PreviewRemoteFramePatchSet = Schema.Struct({
  type: Schema.Literal("patch"),
  sequence: NonNegativeInt,
  /** The picture these rectangles are drawn over; a viewer holding another one resubscribes. */
  after: NonNegativeInt,
  width: PreviewRemoteFramePixelSize,
  height: PreviewRemoteFramePixelSize,
  mimeType: Schema.Literal("image/jpeg"),
  /** Drawn in order; a later rectangle may cover an earlier one. */
  patches: Schema.Array(PreviewRemoteFramePatch).check(
    Schema.isMaxLength(PREVIEW_REMOTE_FRAME_MAX_PATCHES),
  ),
});
export type PreviewRemoteFramePatchSet = typeof PreviewRemoteFramePatchSet.Type;

export const PreviewRemoteFrameEvent = Schema.Union([
  PreviewRemoteFrameKeyframe,
  PreviewRemoteFramePatchSet,
  /** The page's address, title, cursor, or held downloads changed. */
  Schema.Struct({ type: Schema.Literal("state"), state: PreviewRemoteFramePageState }),
  /**
   * No desktop can stream this tab right now (none connected that can, or the
   * one rendering it could not capture). The viewer falls back to polling
   * `previewRemoteSnapshot` until pictures arrive.
   */
  Schema.Struct({
    type: Schema.Literal("unavailable"),
    reason: Schema.String.check(Schema.isMaxLength(500)),
  }),
]);
export type PreviewRemoteFrameEvent = typeof PreviewRemoteFrameEvent.Type;

/** A tab some remote viewer is watching, and what the desktop should send for it. */
export const PreviewRemoteFrameDemand = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  /** The largest picture any viewer of the tab can show, in device pixels. */
  maxWidth: PreviewRemoteFrameRequestDimension,
  maxHeight: PreviewRemoteFrameRequestDimension,
  /** False while any viewer can only draw keyframes. */
  patches: Schema.Boolean,
  /** Raised when the server needs a fresh keyframe (a broken patch chain). */
  keyframeRequest: NonNegativeInt,
});
export type PreviewRemoteFrameDemand = typeof PreviewRemoteFrameDemand.Type;

/** The rendering desktop handing the server what changed in a watched tab. */
export const PreviewRemoteFramePublishInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  /** The publishing host's automation connection; one desktop streams a tab at a time. */
  connectionId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  events: Schema.Array(PreviewRemoteFrameEvent).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
});
export type PreviewRemoteFramePublishInput = typeof PreviewRemoteFramePublishInput.Type;

/**
 * Tab audio for remote viewers. The desktop that renders a tab captures its
 * sound only while a viewer is listening AND the page is actually making
 * sound, encodes it as Opus, and relays it through the server in batches of
 * short packets. Silence and closed viewers cost nothing on the wire.
 */
export const PREVIEW_TAB_AUDIO_MAX_PACKETS = 64;
/** A 20 ms Opus packet is a few hundred bytes; this leaves generous room. */
export const PREVIEW_TAB_AUDIO_MAX_PACKET_BASE64 = 16_384;

export const PreviewTabAudioFormat = Schema.Struct({
  codec: Schema.Literal("opus"),
  sampleRate: PositiveInt,
  numberOfChannels: PositiveInt.check(Schema.isLessThanOrEqualTo(8)),
  /** Base64 Opus identification header, when the encoder supplied one. */
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
});
export type PreviewTabAudioFormat = typeof PreviewTabAudioFormat.Type;

export const PreviewTabAudioPacket = Schema.Struct({
  /** Microseconds on the capture's own clock. */
  timestamp: Schema.Number,
  /** Microseconds of sound this packet decodes to. */
  duration: Schema.Number,
  /** Base64 Opus packet. */
  data: Schema.String.check(Schema.isMaxLength(PREVIEW_TAB_AUDIO_MAX_PACKET_BASE64)),
});
export type PreviewTabAudioPacket = typeof PreviewTabAudioPacket.Type;

export const PreviewTabAudioEvent = Schema.Union([
  /** The tab started or stopped making sound (packets follow while audible). */
  Schema.Struct({
    type: Schema.Literal("audible"),
    audible: Schema.Boolean,
    /** Why sound stopped when the desktop could not capture it, for diagnosis. */
    reason: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  }),
  Schema.Struct({
    type: Schema.Literal("packets"),
    format: PreviewTabAudioFormat,
    packets: Schema.Array(PreviewTabAudioPacket).check(
      Schema.isMaxLength(PREVIEW_TAB_AUDIO_MAX_PACKETS),
    ),
  }),
]);
export type PreviewTabAudioEvent = typeof PreviewTabAudioEvent.Type;

export const PreviewTabAudioTarget = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
});
export type PreviewTabAudioTarget = typeof PreviewTabAudioTarget.Type;

/** A viewer listening to one tab. */
export const PreviewTabAudioWatchInput = PreviewTabAudioTarget;
export type PreviewTabAudioWatchInput = typeof PreviewTabAudioWatchInput.Type;

/**
 * What a listener's player did with a tab's sound, reported now and then.
 * Only the listening device knows whether relayed sound actually played;
 * the server records this in its trace, which is how "no sound on my phone"
 * becomes a locked page, a failed decoder, or a quiet tab.
 */
export const PreviewTabAudioListenerReport = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  /** Packet batches that arrived. */
  batches: NonNegativeInt,
  /** Batches dropped because a tap had not unlocked sound yet. */
  batchesWhileLocked: NonNegativeInt,
  packetsDecoded: NonNegativeInt,
  /** Decoded pieces of sound, and how many of them were started. */
  framesOut: NonNegativeInt,
  buffersStarted: NonNegativeInt,
  /** Decoded sound thrown away for arriving too late to play live. */
  lateDropped: NonNegativeInt,
  contextState: Schema.String.check(Schema.isMaxLength(32)),
  lastError: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type PreviewTabAudioListenerReport = typeof PreviewTabAudioListenerReport.Type;

/** The rendering desktop handing the server one event for a tab's listeners. */
export const PreviewTabAudioPublishInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  event: PreviewTabAudioEvent,
});
export type PreviewTabAudioPublishInput = typeof PreviewTabAudioPublishInput.Type;

/**
 * A position expressed as fractions of the rendered frame, 0..1 on each axis.
 * Phones never learn the guest's CSS viewport (frames arrive resized), so the
 * server converts fractions to CSS pixels against the host's measured viewport
 * at dispatch time.
 */
export const PreviewRemoteFramePoint = Schema.Struct({
  x: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  y: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});
export type PreviewRemoteFramePoint = typeof PreviewRemoteFramePoint.Type;

/**
 * Scroll deltas as fractions of the guest viewport per axis. A fling can cover
 * several viewports; the bound exists so a client bug cannot request an
 * effectively unbounded scroll.
 */
const PreviewRemoteScrollDelta = Schema.Finite.check(
  Schema.isBetween({ minimum: -32, maximum: 32 }),
);

/**
 * Editing commands a remote viewer's context menu runs in the guest. Copy and
 * paste are absent on purpose: both use the viewer's own clipboard (copy from
 * the menu's `selectionText`, paste as typed text), never the desktop's.
 */
export const PreviewContextMenuCommand = Schema.Literals(["undo", "redo", "delete", "selectAll"]);
export type PreviewContextMenuCommand = typeof PreviewContextMenuCommand.Type;

/** Longest selection a context menu carries back; copying a whole page is not a menu's job. */
export const PREVIEW_CONTEXT_MENU_SELECTION_MAX_CHARS = 20_000;
/** URLs past this (inline `data:` images, mostly) are dropped rather than shipped. */
export const PREVIEW_CONTEXT_MENU_URL_MAX_CHARS = 8_192;

/** What sat under the pointer when the guest was right-clicked. */
export const PreviewContextMenuTarget = Schema.Struct({
  pageUrl: Schema.String.check(Schema.isMaxLength(PREVIEW_CONTEXT_MENU_URL_MAX_CHARS)),
  linkUrl: Schema.String.check(Schema.isMaxLength(PREVIEW_CONTEXT_MENU_URL_MAX_CHARS)),
  linkText: Schema.String.check(Schema.isMaxLength(2_048)),
  srcUrl: Schema.String.check(Schema.isMaxLength(PREVIEW_CONTEXT_MENU_URL_MAX_CHARS)),
  mediaType: Schema.String.check(Schema.isMaxLength(32)),
  isEditable: Schema.Boolean,
  selectionText: Schema.String.check(Schema.isMaxLength(PREVIEW_CONTEXT_MENU_SELECTION_MAX_CHARS)),
  canUndo: Schema.Boolean,
  canRedo: Schema.Boolean,
  canSelectAll: Schema.Boolean,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
});
export type PreviewContextMenuTarget = typeof PreviewContextMenuTarget.Type;

export const PreviewRemoteInputAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("click"),
    position: PreviewRemoteFramePoint,
  }),
  Schema.Struct({
    kind: Schema.Literal("drag"),
    from: PreviewRemoteFramePoint,
    to: PreviewRemoteFramePoint,
    // A press-and-hold is a drag whose ends coincide, held for `holdMs`.
    button: Schema.optional(Schema.Literals(["left", "right"])),
    holdMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5_000 }))),
  }),
  // Right-click. The host returns what sat under the pointer so the viewer can
  // draw the menu itself; the guest's native menu would open on the desktop.
  Schema.Struct({
    kind: Schema.Literal("contextMenu"),
    position: PreviewRemoteFramePoint,
  }),
  Schema.Struct({
    kind: Schema.Literal("editCommand"),
    command: PreviewContextMenuCommand,
  }),
  Schema.Struct({
    kind: Schema.Literal("scroll"),
    deltaX: PreviewRemoteScrollDelta,
    deltaY: PreviewRemoteScrollDelta,
    /** Where the wheel turns: the container under this point scrolls. Omitted scrolls the page. */
    position: Schema.optional(PreviewRemoteFramePoint),
  }),
  Schema.Struct({
    kind: Schema.Literal("type"),
    text: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(4096)),
    position: Schema.optional(PreviewRemoteFramePoint),
  }),
  // Answering a held download is the one approval a remote client must be able
  // to give: the file is staged on the desktop and the browser blocks until
  // someone chooses, so without this the user has to walk to the machine to
  // press one button.
  Schema.Struct({
    kind: Schema.Literal("answerDownloadApproval"),
    approvalId: TrimmedNonEmptyString,
    decision: Schema.Literals(["allow-domain", "allow-once", "deny"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("press"),
    key: TrimmedNonEmptyString.check(Schema.isMaxLength(32)),
  }),
  Schema.Struct({
    kind: Schema.Literal("history"),
    action: Schema.Literals(["back", "forward", "reload"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("navigate"),
    url: Url,
  }),
]);
export type PreviewRemoteInputAction = typeof PreviewRemoteInputAction.Type;

/** Forwards one user gesture from a remote client into the desktop host's tab. */
export const PreviewRemoteInputInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  action: PreviewRemoteInputAction,
});
export type PreviewRemoteInputInput = typeof PreviewRemoteInputInput.Type;

export const PreviewRemoteInputResult = Schema.Struct({
  deliveredAt: Schema.String,
  /** Set by `contextMenu`; null when the page drew its own menu instead. */
  contextMenu: Schema.optional(Schema.NullOr(PreviewContextMenuTarget)),
});
export type PreviewRemoteInputResult = typeof PreviewRemoteInputResult.Type;

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
