import type {
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  VcsPullInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  GitResolvePullRequestResult,
  VcsStatusInput,
  VcsStatusResult,
} from "./git.ts";
import type { ReviewDiffPreviewInput, ReviewDiffPreviewResult } from "./review.ts";
import type { FilesystemBrowseInput, FilesystemBrowseResult } from "./filesystem.ts";
import type { AssetCreateUrlInput, AssetCreateUrlResult } from "./assets.ts";
import type {
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import type {
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalListInput,
  TerminalListResult,
  TerminalMetadataStreamEvent,
  TerminalOpenInput,
  TerminalReadInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import * as Schema from "effect/Schema";
import {
  RemoteControlCursorShape,
  RemoteControlHostStatusReason,
  RemoteControlInput,
} from "./remoteControl.ts";
import type {
  DiscoveredLocalServerList,
  PreviewCloseInput,
  PreviewCloseResult,
  PreviewEvent,
  PreviewListInput,
  PreviewListResult,
  PreviewNavigateInput,
  PreviewOpenInput,
  PreviewRefreshInput,
  PreviewReportStatusInput,
  PreviewResizeInput,
  PreviewSessionSnapshot,
} from "./preview.ts";
import {
  PreviewAutomationClickInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationHost,
  PreviewAutomationHostFocus,
  PreviewAutomationPressInput,
  PreviewAutomationResponse,
  PreviewAutomationScrollInput,
  PreviewAutomationFrame,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationStreamEvent,
  PreviewAutomationTypeInput,
  PreviewAutomationSelectOptionInput,
  PreviewAutomationSelectOptionResult,
  PreviewAutomationUploadInput,
  PreviewAutomationUploadResult,
  PreviewAutomationWaitForDownloadInput,
  PreviewAutomationWaitForDownloadResult,
  PreviewAutomationWaitForInput,
} from "./previewAutomation.ts";
import { PreviewDownload, PreviewDownloadApproval } from "./previewAutomation.ts";
import type {
  ClientOrchestrationCommand,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamItem,
  OrchestrationSubscribeThreadInput,
  OrchestrationThreadStreamItem,
} from "./orchestration.ts";
import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import { AuthAccessTokenResult, AuthSessionState, AuthWebSocketTicketResult } from "./auth.ts";
import { AdvertisedEndpoint } from "./remoteAccess.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import type { ClientSettings } from "./settings.ts";
import type {
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
} from "./sourceControl.ts";
import type { DesktopPermissionsBridge } from "./desktopPermissions.ts";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  /** Renders as a non-interactive section header label. Web fallback only — stripped on desktop native menus. */
  header?: boolean;
  /** Icon keyword resolved by the web fallback. Stripped on desktop native menus. */
  icon?: string;
  children?: readonly ContextMenuItem<T>[];
}

export interface ContextMenuItemSchemaType {
  readonly id: string;
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly header?: boolean;
  readonly icon?: string;
  readonly children?: readonly ContextMenuItemSchemaType[];
}

export const ContextMenuItemSchema: Schema.Codec<ContextMenuItemSchemaType> = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  destructive: Schema.optionalKey(Schema.Boolean),
  disabled: Schema.optionalKey(Schema.Boolean),
  header: Schema.optionalKey(Schema.Boolean),
  icon: Schema.optionalKey(Schema.String),
  children: Schema.optionalKey(
    Schema.Array(
      Schema.suspend((): Schema.Codec<ContextMenuItemSchemaType> => ContextMenuItemSchema),
    ),
  ),
});

export type DesktopRuntimeArch = "arm64" | "x64" | "other";
export type DesktopTheme = "light" | "dark" | "system";
export type DesktopAppStageLabel = "Alpha" | "Dev" | "Nightly";

export const DesktopRuntimeArchSchema = Schema.Literals(["arm64", "x64", "other"]);
export const DesktopThemeSchema = Schema.Literals(["light", "dark", "system"]);
export const DesktopAppStageLabelSchema = Schema.Literals(["Alpha", "Dev", "Nightly"]);

export interface DesktopAppBranding {
  baseName: string;
  stageLabel: DesktopAppStageLabel;
  displayName: string;
}

export const DesktopAppBrandingSchema = Schema.Struct({
  baseName: Schema.String,
  stageLabel: DesktopAppStageLabelSchema,
  displayName: Schema.String,
});

export interface DesktopRuntimeInfo {
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
}

export const DesktopRuntimeInfoSchema = Schema.Struct({
  hostArch: DesktopRuntimeArchSchema,
  appArch: DesktopRuntimeArchSchema,
  runningUnderArm64Translation: Schema.Boolean,
});

// Stable id for the Windows-native primary backend. Desktop side wraps
// this with a brand inside DesktopBackendManager; web side keeps it as
// a plain string so the env-runtime can compare against it without
// importing brand machinery from the desktop package.
export const PRIMARY_LOCAL_ENVIRONMENT_ID = "primary";

export interface DesktopEnvironmentBootstrap {
  // Stable backend instance id (e.g. "primary" or "wsl:ubuntu"). The
  // web env runtime keys local environments off this so projects
  // routed to a specific backend reopen against the same one.
  id: string;
  label: string;
  // Concrete WSL distro used by the current backend run. This stays separate
  // from id because a default-tracking instance keeps the stable
  // "wsl:default" IPC target while each run launches a specific distro.
  runningDistro?: string | null;
  httpBaseUrl: string | null;
  wsBaseUrl: string | null;
  bootstrapToken?: string;
}

export const DesktopEnvironmentBootstrapSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  runningDistro: Schema.optionalKey(Schema.NullOr(Schema.String)),
  httpBaseUrl: Schema.NullOr(Schema.String),
  wsBaseUrl: Schema.NullOr(Schema.String),
  bootstrapToken: Schema.optionalKey(Schema.String),
});

export const DesktopSshEnvironmentTargetSchema = Schema.Struct({
  alias: Schema.String,
  hostname: Schema.String,
  username: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Number),
});
export type DesktopSshEnvironmentTarget = typeof DesktopSshEnvironmentTargetSchema.Type;

export type DesktopSshHostSource = "ssh-config" | "known-hosts";
export const DesktopSshHostSourceSchema = Schema.Literals(["ssh-config", "known-hosts"]);

export interface DesktopDiscoveredSshHost extends DesktopSshEnvironmentTarget {
  source: DesktopSshHostSource;
}

export const DesktopDiscoveredSshHostSchema = Schema.Struct({
  alias: Schema.String,
  hostname: Schema.String,
  username: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Number),
  source: DesktopSshHostSourceSchema,
});

export interface DesktopSshEnvironmentBootstrap {
  target: DesktopSshEnvironmentTarget;
  httpBaseUrl: string;
  wsBaseUrl: string;
  pairingToken: string | null;
  remotePort?: number;
  remoteServerKind?: "external" | "managed";
}

export const DesktopSshEnvironmentBootstrapSchema = Schema.Struct({
  target: DesktopSshEnvironmentTargetSchema,
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  pairingToken: Schema.NullOr(Schema.String),
  remotePort: Schema.optionalKey(Schema.Number),
  remoteServerKind: Schema.optionalKey(Schema.Literals(["external", "managed"])),
});

export interface DesktopSshPasswordPromptRequest {
  requestId: string;
  destination: string;
  username: string | null;
  prompt: string;
  expiresAt: string;
}

export const DesktopSshPasswordPromptRequestSchema = Schema.Struct({
  requestId: Schema.String,
  destination: Schema.String,
  username: Schema.NullOr(Schema.String),
  prompt: Schema.String,
  expiresAt: Schema.String,
});

