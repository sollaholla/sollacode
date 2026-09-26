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
});
export type PreviewRemoteSnapshotResult = typeof PreviewRemoteSnapshotResult.Type;

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
