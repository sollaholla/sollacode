import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { ExternalLauncherError, LaunchEditorInput } from "./editor.ts";
import { ThreadId as ThreadIdSchema, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  AuthAccessStreamError,
  AuthAccessStreamEvent,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  BackgroundPolicySnapshot,
  ClientActivityReportInput,
  HostPowerSnapshot,
} from "./background.ts";
import {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemBrowseError,
} from "./filesystem.ts";
import { AssetAccessError, AssetCreateUrlInput, AssetCreateUrlResult } from "./assets.ts";
import {
  ThreadArtifactDeleteResult,
  ThreadArtifactDetail,
  ThreadArtifactError,
  ThreadArtifactGetInput,
  ThreadArtifactArchiveInput,
  ThreadArtifactListInput,
  ThreadArtifactListResult,
  ThreadArtifactStreamItem,
} from "./artifacts.ts";
import {
  GitActionProgressEvent,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  GitCommandError,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  VcsPullInput,
  GitPullRequestRefInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  TextGenerationError,
  VcsStatusInput,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "./git.ts";
import {
  ReviewDiffPreviewError,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
} from "./review.ts";
import { KeybindingsConfigError } from "./keybindings.ts";
import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSnapshotError,
  OrchestrationSearchThreadsError,
  OrchestrationSearchThreadsInput,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationRpcSchemas,
} from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ProjectListEntriesError,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadFileError,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchContentsError,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
  ProjectCheckWorkspaceRootError,
  ProjectCheckWorkspaceRootInput,
  ProjectCheckWorkspaceRootResult,
} from "./project.ts";
import {
  TerminalAttachInput,
  TerminalAttachStreamItem,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEventStreamItem,
  TerminalGetLayoutInput,
  TerminalGetLayoutResult,
  TerminalLayoutStreamItem,
  TerminalListInput,
  TerminalListResult,
  TerminalMetadataStreamItem,
  TerminalOpenInput,
  TerminalReadInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalSetLayoutInput,
  TerminalThreadLayout,
  TerminalWriteInput,
} from "./terminal.ts";
import {
  VmAgent,
  VmAgentNotificationPreferences,
  VmAgentBlockerRef,
  VmAgentBlockerResolveInput,
  VmAgentNotificationPreferencesInput,
  VmAgentNotificationRef,
  VmAgentCreateInput,
  VmAgentCollaborationError,
  VmAgentCollaborationReceipt,
  VmAgentCollaborationStreamItem,
  VmAgentDelegationDetail,
  VmAgentDelegationRef,
  VmAgentDelegationSendMessageInput,
  VmAgentError,
  VmAgentRef,
  VmAgentStreamItem,
  VmAgentTask,
  VmAgentTaskCreateInput,
  VmAgentTaskPromptGenerationInput,
  VmAgentTaskPromptGenerationResult,
  VmAgentTaskRef,
  VmAgentTaskUpdateInput,
  VmAgentWorkspaceError,
  VmAgentWorkspaceStreamItem,
} from "./vm.ts";
import {
  DiscoveredLocalServerList,
  PreviewCloseInput,
  PreviewError,
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
  PreviewAutomationError,
  PreviewAutomationHost,
  PreviewAutomationHostFocus,
  PreviewAutomationResponse,
  PreviewAutomationStreamEvent,
} from "./previewAutomation.ts";
import {
  RemoteControlCancelInput,
  RemoteControlControllerStreamEvent,
  RemoteControlError,
  RemoteControlHost,
  RemoteControlHostEndInput,
  RemoteControlHostReportStatusInput,
  RemoteControlHostPublishFrameInput,
  RemoteControlHostPublishVideoChunkInput,
  RemoteControlHostRespondInput,
  RemoteControlHostStreamEvent,
  RemoteControlRequestAccessInput,
  RemoteControlSendInputInput,
  RemoteControlSession,
  RemoteControlWatchInput,
} from "./remoteControl.ts";
import {
  ProviderAccountSwitchError,
  ProviderAccountSwitchState,
  ServerConfigStreamEvent,
  ServerConfig,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerLifecycleStreamEvent,
  ServerRemoveKeybindingInput,
  ServerRemoveKeybindingResult,
  ServerProviderUpdatedPayload,
  ServerSelfUpdateError,
  ServerSelfUpdateInput,
  ServerSelfUpdateResult,
  ServerTraceDiagnosticsResult,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import {
  ResourceTelemetryHistory,
  ResourceTelemetryHistoryInput,
  ResourceTelemetryRetryResult,
  ResourceTelemetrySnapshot,
} from "./resourceTelemetry.ts";
import { ServerSettings, ServerSettingsError, ServerSettingsPatch } from "./settings.ts";
import {
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlDiscoveryResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryError,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
} from "./sourceControl.ts";
import { VcsError } from "./vcs.ts";

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsCheckWorkspaceRoot: "projects.checkWorkspaceRoot",
  projectsListEntries: "projects.listEntries",
  projectsReadFile: "projects.readFile",
  projectsSearchContents: "projects.searchContents",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",
  assetsCreateUrl: "assets.createUrl",
  threadArtifactsList: "threadArtifacts.list",
  threadArtifactsGet: "threadArtifacts.get",
  threadArtifactsArchive: "threadArtifacts.archive",
  threadArtifactsRestore: "threadArtifacts.restore",
  threadArtifactsDelete: "threadArtifacts.delete",
  threadArtifactsSubscribe: "threadArtifacts.subscribe",

  // VCS methods
  vcsPull: "vcs.pull",
  vcsRefreshStatus: "vcs.refreshStatus",
  vcsListRefs: "vcs.listRefs",
  vcsCreateWorktree: "vcs.createWorktree",
  vcsRemoveWorktree: "vcs.removeWorktree",
  vcsCreateRef: "vcs.createRef",
  vcsSwitchRef: "vcs.switchRef",
  vcsInit: "vcs.init",

  // Git workflow methods
  gitRunStackedAction: "git.runStackedAction",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  // Review methods
  reviewGetDiffPreview: "review.getDiffPreview",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalAttach: "terminal.attach",
  terminalList: "terminal.list",
  terminalRead: "terminal.read",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",
  terminalGetLayout: "terminal.getLayout",
  terminalSetLayout: "terminal.setLayout",

  // Preview methods
  previewOpen: "preview.open",
  previewNavigate: "preview.navigate",
  previewResize: "preview.resize",
  previewRefresh: "preview.refresh",
  previewClose: "preview.close",
  previewList: "preview.list",
  previewReportStatus: "preview.reportStatus",
  previewAutomationConnect: "previewAutomation.connect",
  previewAutomationRespond: "previewAutomation.respond",
  previewAutomationFocusHost: "previewAutomation.focusHost",
  remoteControlHostConnect: "remoteControl.hostConnect",
  remoteControlHostRespond: "remoteControl.hostRespond",
  remoteControlHostPublishFrame: "remoteControl.hostPublishFrame",
  remoteControlHostPublishVideoChunk: "remoteControl.hostPublishVideoChunk",
  remoteControlHostEnd: "remoteControl.hostEnd",
  remoteControlHostReportStatus: "remoteControl.hostReportStatus",
  remoteControlRequestAccess: "remoteControl.requestAccess",
  remoteControlWatch: "remoteControl.watch",
  remoteControlSendInput: "remoteControl.sendInput",
  remoteControlCancel: "remoteControl.cancel",

  // Agent Stack (named VM agents)
  vmAgentCreate: "vmAgent.create",
  vmAgentBuilderOpen: "vmAgent.builder.open",
  vmAgentDelete: "vmAgent.delete",
  vmAgentSubscribe: "vmAgent.subscribe",
  vmAgentWorkspaceSubscribe: "vmAgent.workspace.subscribe",
  vmAgentTaskCreate: "vmAgent.task.create",
  vmAgentTaskUpdate: "vmAgent.task.update",
  vmAgentTaskDelete: "vmAgent.task.delete",
  vmAgentTaskRunNow: "vmAgent.task.runNow",
  vmAgentTaskGeneratePrompt: "vmAgent.task.generatePrompt",
  vmAgentNotificationMarkRead: "vmAgent.notification.markRead",
  vmAgentBlockerResolve: "vmAgent.blocker.resolve",
  vmAgentNotificationPreferencesUpdate: "vmAgent.notification.preferences.update",
  vmAgentCollaborationSubscribe: "vmAgent.collaboration.subscribe",
  vmAgentCollaborationGet: "vmAgent.collaboration.get",
  vmAgentCollaborationSendMessage: "vmAgent.collaboration.sendMessage",
  vmAgentCollaborationCancel: "vmAgent.collaboration.cancel",

  // Server meta
  serverProbe: "server.probe",
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverStartProviderAccountSwitch: "server.startProviderAccountSwitch",
  serverGetProviderAccountSwitch: "server.getProviderAccountSwitch",
  serverOpenProviderAccountSwitchAuthLink: "server.openProviderAccountSwitchAuthLink",
  serverSubmitProviderAccountSwitchCode: "server.submitProviderAccountSwitchCode",
  serverCancelProviderAccountSwitch: "server.cancelProviderAccountSwitch",
  serverUpdateProvider: "server.updateProvider",
  serverUpdateServer: "server.updateServer",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverRemoveKeybinding: "server.removeKeybinding",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverDiscoverSourceControl: "server.discoverSourceControl",
  serverGetTraceDiagnostics: "server.getTraceDiagnostics",
  serverGetProcessDiagnostics: "server.getProcessDiagnostics",
  serverGetProcessResourceHistory: "server.getProcessResourceHistory",
  serverGetResourceTelemetryHistory: "server.getResourceTelemetryHistory",
  serverRetryResourceTelemetry: "server.retryResourceTelemetry",
  serverSignalProcess: "server.signalProcess",
  serverReportClientActivity: "server.reportClientActivity",
  serverReportHostPowerState: "server.reportHostPowerState",
  serverGetBackgroundPolicy: "server.getBackgroundPolicy",

  // Source control methods
  sourceControlLookupRepository: "sourceControl.lookupRepository",
  sourceControlCloneRepository: "sourceControl.cloneRepository",
  sourceControlPublishRepository: "sourceControl.publishRepository",

  // Streaming subscriptions
  subscribeVcsStatus: "subscribeVcsStatus",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeTerminalMetadata: "subscribeTerminalMetadata",
  subscribeTerminalLayouts: "subscribeTerminalLayouts",
  subscribePreviewEvents: "subscribePreviewEvents",
  subscribeDiscoveredLocalServers: "subscribeDiscoveredLocalServers",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",
  subscribeBackgroundPolicy: "subscribeBackgroundPolicy",
  subscribeResourceTelemetry: "subscribeResourceTelemetry",
} as const;