export const DesktopSshPasswordPromptCancelledType = "ssh-password-prompt-cancelled" as const;

export const DesktopSshPasswordPromptCancelledResultSchema = Schema.Struct({
  type: Schema.Literal(DesktopSshPasswordPromptCancelledType),
  message: Schema.String,
});

export const DesktopSshEnvironmentEnsureOptionsSchema = Schema.Struct({
  issuePairingToken: Schema.optionalKey(Schema.Boolean),
});

export const DesktopSshEnvironmentEnsureInputSchema = Schema.Struct({
  target: DesktopSshEnvironmentTargetSchema,
  options: Schema.optionalKey(DesktopSshEnvironmentEnsureOptionsSchema),
});

export const DesktopSshEnvironmentEnsureResultSchema = Schema.Union([
  DesktopSshEnvironmentBootstrapSchema,
  DesktopSshPasswordPromptCancelledResultSchema,
]);

export const DesktopSshHttpBaseUrlInputSchema = Schema.Struct({
  httpBaseUrl: Schema.String,
});

export const DesktopSshBearerRequestInputSchema = Schema.Struct({
  httpBaseUrl: Schema.String,
  bearerToken: Schema.String,
});

export const DesktopSshBearerBootstrapInputSchema = Schema.Struct({
  httpBaseUrl: Schema.String,
  credential: Schema.String,
});

export const DesktopSshPasswordPromptResolutionInputSchema = Schema.Struct({
  requestId: Schema.String,
  password: Schema.NullOr(Schema.String),
});

export const PersistedSavedEnvironmentRecordSchema = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  wsBaseUrl: Schema.String,
  httpBaseUrl: Schema.String,
  createdAt: Schema.String,
  lastConnectedAt: Schema.NullOr(Schema.String),
  desktopSsh: Schema.optionalKey(DesktopSshEnvironmentTargetSchema),
  relayManaged: Schema.optionalKey(
    Schema.Struct({
      relayUrl: Schema.String,
    }),
  ),
});
export type PersistedSavedEnvironmentRecord = typeof PersistedSavedEnvironmentRecordSchema.Type;

export type DesktopServerExposureMode = "local-only" | "network-accessible";

export const DesktopServerExposureModeSchema = Schema.Literals([
  "local-only",
  "network-accessible",
]);

export const DesktopTailscaleServeStatusSchema = Schema.Literals([
  "disabled",
  "checking",
  "available",
  "tailscale-not-installed",
  "tailscale-not-running",
  "tailscale-not-authenticated",
  "https-consent-required",
  "port-conflict",
  "serve-failed",
  "endpoint-unreachable",
]);
export type DesktopTailscaleServeStatus = typeof DesktopTailscaleServeStatusSchema.Type;

export interface DesktopServerExposureState {
  mode: DesktopServerExposureMode;
  endpointUrl: string | null;
  advertisedHost: string | null;
  tailscaleServeRequested: boolean;
  tailscaleServeEffective: boolean;
  tailscaleServeStatus: DesktopTailscaleServeStatus;
  tailscaleServeConsentUrl: string | null;
  tailscaleServePort: number;
}

export const DesktopServerExposureStateSchema = Schema.Struct({
  mode: DesktopServerExposureModeSchema,
  endpointUrl: Schema.NullOr(Schema.String),
  advertisedHost: Schema.NullOr(Schema.String),
  tailscaleServeRequested: Schema.Boolean,
  tailscaleServeEffective: Schema.Boolean,
  tailscaleServeStatus: DesktopTailscaleServeStatusSchema,
  tailscaleServeConsentUrl: Schema.NullOr(Schema.String),
  tailscaleServePort: Schema.Number,
});

export interface DesktopLanPeer {
  readonly id: string;
  readonly environmentId: EnvironmentId | null;
  readonly label: string;
  readonly backendUrl: string;
  readonly lastSeenAt: number;
}

export const DesktopLanPeerSchema = Schema.Struct({
  id: Schema.String,
  environmentId: Schema.NullOr(EnvironmentId),
  label: Schema.String,
  backendUrl: Schema.String,
  lastSeenAt: Schema.Number,
});

export const DesktopLanDiscoveryIssueKindSchema = Schema.Literals([
  "permission-denied",
  "port-unavailable",
  "network-unavailable",
  "unknown",
]);
export type DesktopLanDiscoveryIssueKind = typeof DesktopLanDiscoveryIssueKindSchema.Type;

export interface DesktopLanDiscoveryIssue {
  readonly kind: DesktopLanDiscoveryIssueKind;
  readonly title: string;
  readonly detail: string;
}

export const DesktopLanDiscoveryIssueSchema = Schema.Struct({
  kind: DesktopLanDiscoveryIssueKindSchema,
  title: Schema.String,
  detail: Schema.String,
});

export interface DesktopLanDiscoveryState {
  readonly status: "ready" | "retrying";
  readonly peers: ReadonlyArray<DesktopLanPeer>;
  readonly issue: DesktopLanDiscoveryIssue | null;
}

export const DesktopLanDiscoveryStateSchema = Schema.Struct({
  status: Schema.Literals(["ready", "retrying"]),
  peers: Schema.Array(DesktopLanPeerSchema),
  issue: Schema.NullOr(DesktopLanDiscoveryIssueSchema),
});

export interface DesktopLanPairingRequestInput {
  readonly peerId: string;
  readonly initiatorPairingUrl: string;
}

export const DesktopLanPairingRequestInputSchema = Schema.Struct({
  peerId: Schema.String,
  initiatorPairingUrl: Schema.String,
});

export interface DesktopLanPairingRequestResult {
  readonly requestId: string;
  readonly responderPairingUrl: string;
}

export const DesktopLanPairingRequestResultSchema = Schema.Struct({
  requestId: Schema.String,
  responderPairingUrl: Schema.String,
});

export interface DesktopLanPairingCompletionInput {
  readonly requestId: string;
  readonly responderPairingUrl?: string;
  readonly error?: string;
}

export const DesktopLanPairingCompletionInputSchema = Schema.Struct({
  requestId: Schema.String,
  responderPairingUrl: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});

export interface DesktopLanPairingApprovedEvent {
  readonly type: "approved-request";
  readonly requestId: string;
  readonly initiatorLabel: string;
  readonly initiatorPairingUrl: string;
}

export const DesktopLanPairingApprovedEventSchema = Schema.Struct({
  type: Schema.Literal("approved-request"),
  requestId: Schema.String,
  initiatorLabel: Schema.String,
  initiatorPairingUrl: Schema.String,
});

export interface PickFolderOptions {
  initialPath?: string | null;
  // When set, the desktop dialog opens against the named backend's
  // filesystem instead of the primary's. Used by callers that already
  // know which local environment they're targeting (e.g. opening a
  // project that lives inside WSL). Omitting it keeps the historical
  // behavior so non-WSL users never see a different picker.
  targetEnvironmentId?: string;
}

export const PickFolderOptionsSchema = Schema.Struct({
  initialPath: Schema.optionalKey(Schema.NullOr(Schema.String)),
  targetEnvironmentId: Schema.optionalKey(Schema.String),
});

export interface DesktopWslDistro {
  name: string;
  isDefault: boolean;
  version: 1 | 2;
}

export const DesktopWslDistroSchema = Schema.Struct({
  name: Schema.String,
  isDefault: Schema.Boolean,
  version: Schema.Literals([1, 2]),
});

