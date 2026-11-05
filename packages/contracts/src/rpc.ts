import {
  PreviewAccountLinkInput,
  PreviewAccountSignOutInput,
  PreviewAccountsSnapshot,
} from "./previewAccounts.ts";
import {
  WebPushStatusInput,
  WebPushStatus,
  WebPushSubscribeInput,
  WebPushEndpointInput,
  WebPushError,
} from "./webPush.ts";
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
  FilesystemPathsExistInput,
  FilesystemPathsExistResult,
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
  ModelSelection,
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSnapshotError,
  OrchestrationSearchThreadsError,
  OrchestrationSearchThreadsInput,
  OrchestrationGetProjectStatisticsError,
  OrchestrationGetProjectStatisticsInput,
  OrchestrationMeasureProjectFoldersInput,
  OrchestrationProjectFolders,
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
  ProjectFolderRemovalCheck,
  ProjectFolderRemovalError,
  ProjectFolderRemovalInput,
  ProjectRemoveWithFolderResult,
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
  VmAgentAttentionStreamItem,
  VmAgentBlockerResolveInput,
  VmAgentCollaborationError,
  VmAgentCollaborationReceipt,
  VmAgentCollaborationSubscribeInput,
  VmAgentCollaborationWireStreamItem,
  VmAgentCreateInput,
  VmAgentDelegationDetail,
  VmAgentDelegationRef,
  VmAgentDelegationSendMessageInput,
  VmAgentError,
  VmAgentNotificationPreferences,
  VmAgentNotificationPreferencesInput,
  VmAgentNotificationRef,
  VmAgentNotificationUpdateInput,
  VmAgentRef,
  VmAgentRules,
  VmAgentVoiceSetInput,
  VmAgentRenameInput,
  VmAgentRulesUpdateInput,
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
  PreviewCloseResult,
  PreviewError,
  PreviewEvent,
  PreviewListInput,
  PreviewListResult,
  PreviewNavigateInput,
  PreviewOpenInput,
  PreviewRefreshInput,
  PreviewMediaWatchInput,
  PreviewMediaWatchEvent,
  PreviewMediaTicketInput,
  PreviewMediaAccessDeniedError,
  PreviewRemoteFrameEvent,
  PreviewRemoteFramePublishInput,
  PreviewRemoteFrameWatchInput,
  PreviewRemoteInputInput,
  PreviewRemoteInputResult,
  PreviewRemoteSnapshotInput,
  PreviewRemoteSnapshotResult,
  PreviewRemoteSnapshotUnchangedResult,
  PreviewReportStatusInput,
  PreviewReportActivityInput,
  PreviewResizeInput,
  PreviewSessionSnapshot,
  PreviewTabAudioEvent,
  PreviewTabAudioListenerReport,
  PreviewTabAudioPublishInput,
  PreviewTabAudioWatchInput,
} from "./preview.ts";
import {
  PreviewHostMediaTicketInput,
  PreviewAutomationError,
  PreviewAutomationHost,
  PreviewAutomationHostFocus,
  PreviewAutomationResponse,
  PreviewAutomationStreamEvent,
  PreviewCredentialRemoveInput,
  PreviewCredentialSaveInput,
  PreviewCredentialSummary,
  PreviewPasskeyRemoveInput,
  PreviewPasskeySiteInput,
  PreviewPasskeysSnapshot,
  PreviewCredentialVaultError,
} from "./previewAutomation.ts";
import {
  RemoteControlCancelInput,
  RemoteControlControllerStreamEvent,
  RemoteControlError,
  RemoteControlHost,
  RemoteControlHostEndInput,
  RemoteControlHostReportStatusInput,
  RemoteControlHostAcknowledgeInputInput,
  RemoteControlHostPublishFrameInput,
  RemoteControlHostPublishVideoChunkInput,
  RemoteControlHostRespondInput,
  RemoteControlHostStreamEvent,
  RemoteControlRequestAccessInput,
  RemoteControlSendInputInput,
  RemoteControlSession,
  RemoteControlWatchInput,
  RemoteControlHostMediaTicketInput,
  RemoteControlHostReportPointerInput,
  RemoteControlMediaTicketInput,
} from "./remoteControl.ts";
import { MediaChannelTicket } from "./mediaChannel.ts";
import {
  AgentCall,
  AgentCallError,
  AgentCallPlaceInput,
  AgentCallEndInput,
  AgentCallParticipantInput,
  AgentCallRef,
  AgentCallRoster,
  AgentCallsSnapshot,
} from "./agentCall.ts";
import {
  DatabaseStorageError,
  DatabaseStorageStatus,
  StorageCleanupStartError,
  StorageCleanupStartInput,
  StorageCleanupStartResult,
  HostRepairStartError,
  HostRepairStartInput,
  HostRepairStartResult,
  ProviderAccountSwitchError,
  ProviderAccountSwitchState,
  ProviderUsageResetError,
  ProviderUsageResetInput,
  ProviderUsageResetResult,
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
import { HostVitals } from "./hostVitals.ts";
import {
  DeviceCatalog,
  DeviceCreateInput,
  DeviceError,
  DeviceListResult,
  DevicePowerInput,
  DeviceRef,
  DeviceSummary,
  DeviceViewResult,
} from "./devices.ts";
import { RelayedEnvironmentList, RelayedEnvironmentsPublishInput } from "./relayedEnvironments.ts";
import {
  ResourceTelemetryHistory,
  ResourceTelemetryHistoryInput,
  ResourceTelemetryRetryResult,
  ResourceTelemetrySnapshot,
} from "./resourceTelemetry.ts";
import { VoiceTranscriptCorrectionInput, VoiceTranscriptCorrectionResult } from "./voice.ts";
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
  projectsCheckFolderRemoval: "projects.checkFolderRemoval",
  projectsRemoveWithFolder: "projects.removeWithFolder",
  projectsListEntries: "projects.listEntries",
  projectsReadFile: "projects.readFile",
  projectsSearchContents: "projects.searchContents",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",
  filesystemPathsExist: "filesystem.pathsExist",
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
  previewRemoteSnapshot: "preview.remoteSnapshot",
  previewRemoteInput: "preview.remoteInput",
  previewMediaWatch: "preview.mediaWatch",
  previewMediaTicket: "preview.mediaTicket",
  previewHostMediaTicket: "preview.hostMediaTicket",
  previewRemoteFrames: "preview.remoteFrames",
  previewRemoteFramePublish: "preview.remoteFramePublish",
  previewTabAudioWatch: "preview.tabAudioWatch",
  previewTabAudioPublish: "preview.tabAudioPublish",
  previewTabAudioReport: "preview.tabAudioReport",
  previewReportStatus: "preview.reportStatus",
  previewReportActivity: "preview.reportActivity",
  previewAutomationConnect: "previewAutomation.connect",
  previewAutomationRespond: "previewAutomation.respond",
  previewAutomationFocusHost: "previewAutomation.focusHost",
  previewCredentialsList: "previewCredentials.list",
  previewCredentialsSave: "previewCredentials.save",
  previewCredentialsRemove: "previewCredentials.remove",
  previewAccountsSnapshot: "previewAccounts.snapshot",
  previewAccountsSignOut: "previewAccounts.signOut",
  previewAccountsLink: "previewAccounts.link",
  previewPasskeysSnapshot: "previewPasskeys.snapshot",
  previewPasskeysSetSite: "previewPasskeys.setSite",
  previewPasskeysRemove: "previewPasskeys.remove",
  devicesList: "devices.list",
  devicesCatalog: "devices.catalog",
  devicesCreate: "devices.create",
  devicesDelete: "devices.delete",
  devicesSetPower: "devices.setPower",
  devicesView: "devices.view",
  relayedEnvironmentsPublish: "relayedEnvironments.publish",
  remoteControlHostConnect: "remoteControl.hostConnect",
  remoteControlHostRespond: "remoteControl.hostRespond",
  remoteControlHostPublishFrame: "remoteControl.hostPublishFrame",
  remoteControlHostPublishVideoChunk: "remoteControl.hostPublishVideoChunk",
  remoteControlHostEnd: "remoteControl.hostEnd",
  remoteControlHostReportStatus: "remoteControl.hostReportStatus",
  remoteControlHostAcknowledgeInput: "remoteControl.hostAcknowledgeInput",
  remoteControlRequestAccess: "remoteControl.requestAccess",
  remoteControlWatch: "remoteControl.watch",
  remoteControlSendInput: "remoteControl.sendInput",
  remoteControlCancel: "remoteControl.cancel",
  remoteControlMediaTicket: "remoteControl.mediaTicket",
  remoteControlHostMediaTicket: "remoteControl.hostMediaTicket",
  remoteControlHostReportPointer: "remoteControl.hostReportPointer",

  // Agent Stack (named VM agents)
  vmAgentCreate: "vmAgent.create",
  vmAgentBuilderOpen: "vmAgent.builder.open",
  vmAgentDelete: "vmAgent.delete",
  vmAgentStart: "vmAgent.start",
  vmAgentStop: "vmAgent.stop",
  vmAgentVoiceSet: "vmAgent.voice.set",
  vmAgentRename: "vmAgent.rename",
  vmAgentSubscribe: "vmAgent.subscribe",
  vmAgentWorkspaceSubscribe: "vmAgent.workspace.subscribe",
  vmAgentRulesGet: "vmAgent.rules.get",
  vmAgentRulesUpdate: "vmAgent.rules.update",
  vmAgentAttentionSubscribe: "vmAgent.attention.subscribe",
  vmAgentTaskCreate: "vmAgent.task.create",
  vmAgentTaskUpdate: "vmAgent.task.update",
  vmAgentTaskDelete: "vmAgent.task.delete",
  vmAgentTaskRunNow: "vmAgent.task.runNow",
  vmAgentTaskGeneratePrompt: "vmAgent.task.generatePrompt",
  vmAgentNotificationMarkRead: "vmAgent.notification.markRead",
  vmAgentNotificationUpdate: "vmAgent.notification.update",
  vmAgentBlockerResolve: "vmAgent.blocker.resolve",
  vmAgentCallsSubscribe: "vmAgent.calls.subscribe",
  vmAgentCallPlace: "vmAgent.call.place",
  vmAgentCallDecline: "vmAgent.call.decline",
  vmAgentCallEnd: "vmAgent.call.end",
  vmAgentCallRoster: "vmAgent.call.roster",
  vmAgentCallAddParticipant: "vmAgent.call.addParticipant",
  vmAgentCallRemoveParticipant: "vmAgent.call.removeParticipant",
  vmAgentNotificationPreferencesUpdate: "vmAgent.notification.preferences.update",
  vmAgentCollaborationSubscribe: "vmAgent.collaboration.subscribe",
  vmAgentCollaborationGet: "vmAgent.collaboration.get",
  vmAgentCollaborationSendMessage: "vmAgent.collaboration.sendMessage",
  vmAgentCollaborationCancel: "vmAgent.collaboration.cancel",

  // Server meta
  serverProbe: "server.probe",
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverConsumeProviderUsageReset: "server.consumeProviderUsageReset",
  serverResumeUsageGuard: "server.resumeUsageGuard",
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
  voiceTranscriptCorrect: "voice.transcript.correct",
  serverDiscoverSourceControl: "server.discoverSourceControl",
  serverGetTraceDiagnostics: "server.getTraceDiagnostics",
  serverGetProcessDiagnostics: "server.getProcessDiagnostics",
  serverGetProcessResourceHistory: "server.getProcessResourceHistory",
  serverGetResourceTelemetryHistory: "server.getResourceTelemetryHistory",
  serverRetryResourceTelemetry: "server.retryResourceTelemetry",
  serverStartStorageCleanup: "server.startStorageCleanup",
  serverGetDatabaseStorage: "server.getDatabaseStorage",
  serverScheduleDatabaseCompaction: "server.scheduleDatabaseCompaction",
  serverCancelDatabaseCompaction: "server.cancelDatabaseCompaction",
  webPushStatus: "webPush.status",
  webPushSubscribe: "webPush.subscribe",
  webPushUnsubscribe: "webPush.unsubscribe",
  webPushTest: "webPush.test",
  serverStartHostRepair: "server.startHostRepair",
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
  subscribeHostVitals: "subscribeHostVitals",
  subscribeRelayedEnvironments: "subscribeRelayedEnvironments",
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

export const WsServerConsumeProviderUsageResetRpc = Rpc.make(
  WS_METHODS.serverConsumeProviderUsageReset,
  {
    payload: ProviderUsageResetInput,
    success: ProviderUsageResetResult,
    error: Schema.Union([ProviderUsageResetError, EnvironmentAuthorizationError]),
  },
);

/**
 * Lift the usage guard's hold on one thread: put its sleeping deliveries back
 * on the queue and let its work through until the window resets.
 */
export const WsServerResumeUsageGuardRpc = Rpc.make(WS_METHODS.serverResumeUsageGuard, {
  payload: Schema.Struct({
    threadId: ThreadIdSchema,
    recheckOnly: Schema.optional(Schema.Boolean),
    modelSelection: Schema.optional(ModelSelection),
  }),
  /** `reason` is set when the resume was refused because the provider itself reports the account exhausted. */
  success: Schema.Struct({ resumed: Schema.Boolean, reason: Schema.optional(Schema.String) }),
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

export const WsVoiceTranscriptCorrectRpc = Rpc.make(WS_METHODS.voiceTranscriptCorrect, {
  payload: VoiceTranscriptCorrectionInput,
  success: VoiceTranscriptCorrectionResult,
  error: Schema.Union([TextGenerationError, EnvironmentAuthorizationError]),
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

export const WsWebPushStatusRpc = Rpc.make(WS_METHODS.webPushStatus, {
  payload: WebPushStatusInput,
  success: WebPushStatus,
  error: Schema.Union([WebPushError, EnvironmentAuthorizationError]),
});

export const WsWebPushSubscribeRpc = Rpc.make(WS_METHODS.webPushSubscribe, {
  payload: WebPushSubscribeInput,
  success: Schema.Void,
  error: Schema.Union([WebPushError, EnvironmentAuthorizationError]),
});

export const WsWebPushUnsubscribeRpc = Rpc.make(WS_METHODS.webPushUnsubscribe, {
  payload: WebPushEndpointInput,
  success: Schema.Void,
  error: Schema.Union([WebPushError, EnvironmentAuthorizationError]),
});

export const WsWebPushTestRpc = Rpc.make(WS_METHODS.webPushTest, {
  payload: WebPushEndpointInput,
  success: Schema.Void,
  error: Schema.Union([WebPushError, EnvironmentAuthorizationError]),
});

export const WsServerStartStorageCleanupRpc = Rpc.make(WS_METHODS.serverStartStorageCleanup, {
  payload: StorageCleanupStartInput,
  success: StorageCleanupStartResult,
  error: Schema.Union([StorageCleanupStartError, EnvironmentAuthorizationError]),
});

export const WsServerGetDatabaseStorageRpc = Rpc.make(WS_METHODS.serverGetDatabaseStorage, {
  payload: Schema.Struct({}),
  success: DatabaseStorageStatus,
  error: Schema.Union([DatabaseStorageError, EnvironmentAuthorizationError]),
});

/** Compacts the database at the server's next start; returns the updated status. */
export const WsServerScheduleDatabaseCompactionRpc = Rpc.make(
  WS_METHODS.serverScheduleDatabaseCompaction,
  {
    payload: Schema.Struct({}),
    success: DatabaseStorageStatus,
    error: Schema.Union([DatabaseStorageError, EnvironmentAuthorizationError]),
  },
);

export const WsServerCancelDatabaseCompactionRpc = Rpc.make(
  WS_METHODS.serverCancelDatabaseCompaction,
  {
    payload: Schema.Struct({}),
    success: DatabaseStorageStatus,
    error: Schema.Union([DatabaseStorageError, EnvironmentAuthorizationError]),
  },
);

export const WsServerStartHostRepairRpc = Rpc.make(WS_METHODS.serverStartHostRepair, {
  payload: HostRepairStartInput,
  success: HostRepairStartResult,
  error: Schema.Union([HostRepairStartError, EnvironmentAuthorizationError]),
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

export const WsProjectsCheckFolderRemovalRpc = Rpc.make(WS_METHODS.projectsCheckFolderRemoval, {
  payload: ProjectFolderRemovalInput,
  success: ProjectFolderRemovalCheck,
  error: Schema.Union([ProjectFolderRemovalError, EnvironmentAuthorizationError]),
});

export const WsProjectsRemoveWithFolderRpc = Rpc.make(WS_METHODS.projectsRemoveWithFolder, {
  payload: ProjectFolderRemovalInput,
  success: ProjectRemoveWithFolderResult,
  error: Schema.Union([ProjectFolderRemovalError, EnvironmentAuthorizationError]),
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

export const WsFilesystemPathsExistRpc = Rpc.make(WS_METHODS.filesystemPathsExist, {
  payload: FilesystemPathsExistInput,
  success: FilesystemPathsExistResult,
  error: EnvironmentAuthorizationError,
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
  // Schema.Void erases a newer result object, while this union accepts the
  // undefined response from older servers. That makes the same RPC tag safe
  // in both rolling-upgrade directions.
  success: Schema.UndefinedOr(PreviewCloseResult),
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewListRpc = Rpc.make(WS_METHODS.previewList, {
  payload: PreviewListInput,
  success: PreviewListResult,
  error: EnvironmentAuthorizationError,
});

export const WsPreviewRemoteSnapshotRpc = Rpc.make(WS_METHODS.previewRemoteSnapshot, {
  payload: PreviewRemoteSnapshotInput,
  success: Schema.Union([PreviewRemoteSnapshotResult, PreviewRemoteSnapshotUnchangedResult]),
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
});

export const WsPreviewRemoteInputRpc = Rpc.make(WS_METHODS.previewRemoteInput, {
  payload: PreviewRemoteInputInput,
  success: PreviewRemoteInputResult,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
});

export const WsPreviewMediaWatchRpc = Rpc.make(WS_METHODS.previewMediaWatch, {
  payload: PreviewMediaWatchInput,
  success: PreviewMediaWatchEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});
export const WsPreviewMediaTicketRpc = Rpc.make(WS_METHODS.previewMediaTicket, {
  payload: PreviewMediaTicketInput,
  success: MediaChannelTicket,
  error: Schema.Union([PreviewMediaAccessDeniedError, EnvironmentAuthorizationError]),
});
export const WsPreviewHostMediaTicketRpc = Rpc.make(WS_METHODS.previewHostMediaTicket, {
  payload: PreviewHostMediaTicketInput,
  success: MediaChannelTicket,
  error: Schema.Union([PreviewMediaAccessDeniedError, EnvironmentAuthorizationError]),
});

/** A remote viewer watching a tab; pictures arrive as the page changes. */
export const WsPreviewRemoteFramesRpc = Rpc.make(WS_METHODS.previewRemoteFrames, {
  payload: PreviewRemoteFrameWatchInput,
  success: PreviewRemoteFrameEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

/** The rendering desktop handing over what changed in a watched tab. */
export const WsPreviewRemoteFramePublishRpc = Rpc.make(WS_METHODS.previewRemoteFramePublish, {
  payload: PreviewRemoteFramePublishInput,
  error: EnvironmentAuthorizationError,
});

export const WsPreviewTabAudioWatchRpc = Rpc.make(WS_METHODS.previewTabAudioWatch, {
  payload: PreviewTabAudioWatchInput,
  success: PreviewTabAudioEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsPreviewTabAudioPublishRpc = Rpc.make(WS_METHODS.previewTabAudioPublish, {
  payload: PreviewTabAudioPublishInput,
  error: EnvironmentAuthorizationError,
});

export const WsPreviewTabAudioReportRpc = Rpc.make(WS_METHODS.previewTabAudioReport, {
  payload: PreviewTabAudioListenerReport,
  error: EnvironmentAuthorizationError,
});

export const WsPreviewReportActivityRpc = Rpc.make(WS_METHODS.previewReportActivity, {
  payload: PreviewReportActivityInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
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

// Settings screens on any device manage the saved passwords kept by the
// desktop app on the environment's own machine; the server only relays.
export const WsPreviewCredentialsListRpc = Rpc.make(WS_METHODS.previewCredentialsList, {
  payload: Schema.Struct({}),
  success: Schema.Array(PreviewCredentialSummary),
  error: Schema.Union([PreviewCredentialVaultError, EnvironmentAuthorizationError]),
});

export const WsPreviewCredentialsSaveRpc = Rpc.make(WS_METHODS.previewCredentialsSave, {
  payload: PreviewCredentialSaveInput,
  success: PreviewCredentialSummary,
  error: Schema.Union([PreviewCredentialVaultError, EnvironmentAuthorizationError]),
});

export const WsPreviewCredentialsRemoveRpc = Rpc.make(WS_METHODS.previewCredentialsRemove, {
  payload: PreviewCredentialRemoveInput,
  error: Schema.Union([PreviewCredentialVaultError, EnvironmentAuthorizationError]),
});

export const WsPreviewAccountsSnapshotRpc = Rpc.make(WS_METHODS.previewAccountsSnapshot, {
  payload: Schema.Struct({ refresh: Schema.optionalKey(Schema.Boolean) }),
  success: PreviewAccountsSnapshot,
  error: Schema.Union([PreviewCredentialVaultError, EnvironmentAuthorizationError]),
});

export const WsPreviewAccountsSignOutRpc = Rpc.make(WS_METHODS.previewAccountsSignOut, {
  payload: PreviewAccountSignOutInput,
  error: Schema.Union([PreviewCredentialVaultError, EnvironmentAuthorizationError]),
});

export const WsPreviewAccountsLinkRpc = Rpc.make(WS_METHODS.previewAccountsLink, {
  payload: PreviewAccountLinkInput,
  error: Schema.Union([PreviewCredentialVaultError, EnvironmentAuthorizationError]),
});

export const WsPreviewPasskeysSnapshotRpc = Rpc.make(WS_METHODS.previewPasskeysSnapshot, {
  payload: Schema.Struct({}),
  success: PreviewPasskeysSnapshot,
  error: Schema.Union([PreviewCredentialVaultError, EnvironmentAuthorizationError]),
});

export const WsPreviewPasskeysSetSiteRpc = Rpc.make(WS_METHODS.previewPasskeysSetSite, {
  payload: PreviewPasskeySiteInput,
  success: PreviewPasskeysSnapshot,
  error: Schema.Union([PreviewCredentialVaultError, EnvironmentAuthorizationError]),
});

export const WsPreviewPasskeysRemoveRpc = Rpc.make(WS_METHODS.previewPasskeysRemove, {
  payload: PreviewPasskeyRemoveInput,
  success: PreviewPasskeysSnapshot,
  error: Schema.Union([PreviewCredentialVaultError, EnvironmentAuthorizationError]),
});

// iOS simulators and Android emulators on the environment's machine.
export const WsDevicesListRpc = Rpc.make(WS_METHODS.devicesList, {
  payload: Schema.Struct({}),
  success: DeviceListResult,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

export const WsDevicesCatalogRpc = Rpc.make(WS_METHODS.devicesCatalog, {
  payload: Schema.Struct({}),
  success: DeviceCatalog,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

export const WsDevicesCreateRpc = Rpc.make(WS_METHODS.devicesCreate, {
  payload: DeviceCreateInput,
  success: DeviceSummary,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

export const WsDevicesDeleteRpc = Rpc.make(WS_METHODS.devicesDelete, {
  payload: DeviceRef,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

export const WsDevicesSetPowerRpc = Rpc.make(WS_METHODS.devicesSetPower, {
  payload: DevicePowerInput,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

// Starts the device when it is off.
export const WsDevicesViewRpc = Rpc.make(WS_METHODS.devicesView, {
  payload: DeviceRef,
  success: DeviceViewResult,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

// The host's desktop app shares its saved connections with the host's clients.
export const WsRelayedEnvironmentsPublishRpc = Rpc.make(WS_METHODS.relayedEnvironmentsPublish, {
  payload: RelayedEnvironmentsPublishInput,
  error: EnvironmentAuthorizationError,
});

export const WsSubscribeRelayedEnvironmentsRpc = Rpc.make(WS_METHODS.subscribeRelayedEnvironments, {
  payload: Schema.Struct({}),
  success: RelayedEnvironmentList,
  error: EnvironmentAuthorizationError,
  stream: true,
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

/** Switch an agent on: scheduled tasks resume and the scheduler is woken. */
export const WsVmAgentStartRpc = Rpc.make(WS_METHODS.vmAgentStart, {
  payload: Schema.Struct({
    ...VmAgentRef.fields,
    backlog: Schema.optional(Schema.Literals(["combine", "skip"])),
  }),
  success: Schema.Union([VmAgent, Schema.Struct({ backlogCount: Schema.Number })]),
  error: Schema.Union([VmAgentError, VmAgentWorkspaceError, EnvironmentAuthorizationError]),
});

/**
 * Switch an agent off: its in-flight turn is interrupted, due scheduled tasks
 * are ignored and run-now is refused until it is started again.
 */
export const WsVmAgentStopRpc = Rpc.make(WS_METHODS.vmAgentStop, {
  payload: VmAgentRef,
  success: VmAgent,
  error: Schema.Union([VmAgentError, EnvironmentAuthorizationError]),
});

export const WsVmAgentRenameRpc = Rpc.make(WS_METHODS.vmAgentRename, {
  payload: VmAgentRenameInput,
  success: VmAgent,
  error: Schema.Union([VmAgentError, EnvironmentAuthorizationError]),
});

/** Chooses the voice an agent speaks with on calls, from its next call. */
export const WsVmAgentVoiceSetRpc = Rpc.make(WS_METHODS.vmAgentVoiceSet, {
  payload: VmAgentVoiceSetInput,
  success: VmAgent,
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

export const WsVmAgentRulesGetRpc = Rpc.make(WS_METHODS.vmAgentRulesGet, {
  payload: VmAgentRef,
  success: VmAgentRules,
  error: Schema.Union([VmAgentWorkspaceError, EnvironmentAuthorizationError]),
});

export const WsVmAgentRulesUpdateRpc = Rpc.make(WS_METHODS.vmAgentRulesUpdate, {
  payload: VmAgentRulesUpdateInput,
  success: VmAgentRules,
  error: Schema.Union([VmAgentWorkspaceError, EnvironmentAuthorizationError]),
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

export const WsVmAgentNotificationUpdateRpc = Rpc.make(WS_METHODS.vmAgentNotificationUpdate, {
  payload: VmAgentNotificationUpdateInput,
  error: Schema.Union([VmAgentWorkspaceError, EnvironmentAuthorizationError]),
});

export const WsVmAgentAttentionSubscribeRpc = Rpc.make(WS_METHODS.vmAgentAttentionSubscribe, {
  payload: Schema.Struct({}),
  success: VmAgentAttentionStreamItem,
  error: Schema.Union([VmAgentWorkspaceError, EnvironmentAuthorizationError]),
  stream: true,
});

/** Open and recently ended agent calls; a full snapshot on every change. */
export const WsVmAgentCallsSubscribeRpc = Rpc.make(WS_METHODS.vmAgentCallsSubscribe, {
  payload: Schema.Struct({}),
  success: AgentCallsSnapshot,
  error: Schema.Union([AgentCallError, EnvironmentAuthorizationError]),
  stream: true,
});

/** The person calls an agent. Rings only on the placing device until it opens voice. */
export const WsVmAgentCallPlaceRpc = Rpc.make(WS_METHODS.vmAgentCallPlace, {
  payload: AgentCallPlaceInput,
  success: AgentCall,
  error: Schema.Union([AgentCallError, EnvironmentAuthorizationError]),
});

export const WsVmAgentCallDeclineRpc = Rpc.make(WS_METHODS.vmAgentCallDecline, {
  payload: AgentCallRef,
  error: Schema.Union([AgentCallError, EnvironmentAuthorizationError]),
});

/** Hangs up an active call or cancels a ringing one. Idempotent. */
export const WsVmAgentCallEndRpc = Rpc.make(WS_METHODS.vmAgentCallEnd, {
  payload: AgentCallEndInput,
  error: Schema.Union([AgentCallError, EnvironmentAuthorizationError]),
});

/** Who the live call's voice can transfer to or add: the roster it started with. */
export const WsVmAgentCallRosterRpc = Rpc.make(WS_METHODS.vmAgentCallRoster, {
  payload: AgentCallRef,
  success: AgentCallRoster,
  error: Schema.Union([AgentCallError, EnvironmentAuthorizationError]),
});

/** Adds a chat to an active call (at most `AGENT_CALL_MAX_PARTICIPANTS`). */
export const WsVmAgentCallAddParticipantRpc = Rpc.make(WS_METHODS.vmAgentCallAddParticipant, {
  payload: AgentCallParticipantInput,
  success: AgentCall,
  error: Schema.Union([AgentCallError, EnvironmentAuthorizationError]),
});

/** Takes a chat off a call. Idempotent. */
export const WsVmAgentCallRemoveParticipantRpc = Rpc.make(WS_METHODS.vmAgentCallRemoveParticipant, {
  payload: AgentCallParticipantInput,
  success: AgentCall,
  error: Schema.Union([AgentCallError, EnvironmentAuthorizationError]),
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
    payload: VmAgentCollaborationSubscribeInput,
    success: VmAgentCollaborationWireStreamItem,
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

export const WsRemoteControlHostAcknowledgeInputRpc = Rpc.make(
  WS_METHODS.remoteControlHostAcknowledgeInput,
  {
    payload: RemoteControlHostAcknowledgeInputInput,
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

export const WsRemoteControlMediaTicketRpc = Rpc.make(WS_METHODS.remoteControlMediaTicket, {
  payload: RemoteControlMediaTicketInput,
  success: MediaChannelTicket,
  error: Schema.Union([RemoteControlError, EnvironmentAuthorizationError]),
});

export const WsRemoteControlHostMediaTicketRpc = Rpc.make(WS_METHODS.remoteControlHostMediaTicket, {
  payload: RemoteControlHostMediaTicketInput,
  success: MediaChannelTicket,
  error: Schema.Union([RemoteControlError, EnvironmentAuthorizationError]),
});

export const WsRemoteControlHostReportPointerRpc = Rpc.make(
  WS_METHODS.remoteControlHostReportPointer,
  {
    payload: RemoteControlHostReportPointerInput,
    error: Schema.Union([RemoteControlError, EnvironmentAuthorizationError]),
  },
);

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

export const WsOrchestrationGetProjectStatisticsRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getProjectStatistics,
  {
    payload: OrchestrationGetProjectStatisticsInput,
    success: OrchestrationRpcSchemas.getProjectStatistics.output,
    error: Schema.Union([OrchestrationGetProjectStatisticsError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationSubscribeProjectFoldersRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.subscribeProjectFolders,
  {
    payload: Schema.Struct({}),
    success: OrchestrationProjectFolders,
    error: EnvironmentAuthorizationError,
    stream: true,
  },
);

export const WsOrchestrationMeasureProjectFoldersRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.measureProjectFolders,
  {
    payload: OrchestrationMeasureProjectFoldersInput,
    success: Schema.Struct({}),
    error: EnvironmentAuthorizationError,
  },
);

export const WsOrchestrationGetArchivedShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
  {
    payload: OrchestrationRpcSchemas.getArchivedShellSnapshot.input,
    success: OrchestrationRpcSchemas.getArchivedShellSnapshot.output,
    error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationDeleteArchivedThreadsRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.deleteArchivedThreads,
  {
    payload: OrchestrationRpcSchemas.deleteArchivedThreads.input,
    success: OrchestrationRpcSchemas.deleteArchivedThreads.output,
    error: Schema.Union([OrchestrationDispatchCommandError, EnvironmentAuthorizationError]),
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
  // A client that understands `providerStatusesPatch` says so; a server that
  // predates it ignores the key and keeps sending full `providerStatuses`.
  payload: Schema.Struct({ acceptsProviderPatches: Schema.optionalKey(Schema.Boolean) }),
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

export const WsSubscribeHostVitalsRpc = Rpc.make(WS_METHODS.subscribeHostVitals, {
  payload: Schema.Struct({}),
  success: HostVitals,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsRpcGroup = RpcGroup.make(
  WsWebPushStatusRpc,
  WsWebPushSubscribeRpc,
  WsWebPushUnsubscribeRpc,
  WsWebPushTestRpc,
  WsServerProbeRpc,
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerConsumeProviderUsageResetRpc,
  WsServerResumeUsageGuardRpc,
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
  WsVoiceTranscriptCorrectRpc,
  WsServerDiscoverSourceControlRpc,
  WsServerGetTraceDiagnosticsRpc,
  WsServerGetProcessDiagnosticsRpc,
  WsServerGetProcessResourceHistoryRpc,
  WsServerGetResourceTelemetryHistoryRpc,
  WsServerRetryResourceTelemetryRpc,
  WsServerStartStorageCleanupRpc,
  WsServerGetDatabaseStorageRpc,
  WsServerScheduleDatabaseCompactionRpc,
  WsServerCancelDatabaseCompactionRpc,
  WsServerStartHostRepairRpc,
  WsServerSignalProcessRpc,
  WsServerReportClientActivityRpc,
  WsServerReportHostPowerStateRpc,
  WsServerGetBackgroundPolicyRpc,
  WsSourceControlLookupRepositoryRpc,
  WsSourceControlCloneRepositoryRpc,
  WsSourceControlPublishRepositoryRpc,
  WsProjectsCheckWorkspaceRootRpc,
  WsProjectsCheckFolderRemovalRpc,
  WsProjectsRemoveWithFolderRpc,
  WsProjectsListEntriesRpc,
  WsProjectsReadFileRpc,
  WsProjectsSearchContentsRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsWriteFileRpc,
  WsShellOpenInEditorRpc,
  WsFilesystemBrowseRpc,
  WsFilesystemPathsExistRpc,
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
  WsPreviewRemoteSnapshotRpc,
  WsPreviewRemoteInputRpc,
  WsPreviewTabAudioWatchRpc,
  WsPreviewTabAudioPublishRpc,
  WsPreviewTabAudioReportRpc,
  WsPreviewMediaWatchRpc,
  WsPreviewMediaTicketRpc,
  WsPreviewHostMediaTicketRpc,
  WsPreviewRemoteFramesRpc,
  WsPreviewRemoteFramePublishRpc,
  WsPreviewReportStatusRpc,
  WsPreviewReportActivityRpc,
  WsPreviewAutomationConnectRpc,
  WsPreviewAutomationRespondRpc,
  WsPreviewAutomationFocusHostRpc,
  WsPreviewCredentialsListRpc,
  WsPreviewCredentialsSaveRpc,
  WsPreviewCredentialsRemoveRpc,
  WsPreviewAccountsSnapshotRpc,
  WsPreviewAccountsSignOutRpc,
  WsPreviewAccountsLinkRpc,
  WsPreviewPasskeysSnapshotRpc,
  WsPreviewPasskeysSetSiteRpc,
  WsPreviewPasskeysRemoveRpc,
  WsDevicesListRpc,
  WsDevicesCatalogRpc,
  WsDevicesCreateRpc,
  WsDevicesDeleteRpc,
  WsDevicesSetPowerRpc,
  WsDevicesViewRpc,
  WsRelayedEnvironmentsPublishRpc,
  WsSubscribeRelayedEnvironmentsRpc,
  WsRemoteControlHostConnectRpc,
  WsRemoteControlHostRespondRpc,
  WsRemoteControlHostPublishFrameRpc,
  WsRemoteControlHostPublishVideoChunkRpc,
  WsRemoteControlHostEndRpc,
  WsRemoteControlHostReportStatusRpc,
  WsRemoteControlHostAcknowledgeInputRpc,
  WsRemoteControlRequestAccessRpc,
  WsRemoteControlWatchRpc,
  WsRemoteControlSendInputRpc,
  WsRemoteControlCancelRpc,
  WsRemoteControlMediaTicketRpc,
  WsRemoteControlHostMediaTicketRpc,
  WsRemoteControlHostReportPointerRpc,
  WsVmAgentCreateRpc,
  WsVmAgentBuilderOpenRpc,
  WsVmAgentDeleteRpc,
  WsVmAgentStartRpc,
  WsVmAgentStopRpc,
  WsVmAgentVoiceSetRpc,
  WsVmAgentRenameRpc,
  WsVmAgentSubscribeRpc,
  WsVmAgentWorkspaceSubscribeRpc,
  WsVmAgentRulesGetRpc,
  WsVmAgentRulesUpdateRpc,
  WsVmAgentAttentionSubscribeRpc,
  WsVmAgentCallsSubscribeRpc,
  WsVmAgentCallPlaceRpc,
  WsVmAgentCallDeclineRpc,
  WsVmAgentCallEndRpc,
  WsVmAgentCallRosterRpc,
  WsVmAgentCallAddParticipantRpc,
  WsVmAgentCallRemoveParticipantRpc,
  WsVmAgentTaskCreateRpc,
  WsVmAgentTaskUpdateRpc,
  WsVmAgentTaskDeleteRpc,
  WsVmAgentTaskRunNowRpc,
  WsVmAgentTaskGeneratePromptRpc,
  WsVmAgentNotificationMarkReadRpc,
  WsVmAgentNotificationUpdateRpc,
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
  WsSubscribeHostVitalsRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationSearchThreadsRpc,
  WsOrchestrationGetProjectStatisticsRpc,
  WsOrchestrationSubscribeProjectFoldersRpc,
  WsOrchestrationMeasureProjectFoldersRpc,
  WsOrchestrationGetArchivedShellSnapshotRpc,
  WsOrchestrationDeleteArchivedThreadsRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
);