export const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

export const WsServerRemoveKeybindingRpc = Rpc.make(WS_METHODS.serverRemoveKeybinding, {
  payload: ServerRemoveKeybindingInput,
  success: ServerRemoveKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

export const WsServerProbeRpc = Rpc.make(WS_METHODS.serverProbe, {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
  error: EnvironmentAuthorizationError,
});

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({
    /**
     * When supplied, only refresh this specific provider instance. When
     * omitted, refresh all configured instances — the legacy `refresh()`
     * behaviour retained for transports that still dispatch untargeted
     * refreshes.
     */
    instanceId: Schema.optional(ProviderInstanceId),
  }),
  success: ServerProviderUpdatedPayload,
  error: EnvironmentAuthorizationError,
});

export const WsServerStartProviderAccountSwitchRpc = Rpc.make(
  WS_METHODS.serverStartProviderAccountSwitch,
  {
    payload: Schema.Struct({ instanceId: ProviderInstanceId }),
    success: ProviderAccountSwitchState,
    error: Schema.Union([ProviderAccountSwitchError, EnvironmentAuthorizationError]),
  },
);

export const WsServerGetProviderAccountSwitchRpc = Rpc.make(
  WS_METHODS.serverGetProviderAccountSwitch,
  {
    payload: Schema.Struct({
      instanceId: ProviderInstanceId,
      switchId: Schema.optionalKey(Schema.String),
    }),
    success: Schema.NullOr(ProviderAccountSwitchState),
    error: EnvironmentAuthorizationError,
  },
);