export interface DesktopWslState {
  // True when the user has opted the WSL backend in; the actual backend
  // process is registered with the desktop pool independently of this
  // flag and may take a moment to come up after the user enables it.
  enabled: boolean;
  // null means "track the current WSL default distro".
  distro: string | null;
  available: boolean;
  // When true (and `enabled` is also true) the desktop runs only the
  // WSL backend as the primary; the Windows-side Node backend is not
  // started. Toggling this requires an app restart because the
  // primary backend's spec is captured once at layer init.
  wslOnly: boolean;
  distros: readonly DesktopWslDistro[];
  // Reason the dual-mode WSL backend last failed preflight (no node, wrong
  // version, missing build tools), or null. Surfaced inline in Connections
  // settings. Always null in wsl-only mode — that path shows a dialog and
  // falls back to Windows instead.
  preflightError: string | null;
}

export const DesktopWslStateSchema = Schema.Struct({
  enabled: Schema.Boolean,
  distro: Schema.NullOr(Schema.String),
  available: Schema.Boolean,
  wslOnly: Schema.Boolean,
  distros: Schema.Array(DesktopWslDistroSchema),
  preflightError: Schema.NullOr(Schema.String),
});

/**
 * Renderer-facing snapshot of a desktop preview tab. Mirrors the main-process
 * PreviewTabState shape but uses serialisable primitives only.
 */
export type DesktopPreviewNavStatus =
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

/**
 * Emulated `prefers-color-scheme` for the guest page. "system" clears the
 * override so the page follows the OS appearance.
 */
export type DesktopPreviewColorScheme = "system" | "light" | "dark";

export const DesktopPreviewColorSchemeSchema: Schema.Codec<DesktopPreviewColorScheme> =
  Schema.Literals(["system", "light", "dark"]);

export interface DesktopPreviewTabState {
  tabId: string;
  webContentsId: number | null;
  /**
   * Transient main-process request for the renderer to give this guest an
   * on-window compositor surface. Used only while capturing a background tab.
   */
  snapshotStageId: string | null;
  navStatus: DesktopPreviewNavStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Current zoom factor (1.0 = 100%). */
  zoomFactor: number;
  /** Whether this tab is currently mirrored into a desktop picture-in-picture window. */
  pictureInPicture: boolean;
  colorScheme: DesktopPreviewColorScheme;
  controller: "human" | "agent" | "none" | "waiting-for-user";
  /**
   * The tab an agent is working in, sticky between its individual actions.
   *
   * `controller` is only "agent" for the milliseconds a CDP command is in
   * flight, so a surface that watched it saw nothing between tool calls. This
   * stays set on the last tab an agent drove until it drives a different one,
   * which is what answers "which tab is it in?" while a turn runs.
   */
  agentActive: boolean;
  /**
   * Downloads this tab finished, newest first.
   *
   * Carried on the tab so the notice appears on the tab that fetched the file,
   * and so it survives a reload of the panel: a download that completed while
   * the user was elsewhere is still there when they come back.
   */
  downloads: ReadonlyArray<PreviewDownload>;
  /** Downloads paused until the user allows or denies the site. */
  pendingDownloadApprovals: ReadonlyArray<PreviewDownloadApproval>;
  updatedAt: string;
}

/**
 * A guest page asked to open a link in another browser tab. The source uses
 * the desktop runtime tab id so the renderer can recover the owning thread
 * before creating the durable preview session.
 */
export interface DesktopPreviewNewTabRequest {
  readonly sourceTabId: string;
  readonly url: string;
}

/**
 * Privacy-bounded network evidence emitted by the desktop browser host. The
 * renderer correlates the guest webContents id with its runtime preview tab;
 * no cookies, request bodies, response bodies, or header values are included.
 */
export type DesktopPreviewHumanVerificationSignal =
  | {
      readonly kind: "cf-mitigated-challenge";
      readonly webContentsId: number;
      readonly url: string;
      readonly observedAt: string;
      readonly statusCode: number;
    }
  | {
      readonly kind: "cloudflare-reachability";
      readonly webContentsId: number;
      readonly url: string;
      readonly observedAt: string;
      readonly reachable: boolean;
      readonly statusCode: number | null;
      readonly error: string | null;
    };

export const DesktopPreviewTabIdSchema = Schema.String.check(Schema.isTrimmed()).check(
  Schema.isNonEmpty(),
);

/**
 * Desktop preview automation addresses a renderer-local runtime tab id. That
 * id includes the environment, thread, server epoch, and public preview tab
 * id, so it can legitimately exceed the public PreviewTabId length bound.
 */
export const DesktopPreviewAutomationStatusSchema = Schema.Struct({
  ...PreviewAutomationStatus.fields,
  tabId: Schema.NullOr(DesktopPreviewTabIdSchema),
});
export type DesktopPreviewAutomationStatus = typeof DesktopPreviewAutomationStatusSchema.Type;

export const DesktopPreviewNavStatusSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("Idle") }),
  Schema.Struct({
    kind: Schema.Literal("Loading"),
    url: Schema.String,
    title: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("Success"),
    url: Schema.String,
    title: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("LoadFailed"),
    url: Schema.String,
    title: Schema.String,
    code: Schema.Number,
    description: Schema.String,
  }),
]);

export const DesktopPreviewTabStateSchema: Schema.Codec<DesktopPreviewTabState> = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  webContentsId: Schema.NullOr(Schema.Int),
  snapshotStageId: Schema.NullOr(Schema.String),
  navStatus: DesktopPreviewNavStatusSchema,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  zoomFactor: Schema.Number,
  pictureInPicture: Schema.Boolean,
  colorScheme: DesktopPreviewColorSchemeSchema,
  controller: Schema.Literals(["human", "agent", "none", "waiting-for-user"]),
  agentActive: Schema.Boolean,
  downloads: Schema.Array(PreviewDownload),
  pendingDownloadApprovals: Schema.Array(PreviewDownloadApproval),
  updatedAt: Schema.String,
});

export interface DesktopPreviewPointerEvent {
  tabId: string;
  phase: "move" | "click";
  x: number;
  y: number;
  sequence: number;
  createdAt: string;
}

export const DesktopPreviewPointerEventSchema: Schema.Codec<DesktopPreviewPointerEvent> =
  Schema.Struct({
    tabId: DesktopPreviewTabIdSchema,
    phase: Schema.Literals(["move", "click"]),
    x: Schema.Number,
    y: Schema.Number,
    sequence: Schema.Int,
    createdAt: Schema.String,
  });

/**
 * Static config a renderer needs to mount a preview `<webview>`. Returned
 * atomically by `DesktopPreviewBridge.getPreviewConfig()` so the renderer
 * doesn't have to wait on three separate IPC round-trips before the webview
 * can attach.
 */
export interface DesktopPreviewWebviewConfig {
  /** `persist:t3code-preview` (or whatever the desktop chose). */
  partition: string;
  /**
   * Canonical `<webview webpreferences="...">` string. Encodes the security
   * posture (sandboxed but contextIsolation off so the picker preload can
   * read the page's React DevTools hook). Always present.
   */
  webPreferences: string;
  /**
   * Absolute `file://`-style URL to the picker preload bundle. Set to null
   * when the bundle isn't present (older builds, broken install) — the
   * renderer must then disable element-pick affordances.
   */
  preloadUrl: string | null;
}

export const DesktopPreviewWebviewConfigSchema: Schema.Codec<DesktopPreviewWebviewConfig> =
  Schema.Struct({
    partition: Schema.String,
    webPreferences: Schema.String,
    preloadUrl: Schema.NullOr(Schema.String),
  });

export interface DesktopPreviewAnnotationTheme {
  colorScheme: "light" | "dark";
  radius: string;
  background: string;
  foreground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  border: string;
  input: string;
  ring: string;
  fontSans: string;
  fontMono: string;
}

export const DesktopPreviewAnnotationThemeSchema: Schema.Codec<DesktopPreviewAnnotationTheme> =
  Schema.Struct({
    colorScheme: Schema.Literals(["light", "dark"]),
    radius: Schema.String,
    background: Schema.String,
    foreground: Schema.String,
    popover: Schema.String,
    popoverForeground: Schema.String,
    primary: Schema.String,
    primaryForeground: Schema.String,
    muted: Schema.String,
    mutedForeground: Schema.String,
    accent: Schema.String,
    accentForeground: Schema.String,
    border: Schema.String,
    input: Schema.String,
    ring: Schema.String,
    fontSans: Schema.String,
    fontMono: Schema.String,
  });

export interface DesktopPreviewRecordingFrame {
  tabId: string;
  data: string;
  width: number;
  height: number;
  receivedAt: string;
}

export const DesktopPreviewRecordingFrameSchema: Schema.Codec<DesktopPreviewRecordingFrame> =
  Schema.Struct({
    tabId: DesktopPreviewTabIdSchema,
    data: Schema.String,
    width: Schema.Number,
    height: Schema.Number,
    receivedAt: Schema.String,
  });

export interface DesktopPreviewRecordingArtifact {
  id: string;
  tabId: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export const DesktopPreviewRecordingArtifactSchema: Schema.Codec<DesktopPreviewRecordingArtifact> =
  Schema.Struct({
    id: Schema.String,
    tabId: DesktopPreviewTabIdSchema,
    path: Schema.String,
    mimeType: Schema.String,
    sizeBytes: Schema.Int,
    createdAt: Schema.String,
  });

export interface DesktopPreviewScreenshotArtifact {
  id: string;
  tabId: string;
  path: string;
  mimeType: "image/png";
  sizeBytes: number;
  createdAt: string;
}

export const DesktopPreviewScreenshotArtifactSchema: Schema.Codec<DesktopPreviewScreenshotArtifact> =
  Schema.Struct({
    id: Schema.String,
    tabId: DesktopPreviewTabIdSchema,
    path: Schema.String,
    mimeType: Schema.Literal("image/png"),
    sizeBytes: Schema.Int,
    createdAt: Schema.String,
  });

/**
 * Single stack frame captured by react-grab's `getElementContext`. We surface
 * the source file/line so coding agents can jump straight to the JSX that
 * produced the picked DOM node.
 */
export interface PickedElementStackFrame {
  functionName: string | null;
  fileName: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
}

export const PickedElementStackFrameSchema: Schema.Codec<PickedElementStackFrame> = Schema.Struct({
  functionName: Schema.NullOr(Schema.String),
  fileName: Schema.NullOr(Schema.String),
  lineNumber: Schema.NullOr(Schema.Number),
  columnNumber: Schema.NullOr(Schema.Number),
});

/**
 * A successful element pick from the preview webview. All fields are
 * best-effort — pages that don't ship a React fiber tree (or aren't running
 * in dev) will still produce a usable payload (selector + html preview),
 * just without component / source attribution.
 */
export interface PickedElementPayload {
  /** URL of the page the element was picked on. */
  pageUrl: string;
  /** Optional `<title>` of that page (best-effort). */
  pageTitle: string | null;
  /** Lowercase tag name, e.g. `"button"`. */
  tagName: string;
  /** CSS selector resolving back to the element on a re-render. */
  selector: string | null;
  /** Truncated outer-HTML preview (matches react-grab's `htmlPreview`). */
  htmlPreview: string;
  /** Nearest React component display name, or null when unavailable. */
  componentName: string | null;
  /** First source-mapped stack frame (file + line of the JSX source). */
  source: PickedElementStackFrame | null;
  /** Full owner-stack frames; can be empty. Useful for richer context. */
  stack: ReadonlyArray<PickedElementStackFrame>;
  /** Author CSS only (UA defaults stripped) — react-grab's `styles`. */
  styles: string;
  /** Wall-clock pick time as ISO-8601 string. */
  pickedAt: string;
}

export const PickedElementPayloadSchema: Schema.Codec<PickedElementPayload> = Schema.Struct({
  pageUrl: Schema.String,
  pageTitle: Schema.NullOr(Schema.String),
  tagName: Schema.String,
  selector: Schema.NullOr(Schema.String),
  htmlPreview: Schema.String,
  componentName: Schema.NullOr(Schema.String),
  source: Schema.NullOr(PickedElementStackFrameSchema),
  stack: Schema.Array(PickedElementStackFrameSchema),
  styles: Schema.String,
  pickedAt: Schema.String,
});

export interface PreviewAnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const PreviewAnnotationRectSchema: Schema.Codec<PreviewAnnotationRect> = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});

export interface PreviewAnnotationPoint {
  x: number;
  y: number;
}

export const PreviewAnnotationPointSchema: Schema.Codec<PreviewAnnotationPoint> = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});

export interface PreviewAnnotationElementTarget {
  id: string;
  element: PickedElementPayload;
  rect: PreviewAnnotationRect;
}

export const PreviewAnnotationElementTargetSchema: Schema.Codec<PreviewAnnotationElementTarget> =
  Schema.Struct({
    id: Schema.String,
    element: PickedElementPayloadSchema,
    rect: PreviewAnnotationRectSchema,
  });

export interface PreviewAnnotationRegionTarget {
  id: string;
  rect: PreviewAnnotationRect;
}

export const PreviewAnnotationRegionTargetSchema: Schema.Codec<PreviewAnnotationRegionTarget> =
  Schema.Struct({
    id: Schema.String,
    rect: PreviewAnnotationRectSchema,
  });

export interface PreviewAnnotationStrokeTarget {
  id: string;
  color: string;
  width: number;
  points: ReadonlyArray<PreviewAnnotationPoint>;
  bounds: PreviewAnnotationRect;
}

export const PreviewAnnotationStrokeTargetSchema: Schema.Codec<PreviewAnnotationStrokeTarget> =
  Schema.Struct({
    id: Schema.String,
    color: Schema.String,
    width: Schema.Number,
    points: Schema.Array(PreviewAnnotationPointSchema),
    bounds: PreviewAnnotationRectSchema,
  });

export interface PreviewAnnotationStyleChange {
  targetId: string;
  selector: string | null;
  property: string;
  previousValue: string;
  value: string;
}

export const PreviewAnnotationStyleChangeSchema: Schema.Codec<PreviewAnnotationStyleChange> =
  Schema.Struct({
    targetId: Schema.String,
    selector: Schema.NullOr(Schema.String),
    property: Schema.String,
    previousValue: Schema.String,
    value: Schema.String,
  });

export interface PreviewAnnotationScreenshot {
  dataUrl: string;
  width: number;
  height: number;
  cropRect: PreviewAnnotationRect;
}

export const PreviewAnnotationScreenshotSchema: Schema.Codec<PreviewAnnotationScreenshot> =
  Schema.Struct({
    dataUrl: Schema.String,
    width: Schema.Number,
    height: Schema.Number,
    cropRect: PreviewAnnotationRectSchema,
  });

/**
 * A submitted preview annotation. One annotation may reference multiple DOM
 * elements, freeform regions, and ink strokes. The desktop main process adds
 * the screenshot after the guest preload submits the structured draft.
 */