export const WsServerOpenProviderAccountSwitchAuthLinkRpc = Rpc.make(
  WS_METHODS.serverOpenProviderAccountSwitchAuthLink,
  {
    payload: Schema.Struct({
      instanceId: ProviderInstanceId,
      switchId: Schema.String,
    }),
    success: ProviderAccountSwitchState,
    error: Schema.Union([ProviderAccountSwitchError, EnvironmentAuthorizationError]),
  },
);

export const WsServerSubmitProviderAccountSwitchCodeRpc = Rpc.make(
  WS_METHODS.serverSubmitProviderAccountSwitchCode,
  {
    payload: Schema.Struct({
      instanceId: ProviderInstanceId,
      switchId: Schema.String,
      code: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
    }),
    success: ProviderAccountSwitchState,
    error: Schema.Union([ProviderAccountSwitchError, EnvironmentAuthorizationError]),
  },
);

export const WsServerCancelProviderAccountSwitchRpc = Rpc.make(
  WS_METHODS.serverCancelProviderAccountSwitch,
  {
    payload: Schema.Struct({
      instanceId: ProviderInstanceId,
      switchId: Schema.String,
    }),
    success: ProviderAccountSwitchState,
    error: Schema.Union([ProviderAccountSwitchError, EnvironmentAuthorizationError]),
  },
);

export const WsServerUpdateProviderRpc = Rpc.make(WS_METHODS.serverUpdateProvider, {
  payload: ServerProviderUpdateInput,
  success: ServerProviderUpdatedPayload,
  error: Schema.Union([ServerProviderUpdateError, EnvironmentAuthorizationError]),
});

export const WsServerUpdateServerRpc = Rpc.make(WS_METHODS.serverUpdateServer, {
  payload: ServerSelfUpdateInput,
  success: ServerSelfUpdateResult,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
});