export interface PreviewAnnotationPayload {
  id: string;
  pageUrl: string;
  pageTitle: string | null;
  comment: string;
  elements: ReadonlyArray<PreviewAnnotationElementTarget>;
  regions: ReadonlyArray<PreviewAnnotationRegionTarget>;
  strokes: ReadonlyArray<PreviewAnnotationStrokeTarget>;
  styleChanges: ReadonlyArray<PreviewAnnotationStyleChange>;
  screenshot: PreviewAnnotationScreenshot | null;
  createdAt: string;
}

export const PreviewAnnotationPayloadSchema: Schema.Codec<PreviewAnnotationPayload> = Schema.Struct(
  {
    id: Schema.String,
    pageUrl: Schema.String,
    pageTitle: Schema.NullOr(Schema.String),
    comment: Schema.String,
    elements: Schema.Array(PreviewAnnotationElementTargetSchema),
    regions: Schema.Array(PreviewAnnotationRegionTargetSchema),
    strokes: Schema.Array(PreviewAnnotationStrokeTargetSchema),
    styleChanges: Schema.Array(PreviewAnnotationStyleChangeSchema),
    screenshot: Schema.NullOr(PreviewAnnotationScreenshotSchema),
    createdAt: Schema.String,
  },
);

export const DesktopPreviewTabInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
});

export const DesktopPreviewRegisterWebviewInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  webContentsId: Schema.Int.check(Schema.isGreaterThan(0)),
});

export const DesktopPreviewUiActivityInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  leaseId: Schema.String.check(Schema.isTrimmed())
    .check(Schema.isNonEmpty())
    .check(Schema.isMaxLength(200)),
  active: Schema.Boolean,
});

export const DesktopPreviewNavigateInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  url: Schema.String,
});

export const DesktopPreviewConfigInputSchema = Schema.Struct({
  environmentId: EnvironmentId,
  /**
   * Thread hosting the webview. When present, the browser partition is scoped
   * to this thread so each conversation (and therefore each agent, which owns
   * exactly one thread) keeps its own cookies, logins, and cache.
   */
  threadId: Schema.optional(ThreadId),
  /** Optional profile owner for agent-created threads that intentionally
      inherit another thread's cookies, storage, and cache. */
  browserProfileThreadId: Schema.optional(ThreadId),
});

/**
 * Where downloads from this thread's browser tabs should be written.
 *
 * The renderer supplies it because only it knows which workspace a thread is
 * working in; the desktop side sees an opaque partition scope and nothing else.
 */
export const DesktopPreviewSetDownloadDirectoryInputSchema = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: Schema.optional(ThreadId),
  browserProfileThreadId: Schema.optional(ThreadId),
  directory: Schema.String,
});

export const DesktopPreviewSetColorSchemeInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  colorScheme: DesktopPreviewColorSchemeSchema,
});

export const DesktopPreviewAnnotationThemeInputSchema = Schema.Struct({
  theme: DesktopPreviewAnnotationThemeSchema,
});

export const DesktopPreviewArtifactInputSchema = Schema.Struct({
  path: Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty()),
});

export const DesktopPreviewRecordingSaveInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  mimeType: Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty()),
  data: Schema.Uint8Array,
});

const DesktopPreviewAutomationExpiryFields = {
  /** Absolute renderer deadline. Main-process input work is cancelled after it. */
  expiresAt: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
};

export const DesktopPreviewAutomationClickInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  input: PreviewAutomationClickInput,
  ...DesktopPreviewAutomationExpiryFields,
});

export const DesktopPreviewAutomationTypeInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  input: PreviewAutomationTypeInput,
  ...DesktopPreviewAutomationExpiryFields,
});

export const DesktopPreviewAutomationUploadInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  input: PreviewAutomationUploadInput,
});

export const DesktopPreviewAutomationSelectOptionInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  input: PreviewAutomationSelectOptionInput,
});

export const DesktopPreviewAutomationPressInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  input: PreviewAutomationPressInput,
  ...DesktopPreviewAutomationExpiryFields,
});

export const DesktopPreviewAutomationScrollInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  input: PreviewAutomationScrollInput,
});

export const DesktopPreviewAutomationEvaluateInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  input: PreviewAutomationEvaluateInput,
});

export const DesktopPreviewAutomationWaitForInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  input: PreviewAutomationWaitForInput,
});

export const DesktopPreviewAutomationWaitForDownloadInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  input: PreviewAutomationWaitForDownloadInput,
});

export const DesktopRemoteControlCaptureInputSchema = Schema.Struct({
  maxWidth: Schema.Int.check(Schema.isBetween({ minimum: 640, maximum: 1_920 })),
  jpegQuality: Schema.Int.check(Schema.isBetween({ minimum: 20, maximum: 90 })),
  // Platform display id to capture. Falls back to the primary display when
  // absent or when the requested monitor has been disconnected.
  displayId: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
});
export type DesktopRemoteControlCaptureInput = typeof DesktopRemoteControlCaptureInputSchema.Type;

export const DesktopRemoteControlDisplaySchema = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(128)),
  label: Schema.String.check(Schema.isNonEmpty()),
  width: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  height: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  isPrimary: Schema.Boolean,
});
export type DesktopRemoteControlDisplay = typeof DesktopRemoteControlDisplaySchema.Type;

export const DesktopRemoteControlCaptureSourceSchema = Schema.Struct({
  displayId: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(128)),
  // Chromium desktop-capture source id, fed to getUserMedia as
  // `chromeMediaSourceId` to open a live MediaStream for that monitor.
  sourceId: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(256)),
});
export type DesktopRemoteControlCaptureSource = typeof DesktopRemoteControlCaptureSourceSchema.Type;

export const DesktopRemoteControlCaptureSourcesSchema = Schema.Struct({
  displays: Schema.Array(DesktopRemoteControlDisplaySchema),
  sources: Schema.Array(DesktopRemoteControlCaptureSourceSchema),
});
export type DesktopRemoteControlCaptureSources =
  typeof DesktopRemoteControlCaptureSourcesSchema.Type;

export const DesktopRemoteControlFrameSchema = Schema.Struct({
  capturedAt: Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty()),
  mimeType: Schema.Literal("image/jpeg"),
  width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3_840 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_160 })),
  data: Schema.String.check(Schema.isNonEmpty()),
  displayId: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(128)),
  displays: Schema.Array(DesktopRemoteControlDisplaySchema),
});
export type DesktopRemoteControlFrame = typeof DesktopRemoteControlFrameSchema.Type;

export const DesktopRemoteControlInputSchema = Schema.Struct({
  input: RemoteControlInput,
  // Capture source id the normalized coordinates are relative to. Without it a
  // pointer aimed at a secondary monitor is applied to the primary one, because
  // absolute mouse coordinates are per-desktop, not per-display.
  displayId: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
});
export type DesktopRemoteControlInput = typeof DesktopRemoteControlInputSchema.Type;

/**
 * Outcome of one injected event.
 *
 * `blocked` is a normal, self-clearing host condition — a UAC prompt, the lock
 * screen, an elevated foreground window, or macOS secure event input — during
 * which the operating system will not deliver synthetic input to anyone. It is
 * reported as a value rather than an error precisely so callers stop treating
 * it as a session failure.
 */
export const DesktopRemoteControlInputResultSchema = Schema.Struct({
  delivered: Schema.Boolean,
  blocked: Schema.optional(RemoteControlHostStatusReason),
});
export type DesktopRemoteControlInputResult = typeof DesktopRemoteControlInputResultSchema.Type;

export const DesktopRemoteControlHostStateSchema = Schema.Struct({
  locked: Schema.Boolean,
  blocked: Schema.optional(RemoteControlHostStatusReason),
  // Host OS cursor shape as a CSS cursor keyword; absent when unknown.
  cursor: Schema.optional(RemoteControlCursorShape),
});
export type DesktopRemoteControlHostState = typeof DesktopRemoteControlHostStateSchema.Type;

/**
 * Clipboard representations for moving a composer draft between desktop tabs.
 * Electron writes these together so macOS and Windows retain both the bitmap
 * and the HTML transfer marker instead of choosing only one representation.
 */
export const DesktopComposerClipboardInputSchema = Schema.Struct({
  text: Schema.String,
  html: Schema.String,
  imagePng: Schema.Uint8Array,
});
export type DesktopComposerClipboardInput = typeof DesktopComposerClipboardInputSchema.Type;

/**
 * Mono signed 16-bit PCM captured by the renderer for macOS SpeechAnalyzer.
 * Keeping this as PCM avoids sending a lossy WebM recording through a second
 * codec before Apple's native speech model sees it.
 */
export const DesktopVoiceTranscriptionInputSchema = Schema.Struct({
  pcm16: Schema.Uint8Array,
  sampleRate: Schema.Int.check(Schema.isBetween({ minimum: 8_000, maximum: 48_000 })),
  locale: Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty()),
  contextualStrings: Schema.Array(
    Schema.String.check(Schema.isTrimmed())
      .check(Schema.isNonEmpty())
      .check(Schema.isMaxLength(80)),
  ).check(Schema.isMaxLength(100)),
});
export type DesktopVoiceTranscriptionInput = typeof DesktopVoiceTranscriptionInputSchema.Type;

export const DesktopVoiceTranscriptionResultSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("success"),
    text: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.String,
  }),
]);
export type DesktopVoiceTranscriptionResult = typeof DesktopVoiceTranscriptionResultSchema.Type;

export interface DesktopBridge {
  getAppBranding: () => DesktopAppBranding | null;
  // One bootstrap per pool instance currently registered with bootstrap
  // info (omits instances whose backend hasn't produced a config yet).
  // The primary backend is identified by id === PRIMARY_LOCAL_ENVIRONMENT_ID.
  getLocalEnvironmentBootstraps: () => readonly DesktopEnvironmentBootstrap[];
  getLocalEnvironmentBearerToken: () => Promise<string>;
  getClientSettings: () => Promise<ClientSettings | null>;
  setClientSettings: (settings: ClientSettings) => Promise<void>;
  getConnectionCatalog?: () => Promise<string | null>;
  setConnectionCatalog?: (catalog: string) => Promise<boolean>;
  clearConnectionCatalog?: () => Promise<void>;
  discoverSshHosts: () => Promise<readonly DesktopDiscoveredSshHost[]>;
  ensureSshEnvironment: (
    target: DesktopSshEnvironmentTarget,
    options?: { issuePairingToken?: boolean },
  ) => Promise<DesktopSshEnvironmentBootstrap>;
  disconnectSshEnvironment: (target: DesktopSshEnvironmentTarget) => Promise<void>;
  fetchSshEnvironmentDescriptor: (httpBaseUrl: string) => Promise<ExecutionEnvironmentDescriptor>;
  bootstrapSshBearerSession: (
    httpBaseUrl: string,
    credential: string,
  ) => Promise<AuthAccessTokenResult>;
  fetchSshSessionState: (httpBaseUrl: string, bearerToken: string) => Promise<AuthSessionState>;
  issueSshWebSocketTicket: (
    httpBaseUrl: string,
    bearerToken: string,
  ) => Promise<AuthWebSocketTicketResult>;
  onSshPasswordPrompt: (listener: (request: DesktopSshPasswordPromptRequest) => void) => () => void;
  resolveSshPasswordPrompt: (requestId: string, password: string | null) => Promise<void>;
  getServerExposureState: () => Promise<DesktopServerExposureState>;
  setServerExposureMode: (mode: DesktopServerExposureMode) => Promise<DesktopServerExposureState>;
  setTailscaleServeEnabled: (input: {
    readonly enabled: boolean;
    readonly port?: number;
  }) => Promise<DesktopServerExposureState>;
  reconcileTailscaleServe: () => Promise<DesktopServerExposureState>;
  getAdvertisedEndpoints: () => Promise<readonly AdvertisedEndpoint[]>;
  listLanPeers: () => Promise<readonly DesktopLanPeer[]>;
  getLanDiscoveryState: () => Promise<DesktopLanDiscoveryState>;
  requestLanPairing: (
    input: DesktopLanPairingRequestInput,
  ) => Promise<DesktopLanPairingRequestResult>;
  completeLanPairing: (input: DesktopLanPairingCompletionInput) => Promise<void>;
  onLanPairingEvent: (listener: (event: DesktopLanPairingApprovedEvent) => void) => () => void;
  getWslState: () => Promise<DesktopWslState>;
  setWslBackendEnabled: (enabled: boolean) => Promise<DesktopWslState>;
  setWslDistro: (distro: string | null) => Promise<DesktopWslState>;
  setWslOnly: (enabled: boolean) => Promise<DesktopWslState>;
  pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  openExternal: (url: string) => Promise<boolean>;
  saveThreadExportJson: (input: {
    readonly filename: string;
    readonly contents: string;
  }) => Promise<string>;
  /** Returns false when the path is missing or is not absolute on this desktop host. */
  revealFile: (path: string) => Promise<boolean>;
  writeComposerClipboard: (input: DesktopComposerClipboardInput) => Promise<boolean>;
  setVoiceCaptureSystemAudioMuted: (input: {
    readonly owner: "dictation" | "orchestrator";
    readonly muted: boolean;
  }) => Promise<boolean>;
  /**
   * macOS 26+ on-device dictation. Optional so web, mobile, non-Mac desktop,
   * and an older installed preload transparently retain local Whisper.
   */
  transcribeVoice?: (
    input: DesktopVoiceTranscriptionInput,
  ) => Promise<DesktopVoiceTranscriptionResult>;
  captureRemoteControlFrame: (
    input: DesktopRemoteControlCaptureInput,
  ) => Promise<DesktopRemoteControlFrame>;
  listRemoteControlCaptureSources: () => Promise<DesktopRemoteControlCaptureSources>;
  activateRemoteControlHost: () => Promise<void>;
  sendRemoteControlInput: (
    payload: DesktopRemoteControlInput,
  ) => Promise<DesktopRemoteControlInputResult>;
  resetRemoteControlInput: () => Promise<void>;
  /**
   * Whether an app on the host has captured the cursor. Mirrored into browser
   * pointer lock on the controller so mouse-look works and the two cursors do
   * not diverge.
   */
  readRemoteControlPointerLock: () => Promise<DesktopRemoteControlHostState>;
  startFileDrag: (path: string) => Promise<boolean>;
  /**
   * Absolute filesystem path for a File from a desktop drag-drop.
   * Empty string when Electron cannot map the File (web-only drops).
   */
  getPathForFile?: (file: File) => string;
  onMenuAction: (listener: (action: string) => void) => () => void;
  getWindowFullscreenState: () => boolean;
  onWindowFullscreenStateChange: (listener: (fullscreen: boolean) => void) => () => void;
  onIntentionalShutdown: (listener: () => void) => () => void;
  /** macOS permission status and first-run setup. Undefined in older preloads. */
  permissions?: DesktopPermissionsBridge;
  /**
   * Desktop-only preview surface. Present iff the renderer is hosted by the
   * Electron desktop build; web builds have `preview === undefined`.
   */
  preview?: DesktopPreviewBridge;
  /**
   * Desktop-only floating voice orb. `undefined` in web builds and under old
   * preloads, so every caller feature-detects.
   */
  orchestratorBubble?: DesktopOrchestratorBubbleBridge;
}