export const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({ patch: ServerSettingsPatch }),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerDiscoverSourceControlRpc = Rpc.make(WS_METHODS.serverDiscoverSourceControl, {
  payload: Schema.Struct({}),
  success: SourceControlDiscoveryResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetTraceDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetTraceDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerTraceDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetProcessDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetProcessDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerProcessDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetProcessResourceHistoryRpc = Rpc.make(
  WS_METHODS.serverGetProcessResourceHistory,
  {
    payload: ServerProcessResourceHistoryInput,
    success: ServerProcessResourceHistoryResult,
    error: EnvironmentAuthorizationError,
  },
);

export const WsServerGetResourceTelemetryHistoryRpc = Rpc.make(
  WS_METHODS.serverGetResourceTelemetryHistory,
  {
    payload: ResourceTelemetryHistoryInput,
    success: ResourceTelemetryHistory,
    error: EnvironmentAuthorizationError,
  },
);

export const WsServerRetryResourceTelemetryRpc = Rpc.make(WS_METHODS.serverRetryResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetryRetryResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerSignalProcessRpc = Rpc.make(WS_METHODS.serverSignalProcess, {
  payload: ServerSignalProcessInput,
  success: ServerSignalProcessResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerReportClientActivityRpc = Rpc.make(WS_METHODS.serverReportClientActivity, {
  payload: ClientActivityReportInput,
  error: EnvironmentAuthorizationError,
});

export const WsServerReportHostPowerStateRpc = Rpc.make(WS_METHODS.serverReportHostPowerState, {
  payload: HostPowerSnapshot,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetBackgroundPolicyRpc = Rpc.make(WS_METHODS.serverGetBackgroundPolicy, {
  payload: Schema.Struct({}),
  success: BackgroundPolicySnapshot,
  error: EnvironmentAuthorizationError,
});

export const WsSourceControlLookupRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlLookupRepository,
  {
    payload: SourceControlRepositoryLookupInput,
    success: SourceControlRepositoryInfo,
    error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
  },
);

export const WsSourceControlCloneRepositoryRpc = Rpc.make(WS_METHODS.sourceControlCloneRepository, {
  payload: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

export const WsSourceControlPublishRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlPublishRepository,
  {
    payload: SourceControlPublishRepositoryInput,
    success: SourceControlPublishRepositoryResult,
    error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
  },
);

export const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: Schema.Union([ProjectSearchEntriesError, EnvironmentAuthorizationError]),
});

export const WsProjectsSearchContentsRpc = Rpc.make(WS_METHODS.projectsSearchContents, {
  payload: ProjectSearchContentsInput,
  success: ProjectSearchContentsResult,
  error: Schema.Union([ProjectSearchContentsError, EnvironmentAuthorizationError]),
});

export const WsProjectsCheckWorkspaceRootRpc = Rpc.make(WS_METHODS.projectsCheckWorkspaceRoot, {
  payload: ProjectCheckWorkspaceRootInput,
  success: ProjectCheckWorkspaceRootResult,
  error: Schema.Union([ProjectCheckWorkspaceRootError, EnvironmentAuthorizationError]),
});

export const WsProjectsListEntriesRpc = Rpc.make(WS_METHODS.projectsListEntries, {
  payload: ProjectListEntriesInput,
  success: ProjectListEntriesResult,
  error: Schema.Union([ProjectListEntriesError, EnvironmentAuthorizationError]),
});

export const WsProjectsReadFileRpc = Rpc.make(WS_METHODS.projectsReadFile, {
  payload: ProjectReadFileInput,
  success: ProjectReadFileResult,
  error: Schema.Union([ProjectReadFileError, EnvironmentAuthorizationError]),
});

export const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: Schema.Union([ProjectWriteFileError, EnvironmentAuthorizationError]),
});

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: LaunchEditorInput,
  error: Schema.Union([ExternalLauncherError, EnvironmentAuthorizationError]),
});

export const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: Schema.Union([FilesystemBrowseError, EnvironmentAuthorizationError]),
});

export const WsAssetsCreateUrlRpc = Rpc.make(WS_METHODS.assetsCreateUrl, {
  payload: AssetCreateUrlInput,
  success: AssetCreateUrlResult,
  error: Schema.Union([AssetAccessError, EnvironmentAuthorizationError]),
});

export const WsThreadArtifactsListRpc = Rpc.make(WS_METHODS.threadArtifactsList, {
  payload: ThreadArtifactListInput,
  success: ThreadArtifactListResult,
  error: Schema.Union([ThreadArtifactError, EnvironmentAuthorizationError]),
});

export const WsThreadArtifactsGetRpc = Rpc.make(WS_METHODS.threadArtifactsGet, {
  payload: ThreadArtifactGetInput,
  success: ThreadArtifactDetail,
  error: Schema.Union([ThreadArtifactError, EnvironmentAuthorizationError]),
});

export const WsThreadArtifactsArchiveRpc = Rpc.make(WS_METHODS.threadArtifactsArchive, {
  payload: ThreadArtifactArchiveInput,
  success: ThreadArtifactDetail,
  error: Schema.Union([ThreadArtifactError, EnvironmentAuthorizationError]),
});

export const WsThreadArtifactsRestoreRpc = Rpc.make(WS_METHODS.threadArtifactsRestore, {
  payload: ThreadArtifactArchiveInput,
  success: ThreadArtifactDetail,
  error: Schema.Union([ThreadArtifactError, EnvironmentAuthorizationError]),
});

export const WsThreadArtifactsDeleteRpc = Rpc.make(WS_METHODS.threadArtifactsDelete, {
  payload: ThreadArtifactGetInput,
  success: ThreadArtifactDeleteResult,
  error: Schema.Union([ThreadArtifactError, EnvironmentAuthorizationError]),
});

export const WsThreadArtifactsSubscribeRpc = Rpc.make(WS_METHODS.threadArtifactsSubscribe, {
  payload: ThreadArtifactListInput,
  success: ThreadArtifactStreamItem,
  error: Schema.Union([ThreadArtifactError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsSubscribeVcsStatusRpc = Rpc.make(WS_METHODS.subscribeVcsStatus, {
  payload: VcsStatusInput,
  success: VcsStatusStreamEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsVcsPullRpc = Rpc.make(WS_METHODS.vcsPull, {
  payload: VcsPullInput,
  success: VcsPullResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsRefreshStatusRpc = Rpc.make(WS_METHODS.vcsRefreshStatus, {
  payload: VcsStatusInput,
  success: VcsStatusResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsVcsListRefsRpc = Rpc.make(WS_METHODS.vcsListRefs, {
  payload: VcsListRefsInput,
  success: VcsListRefsResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsCreateWorktreeRpc = Rpc.make(WS_METHODS.vcsCreateWorktree, {
  payload: VcsCreateWorktreeInput,
  success: VcsCreateWorktreeResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsRemoveWorktreeRpc = Rpc.make(WS_METHODS.vcsRemoveWorktree, {
  payload: VcsRemoveWorktreeInput,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsCreateRefRpc = Rpc.make(WS_METHODS.vcsCreateRef, {
  payload: VcsCreateRefInput,
  success: VcsCreateRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsSwitchRefRpc = Rpc.make(WS_METHODS.vcsSwitchRef, {
  payload: VcsSwitchRefInput,
  success: VcsSwitchRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsInitRpc = Rpc.make(WS_METHODS.vcsInit, {
  payload: VcsInitInput,
  error: Schema.Union([VcsError, EnvironmentAuthorizationError]),
});

/**
 * Ephemeral live diff preview for compact/mobile surfaces.
 * Not the persisted T3 Review model. Future review sessions should use
 * review.open* + review.getSnapshot.
 */
export const WsReviewGetDiffPreviewRpc = Rpc.make(WS_METHODS.reviewGetDiffPreview, {
  payload: ReviewDiffPreviewInput,
  success: ReviewDiffPreviewResult,
  error: Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]),
});

export const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalAttachRpc = Rpc.make(WS_METHODS.terminalAttach, {
  payload: TerminalAttachInput,
  success: TerminalAttachStreamItem,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsTerminalListRpc = Rpc.make(WS_METHODS.terminalList, {
  payload: TerminalListInput,
  success: TerminalListResult,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalReadRpc = Rpc.make(WS_METHODS.terminalRead, {
  payload: TerminalReadInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsPreviewOpenRpc = Rpc.make(WS_METHODS.previewOpen, {
  payload: PreviewOpenInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewNavigateRpc = Rpc.make(WS_METHODS.previewNavigate, {
  payload: PreviewNavigateInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewResizeRpc = Rpc.make(WS_METHODS.previewResize, {
  payload: PreviewResizeInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewRefreshRpc = Rpc.make(WS_METHODS.previewRefresh, {
  payload: PreviewRefreshInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewCloseRpc = Rpc.make(WS_METHODS.previewClose, {
  payload: PreviewCloseInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewListRpc = Rpc.make(WS_METHODS.previewList, {
  payload: PreviewListInput,
  success: PreviewListResult,
  error: EnvironmentAuthorizationError,
});

export const WsPreviewReportStatusRpc = Rpc.make(WS_METHODS.previewReportStatus, {
  payload: PreviewReportStatusInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewAutomationConnectRpc = Rpc.make(WS_METHODS.previewAutomationConnect, {
  payload: PreviewAutomationHost,
  success: PreviewAutomationStreamEvent,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsPreviewAutomationRespondRpc = Rpc.make(WS_METHODS.previewAutomationRespond, {
  payload: PreviewAutomationResponse,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
});

export const WsPreviewAutomationFocusHostRpc = Rpc.make(WS_METHODS.previewAutomationFocusHost, {
  payload: PreviewAutomationHostFocus,
  error: EnvironmentAuthorizationError,
});

export const WsRemoteControlHostConnectRpc = Rpc.make(WS_METHODS.remoteControlHostConnect, {
  payload: RemoteControlHost,
  success: RemoteControlHostStreamEvent,
  error: Schema.Union([RemoteControlError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsRemoteControlHostRespondRpc = Rpc.make(WS_METHODS.remoteControlHostRespond, {
  payload: RemoteControlHostRespondInput,
  success: RemoteControlSession,
  error: Schema.Union([RemoteControlError, EnvironmentAuthorizationError]),
});

export const WsVmAgentCreateRpc = Rpc.make(WS_METHODS.vmAgentCreate, {
  payload: VmAgentCreateInput,
  success: VmAgent,
  error: Schema.Union([VmAgentError, EnvironmentAuthorizationError]),
});

/**
 * Opens the singleton Agent Builder chat: ensures the one persistent thread in
 * the hidden agents project exists (its prefixed id grants it the
 * agent_builder tool) and returns its id for navigation. Idempotent — a second
 * open finds the thread already there.
 */
export const VmAgentBuilderOpenInput = Schema.Struct({});
export type VmAgentBuilderOpenInput = typeof VmAgentBuilderOpenInput.Type;

export const VmAgentBuilderOpenResult = Schema.Struct({
  threadId: ThreadIdSchema,
});
export type VmAgentBuilderOpenResult = typeof VmAgentBuilderOpenResult.Type;

export const WsVmAgentBuilderOpenRpc = Rpc.make(WS_METHODS.vmAgentBuilderOpen, {
  payload: VmAgentBuilderOpenInput,
  success: VmAgentBuilderOpenResult,
  error: Schema.Union([OrchestrationDispatchCommandError, EnvironmentAuthorizationError]),
});

export const WsVmAgentDeleteRpc = Rpc.make(WS_METHODS.vmAgentDelete, {
  payload: VmAgentRef,
  error: Schema.Union([VmAgentError, EnvironmentAuthorizationError]),
});

export const WsVmAgentSubscribeRpc = Rpc.make(WS_METHODS.vmAgentSubscribe, {
  payload: Schema.Struct({}),
  success: VmAgentStreamItem,
  error: Schema.Union([VmAgentError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsVmAgentWorkspaceSubscribeRpc = Rpc.make(WS_METHODS.vmAgentWorkspaceSubscribe, {
  payload: VmAgentRef,
  success: VmAgentWorkspaceStreamItem,
  error: Schema.Union([VmAgentWorkspaceError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsVmAgentTaskCreateRpc = Rpc.make(WS_METHODS.vmAgentTaskCreate, {
  payload: VmAgentTaskCreateInput,
  success: VmAgentTask,
  error: Schema.Union([VmAgentWorkspaceError, EnvironmentAuthorizationError]),
});

export const WsVmAgentTaskUpdateRpc = Rpc.make(WS_METHODS.vmAgentTaskUpdate, {
  payload: VmAgentTaskUpdateInput,
  success: VmAgentTask,
  error: Schema.Union([VmAgentWorkspaceError, EnvironmentAuthorizationError]),
});

export const WsVmAgentTaskDeleteRpc = Rpc.make(WS_METHODS.vmAgentTaskDelete, {
  payload: VmAgentTaskRef,
  error: Schema.Union([VmAgentWorkspaceError, EnvironmentAuthorizationError]),
});

export const WsVmAgentTaskRunNowRpc = Rpc.make(WS_METHODS.vmAgentTaskRunNow, {
  payload: VmAgentTaskRef,
  success: VmAgentTask,
  error: Schema.Union([VmAgentWorkspaceError, EnvironmentAuthorizationError]),
});

export const WsVmAgentTaskGeneratePromptRpc = Rpc.make(WS_METHODS.vmAgentTaskGeneratePrompt, {
  payload: VmAgentTaskPromptGenerationInput,
  success: VmAgentTaskPromptGenerationResult,
  error: Schema.Union([TextGenerationError, VmAgentWorkspaceError, EnvironmentAuthorizationError]),
});

export const WsVmAgentNotificationMarkReadRpc = Rpc.make(WS_METHODS.vmAgentNotificationMarkRead, {
  payload: VmAgentNotificationRef,
  error: Schema.Union([VmAgentWorkspaceError, EnvironmentAuthorizationError]),
});

export const WsVmAgentBlockerResolveRpc = Rpc.make(WS_METHODS.vmAgentBlockerResolve, {
  payload: VmAgentBlockerResolveInput,
  error: Schema.Union([VmAgentWorkspaceError, EnvironmentAuthorizationError]),
});

export const WsVmAgentNotificationPreferencesUpdateRpc = Rpc.make(
  WS_METHODS.vmAgentNotificationPreferencesUpdate,
  {
    payload: VmAgentNotificationPreferencesInput,
    success: VmAgentNotificationPreferences,
    error: Schema.Union([VmAgentWorkspaceError, EnvironmentAuthorizationError]),
  },
);

export const WsVmAgentCollaborationSubscribeRpc = Rpc.make(
  WS_METHODS.vmAgentCollaborationSubscribe,
  {
    payload: Schema.Struct({}),
    success: VmAgentCollaborationStreamItem,
    error: Schema.Union([VmAgentCollaborationError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

export const WsVmAgentCollaborationGetRpc = Rpc.make(WS_METHODS.vmAgentCollaborationGet, {
  payload: VmAgentDelegationRef,
  success: VmAgentDelegationDetail,
  error: Schema.Union([VmAgentCollaborationError, EnvironmentAuthorizationError]),
});

export const WsVmAgentCollaborationSendMessageRpc = Rpc.make(
  WS_METHODS.vmAgentCollaborationSendMessage,
  {
    payload: VmAgentDelegationSendMessageInput,
    success: VmAgentCollaborationReceipt,
    error: Schema.Union([VmAgentCollaborationError, EnvironmentAuthorizationError]),
  },
);

export const WsVmAgentCollaborationCancelRpc = Rpc.make(WS_METHODS.vmAgentCollaborationCancel, {
  payload: VmAgentDelegationRef,
  success: VmAgentCollaborationReceipt,
  error: Schema.Union([VmAgentCollaborationError, EnvironmentAuthorizationError]),
});

export const WsRemoteControlHostPublishFrameRpc = Rpc.make(
  WS_METHODS.remoteControlHostPublishFrame,
  {
    payload: RemoteControlHostPublishFrameInput,
    error: Schema.Union([RemoteControlError, EnvironmentAuthorizationError]),
  },
);

export const WsRemoteControlHostPublishVideoChunkRpc = Rpc.make(
  WS_METHODS.remoteControlHostPublishVideoChunk,
  {
    payload: RemoteControlHostPublishVideoChunkInput,
    error: Schema.Union([RemoteControlError, EnvironmentAuthorizationError]),
  },
);

export const WsRemoteControlHostReportStatusRpc = Rpc.make(
  WS_METHODS.remoteControlHostReportStatus,
  {
    payload: RemoteControlHostReportStatusInput,
    error: Schema.Union([RemoteControlError, EnvironmentAuthorizationError]),
  },
);

export const WsRemoteControlHostEndRpc = Rpc.make(WS_METHODS.remoteControlHostEnd, {
  payload: RemoteControlHostEndInput,
  success: RemoteControlSession,
  error: Schema.Union([RemoteControlError, EnvironmentAuthorizationError]),
});

export const WsRemoteControlRequestAccessRpc = Rpc.make(WS_METHODS.remoteControlRequestAccess, {
  payload: RemoteControlRequestAccessInput,
  success: RemoteControlSession,
  error: Schema.Union([RemoteControlError, EnvironmentAuthorizationError]),
});

export const WsRemoteControlWatchRpc = Rpc.make(WS_METHODS.remoteControlWatch, {
  payload: RemoteControlWatchInput,
  success: RemoteControlControllerStreamEvent,
  error: Schema.Union([RemoteControlError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsRemoteControlSendInputRpc = Rpc.make(WS_METHODS.remoteControlSendInput, {
  payload: RemoteControlSendInputInput,
  error: Schema.Union([RemoteControlError, EnvironmentAuthorizationError]),
});

export const WsRemoteControlCancelRpc = Rpc.make(WS_METHODS.remoteControlCancel, {
  payload: RemoteControlCancelInput,
  success: RemoteControlSession,
  error: Schema.Union([RemoteControlError, EnvironmentAuthorizationError]),
});

export const WsSubscribePreviewEventsRpc = Rpc.make(WS_METHODS.subscribePreviewEvents, {
  payload: Schema.Struct({}),
  success: PreviewEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeDiscoveredLocalServersRpc = Rpc.make(
  WS_METHODS.subscribeDiscoveredLocalServers,
  {
    payload: Schema.Struct({}),
    success: DiscoveredLocalServerList,
    error: EnvironmentAuthorizationError,
    stream: true,
  },
);

export const WsOrchestrationDispatchCommandRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  {
    payload: ClientOrchestrationCommand,
    success: OrchestrationRpcSchemas.dispatchCommand.output,
    error: Schema.Union([OrchestrationDispatchCommandError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: Schema.Union([OrchestrationGetTurnDiffError, EnvironmentAuthorizationError]),
});

export const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationGetFullThreadDiffInput,
    success: OrchestrationRpcSchemas.getFullThreadDiff.output,
    error: Schema.Union([OrchestrationGetFullThreadDiffError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationSearchThreadsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.searchThreads, {
  payload: OrchestrationSearchThreadsInput,
  success: OrchestrationRpcSchemas.searchThreads.output,
  error: Schema.Union([OrchestrationSearchThreadsError, EnvironmentAuthorizationError]),
});

export const WsOrchestrationGetArchivedShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
  {
    payload: OrchestrationRpcSchemas.getArchivedShellSnapshot.input,
    success: OrchestrationRpcSchemas.getArchivedShellSnapshot.output,
    error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: OrchestrationRpcSchemas.subscribeShell.output,
  error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsOrchestrationSubscribeThreadRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.subscribeThread,
  {
    payload: OrchestrationRpcSchemas.subscribeThread.input,
    success: OrchestrationRpcSchemas.subscribeThread.output,
    error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

export const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEventStreamItem,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeTerminalMetadataRpc = Rpc.make(WS_METHODS.subscribeTerminalMetadata, {
  payload: Schema.Struct({}),
  success: TerminalMetadataStreamItem,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeTerminalLayoutsRpc = Rpc.make(WS_METHODS.subscribeTerminalLayouts, {
  payload: Schema.Struct({}),
  success: TerminalLayoutStreamItem,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsTerminalGetLayoutRpc = Rpc.make(WS_METHODS.terminalGetLayout, {
  payload: TerminalGetLayoutInput,
  success: TerminalGetLayoutResult,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalSetLayoutRpc = Rpc.make(WS_METHODS.terminalSetLayout, {
  payload: TerminalSetLayoutInput,
  success: TerminalThreadLayout,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeAuthAccessRpc = Rpc.make(WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  error: Schema.Union([AuthAccessStreamError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsSubscribeBackgroundPolicyRpc = Rpc.make(WS_METHODS.subscribeBackgroundPolicy, {
  payload: Schema.Struct({}),
  success: BackgroundPolicySnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeResourceTelemetryRpc = Rpc.make(WS_METHODS.subscribeResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetrySnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsRpcGroup = RpcGroup.make(
  WsServerProbeRpc,
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerStartProviderAccountSwitchRpc,
  WsServerGetProviderAccountSwitchRpc,
  WsServerOpenProviderAccountSwitchAuthLinkRpc,
  WsServerSubmitProviderAccountSwitchCodeRpc,
  WsServerCancelProviderAccountSwitchRpc,
  WsServerUpdateProviderRpc,
  WsServerUpdateServerRpc,
  WsServerUpsertKeybindingRpc,
  WsServerRemoveKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerDiscoverSourceControlRpc,
  WsServerGetTraceDiagnosticsRpc,
  WsServerGetProcessDiagnosticsRpc,
  WsServerGetProcessResourceHistoryRpc,
  WsServerGetResourceTelemetryHistoryRpc,
  WsServerRetryResourceTelemetryRpc,
  WsServerSignalProcessRpc,
  WsServerReportClientActivityRpc,
  WsServerReportHostPowerStateRpc,
  WsServerGetBackgroundPolicyRpc,
  WsSourceControlLookupRepositoryRpc,
  WsSourceControlCloneRepositoryRpc,
  WsSourceControlPublishRepositoryRpc,
  WsProjectsCheckWorkspaceRootRpc,
  WsProjectsListEntriesRpc,
  WsProjectsReadFileRpc,
  WsProjectsSearchContentsRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsWriteFileRpc,
  WsShellOpenInEditorRpc,
  WsFilesystemBrowseRpc,
  WsAssetsCreateUrlRpc,
  WsThreadArtifactsListRpc,
  WsThreadArtifactsGetRpc,
  WsThreadArtifactsArchiveRpc,
  WsThreadArtifactsRestoreRpc,
  WsThreadArtifactsDeleteRpc,
  WsThreadArtifactsSubscribeRpc,
  WsSubscribeVcsStatusRpc,
  WsVcsPullRpc,
  WsVcsRefreshStatusRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsVcsListRefsRpc,
  WsVcsCreateWorktreeRpc,
  WsVcsRemoveWorktreeRpc,
  WsVcsCreateRefRpc,
  WsVcsSwitchRefRpc,
  WsVcsInitRpc,
  WsReviewGetDiffPreviewRpc,
  WsTerminalOpenRpc,
  WsTerminalAttachRpc,
  WsTerminalListRpc,
  WsTerminalReadRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsTerminalGetLayoutRpc,
  WsTerminalSetLayoutRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeTerminalMetadataRpc,
  WsSubscribeTerminalLayoutsRpc,
  WsPreviewOpenRpc,
  WsPreviewNavigateRpc,
  WsPreviewResizeRpc,
  WsPreviewRefreshRpc,
  WsPreviewCloseRpc,
  WsPreviewListRpc,
  WsPreviewReportStatusRpc,
  WsPreviewAutomationConnectRpc,
  WsPreviewAutomationRespondRpc,
  WsPreviewAutomationFocusHostRpc,
  WsRemoteControlHostConnectRpc,
  WsRemoteControlHostRespondRpc,
  WsRemoteControlHostPublishFrameRpc,
  WsRemoteControlHostPublishVideoChunkRpc,
  WsRemoteControlHostEndRpc,
  WsRemoteControlHostReportStatusRpc,
  WsRemoteControlRequestAccessRpc,
  WsRemoteControlWatchRpc,
  WsRemoteControlSendInputRpc,
  WsRemoteControlCancelRpc,
  WsVmAgentCreateRpc,
  WsVmAgentBuilderOpenRpc,
  WsVmAgentDeleteRpc,
  WsVmAgentSubscribeRpc,
  WsVmAgentWorkspaceSubscribeRpc,
  WsVmAgentTaskCreateRpc,
  WsVmAgentTaskUpdateRpc,
  WsVmAgentTaskDeleteRpc,
  WsVmAgentTaskRunNowRpc,
  WsVmAgentTaskGeneratePromptRpc,
  WsVmAgentNotificationMarkReadRpc,
  WsVmAgentBlockerResolveRpc,
  WsVmAgentNotificationPreferencesUpdateRpc,
  WsVmAgentCollaborationSubscribeRpc,
  WsVmAgentCollaborationGetRpc,
  WsVmAgentCollaborationSendMessageRpc,
  WsVmAgentCollaborationCancelRpc,
  WsSubscribePreviewEventsRpc,
  WsSubscribeDiscoveredLocalServersRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsSubscribeBackgroundPolicyRpc,
  WsSubscribeResourceTelemetryRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationSearchThreadsRpc,
  WsOrchestrationGetArchivedShellSnapshotRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
);