/**
 * Mirror of the voice session the floating bubble renders. Published by the
 * main window's renderer (the only place the WebRTC session lives), relayed by
 * the main process to the bubble window.
 */
export interface DesktopOrchestratorBubbleState {
  /**
   * `working` is not a voice-session state — it is the orb's own reading of
   * "the assistant has the floor but is not making a sound", i.e. a tool call
   * between sentences. Without it the orb showed a live microphone through
   * that entire window, which says "talk now" at the one moment the session
   * cannot hear you.
   */
  readonly status: "idle" | "connecting" | "listening" | "speaking" | "working" | "error";
  /** Instantaneous microphone level, 0..1. */
  readonly micLevel: number;
  /** Instantaneous orchestrator playback level, 0..1. */
  readonly assistantLevel: number;
}

/**
 * The always-on-top voice orb. Present iff the renderer is hosted by the
 * Electron desktop build. The same bridge serves both windows: the main window
 * publishes state and toggles visibility, the bubble window subscribes, drags
 * itself, and asks for the orchestrator thread to be opened.
 */
export interface DesktopOrchestratorBubbleBridge {
  /** Create or destroy the bubble window. Idempotent. */
  setVisible: (visible: boolean) => Promise<void>;
  /** Push the live voice-session state; the main process relays and latches it. */
  publishState: (state: DesktopOrchestratorBubbleState) => Promise<void>;
  /** Fires with the latched state immediately, then on every publish. */
  onState: (listener: (state: DesktopOrchestratorBubbleState) => void) => () => void;
  /** Move the bubble window (absolute screen coordinates, top-left origin). */
  move: (position: { readonly x: number; readonly y: number }) => Promise<void>;
  /**
   * Latch the OS-cursor grab offset before move events. Optional on older
   * preloads; without it Windows DPI can freeze the orb in place.
   */
  beginDrag?: () => Promise<void>;
  /** Persist the bubble's resting position after a drag. */
  dragEnd: () => Promise<void>;
  /** Reveal the main window and navigate it to the orchestrator thread. */
  open: () => Promise<void>;
  /**
   * Start or stop the voice session. Routed to the main window, which owns the
   * only WebRTC session — deliberately without revealing it, so tapping the orb
   * to talk never yanks the app in front of whatever the user is doing.
   */
  toggleVoice: () => Promise<void>;
  /** Main-window side of {@link toggleVoice}. */
  onVoiceToggleRequested: (listener: () => void) => () => void;
}

export interface DesktopPreviewBridge {
  createTab: (tabId: string) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
  registerWebview: (tabId: string, webContentsId: number) => Promise<void>;
  setUiActivity: (tabId: string, leaseId: string, active: boolean) => Promise<void>;
  navigate: (tabId: string, url: string) => Promise<void>;
  goBack: (tabId: string) => Promise<void>;
  goForward: (tabId: string) => Promise<void>;
  refresh: (tabId: string) => Promise<void>;
  zoomIn: (tabId: string) => Promise<void>;
  zoomOut: (tabId: string) => Promise<void>;
  resetZoom: (tabId: string) => Promise<void>;
  /** Reload bypassing the HTTP cache. */
  hardReload: (tabId: string) => Promise<void>;
  /**
   * Emulate `prefers-color-scheme` on the guest page ("system" clears the
   * override). Persists per tab and is re-applied across webview swaps.
   */
  setColorScheme: (tabId: string, colorScheme: DesktopPreviewColorScheme) => Promise<void>;
  /** Open the guest webview's DevTools (detached). */
  openDevTools: (tabId: string) => Promise<void>;
  /** Drop cookies + storage data for the preview partition (all tabs). */
  clearCookies: () => Promise<void>;
  /** Drop the HTTP cache for the preview partition (all tabs). */
  clearCache: () => Promise<void>;
  /**
   * One-shot config for mounting a preview `<webview>`. Replaces three
   * earlier round-trip calls (`getBrowserPartition`, `getWebviewPreferences`,
   * `getPickPreloadPath`) so adding a new field here only requires touching
   * the contract + main, not the renderer's mount logic.
   */
  getPreviewConfig: (
    environmentId: EnvironmentId,
    threadId?: ThreadId,
    browserProfileThreadId?: ThreadId,
  ) => Promise<DesktopPreviewWebviewConfig>;
  /**
   * Point this thread's downloads at its own workspace, so a file an agent
   * fetches lands where that agent is working instead of in the app's
   * artifacts folder.
   */
  setPreviewDownloadDirectory: (
    directory: string,
    environmentId: EnvironmentId,
    threadId?: ThreadId,
    browserProfileThreadId?: ThreadId,
  ) => Promise<void>;
  setAnnotationTheme: (theme: DesktopPreviewAnnotationTheme) => Promise<void>;
  /**
   * Activate the in-page element picker for the given tab. Resolves with
   * the picked payload, or `null` when the user cancels (Escape / nav). The
   * promise rejects if the picker can't be activated (no webview, etc.).
   */
  pickElement: (tabId: string) => Promise<PreviewAnnotationPayload | null>;
  /** Cancel an in-flight preview annotation session. */
  cancelPickElement: (tabId: string) => Promise<void>;
  captureScreenshot: (tabId: string) => Promise<DesktopPreviewScreenshotArtifact>;
  revealArtifact: (path: string) => Promise<void>;
  /** Show a finished download in Finder / File Explorer. */
  revealPreviewDownload: (path: string) => Promise<void>;
  /** Answer a held download: allow this site from now on, allow one file, or deny. */
  answerPreviewDownloadApproval: (
    id: string,
    decision: "allow-domain" | "allow-once" | "deny",
  ) => Promise<void>;
  copyArtifactToClipboard: (path: string) => Promise<void>;
  /** Fires when a guest link targets a new browser tab. */
  onNewTabRequested: (listener: (request: DesktopPreviewNewTabRequest) => void) => () => void;
  /** Reports Challenge Page headers and Cloudflare challenge-host reachability. */
  onHumanVerificationSignal: (
    listener: (signal: DesktopPreviewHumanVerificationSignal) => void,
  ) => () => void;
  pictureInPicture: {
    open: (tabId: string) => Promise<void>;
    close: (tabId: string) => Promise<void>;
  };
  recording: {
    startScreencast: (tabId: string) => Promise<void>;
    stopScreencast: (tabId: string) => Promise<void>;
    save: (
      tabId: string,
      mimeType: string,
      data: Uint8Array,
    ) => Promise<DesktopPreviewRecordingArtifact>;
    onFrame: (listener: (frame: DesktopPreviewRecordingFrame) => void) => () => void;
  };
  automation: {
    /** Keep every preview guest running as foreground while an agent is actively using it. */
    renewForeground: () => Promise<void>;
    status: (tabId: string) => Promise<DesktopPreviewAutomationStatus>;
    /** The picture alone, without the DOM and accessibility reads. */
    frame: (tabId: string) => Promise<PreviewAutomationFrame>;
    snapshot: (tabId: string) => Promise<PreviewAutomationSnapshot>;
    click: (tabId: string, input: PreviewAutomationClickInput, expiresAt?: number) => Promise<void>;
    type: (tabId: string, input: PreviewAutomationTypeInput, expiresAt?: number) => Promise<void>;
    upload: (
      tabId: string,
      input: PreviewAutomationUploadInput,
    ) => Promise<PreviewAutomationUploadResult>;
    /** Chooses in a `<select>` without opening the menu Chromium draws outside the page. */
    selectOption: (
      tabId: string,
      input: PreviewAutomationSelectOptionInput,
    ) => Promise<PreviewAutomationSelectOptionResult>;
    press: (tabId: string, input: PreviewAutomationPressInput, expiresAt?: number) => Promise<void>;
    scroll: (tabId: string, input: PreviewAutomationScrollInput) => Promise<void>;
    evaluate: (tabId: string, input: PreviewAutomationEvaluateInput) => Promise<unknown>;
    waitFor: (tabId: string, input: PreviewAutomationWaitForInput) => Promise<void>;
    /** Resolves once a download this tab started finishes, or its hold is answered. */
    waitForDownload: (
      tabId: string,
      input: PreviewAutomationWaitForDownloadInput,
    ) => Promise<PreviewAutomationWaitForDownloadResult>;
  };
  onStateChange: (listener: (tabId: string, state: DesktopPreviewTabState) => void) => () => void;
  onPointerEvent: (listener: (event: DesktopPreviewPointerEvent) => void) => () => void;
}

/**
 * APIs bound to the local app shell, not to any particular backend environment.
 *
 * These capabilities describe the desktop/browser host that the user is
 * currently running: dialogs, external-link opening, context menus, and
 * app-level settings/config access. They must not be used as a proxy for
 * "whatever environment the user is targeting", because in a multi-environment
 * world the local shell and a selected backend environment are distinct
 * concepts.
 */
export interface LocalApi {
  dialogs: {
    pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
    confirm: (message: string) => Promise<boolean>;
  };
  shell: {
    openExternal: (url: string) => Promise<void>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
  persistence: {
    getClientSettings: () => Promise<ClientSettings | null>;
    setClientSettings: (settings: ClientSettings) => Promise<void>;
  };
}

/**
 * APIs bound to a specific backend environment connection.
 *
 * These operations must always be routed with explicit environment context.
 * They represent remote stateful capabilities such as orchestration, terminal,
 * project, VCS, and provider operations. In multi-environment mode, each environment gets
 * its own instance of this surface, and callers should resolve it by
 * `environmentId` rather than reaching through the local desktop bridge.
 */
export interface EnvironmentApi {
  terminal: {
    open: (input: typeof TerminalOpenInput.Encoded) => Promise<TerminalSessionSnapshot>;
    attach: (
      input: typeof TerminalAttachInput.Encoded,
      callback: (event: TerminalAttachStreamEvent) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
    list: (input?: typeof TerminalListInput.Encoded) => Promise<TerminalListResult>;
    read: (input: typeof TerminalReadInput.Encoded) => Promise<TerminalSessionSnapshot>;
    write: (input: typeof TerminalWriteInput.Encoded) => Promise<void>;
    resize: (input: typeof TerminalResizeInput.Encoded) => Promise<void>;
    clear: (input: typeof TerminalClearInput.Encoded) => Promise<void>;
    restart: (input: typeof TerminalRestartInput.Encoded) => Promise<TerminalSessionSnapshot>;
    close: (input: typeof TerminalCloseInput.Encoded) => Promise<void>;
    onMetadata: (
      callback: (event: TerminalMetadataStreamEvent) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
  };
  projects: {
    listEntries: (input: ProjectListEntriesInput) => Promise<ProjectListEntriesResult>;
    readFile: (input: ProjectReadFileInput) => Promise<ProjectReadFileResult>;
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
  };
  filesystem: {
    browse: (input: FilesystemBrowseInput) => Promise<FilesystemBrowseResult>;
  };
  assets: {
    createUrl: (input: AssetCreateUrlInput) => Promise<AssetCreateUrlResult>;
  };
  sourceControl: {
    lookupRepository: (
      input: SourceControlRepositoryLookupInput,
    ) => Promise<SourceControlRepositoryInfo>;
    cloneRepository: (
      input: SourceControlCloneRepositoryInput,
    ) => Promise<SourceControlCloneRepositoryResult>;
    publishRepository: (
      input: SourceControlPublishRepositoryInput,
    ) => Promise<SourceControlPublishRepositoryResult>;
  };
  vcs: {
    listRefs: (input: VcsListRefsInput) => Promise<VcsListRefsResult>;
    createWorktree: (input: VcsCreateWorktreeInput) => Promise<VcsCreateWorktreeResult>;
    removeWorktree: (input: VcsRemoveWorktreeInput) => Promise<void>;
    createRef: (input: VcsCreateRefInput) => Promise<VcsCreateRefResult>;
    switchRef: (input: VcsSwitchRefInput) => Promise<VcsSwitchRefResult>;
    init: (input: VcsInitInput) => Promise<void>;
    pull: (input: VcsPullInput) => Promise<VcsPullResult>;
    refreshStatus: (input: VcsStatusInput) => Promise<VcsStatusResult>;
    onStatus: (
      input: VcsStatusInput,
      callback: (status: VcsStatusResult) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
  };
  git: {
    resolvePullRequest: (input: GitPullRequestRefInput) => Promise<GitResolvePullRequestResult>;
    preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Promise<GitPreparePullRequestThreadResult>;
  };
  review: {
    getDiffPreview: (input: ReviewDiffPreviewInput) => Promise<ReviewDiffPreviewResult>;
  };
  orchestration: {
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    getTurnDiff: (input: OrchestrationGetTurnDiffInput) => Promise<OrchestrationGetTurnDiffResult>;
    getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    getArchivedShellSnapshot: () => Promise<OrchestrationShellSnapshot>;
    subscribeShell: (
      callback: (event: OrchestrationShellStreamItem) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
    subscribeThread: (
      input: OrchestrationSubscribeThreadInput,
      callback: (event: OrchestrationThreadStreamItem) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
  };
  preview: {
    open: (input: typeof PreviewOpenInput.Encoded) => Promise<PreviewSessionSnapshot>;
    navigate: (input: typeof PreviewNavigateInput.Encoded) => Promise<PreviewSessionSnapshot>;
    resize: (input: typeof PreviewResizeInput.Encoded) => Promise<PreviewSessionSnapshot>;
    refresh: (input: typeof PreviewRefreshInput.Encoded) => Promise<void>;
    close: (input: typeof PreviewCloseInput.Encoded) => Promise<PreviewCloseResult | undefined>;
    list: (input: typeof PreviewListInput.Encoded) => Promise<PreviewListResult>;
    reportStatus: (input: typeof PreviewReportStatusInput.Encoded) => Promise<void>;
    automation: {
      connect: (
        input: PreviewAutomationHost,
        callback: (event: PreviewAutomationStreamEvent) => void,
        options?: { onResubscribe?: () => void },
      ) => () => void;
      respond: (response: PreviewAutomationResponse) => Promise<void>;
      focusHost: (input: PreviewAutomationHostFocus) => Promise<void>;
    };
    onEvent: (
      callback: (event: PreviewEvent) => void,
      options?: { onResubscribe?: () => void },
    ) => () => void;
    subscribePorts: (
      callback: (servers: DiscoveredLocalServerList) => void,
      options?: { onResubscribe?: () => void },
    ) => () => void;
  };
}
