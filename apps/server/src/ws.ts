import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
  AuthAccessStreamError,
  AuthOrchestrationOperateScope,
  type AuthAccessStreamEvent,
  type AuthEnvironmentScope,
  AuthSessionId,
  CommandId,
  type DiscoveredLocalServerList,
  EventId,
  type OrchestrationCommand,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadStreamItem,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationSearchThreadsError,
  OrchestrationGetTurnDiffError,
  ProviderAccountSwitchError,
  ORCHESTRATION_WS_METHODS,
  type ProjectId,
  type ProjectEntriesFailure,
  type ProjectFileFailure,
  type ProjectFileOperation,
  ProjectCheckWorkspaceRootError,
  ProjectListEntriesError,
  ProjectReadFileError,
  ProjectSearchContentsError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  type FilesystemBrowseFailure,
  FilesystemBrowseError,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspaceContextResolutionError,
  RpcClientId,
  EnvironmentAuthorizationError,
  ThreadId,
  type TerminalAttachStreamItem,
  type TerminalEventStreamItem,
  type TerminalLayoutStreamItem,
  type TerminalMetadataStreamItem,
  type VmAgentStreamItem,
  type VmAgentAttentionStreamItem,
  VmAgentNotFoundError,
  VmAgentWorkspaceOperationError,
  type VmAgentWorkspaceStreamItem,
  type VmAgentCollaborationStreamItem,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { HttpRouter, HttpServerRequest, HttpServerRespondable } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "./config.ts";
import {
  activityAuthorizesExternalImagePath,
  messageAuthorizesExternalImagePath,
} from "./assets/ThreadAssetAuthorization.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import {
  projectActivityEvent,
  projectThreadDetailSnapshot,
} from "./orchestration/ActivityPayloadProjection.ts";
import { normalizeDispatchCommand } from "./orchestration/Normalizer.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadSubscriptionRegistry from "./orchestration/Services/ThreadSubscriptionRegistry.ts";
import * as ThreadPendingWorkSignal from "./persistence/Services/ThreadPendingWorkSignal.ts";
import {
  observeRpcEffect as instrumentRpcEffect,
  observeRpcStream as instrumentRpcStream,
  observeRpcStreamEffect as instrumentRpcStreamEffect,
} from "./observability/RpcInstrumentation.ts";
import * as ProviderRegistry from "./provider/Services/ProviderRegistry.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ProviderAccountSwitch from "./provider/providerAccountSwitch.ts";
import * as ServerSelfUpdate from "./service/selfUpdate.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as RemoteControlBroker from "./remoteControl/RemoteControlBroker.ts";
import * as VmManager from "./vm/VmManager.ts";
import * as VmAgentWorkspace from "./vm/VmAgentWorkspace.ts";
import * as VmAgentTaskScheduler from "./vm/VmAgentTaskScheduler.ts";
import * as VmAgentCollaboration from "./vm/VmAgentCollaboration.ts";
import {
  createAgentThread,
  deleteAgentThread,
  notifyAgentBlockerResolved,
  openAgentBuilderThread,
} from "./vm/agentThread.ts";
import { VmAgentStore } from "./persistence/Services/VmAgents.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import * as PreviewManager from "./preview/Manager.ts";
import { issueAssetUrl } from "./assets/AssetAccess.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { requiredScopeForRpcMethod } from "./auth/RpcAuthorization.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as ByteBoundedResyncBuffer from "./stream/ByteBoundedResyncBuffer.ts";
import * as ProjectionLiveBuffer from "./stream/ProjectionLiveBuffer.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import { ThreadArtifactService } from "./artifacts/ThreadArtifactService.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as AzureDevOpsCli from "./sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "./sourceControl/BitbucketApi.ts";
import * as GitHubCli from "./sourceControl/GitHubCli.ts";
import * as GitLabCli from "./sourceControl/GitLabCli.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "./auth/http.ts";
const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const EDITOR_DISCOVERY_TIMEOUT = Duration.seconds(5);
const TERMINAL_STREAM_MAX_BYTES = 1024 * 1024;
const TERMINAL_METADATA_STREAM_MAX_BYTES = 2 * 1024 * 1024;
const TERMINAL_STREAM_MAX_ITEMS = 256;
const terminalStreamTextEncoder = new TextEncoder();

const terminalResyncRequired = {
  type: "resync-required" as const,
  reason: "slow-consumer" as const,
};

function terminalSnapshotByteSize(snapshot: { readonly history: string }): number {
  return terminalStreamTextEncoder.encode(snapshot.history).byteLength + 2_048;
}

function terminalStreamEventByteSize(
  event: TerminalAttachStreamItem | TerminalEventStreamItem,
): number {
  switch (event.type) {
    case "snapshot":
    case "restarted":
      return terminalSnapshotByteSize(event.snapshot);
    case "started":
      return terminalSnapshotByteSize(event.snapshot);
    case "output":
      return terminalStreamTextEncoder.encode(event.data).byteLength + 256;
    case "error":
      return terminalStreamTextEncoder.encode(event.message).byteLength + 256;
    case "activity":
      return terminalStreamTextEncoder.encode(event.label).byteLength + 256;
    case "exited":
    case "closed":
    case "cleared":
    case "resync-required":
      return 256;
  }
}

function terminalMetadataEventByteSize(event: TerminalMetadataStreamItem): number {
  const summaryByteSize = (terminal: {
    readonly cwd: string;
    readonly label: string;
    readonly threadId: string;
    readonly terminalId: string;
  }) =>
    terminalStreamTextEncoder.encode(
      `${terminal.threadId}\u0000${terminal.terminalId}\u0000${terminal.cwd}\u0000${terminal.label}`,
    ).byteLength + 512;
  switch (event.type) {
    case "snapshot":
      return event.terminals.reduce((total, terminal) => total + summaryByteSize(terminal), 512);
    case "upsert":
      return summaryByteSize(event.terminal);
    case "remove":
      return (
        terminalStreamTextEncoder.encode(`${event.threadId}\u0000${event.terminalId}`).byteLength +
        256
      );
    case "resync-required":
      return 256;
  }
}

function terminalLayoutEventByteSize(event: TerminalLayoutStreamItem): number {
  switch (event.type) {
    case "snapshot":
      return terminalStreamTextEncoder.encode(JSON.stringify(event.layouts)).byteLength + 512;
    case "layout":
      return terminalStreamTextEncoder.encode(JSON.stringify(event.layout)).byteLength + 256;
    case "resync-required":
      return 256;
  }
}

export const resolveAvailableEditorsForConfig = <A, E, R>(
  discovery: Effect.Effect<ReadonlyArray<A>, E, R>,
) =>
  discovery.pipe(
    Effect.timeoutOption(EDITOR_DISCOVERY_TIMEOUT),
    Effect.map(Option.getOrElse(() => [])),
  );

function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

/** Preserve the setup runner's broader pre-refactor message normalization. */
function legacySetupFailureDescription(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return String(cause);
}

function projectEntriesFailureContext(error: WorkspaceEntries.WorkspaceEntriesError): {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
} {
  switch (error._tag) {
    case "WorkspaceRootNotExistsError":
      return {
        failure: "workspace_root_not_found",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootCreateFailedError":
      return {
        failure: "workspace_root_create_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootStatFailedError":
      return {
        failure: "workspace_root_stat_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
        detail: error.phase,
      };
    case "WorkspaceRootNotDirectoryError":
      return {
        failure: "workspace_root_not_directory",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceSearchIndexCreateFailed":
      return {
        failure: "search_index_create_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    case "WorkspaceSearchIndexScanTimedOut":
      return {
        failure: "search_index_scan_timed_out",
        normalizedCwd: error.cwd,
        timeout: error.timeout,
      };
    case "WorkspaceSearchIndexSearchFailed":
      return {
        failure: "search_index_search_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function filesystemBrowseFailureContext(error: WorkspaceEntries.WorkspaceEntriesBrowseError): {
  readonly failure: FilesystemBrowseFailure;
  readonly parentPath?: string;
  readonly platform?: string;
} {
  switch (error._tag) {
    case "WorkspaceEntriesWindowsPathUnsupportedError":
      return { failure: "windows_path_unsupported", platform: error.platform };
    case "WorkspaceEntriesCurrentProjectRequiredError":
      return { failure: "current_project_required" };
    case "WorkspaceEntriesReadDirectoryError":
      return { failure: "read_directory_failed", parentPath: error.parentPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function projectFileFailureContext(
  error:
    | WorkspaceFileSystem.WorkspaceFileSystemError
    | WorkspacePaths.WorkspacePathOutsideRootError,
): {
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
} {
  switch (error._tag) {
    case "WorkspacePathOutsideRootError":
      return { failure: "workspace_path_outside_root" };
    case "WorkspaceFileSystemOperationError":
      return {
        failure: "operation_failed",
        resolvedPath: error.resolvedPath,
        operation: error.operation,
        operationPath: error.operationPath,
      };
    case "WorkspaceFilePathEscapeError":
      return {
        failure: "resolved_path_outside_root",
        resolvedPath: error.resolvedPath,
        resolvedWorkspaceRoot: error.resolvedWorkspaceRoot,
      };
    case "WorkspacePathNotFileError":
      return { failure: "path_not_file", resolvedPath: error.resolvedPath };
    case "WorkspaceBinaryFileError":
      return { failure: "binary_file", resolvedPath: error.resolvedPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function projectSetupScriptCompatibilityDetail(
  error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError,
): string {
  switch (error._tag) {
    case "ProjectSetupScriptOperationError":
      return legacySetupFailureDescription(error.cause);
    case "ProjectSetupScriptProjectNotFoundError":
      return "Project was not found for setup script execution.";
    default:
      return unexpectedCompatibilityError(error);
  }
}

function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.session-set";
  }
> {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set"
  );
}

const PROVIDER_STATUS_DEBOUNCE_MS = 200;

// When a resuming client's cursor is more than this many events behind the
// current head, skip the per-event catch-up replay and send a fresh shell
// snapshot instead. Replaying each intervening event costs a shell refetch;
// past this gap a single O(active-threads) snapshot is cheaper and bounded.
// Matches the event store's default page size (DEFAULT_READ_FROM_SEQUENCE_LIMIT).
const SHELL_RESUME_MAX_GAP = 1_000;

// Same bound for thread resume. The replay reads the *global* event range and
// filters per-thread afterwards, so a stale cursor far behind the head would
// otherwise decode every intervening event's payload — reconnects with cursors
// hundreds of thousands of events behind have OOM-killed servers on large
// databases. Past this gap the client is reset with a fresh thread snapshot.
const THREAD_RESUME_MAX_GAP = 1_000;

const THREAD_DETAIL_COALESCE_WINDOW = Duration.millis(50);
const THREAD_DETAIL_COALESCE_MAX_CHUNK = 512;

/**
 * Combine only adjacent chunks for the same streaming assistant message.
 * Keeping the last event's sequence preserves the stream cursor while the
 * first chunk's creation time preserves the message identity clients render.
 * Any lifecycle/activity/marker item is an ordering barrier.
 */
export function coalesceThreadStreamItems(
  items: ReadonlyArray<OrchestrationThreadStreamItem>,
): ReadonlyArray<OrchestrationThreadStreamItem> {
  const output: Array<OrchestrationThreadStreamItem> = [];

  for (const item of items) {
    const previous = output.at(-1);
    if (
      previous?.kind === "event" &&
      item.kind === "event" &&
      previous.event.type === "thread.message-sent" &&
      item.event.type === "thread.message-sent" &&
      previous.event.payload.role === "assistant" &&
      item.event.payload.role === "assistant" &&
      previous.event.payload.streaming &&
      item.event.payload.streaming &&
      previous.event.payload.threadId === item.event.payload.threadId &&
      previous.event.payload.messageId === item.event.payload.messageId
    ) {
      output[output.length - 1] = {
        kind: "event",
        event: {
          ...item.event,
          payload: {
            ...previous.event.payload,
            ...item.event.payload,
            text: previous.event.payload.text + item.event.payload.text,
            createdAt: previous.event.payload.createdAt,
          },
        },
      };
      continue;
    }

    output.push(item);
  }

  return output;
}

const coalesceThreadStream = <E, R>(
  stream: Stream.Stream<OrchestrationThreadStreamItem, E, R>,
): Stream.Stream<OrchestrationThreadStreamItem, E, R> =>
  stream.pipe(
    Stream.groupedWithin(THREAD_DETAIL_COALESCE_MAX_CHUNK, THREAD_DETAIL_COALESCE_WINDOW),
    Stream.map(coalesceThreadStreamItems),
    Stream.flatMap((items) => Stream.fromIterable(items)),
  );

function toAuthAccessStreamEvent(
  change: PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: change.pairingLink,
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}

const VM_AGENT_STREAM_MAX_BYTES = 512 * 1024;
const VM_WORKSPACE_STREAM_MAX_BYTES = 2 * 1024 * 1024;
const VM_STREAM_MAX_ITEMS = 64;

const vmResyncRequired = {
  type: "resync-required" as const,
  reason: "slow-consumer" as const,
};

function vmAgentStreamItemByteSize(item: VmAgentStreamItem): number {
  if (item.type === "snapshot") {
    return item.agents.reduce(
      (sum, agent) => sum + agent.name.length + agent.purpose.length + 256,
      512,
    );
  }
  if (item.type === "upsert") {
    return item.agent.name.length + item.agent.purpose.length + 512;
  }
  return 256;
}

function vmWorkspaceStreamItemByteSize(item: VmAgentWorkspaceStreamItem): number {
  return item.type === "resync-required"
    ? 256
    : terminalStreamTextEncoder.encode(JSON.stringify(item)).byteLength + 512;
}

function vmAttentionStreamItemByteSize(item: VmAgentAttentionStreamItem): number {
  return item.type === "resync-required" ? 256 : item.agents.length * 160 + 256;
}

function vmCollaborationStreamItemByteSize(item: VmAgentCollaborationStreamItem): number {
  return item.type === "resync-required"
    ? 256
    : terminalStreamTextEncoder.encode(JSON.stringify(item)).byteLength + 512;
}

const makeWsRpcLayer = (
  currentSession: EnvironmentAuth.AuthenticatedSession,
  previewAutomationBroker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
  remoteControlBroker: RemoteControlBroker.RemoteControlBroker["Service"],
) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const currentSessionId = currentSession.sessionId;
      const crypto = yield* Crypto.Crypto;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const threadSubscriptionRegistry =
        yield* ThreadSubscriptionRegistry.ThreadSubscriptionRegistry;
      const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
      const threadPendingWorkSignal = yield* ThreadPendingWorkSignal.ThreadPendingWorkSignal;
      const checkpointDiffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const keybindings = yield* Keybindings.Keybindings;
      const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
      const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
      const review = yield* ReviewService.ReviewService;
      const vcsProvisioning = yield* VcsProvisioningService.VcsProvisioningService;
      const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const terminalManager = yield* TerminalManager.TerminalManager;
      const vmManager = yield* VmManager.VmManager;
      const vmAgentWorkspace = yield* VmAgentWorkspace.VmAgentWorkspace;
      const vmAgentTaskScheduler = yield* VmAgentTaskScheduler.VmAgentTaskScheduler;
      const vmAgentCollaboration = yield* VmAgentCollaboration.VmAgentCollaboration;
      const vmAgentStore = yield* VmAgentStore;
      const textGeneration = yield* TextGeneration.TextGeneration;
      const previewManager = yield* PreviewManager.PreviewManager;
      const portDiscovery = yield* PortScanner.PortDiscovery;
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
      const providerAccountSwitch = yield* ProviderAccountSwitch.ProviderAccountSwitch;
      const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
      const config = yield* ServerConfig.ServerConfig;
      const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
      const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
      const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
      const rpcClientIds = yield* Ref.make(new Set<RpcClientId>());
      // Proof that a client exists, independent of whether it reports activity.
      // `rpcClientIds` above is only ever populated *by* the activity report, so
      // on its own it can never distinguish a silent client from no client.
      yield* backgroundPolicy.registerConnection(currentSessionId);
      yield* Effect.addFinalizer(() =>
        Ref.get(rpcClientIds).pipe(
          Effect.flatMap((clientIds) =>
            Effect.forEach(
              clientIds,
              (clientId) => backgroundPolicy.removeRpcClient(currentSessionId, clientId),
              {
                discard: true,
              },
            ),
          ),
          Effect.ignore,
        ),
      );
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sourceControlDiscovery = yield* SourceControlDiscovery.SourceControlDiscovery;
      const automaticGitFetchInterval = serverSettings.getSettings.pipe(
        Effect.map(
          (settings) => resolveServerBackgroundActivitySettings(settings).automaticGitFetchInterval,
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to read automatic Git fetch interval setting", {
            detail: cause.message,
          }).pipe(Effect.as(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
        ),
      );
      const sourceControlRepositories =
        yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const sessions = yield* SessionStore.SessionStore;
      const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
      const processResourceMonitor = yield* ProcessResourceMonitor.ProcessResourceMonitor;
      const resourceTelemetry = yield* ResourceTelemetry.ResourceTelemetry;
      const threadArtifacts = yield* ThreadArtifactService;
      const authorizationError = (requiredScope: AuthEnvironmentScope) =>
        new EnvironmentAuthorizationError({
          message: `The authenticated token is missing required scope: ${requiredScope}.`,
          requiredScope,
        });
      const authorizeEffect = <A, E, R>(
        requiredScope: AuthEnvironmentScope,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.scopes.includes(requiredScope)
          ? effect
          : Effect.fail(authorizationError(requiredScope));
      const authorizeStream = <A, E, R>(
        requiredScope: AuthEnvironmentScope,
        stream: Stream.Stream<A, E, R>,
      ): Stream.Stream<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.scopes.includes(requiredScope)
          ? stream
          : Stream.fail(authorizationError(requiredScope));
      const authorizeDesktopHostEffect = <A, E, R>(
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.subject === "desktop-bootstrap" &&
        currentSession.method === "bearer-access-token"
          ? effect
          : Effect.fail(
              new EnvironmentAuthorizationError({
                message:
                  "Remote-control host operations are only available to the local Solla Code desktop app.",
                requiredScope: AuthOrchestrationOperateScope,
              }),
            );
      const observeRpcEffect = <A, E, R>(
        method: string,
        effect: Effect.Effect<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcEffect(
          method,
          authorizeEffect(requiredScopeForRpcMethod(method), effect),
          traceAttributes,
        );
      const observeRpcStream = <A, E, R>(
        method: string,
        stream: Stream.Stream<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcStream(
          method,
          authorizeStream(requiredScopeForRpcMethod(method), stream),
          traceAttributes,
        );
      const observeRpcStreamEffect = <A, StreamError, StreamContext, EffectError, EffectContext>(
        method: string,
        effect: Effect.Effect<
          Stream.Stream<A, StreamError, StreamContext>,
          EffectError,
          EffectContext
        >,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcStreamEffect(
          method,
          authorizeEffect(requiredScopeForRpcMethod(method), effect),
          traceAttributes,
        );
      const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
        isOrchestrationDispatchCommandError(cause)
          ? cause
          : new OrchestrationDispatchCommandError({
              message: cause instanceof Error ? cause.message : fallbackMessage,
              cause,
            });
      const randomUUID = crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, "Failed to generate orchestration command identifier."),
        ),
      );
      const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
      const serverCommandId = (tag: string) =>
        randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

      const loadAuthAccessSnapshot = () =>
        Effect.all({
          pairingLinks: serverAuth.listPairingLinks(),
          clientSessions: serverAuth.listClientSessions(currentSessionId),
        }).pipe(
          Effect.mapError(
            (error) =>
              new AuthAccessStreamError({
                message: error.message,
              }),
          ),
        );

      const appendSetupScriptActivity = (input: {
        readonly threadId: ThreadId;
        readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
        readonly summary: string;
        readonly createdAt: string;
        readonly payload: Record<string, unknown>;
        readonly tone: "info" | "error";
      }) =>
        Effect.all({
          commandId: serverCommandId("setup-script-activity"),
          activityId: serverEventId,
        }).pipe(
          Effect.flatMap(({ commandId, activityId }) =>
            orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId,
              threadId: input.threadId,
              activity: {
                id: activityId,
                tone: input.tone,
                kind: input.kind,
                summary: input.summary,
                payload: input.payload,
                turnId: null,
                createdAt: input.createdAt,
              },
              createdAt: input.createdAt,
            }),
          ),
        );

      const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
        const error = Cause.squash(cause);
        return isOrchestrationDispatchCommandError(error)
          ? error
          : new OrchestrationDispatchCommandError({
              message:
                error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
              cause,
            });
      };

      const toShellStreamEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> => {
        switch (event.type) {
          case "project.created":
          case "project.meta-updated":
            return projectUpsertOrRemove(event.payload.projectId, event.sequence);
          case "project.deleted":
            return Effect.succeed(
              Option.some({
                kind: "project-removed" as const,
                sequence: event.sequence,
                projectId: event.payload.projectId,
              }),
            );
          case "thread.deleted":
          case "thread.archived":
            return Effect.succeed(
              Option.some({
                kind: "thread-removed" as const,
                sequence: event.sequence,
                threadId: event.payload.threadId,
              }),
            );
          case "thread.unarchived":
            return threadUpsertOrRemove(event.payload.threadId, event.sequence);
          default:
            if (event.aggregateKind !== "thread") {
              return Effect.succeed(Option.none());
            }
            return threadUpsertOrRemove(ThreadId.make(event.aggregateId), event.sequence);
        }
      };

      // Coalescing makes each projection read represent every event for that
      // aggregate in the current window. Retry a typed persistence failure once
      // so a brief read failure cannot strand the shell at its previous state.
      // If both attempts fail, log and drop the stream item; treating an error as
      // a missing row would incorrectly remove a still-active aggregate.
      const retryShellProjectionRead = <A, E>(
        aggregateKind: "project" | "thread",
        aggregateId: string,
        read: Effect.Effect<A, E>,
      ): Effect.Effect<Option.Option<A>, never, never> =>
        read.pipe(
          Effect.retry({ times: 1 }),
          Effect.map(Option.some),
          Effect.tapError((error) =>
            Effect.logWarning("orchestration shell projection refetch failed", {
              aggregateKind,
              aggregateId,
              error,
            }),
          ),
          Effect.orElseSucceed(() => Option.none()),
        );

      const projectUpsertOrRemove = (
        projectId: ProjectId,
        sequence: number,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> =>
        retryShellProjectionRead(
          "project",
          projectId,
          projectionSnapshotQuery.getProjectShellById(projectId),
        ).pipe(
          Effect.map(
            Option.flatMap((project) =>
              Option.match(project, {
                onNone: () =>
                  Option.some<OrchestrationShellStreamEvent>({
                    kind: "project-removed" as const,
                    sequence,
                    projectId,
                  }),
                onSome: (nextProject) =>
                  Option.some<OrchestrationShellStreamEvent>({
                    kind: "project-upserted" as const,
                    sequence,
                    project: nextProject,
                  }),
              }),
            ),
          ),
        );

      // Refetch a thread's shell and emit an upsert if it is still active, or a
      // `thread-removed` if the projection has no active row for it. Emitting a
      // removal on a `none` (rather than dropping the event) is what keeps
      // coalescing correct: when a burst collapses a `thread.deleted`/`archived`
      // into a later refetchable event for the same thread, the refetch returns
      // `none` for the now-inactive row and this still tells the sidebar to drop
      // it. A `thread-removed` the client does not have is a harmless no-op. The
      // projection commits in the same transaction before the event publishes,
      // so a `none` reliably means the thread is deleted or archived, not
      // not-yet-persisted.
      const threadUpsertOrRemove = (
        threadId: ThreadId,
        sequence: number,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> =>
        retryShellProjectionRead(
          "thread",
          threadId,
          projectionSnapshotQuery.getThreadShellById(threadId),
        ).pipe(
          Effect.map(
            Option.flatMap((thread) =>
              Option.match(thread, {
                onNone: () =>
                  Option.some<OrchestrationShellStreamEvent>({
                    kind: "thread-removed" as const,
                    sequence,
                    threadId,
                  }),
                onSome: (nextThread) =>
                  Option.some<OrchestrationShellStreamEvent>({
                    kind: "thread-upserted" as const,
                    sequence,
                    thread: nextThread,
                  }),
              }),
            ),
          ),
        );

      // Turn a batch of domain events into shell stream items, coalescing by
      // aggregate first. `toShellStreamEvent` re-reads the *current* projected
      // shell for an aggregate, so within a batch only the latest event per
      // aggregate matters: a burst of streaming `thread.message-sent` deltas for
      // one thread collapses into a single shell refetch, and an unrelated
      // `thread.created` in the same batch is never stuck behind those DB reads.
      //
      // Input events arrive in ascending sequence; we keep the last (highest
      // sequence) event per aggregate, then re-sort ascending before emitting so
      // the client — which applies shell items strictly by increasing sequence
      // and drops any `sequence <= snapshotSequence` — never skips a coalesced
      // item. The refetch runs with bounded concurrency (order-preserving).
      const SHELL_REFETCH_CONCURRENCY = 8;
      const coalesceShellEvents = (
        events: ReadonlyArray<OrchestrationEvent>,
      ): Effect.Effect<ReadonlyArray<OrchestrationShellStreamEvent>, never, never> =>
        Effect.gen(function* () {
          if (events.length === 0) {
            return [];
          }
          const latestByAggregate = new Map<string, OrchestrationEvent>();
          for (const event of events) {
            latestByAggregate.set(`${event.aggregateKind}:${event.aggregateId}`, event);
          }
          const survivors = Array.from(latestByAggregate.values()).sort(
            (left, right) => left.sequence - right.sequence,
          );
          const shellEvents = yield* Effect.forEach(survivors, toShellStreamEvent, {
            concurrency: SHELL_REFETCH_CONCURRENCY,
          });
          return shellEvents.flatMap((option) => (Option.isSome(option) ? [option.value] : []));
        });

      // Small time/size window over which to coalesce shell events. The window
      // bounds the worst-case added latency for a brand-new thread to appear in
      // the sidebar (imperceptible), while collapsing high-frequency streaming
      // traffic so it can't serialize the shell stream behind per-event DB reads.
      const SHELL_COALESCE_WINDOW = Duration.millis(50);
      const SHELL_COALESCE_MAX_CHUNK = 512;
      // A busy streaming turn emits one item per assistant delta plus one per
      // tool activity, and the buffer must also absorb everything published
      // while a multi-MB snapshot is loading or crossing a slow link. At 256
      // a single live turn overflowed the buffer, forcing a resync — whose
      // snapshot load overflowed again, looping "Catching up" forever on
      // remote clients and dropping live deltas until a remount.
      const PROJECTION_LIVE_BUFFER_CAPACITY = 4096;
      const coalesceShellStream = <E, R>(
        stream: Stream.Stream<OrchestrationEvent, E, R>,
      ): Stream.Stream<OrchestrationShellStreamEvent, E, R> =>
        stream.pipe(
          Stream.groupedWithin(SHELL_COALESCE_MAX_CHUNK, SHELL_COALESCE_WINDOW),
          Stream.mapEffect(coalesceShellEvents),
          Stream.flatMap((items) => Stream.fromIterable(items)),
        );

      type ShellLiveInput =
        | { readonly kind: "event"; readonly event: OrchestrationEvent }
        | { readonly kind: "pending-work"; readonly threadId: ThreadId }
        | { readonly kind: "synchronized" }
        | { readonly kind: "resync-required" };

      // Read a thread's current pending work for a scheduler transition that
      // produced no event. Reuses the shell read so the value can never
      // disagree with the one a `thread-upserted` would have carried; a thread
      // the projection no longer holds is simply dropped, since `thread-removed`
      // is the event path's job.
      const threadPendingWorkItem = (
        threadId: ThreadId,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamItem>, never, never> =>
        retryShellProjectionRead(
          "thread",
          threadId,
          projectionSnapshotQuery.getThreadShellById(threadId),
        ).pipe(
          Effect.map(
            Option.flatMap(
              Option.map((thread) => ({
                kind: "thread-pending-work" as const,
                threadId,
                pendingWork: thread.pendingWork ?? null,
              })),
            ),
          ),
        );

      // One marker-free stretch of the live stream: the events coalesce as
      // usual, then any pending-work signal the events did not already cover.
      const coalesceShellSegment = (
        events: ReadonlyArray<OrchestrationEvent>,
        pendingWorkThreadIds: ReadonlySet<ThreadId>,
      ): Effect.Effect<ReadonlyArray<OrchestrationShellStreamItem>, never, never> =>
        Effect.gen(function* () {
          const items: Array<OrchestrationShellStreamItem> = [
            ...(yield* coalesceShellEvents(events)),
          ];
          // A thread with an event in this window just refetched its entire
          // shell, pendingWork included, so its signal would only repeat that
          // read — and a scheduler transition is usually *caused* by the event
          // next to it, which is where most signals land.
          const refetched = new Set(
            events
              .filter((event) => event.aggregateKind === "thread")
              .map((event) => event.aggregateId),
          );
          const uncovered = Array.from(pendingWorkThreadIds).filter(
            (threadId) => !refetched.has(threadId),
          );
          const pendingWorkItems = yield* Effect.forEach(uncovered, threadPendingWorkItem, {
            concurrency: SHELL_REFETCH_CONCURRENCY,
          });
          for (const item of pendingWorkItems) {
            if (Option.isSome(item)) {
              items.push(item.value);
            }
          }
          return items;
        });

      // A completion marker is queued alongside raw live events so it cannot
      // overtake an event still waiting in the coalescing window. Split each
      // batch at markers and coalesce only the segments on either side.
      const coalesceShellLiveInputs = (
        inputs: ReadonlyArray<ShellLiveInput>,
      ): Effect.Effect<ReadonlyArray<OrchestrationShellStreamItem>, never, never> =>
        Effect.gen(function* () {
          const output: Array<OrchestrationShellStreamItem> = [];
          let pendingEvents: Array<OrchestrationEvent> = [];
          let pendingWorkThreadIds = new Set<ThreadId>();

          for (const input of inputs) {
            if (input.kind === "event") {
              pendingEvents.push(input.event);
              continue;
            }
            if (input.kind === "pending-work") {
              pendingWorkThreadIds.add(input.threadId);
              continue;
            }

            output.push(...(yield* coalesceShellSegment(pendingEvents, pendingWorkThreadIds)));
            pendingEvents = [];
            pendingWorkThreadIds = new Set();
            output.push({ kind: input.kind });
          }

          output.push(...(yield* coalesceShellSegment(pendingEvents, pendingWorkThreadIds)));
          return output;
        });

      const coalesceShellLiveStream = <E, R>(
        stream: Stream.Stream<ShellLiveInput, E, R>,
      ): Stream.Stream<OrchestrationShellStreamItem, E, R> =>
        stream.pipe(
          Stream.groupedWithin(SHELL_COALESCE_MAX_CHUNK, SHELL_COALESCE_WINDOW),
          Stream.mapEffect(coalesceShellLiveInputs),
          Stream.flatMap((items) => Stream.fromIterable(items)),
        );

      const dispatchBootstrapTurnStart = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
        Effect.gen(function* () {
          const bootstrap = command.bootstrap;
          const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
          let createdThread = false;
          let targetProjectId = bootstrap?.createThread?.projectId;
          let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
          let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

          const cleanupCreatedThread = () =>
            createdThread
              ? serverCommandId("bootstrap-thread-delete").pipe(
                  Effect.flatMap((commandId) =>
                    orchestrationEngine.dispatch({
                      type: "thread.delete",
                      commandId,
                      threadId: command.threadId,
                    }),
                  ),
                  Effect.ignoreCause({ log: true }),
                )
              : Effect.void;

          const recordSetupScriptLaunchFailure = (input: {
            readonly error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError;
            readonly requestedAt: string;
            readonly worktreePath: string;
          }) => {
            const detail = projectSetupScriptCompatibilityDetail(input.error);
            return appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.failed",
              summary: "Setup script failed to start",
              createdAt: input.requestedAt,
              payload: {
                detail,
                worktreePath: input.worktreePath,
              },
              tone: "error",
            }).pipe(
              Effect.ignoreCause({ log: false }),
              Effect.flatMap(() =>
                Effect.logWarning("bootstrap turn start failed to launch setup script", {
                  threadId: command.threadId,
                  worktreePath: input.worktreePath,
                  detail,
                }),
              ),
            );
          };

          const recordSetupScriptStarted = (input: {
            readonly requestedAt: string;
            readonly worktreePath: string;
            readonly scriptId: string;
            readonly scriptName: string;
            readonly terminalId: string;
          }) =>
            Effect.gen(function* () {
              const startedAt = yield* nowIso;
              const payload = {
                scriptId: input.scriptId,
                scriptName: input.scriptName,
                terminalId: input.terminalId,
                worktreePath: input.worktreePath,
              };
              yield* Effect.all([
                appendSetupScriptActivity({
                  threadId: command.threadId,
                  kind: "setup-script.requested",
                  summary: "Starting setup script",
                  createdAt: input.requestedAt,
                  payload,
                  tone: "info",
                }),
                appendSetupScriptActivity({
                  threadId: command.threadId,
                  kind: "setup-script.started",
                  summary: "Setup script started",
                  createdAt: startedAt,
                  payload,
                  tone: "info",
                }),
              ]).pipe(
                Effect.asVoid,
                Effect.catch((error) =>
                  Effect.logWarning(
                    "bootstrap turn start launched setup script but failed to record setup activity",
                    {
                      threadId: command.threadId,
                      worktreePath: input.worktreePath,
                      scriptId: input.scriptId,
                      terminalId: input.terminalId,
                      detail: error.message,
                    },
                  ),
                ),
              );
            });

          const runSetupProgram = () =>
            Effect.gen(function* () {
              if (!bootstrap?.runSetupScript || !targetWorktreePath) {
                return;
              }
              const worktreePath = targetWorktreePath;
              const requestedAt = yield* nowIso;
              yield* projectSetupScriptRunner
                .runForThread({
                  threadId: command.threadId,
                  ...(targetProjectId ? { projectId: targetProjectId } : {}),
                  ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
                  worktreePath,
                })
                .pipe(
                  Effect.matchEffect({
                    onFailure: (error) =>
                      recordSetupScriptLaunchFailure({
                        error,
                        requestedAt,
                        worktreePath,
                      }),
                    onSuccess: (setupResult) => {
                      if (setupResult.status !== "started") {
                        return Effect.void;
                      }
                      return recordSetupScriptStarted({
                        requestedAt,
                        worktreePath,
                        scriptId: setupResult.scriptId,
                        scriptName: setupResult.scriptName,
                        terminalId: setupResult.terminalId,
                      });
                    },
                  }),
                );
            });

          const bootstrapProgram = Effect.gen(function* () {
            if (bootstrap?.createThread) {
              yield* orchestrationEngine.dispatch({
                type: "thread.create",
                commandId: yield* serverCommandId("bootstrap-thread-create"),
                threadId: command.threadId,
                projectId: bootstrap.createThread.projectId,
                title: bootstrap.createThread.title,
                modelSelection: bootstrap.createThread.modelSelection,
                runtimeMode: bootstrap.createThread.runtimeMode,
                interactionMode: bootstrap.createThread.interactionMode,
                branch: bootstrap.createThread.branch,
                worktreePath: bootstrap.createThread.worktreePath,
                createdAt: bootstrap.createThread.createdAt,
              });
              createdThread = true;
            }

            if (bootstrap?.prepareWorktree) {
              let worktreeBaseRef = bootstrap.prepareWorktree.baseBranch;
              if (bootstrap.prepareWorktree.startFromOrigin) {
                yield* gitWorkflow.fetchRemote({
                  cwd: bootstrap.prepareWorktree.projectCwd,
                  remoteName: "origin",
                });
                const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
                  cwd: bootstrap.prepareWorktree.projectCwd,
                  refName: bootstrap.prepareWorktree.baseBranch,
                  fallbackRemoteName: "origin",
                });
                worktreeBaseRef = resolvedRemoteBase.commitSha;
              }
              const worktree = yield* gitWorkflow.createWorktree({
                cwd: bootstrap.prepareWorktree.projectCwd,
                refName: worktreeBaseRef,
                newRefName: bootstrap.prepareWorktree.branch,
                baseRefName: bootstrap.prepareWorktree.baseBranch,
                path: null,
              });
              targetWorktreePath = worktree.worktree.path;
              yield* orchestrationEngine.dispatch({
                type: "thread.meta.update",
                commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
                threadId: command.threadId,
                branch: worktree.worktree.refName,
                worktreePath: targetWorktreePath,
              });
              yield* refreshGitStatus(targetWorktreePath);
            }

            yield* runSetupProgram();

            return yield* orchestrationEngine.dispatch(finalTurnStartCommand);
          });

          return yield* bootstrapProgram.pipe(
            Effect.catchCause((cause) => {
              const dispatchError = toBootstrapDispatchCommandCauseError(cause);
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.fail(dispatchError);
              }
              return cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.fail(dispatchError)));
            }),
          );
        });

      const dispatchNormalizedCommand = (
        normalizedCommand: OrchestrationCommand,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
        const dispatchEffect =
          normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap
            ? dispatchBootstrapTurnStart(normalizedCommand)
            : orchestrationEngine
                .dispatch(normalizedCommand)
                .pipe(
                  Effect.mapError((cause) =>
                    toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
                  ),
                );

        return startup
          .enqueueCommand(dispatchEffect)
          .pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
            ),
          );
      };

      const loadServerConfig = Effect.gen(function* () {
        const keybindingsConfig = yield* keybindings.loadConfigState;
        const providers = yield* providerRegistry.getProviders;
        const settings = ServerSettings.redactServerSettingsForClient(
          yield* serverSettings.getSettings,
        );
        const environment = yield* serverEnvironment.getDescriptor;
        const auth = yield* serverAuth.getDescriptor();

        return {
          environment,
          auth,
          cwd: config.cwd,
          keybindingsConfigPath: config.keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers,
          availableEditors: yield* resolveAvailableEditorsForConfig(
            externalLauncher.resolveAvailableEditors(),
          ),
          observability: {
            logsDirectoryPath: config.logsDir,
            localTracingEnabled: true,
            ...(config.otlpTracesUrl !== undefined ? { otlpTracesUrl: config.otlpTracesUrl } : {}),
            otlpTracesEnabled: config.otlpTracesUrl !== undefined,
            ...(config.otlpMetricsUrl !== undefined
              ? { otlpMetricsUrl: config.otlpMetricsUrl }
              : {}),
            otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
          },
          settings,
          shellResumeCompletionMarker: true,
          shellPendingWorkUpdates: true,
          threadResumeCompletionMarker: true,
        };
      });

      const refreshGitStatus = (cwd: string) =>
        vcsStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

      return WsRpcGroup.of({
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.dispatchCommand,
            Effect.gen(function* () {
              const normalizedCommand = yield* normalizeDispatchCommand(command);
              const shouldStopSessionAfterArchive =
                normalizedCommand.type === "thread.archive"
                  ? yield* projectionSnapshotQuery
                      .getThreadShellById(normalizedCommand.threadId)
                      .pipe(
                        Effect.map(
                          Option.match({
                            onNone: () => false,
                            onSome: (thread) =>
                              thread.session !== null && thread.session.status !== "stopped",
                          }),
                        ),
                        Effect.orElseSucceed(() => false),
                      )
                  : false;
              const result = yield* dispatchNormalizedCommand(normalizedCommand);
              if (normalizedCommand.type === "thread.archive") {
                if (shouldStopSessionAfterArchive) {
                  yield* Effect.gen(function* () {
                    const stopCommand = yield* normalizeDispatchCommand({
                      type: "thread.session.stop",
                      commandId: CommandId.make(
                        `session-stop-for-archive:${normalizedCommand.commandId}`,
                      ),
                      threadId: normalizedCommand.threadId,
                      createdAt: yield* nowIso,
                    });

                    yield* dispatchNormalizedCommand(stopCommand);
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("failed to stop provider session during archive", {
                        threadId: normalizedCommand.threadId,
                        cause,
                      }),
                    ),
                  );
                }

                yield* terminalManager.close({ threadId: normalizedCommand.threadId }).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to close thread terminals after archive", {
                      threadId: normalizedCommand.threadId,
                      error: error.message,
                    }),
                  ),
                );
              }
              return result;
            }).pipe(
              Effect.mapError((cause) =>
                isOrchestrationDispatchCommandError(cause)
                  ? cause
                  : new OrchestrationDispatchCommandError({
                      message: "Failed to dispatch orchestration command",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTurnDiff,
            checkpointDiffQuery.getTurnDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetTurnDiffError({
                    message: "Failed to load turn diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getFullThreadDiff,
            checkpointDiffQuery.getFullThreadDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetFullThreadDiffError({
                    message: "Failed to load full thread diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.searchThreads]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.searchThreads,
            projectionSnapshotQuery.searchThreads(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationSearchThreadsError({
                    message: "Failed to search threads",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeShell,
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                threadSubscriptionRegistry.acquireShell(),
                threadSubscriptionRegistry.release,
              );
              // Coalesce the live shell stream per aggregate over a small window
              // so bursts of high-frequency events (streaming message deltas,
              // activity appends) collapse into a single shell refetch and never
              // serialize a brand-new thread's `thread.created` behind hundreds
              // of per-event DB reads. See coalesceShellStream.
              // Attach live delivery into a scope-bound buffer BEFORE loading any
              // snapshot or draining catch-up, otherwise an event published while
              // the snapshot query is in flight is lost (it is past the snapshot's
              // sequence but the live subscription is not attached yet). Every
              // path below emits from this same buffered live tail. Overlapping
              // events are deduped by sequence on the client.
              const liveBuffer = yield* ProjectionLiveBuffer.make<ShellLiveInput>({
                capacity: PROJECTION_LIVE_BUFFER_CAPACITY,
                resyncItem: { kind: "resync-required" },
              });
              yield* Effect.forkScoped(
                orchestrationEngine.streamDomainEvents.pipe(
                  Stream.runForEach((event) => liveBuffer.offer({ kind: "event", event })),
                ),
                { startImmediately: true },
              );
              // Scheduler transitions append nothing to the event log, so a
              // thread whose queued work resolves after its last event would
              // otherwise keep whatever this client read last — the "Auto-
              // resuming" row that never stops counting. Attached to the same
              // buffer, before any snapshot, for the same reason events are.
              // Only for clients that asked: older ones cannot decode the item.
              if (input.requestPendingWorkUpdates === true) {
                yield* Effect.forkScoped(
                  threadPendingWorkSignal.changes.pipe(
                    Stream.runForEach((threadId) =>
                      liveBuffer.offer({ kind: "pending-work", threadId }),
                    ),
                  ),
                  { startImmediately: true },
                );
              }
              const bufferedLiveStream = coalesceShellLiveStream(liveBuffer.stream);

              const loadSnapshot = projectionSnapshotQuery.getShellSnapshot().pipe(
                Effect.tapError((cause) =>
                  Effect.logError("orchestration shell snapshot load failed", { cause }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "Failed to load orchestration shell snapshot",
                      cause,
                    }),
                ),
              );

              // Offer the completion marker into the same queue as live events.
              // Anything buffered while snapshot/replay work was in flight is
              // therefore delivered before the client is told it is synchronized.
              const synchronizedThenLive =
                input.requestCompletionMarker === true
                  ? Stream.concat(
                      Stream.fromEffect(
                        liveBuffer
                          .offer({ kind: "synchronized" })
                          .pipe(
                            Effect.andThen(liveBuffer.takeAll),
                            Effect.flatMap(coalesceShellLiveInputs),
                          ),
                      ).pipe(Stream.flatMap((items) => Stream.fromIterable(items))),
                      bufferedLiveStream,
                    )
                  : bufferedLiveStream;

              // When the client already holds a shell snapshot (cached, or loaded
              // over HTTP) it passes that snapshot's sequence, and we resume by
              // replaying shell events after it instead of re-sending the whole
              // projects/threads list over the socket. If the client is too far
              // behind, we fall back to a fresh snapshot instead of an unbounded
              // replay (see below).
              if (input.afterSequence !== undefined) {
                const afterSequence = input.afterSequence;
                const headSequence = yield* orchestrationEngine.latestSequence;
                const replayGap = headSequence - afterSequence;
                // Gap too large: replaying every intervening event (each a shell
                // refetch) is far more expensive than a single O(active-threads)
                // snapshot. A cursor ahead of this engine's authoritative state
                // is also invalid, so reset it with a snapshot. Send the snapshot
                // followed by the buffered live tail, exactly as the
                // no-afterSequence path does.
                if (replayGap < 0 || replayGap > SHELL_RESUME_MAX_GAP) {
                  const snapshot = yield* loadSnapshot;
                  return Stream.concat(
                    Stream.make({ kind: "snapshot" as const, snapshot }),
                    synchronizedThenLive,
                  );
                }
                const catchUpStream = coalesceShellStream(
                  // Replay only through the head captured above. Newer events
                  // are already covered by the live subscription, so this bound
                  // cannot chase a moving event-store head or grow the live
                  // buffer indefinitely while waiting for an empty page.
                  orchestrationEngine.readEvents(afterSequence, replayGap),
                ).pipe(
                  Stream.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: "Failed to replay orchestration shell events",
                        cause,
                      }),
                  ),
                );
                return Stream.concat(catchUpStream, synchronizedThenLive);
              }

              const snapshot = yield* loadSnapshot;
              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot,
                }),
                synchronizedThenLive,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
            projectionSnapshotQuery.getArchivedShellSnapshot().pipe(
              Effect.tapError((cause) =>
                Effect.logError("orchestration archived shell snapshot load failed", { cause }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to load archived orchestration shell snapshot",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeThread,
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                threadSubscriptionRegistry.acquireDetail(input.threadId),
                threadSubscriptionRegistry.release,
              );
              const isThisThreadDetailEvent = (event: OrchestrationEvent) =>
                event.aggregateKind === "thread" &&
                event.aggregateId === input.threadId &&
                isThreadDetailEvent(event);

              const liveStream = orchestrationEngine.streamDomainEvents.pipe(
                Stream.filter(isThisThreadDetailEvent),
                Stream.map((event) => ({
                  kind: "event" as const,
                  event: projectActivityEvent(event),
                })),
              );

              // Attach live delivery before reading either replay or snapshot state.
              // Otherwise an event published while the snapshot is loading is lost.
              const liveBuffer = yield* ProjectionLiveBuffer.make<OrchestrationThreadStreamItem>({
                capacity: PROJECTION_LIVE_BUFFER_CAPACITY,
                resyncItem: { kind: "resync-required" },
              });
              yield* Effect.forkScoped(liveStream.pipe(Stream.runForEach(liveBuffer.offer)));
              const bufferedLiveStream = coalesceThreadStream(liveBuffer.stream);
              const synchronizedThenLive =
                input.requestCompletionMarker === true
                  ? Stream.concat(
                      Stream.fromEffect(
                        liveBuffer
                          .offer({ kind: "synchronized" })
                          .pipe(
                            Effect.andThen(liveBuffer.takeAll),
                            Effect.map(coalesceThreadStreamItems),
                          ),
                      ).pipe(Stream.flatMap((items) => Stream.fromIterable(items))),
                      bufferedLiveStream,
                    )
                  : bufferedLiveStream;

              // When the client already loaded the snapshot over HTTP it passes
              // that snapshot's sequence, and we resume the live subscription by
              // replaying persisted events after it instead of re-sending the
              // (potentially multi-KB) snapshot frame over the socket.
              //
              // The live PubSub subscription must be attached *before* draining
              // the catch-up replay, otherwise events published during the replay
              // window are dropped (they are past the persisted tail the replay
              // read, but the live stream is not yet subscribed). So fork the
              // live stream into a buffer bound to this stream's scope, then emit
              // catch-up followed by the buffered/ongoing live events. Overlapping
              // events are deduped by sequence on the client.
              //
              // The replay is bounded to the projection head captured below. The
              // catch-up range is normally tiny (a fresh HTTP snapshot sequence),
              // but a stale cached cursor can sit hundreds of thousands of global
              // events behind — replaying that decodes every intervening event
              // (including every other thread's tool payloads) only to discard
              // almost all of them, which has OOM-killed servers on large
              // databases. A truncated replay would silently drop this thread's
              // events, so past the gap cap we reset the client with a fresh
              // thread snapshot instead, exactly like subscribeShell above.
              if (input.afterSequence !== undefined) {
                const afterSequence = input.afterSequence;
                const headSequence = yield* orchestrationEngine.latestSequence;
                const replayGap = headSequence - afterSequence;
                if (replayGap >= 0 && replayGap <= THREAD_RESUME_MAX_GAP) {
                  const catchUpStream = orchestrationEngine
                    .readEvents(afterSequence, replayGap)
                    .pipe(
                      Stream.filter(isThisThreadDetailEvent),
                      Stream.map((event) => ({
                        kind: "event" as const,
                        event: projectActivityEvent(event),
                      })),
                      Stream.mapError(
                        (cause) =>
                          new OrchestrationGetSnapshotError({
                            message: `Failed to replay thread ${input.threadId} events`,
                            cause,
                          }),
                      ),
                    );
                  return Stream.concat(catchUpStream, synchronizedThenLive);
                }
                // Gap too large (or cursor ahead of authoritative state): fall
                // through to the snapshot path so the client converges from a
                // fresh thread detail instead of an unbounded replay.
              }

              const snapshot = yield* projectionSnapshotQuery
                .getThreadDetailSnapshot(input.threadId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: `Failed to load thread ${input.threadId}`,
                        cause,
                      }),
                  ),
                );

              if (Option.isNone(snapshot)) {
                return yield* new OrchestrationGetSnapshotError({
                  message: `Thread ${input.threadId} was not found`,
                  cause: input.threadId,
                });
              }

              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot: projectThreadDetailSnapshot(snapshot.value),
                }),
                synchronizedThenLive,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [WS_METHODS.serverProbe]: (_input) =>
          observeRpcEffect(WS_METHODS.serverProbe, Effect.succeed({}), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetConfig]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetConfig, loadServerConfig, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverRefreshProviders]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverRefreshProviders,
            (input.instanceId !== undefined
              ? providerRegistry.refreshInstance(input.instanceId)
              : providerRegistry.refresh()
            ).pipe(Effect.map((providers) => ({ providers }))),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverStartProviderAccountSwitch]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverStartProviderAccountSwitch,
            providerAccountSwitch.start(input.instanceId),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetProviderAccountSwitch]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetProviderAccountSwitch,
            providerAccountSwitch.get(input),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverOpenProviderAccountSwitchAuthLink]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverOpenProviderAccountSwitchAuthLink,
            Effect.gen(function* () {
              const state = yield* providerAccountSwitch.get(input);
              if (!state || !state.authUrl) {
                return yield* new ProviderAccountSwitchError({
                  instanceId: input.instanceId,
                  reason: "The provider login link is not available yet.",
                });
              }
              yield* externalLauncher.launchBrowser(state.authUrl).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAccountSwitchError({
                      instanceId: input.instanceId,
                      reason: "The provider login link could not be opened on the host machine.",
                      cause,
                    }),
                ),
              );
              return state;
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverSubmitProviderAccountSwitchCode]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverSubmitProviderAccountSwitchCode,
            providerAccountSwitch.submitCode(input),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverCancelProviderAccountSwitch]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverCancelProviderAccountSwitch,
            providerAccountSwitch.cancel(input),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverUpdateProvider]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateProvider,
            providerMaintenanceRunner.updateProvider(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpdateServer]: (input) =>
          observeRpcEffect(WS_METHODS.serverUpdateServer, serverSelfUpdate.update(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverUpsertKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverUpsertKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverRemoveKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverRemoveKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.removeKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetSettings]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetSettings,
            serverSettings.getSettings.pipe(
              Effect.map(ServerSettings.redactServerSettingsForClient),
            ),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateSettings,
            serverSettings
              .updateSettings(patch)
              .pipe(Effect.map(ServerSettings.redactServerSettingsForClient)),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverDiscoverSourceControl]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverDiscoverSourceControl,
            sourceControlDiscovery.discover,
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetTraceDiagnostics]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetTraceDiagnostics,
            TraceDiagnostics.readTraceDiagnostics({
              traceFilePath: config.serverTracePath,
              maxFiles: config.traceMaxFiles,
            }),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetProcessDiagnostics]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetProcessDiagnostics, processDiagnostics.read, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetProcessResourceHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetProcessResourceHistory,
            processResourceMonitor.readHistory(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetResourceTelemetryHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetResourceTelemetryHistory,
            resourceTelemetry.readHistory(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverRetryResourceTelemetry]: (_input) =>
          observeRpcEffect(WS_METHODS.serverRetryResourceTelemetry, resourceTelemetry.retry, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverSignalProcess]: (input) =>
          observeRpcEffect(WS_METHODS.serverSignalProcess, processDiagnostics.signal(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverReportClientActivity]: (input, metadata) =>
          Ref.update(rpcClientIds, (clientIds) => {
            const next = new Set(clientIds);
            next.add(RpcClientId.make(metadata.client.id));
            return next;
          }).pipe(
            Effect.andThen(
              observeRpcEffect(
                WS_METHODS.serverReportClientActivity,
                backgroundPolicy.reportClientActivity(
                  currentSessionId,
                  RpcClientId.make(metadata.client.id),
                  input,
                ),
                { "rpc.aggregate": "server" },
              ),
            ),
          ),
        [WS_METHODS.serverReportHostPowerState]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverReportHostPowerState,
            backgroundPolicy.reportHostPowerState(input),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetBackgroundPolicy]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetBackgroundPolicy, backgroundPolicy.snapshot, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.sourceControlLookupRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlLookupRepository,
            sourceControlRepositories.lookupRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlCloneRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlCloneRepository,
            sourceControlRepositories.cloneRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlPublishRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlPublishRepository,
            sourceControlRepositories
              .publishRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchEntries,
            workspaceEntries.search(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSearchEntriesError({
                    cwd: input.cwd,
                    queryLength: input.query.length,
                    limit: input.limit,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsSearchContents]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchContents,
            workspaceEntries.searchContents(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSearchContentsError({
                    cwd: input.cwd,
                    queryLength: input.query.length,
                    limit: input.limit,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsCheckWorkspaceRoot]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsCheckWorkspaceRoot,
            Effect.gen(function* () {
              const project = yield* projectionSnapshotQuery
                .getProjectShellById(input.projectId)
                .pipe(
                  Effect.mapError(
                    (cause) => new ProjectCheckWorkspaceRootError({ detail: cause.message }),
                  ),
                );
              if (Option.isNone(project)) {
                return yield* new ProjectCheckWorkspaceRootError({
                  detail: `Unknown project: ${input.projectId}`,
                });
              }
              const exists = yield* workspaceEntries
                .rootExists(project.value.workspaceRoot)
                .pipe(
                  Effect.mapError(
                    (cause) => new ProjectCheckWorkspaceRootError({ detail: cause.message }),
                  ),
                );
              return { workspaceRoot: project.value.workspaceRoot, exists };
            }),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsListEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsListEntries,
            workspaceEntries.list(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectListEntriesError({
                    ...input,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsReadFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsReadFile,
            workspaceFileSystem.readFile(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectReadFileError({
                    ...input,
                    ...projectFileFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsWriteFile,
            workspaceFileSystem.writeFile(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectWriteFileError({
                    cwd: input.cwd,
                    relativePath: input.relativePath,
                    ...projectFileFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.shellOpenInEditor]: (input) =>
          observeRpcEffect(WS_METHODS.shellOpenInEditor, externalLauncher.launchEditor(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.filesystemBrowse]: (input) =>
          observeRpcEffect(
            WS_METHODS.filesystemBrowse,
            workspaceEntries.browse(input).pipe(
              Effect.mapError(
                (cause) =>
                  new FilesystemBrowseError({
                    ...input,
                    ...filesystemBrowseFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.assetsCreateUrl]: (input) =>
          observeRpcEffect(
            WS_METHODS.assetsCreateUrl,
            Effect.gen(function* () {
              if (
                input.resource._tag === "artifact-revision" ||
                input.resource._tag === "artifact-icon"
              ) {
                const artifactResource = input.resource;
                const detail = yield* threadArtifacts
                  .get({
                    threadId: artifactResource.threadId,
                    artifactId: artifactResource.artifactId,
                  })
                  .pipe(
                    Effect.mapError(
                      () =>
                        new AssetWorkspaceContextNotFoundError({
                          resource: artifactResource,
                        }),
                    ),
                  );
                if (
                  !detail.revisions.some(
                    (revision) => revision.revision === artifactResource.revision,
                  )
                ) {
                  return yield* new AssetWorkspaceContextNotFoundError({
                    resource: artifactResource,
                  });
                }
                return yield* issueAssetUrl({ resource: artifactResource });
              }
              if (input.resource._tag !== "workspace-file") {
                return yield* issueAssetUrl({ resource: input.resource });
              }
              const workspaceResource = input.resource;
              const thread = yield* projectionSnapshotQuery
                .getThreadShellById(workspaceResource.threadId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AssetWorkspaceContextResolutionError({
                        resource: workspaceResource,
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(thread)) {
                return yield* new AssetWorkspaceContextNotFoundError({
                  resource: workspaceResource,
                });
              }
              const project = yield* projectionSnapshotQuery
                .getProjectShellById(thread.value.projectId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AssetWorkspaceContextResolutionError({
                        resource: workspaceResource,
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(project)) {
                return yield* new AssetWorkspaceContextNotFoundError({
                  resource: workspaceResource,
                });
              }
              const allowExternalExactImage =
                workspaceResource.sourceActivityId || workspaceResource.sourceMessageId
                  ? yield* (
                      projectionSnapshotQuery.getThreadAssetSource
                        ? projectionSnapshotQuery.getThreadAssetSource(workspaceResource.threadId, {
                            ...(workspaceResource.sourceActivityId
                              ? { activityId: workspaceResource.sourceActivityId }
                              : {}),
                            ...(workspaceResource.sourceMessageId
                              ? { messageId: workspaceResource.sourceMessageId }
                              : {}),
                          })
                        : projectionSnapshotQuery
                            .getThreadDetailById(workspaceResource.threadId)
                            .pipe(
                              Effect.map((detail) => ({
                                activity: Option.isSome(detail)
                                  ? (detail.value.activities.find(
                                      (activity) =>
                                        activity.id === workspaceResource.sourceActivityId,
                                    ) ?? null)
                                  : null,
                                message: Option.isSome(detail)
                                  ? (detail.value.messages.find(
                                      (message) => message.id === workspaceResource.sourceMessageId,
                                    ) ?? null)
                                  : null,
                              })),
                            )
                    ).pipe(
                      Effect.mapError(
                        (cause) =>
                          new AssetWorkspaceContextResolutionError({
                            resource: workspaceResource,
                            cause,
                          }),
                      ),
                      Effect.map((source) => {
                        const sourceActivity = source.activity;
                        if (
                          sourceActivity &&
                          activityAuthorizesExternalImagePath(
                            sourceActivity,
                            workspaceResource.path,
                          )
                        ) {
                          return true;
                        }
                        const sourceMessage = source.message;
                        return sourceMessage
                          ? messageAuthorizesExternalImagePath(
                              sourceMessage,
                              workspaceResource.path,
                            )
                          : false;
                      }),
                    )
                  : false;
              return yield* issueAssetUrl({
                resource: workspaceResource,
                workspaceRoot: thread.value.worktreePath ?? project.value.workspaceRoot,
                allowExternalExactImage,
              });
            }),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.threadArtifactsList]: (input) =>
          observeRpcEffect(WS_METHODS.threadArtifactsList, threadArtifacts.list(input), {
            "rpc.aggregate": "artifacts",
          }),
        [WS_METHODS.threadArtifactsGet]: (input) =>
          observeRpcEffect(WS_METHODS.threadArtifactsGet, threadArtifacts.get(input), {
            "rpc.aggregate": "artifacts",
          }),
        [WS_METHODS.threadArtifactsArchive]: (input) =>
          observeRpcEffect(
            WS_METHODS.threadArtifactsArchive,
            threadArtifacts.setArchived({ ...input, archived: true }),
            { "rpc.aggregate": "artifacts" },
          ),
        [WS_METHODS.threadArtifactsRestore]: (input) =>
          observeRpcEffect(
            WS_METHODS.threadArtifactsRestore,
            threadArtifacts.setArchived({ ...input, archived: false }),
            { "rpc.aggregate": "artifacts" },
          ),
        [WS_METHODS.threadArtifactsDelete]: (input) =>
          observeRpcEffect(
            WS_METHODS.threadArtifactsDelete,
            threadArtifacts.deleteArtifact(input),
            {
              "rpc.aggregate": "artifacts",
            },
          ),
        [WS_METHODS.threadArtifactsSubscribe]: (input) =>
          observeRpcStream(WS_METHODS.threadArtifactsSubscribe, threadArtifacts.subscribe(input), {
            "rpc.aggregate": "artifacts",
          }),
        [WS_METHODS.subscribeVcsStatus]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeVcsStatus,
            vcsStatusBroadcaster.streamStatus(input, {
              automaticRemoteRefreshInterval: automaticGitFetchInterval,
            }),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsRefreshStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRefreshStatus,
            vcsStatusBroadcaster.refreshStatus(input.cwd),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsPull]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsPull,
            gitWorkflow.pullCurrentBranch(input.cwd).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) => Effect.failCause(cause),
                onSuccess: (result) =>
                  refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
              }),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitRunStackedAction]: (input) =>
          observeRpcStream(
            WS_METHODS.gitRunStackedAction,
            Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
              gitWorkflow
                .runStackedAction(input, {
                  actionId: input.actionId,
                  progressReporter: {
                    publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                  },
                })
                .pipe(
                  Effect.matchCauseEffect({
                    onFailure: (cause) => Queue.failCause(queue, cause),
                    onSuccess: () =>
                      refreshGitStatus(input.cwd).pipe(
                        Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                      ),
                  }),
                ),
            ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitResolvePullRequest,
            gitWorkflow.resolvePullRequest(input),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPreparePullRequestThread,
            gitWorkflow
              .preparePullRequestThread(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.vcsListRefs]: (input) =>
          observeRpcEffect(WS_METHODS.vcsListRefs, gitWorkflow.listRefs(input), {
            "rpc.aggregate": "vcs",
          }),
        [WS_METHODS.vcsCreateWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateWorktree,
            gitWorkflow.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsRemoveWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRemoveWorktree,
            gitWorkflow.removeWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsCreateRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateRef,
            gitWorkflow.createRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsSwitchRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsSwitchRef,
            gitWorkflow.switchRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsInit]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsInit,
            vcsProvisioning
              .initRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.reviewGetDiffPreview]: (input) =>
          observeRpcEffect(WS_METHODS.reviewGetDiffPreview, review.getDiffPreview(input), {
            "rpc.aggregate": "review",
          }),
        [WS_METHODS.terminalOpen]: (input) =>
          observeRpcEffect(WS_METHODS.terminalOpen, terminalManager.open(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalAttach]: (input) =>
          observeRpcStream(
            WS_METHODS.terminalAttach,
            Stream.unwrap(
              Effect.gen(function* () {
                const buffer = yield* ByteBoundedResyncBuffer.make<TerminalAttachStreamItem>({
                  maxBytes: TERMINAL_STREAM_MAX_BYTES,
                  maxItems: TERMINAL_STREAM_MAX_ITEMS,
                  resyncItem: terminalResyncRequired,
                  sizeOf: terminalStreamEventByteSize,
                });
                yield* Effect.acquireRelease(
                  terminalManager.attachStream(input, (event) =>
                    buffer.offer(event).pipe(Effect.asVoid),
                  ),
                  (unsubscribe) => Effect.sync(unsubscribe),
                );
                return buffer.stream;
              }),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.terminalList]: (input) =>
          observeRpcEffect(
            WS_METHODS.terminalList,
            terminalManager.list(input).pipe(Effect.map((terminals) => ({ terminals }))),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.terminalRead]: (input) =>
          observeRpcEffect(WS_METHODS.terminalRead, terminalManager.read(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalWrite]: (input) =>
          observeRpcEffect(WS_METHODS.terminalWrite, terminalManager.write(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalResize]: (input) =>
          observeRpcEffect(WS_METHODS.terminalResize, terminalManager.resize(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClear]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClear, terminalManager.clear(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalRestart]: (input) =>
          observeRpcEffect(WS_METHODS.terminalRestart, terminalManager.restart(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClose]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClose, terminalManager.close(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalGetLayout]: (input) =>
          observeRpcEffect(WS_METHODS.terminalGetLayout, terminalManager.getLayout(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalSetLayout]: (input, metadata) =>
          observeRpcEffect(
            WS_METHODS.terminalSetLayout,
            Effect.gen(function* () {
              const mayPublish = yield* BackgroundPolicy.mayPublishTerminalLayout(
                backgroundPolicy,
                currentSessionId,
                RpcClientId.make(metadata.client.id),
              );
              if (mayPublish) {
                return yield* terminalManager.setLayout(input);
              }
              const current = yield* terminalManager.getLayout({ threadId: input.threadId });
              // With no existing document there is nothing to fight over, so
              // let an older/unreported client establish the initial layout.
              return current.layout ?? (yield* terminalManager.setLayout(input));
            }),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.subscribeTerminalEvents]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalEvents,
            Stream.unwrap(
              Effect.gen(function* () {
                const buffer = yield* ByteBoundedResyncBuffer.make<TerminalEventStreamItem>({
                  maxBytes: TERMINAL_STREAM_MAX_BYTES,
                  maxItems: TERMINAL_STREAM_MAX_ITEMS,
                  resyncItem: terminalResyncRequired,
                  sizeOf: terminalStreamEventByteSize,
                });
                yield* Effect.acquireRelease(
                  terminalManager.subscribe((event) => buffer.offer(event).pipe(Effect.asVoid)),
                  (unsubscribe) => Effect.sync(unsubscribe),
                );
                return buffer.stream;
              }),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.subscribeTerminalMetadata]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalMetadata,
            Stream.unwrap(
              Effect.gen(function* () {
                const buffer = yield* ByteBoundedResyncBuffer.make<TerminalMetadataStreamItem>({
                  maxBytes: TERMINAL_METADATA_STREAM_MAX_BYTES,
                  maxItems: TERMINAL_STREAM_MAX_ITEMS,
                  resyncItem: terminalResyncRequired,
                  sizeOf: terminalMetadataEventByteSize,
                });
                yield* Effect.acquireRelease(
                  terminalManager.subscribeMetadata((event) =>
                    buffer.offer(event).pipe(Effect.asVoid),
                  ),
                  (unsubscribe) => Effect.sync(unsubscribe),
                );
                return buffer.stream;
              }),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.subscribeTerminalLayouts]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalLayouts,
            Stream.unwrap(
              Effect.gen(function* () {
                const buffer = yield* ByteBoundedResyncBuffer.make<TerminalLayoutStreamItem>({
                  maxBytes: TERMINAL_METADATA_STREAM_MAX_BYTES,
                  maxItems: TERMINAL_STREAM_MAX_ITEMS,
                  resyncItem: terminalResyncRequired,
                  sizeOf: terminalLayoutEventByteSize,
                });
                yield* Effect.acquireRelease(
                  terminalManager.subscribeLayouts((event) =>
                    buffer.offer(event).pipe(Effect.asVoid),
                  ),
                  (unsubscribe) => Effect.sync(unsubscribe),
                );
                return buffer.stream;
              }),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.previewOpen]: (input) =>
          observeRpcEffect(WS_METHODS.previewOpen, previewManager.open(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewNavigate]: (input) =>
          observeRpcEffect(WS_METHODS.previewNavigate, previewManager.navigate(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewResize]: (input) =>
          observeRpcEffect(WS_METHODS.previewResize, previewManager.resize(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewRefresh]: (input) =>
          observeRpcEffect(WS_METHODS.previewRefresh, previewManager.refresh(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewClose]: (input) =>
          observeRpcEffect(WS_METHODS.previewClose, previewManager.close(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewList]: (input) =>
          observeRpcEffect(WS_METHODS.previewList, previewManager.list(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewReportStatus]: (input) =>
          observeRpcEffect(WS_METHODS.previewReportStatus, previewManager.reportStatus(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewAutomationConnect]: (input) =>
          observeRpcStreamEffect(
            WS_METHODS.previewAutomationConnect,
            previewAutomationBroker.connect(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.previewAutomationRespond]: (input) =>
          observeRpcEffect(
            WS_METHODS.previewAutomationRespond,
            previewAutomationBroker.respond(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.previewAutomationFocusHost]: (input) =>
          observeRpcEffect(
            WS_METHODS.previewAutomationFocusHost,
            previewAutomationBroker.focusHost(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.remoteControlHostConnect]: (input) =>
          observeRpcStreamEffect(
            WS_METHODS.remoteControlHostConnect,
            authorizeDesktopHostEffect(remoteControlBroker.connectHost(input, currentSessionId)),
            { "rpc.aggregate": "remote-control" },
          ),
        [WS_METHODS.remoteControlHostRespond]: (input) =>
          observeRpcEffect(
            WS_METHODS.remoteControlHostRespond,
            authorizeDesktopHostEffect(
              remoteControlBroker.respondToRequest(input, currentSessionId),
            ),
            { "rpc.aggregate": "remote-control" },
          ),
        [WS_METHODS.remoteControlHostPublishFrame]: (input) =>
          observeRpcEffect(
            WS_METHODS.remoteControlHostPublishFrame,
            authorizeDesktopHostEffect(remoteControlBroker.publishFrame(input, currentSessionId)),
            { "rpc.aggregate": "remote-control" },
          ),
        [WS_METHODS.remoteControlHostPublishVideoChunk]: (input) =>
          observeRpcEffect(
            WS_METHODS.remoteControlHostPublishVideoChunk,
            authorizeDesktopHostEffect(
              remoteControlBroker.publishVideoChunk(input, currentSessionId),
            ),
            { "rpc.aggregate": "remote-control" },
          ),
        [WS_METHODS.remoteControlHostReportStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.remoteControlHostReportStatus,
            authorizeDesktopHostEffect(
              remoteControlBroker.reportHostStatus(input, currentSessionId),
            ),
            { "rpc.aggregate": "remote-control" },
          ),
        [WS_METHODS.remoteControlHostEnd]: (input) =>
          observeRpcEffect(
            WS_METHODS.remoteControlHostEnd,
            authorizeDesktopHostEffect(remoteControlBroker.endByHost(input, currentSessionId)),
            { "rpc.aggregate": "remote-control" },
          ),
        [WS_METHODS.remoteControlRequestAccess]: (input) =>
          observeRpcEffect(
            WS_METHODS.remoteControlRequestAccess,
            remoteControlBroker.requestAccess(input, {
              sessionId: currentSessionId,
              subject: currentSession.subject,
              client: {
                label: currentSession.subject,
                deviceType: "unknown",
              },
            }),
            { "rpc.aggregate": "remote-control" },
          ),
        [WS_METHODS.remoteControlWatch]: (input) =>
          observeRpcStreamEffect(
            WS_METHODS.remoteControlWatch,
            remoteControlBroker.watch(input, currentSessionId),
            { "rpc.aggregate": "remote-control" },
          ),
        [WS_METHODS.remoteControlSendInput]: (input) =>
          observeRpcEffect(
            WS_METHODS.remoteControlSendInput,
            remoteControlBroker.sendInput(input, currentSessionId),
            { "rpc.aggregate": "remote-control" },
          ),
        [WS_METHODS.remoteControlCancel]: (input) =>
          observeRpcEffect(
            WS_METHODS.remoteControlCancel,
            remoteControlBroker.cancel(input, currentSessionId),
            { "rpc.aggregate": "remote-control" },
          ),
        [WS_METHODS.vmAgentCreate]: (input) =>
          observeRpcEffect(
            WS_METHODS.vmAgentCreate,
            Effect.gen(function* () {
              // Create the agent's dedicated chat thread first, then the agent.
              const threadId = yield* createAgentThread(input.name);
              const agent = yield* vmManager.create({ ...input, threadId });
              yield* vmAgentWorkspace
                .ensure(agent.vmAgentId)
                .pipe(Effect.ignoreCause({ log: true }));
              return agent;
            }),
            { "rpc.aggregate": "vm" },
          ),
        [WS_METHODS.vmAgentBuilderOpen]: () =>
          observeRpcEffect(
            WS_METHODS.vmAgentBuilderOpen,
            openAgentBuilderThread.pipe(
              Effect.map((threadId) => ({ threadId })),
              Effect.mapError((cause) =>
                toDispatchCommandError(cause, "The Agent Builder chat could not be opened."),
              ),
            ),
            { "rpc.aggregate": "vm" },
          ),
        [WS_METHODS.vmAgentDelete]: (input) =>
          observeRpcEffect(
            WS_METHODS.vmAgentDelete,
            vmManager
              .deleteAgent(input.vmAgentId)
              .pipe(
                Effect.flatMap((threadId) =>
                  threadId === null ? Effect.void : deleteAgentThread(threadId),
                ),
              ),
            { "rpc.aggregate": "vm" },
          ),
        [WS_METHODS.vmAgentSubscribe]: (_input) =>
          observeRpcStream(
            WS_METHODS.vmAgentSubscribe,
            Stream.unwrap(
              Effect.gen(function* () {
                const buffer = yield* ByteBoundedResyncBuffer.make<VmAgentStreamItem>({
                  maxBytes: VM_AGENT_STREAM_MAX_BYTES,
                  maxItems: VM_STREAM_MAX_ITEMS,
                  resyncItem: vmResyncRequired,
                  sizeOf: vmAgentStreamItemByteSize,
                });
                yield* Effect.acquireRelease(
                  vmManager.subscribeAgents((event) => buffer.offer(event).pipe(Effect.asVoid)),
                  (unsubscribe) => Effect.sync(unsubscribe),
                );
                return buffer.stream;
              }),
            ),
            { "rpc.aggregate": "vm" },
          ),
        [WS_METHODS.vmAgentWorkspaceSubscribe]: (input) =>
          observeRpcStream(
            WS_METHODS.vmAgentWorkspaceSubscribe,
            Stream.unwrap(
              Effect.gen(function* () {
                const buffer = yield* ByteBoundedResyncBuffer.make<VmAgentWorkspaceStreamItem>({
                  maxBytes: VM_WORKSPACE_STREAM_MAX_BYTES,
                  maxItems: VM_STREAM_MAX_ITEMS,
                  resyncItem: vmResyncRequired,
                  sizeOf: vmWorkspaceStreamItemByteSize,
                });
                yield* Effect.acquireRelease(
                  vmAgentWorkspace.subscribe(input.vmAgentId, (snapshot) =>
                    buffer.offer(snapshot).pipe(Effect.asVoid),
                  ),
                  (unsubscribe) => Effect.sync(unsubscribe),
                );
                return buffer.stream;
              }),
            ),
            { "rpc.aggregate": "vm-workspace" },
          ),
        [WS_METHODS.vmAgentAttentionSubscribe]: () =>
          observeRpcStream(
            WS_METHODS.vmAgentAttentionSubscribe,
            Stream.unwrap(
              Effect.gen(function* () {
                const buffer = yield* ByteBoundedResyncBuffer.make<VmAgentAttentionStreamItem>({
                  maxBytes: VM_AGENT_STREAM_MAX_BYTES,
                  maxItems: VM_STREAM_MAX_ITEMS,
                  resyncItem: vmResyncRequired,
                  sizeOf: vmAttentionStreamItemByteSize,
                });
                yield* Effect.acquireRelease(
                  vmAgentWorkspace.subscribeAttention((snapshot) =>
                    buffer.offer(snapshot).pipe(Effect.asVoid),
                  ),
                  (unsubscribe) => Effect.sync(unsubscribe),
                );
                return buffer.stream;
              }),
            ),
            { "rpc.aggregate": "vm-workspace" },
          ),
        [WS_METHODS.vmAgentCollaborationSubscribe]: (_input) =>
          observeRpcStream(
            WS_METHODS.vmAgentCollaborationSubscribe,
            Stream.unwrap(
              Effect.gen(function* () {
                const buffer = yield* ByteBoundedResyncBuffer.make<VmAgentCollaborationStreamItem>({
                  maxBytes: VM_WORKSPACE_STREAM_MAX_BYTES,
                  maxItems: VM_STREAM_MAX_ITEMS,
                  resyncItem: vmResyncRequired,
                  sizeOf: vmCollaborationStreamItemByteSize,
                });
                yield* Effect.acquireRelease(
                  vmAgentCollaboration.subscribe((snapshot) =>
                    buffer.offer(snapshot).pipe(Effect.asVoid),
                  ),
                  (unsubscribe) => Effect.sync(unsubscribe),
                );
                return buffer.stream;
              }),
            ),
            { "rpc.aggregate": "vm-collaboration" },
          ),
        [WS_METHODS.vmAgentCollaborationGet]: (input) =>
          observeRpcEffect(
            WS_METHODS.vmAgentCollaborationGet,
            vmAgentCollaboration.getDetail({ kind: "user" }, input.delegationId),
            { "rpc.aggregate": "vm-collaboration" },
          ),
        [WS_METHODS.vmAgentCollaborationSendMessage]: (input) =>
          observeRpcEffect(
            WS_METHODS.vmAgentCollaborationSendMessage,
            vmAgentCollaboration
              .sendMessage({ kind: "user" }, input)
              .pipe(Effect.tap(() => vmAgentTaskScheduler.wake())),
            { "rpc.aggregate": "vm-collaboration" },
          ),
        [WS_METHODS.vmAgentCollaborationCancel]: (input) =>
          observeRpcEffect(
            WS_METHODS.vmAgentCollaborationCancel,
            vmAgentCollaboration.cancel({ kind: "user" }, input.delegationId),
            { "rpc.aggregate": "vm-collaboration" },
          ),
        [WS_METHODS.vmAgentTaskCreate]: (input) =>
          observeRpcEffect(
            WS_METHODS.vmAgentTaskCreate,
            vmAgentWorkspace
              .createTask({ ...input, createdBy: "user", activate: true })
              .pipe(Effect.tap(() => vmAgentTaskScheduler.wake())),
            { "rpc.aggregate": "vm-workspace" },
          ),
        [WS_METHODS.vmAgentTaskUpdate]: (input) =>
          observeRpcEffect(
            WS_METHODS.vmAgentTaskUpdate,
            vmAgentWorkspace.updateTask(input).pipe(Effect.tap(() => vmAgentTaskScheduler.wake())),
            { "rpc.aggregate": "vm-workspace" },
          ),
        [WS_METHODS.vmAgentTaskDelete]: (input) =>
          observeRpcEffect(
            WS_METHODS.vmAgentTaskDelete,
            vmAgentWorkspace.deleteTask(input.vmAgentId, input.taskId),
            { "rpc.aggregate": "vm-workspace" },
          ),
        [WS_METHODS.vmAgentTaskRunNow]: (input) =>
          observeRpcEffect(
            WS_METHODS.vmAgentTaskRunNow,
            vmAgentWorkspace
              .runTaskNow(input.vmAgentId, input.taskId)
              .pipe(Effect.tap(() => vmAgentTaskScheduler.wake())),
            { "rpc.aggregate": "vm-workspace" },
          ),
        [WS_METHODS.vmAgentTaskGeneratePrompt]: (input) =>
          observeRpcEffect(
            WS_METHODS.vmAgentTaskGeneratePrompt,
            Effect.gen(function* () {
              yield* vmAgentWorkspace.ensure(input.vmAgentId);
              const agent = yield* vmAgentStore.getById(input.vmAgentId).pipe(
                Effect.mapError(
                  (error) =>
                    new VmAgentWorkspaceOperationError({
                      operation: "resolving agent for prompt generation",
                      detail: error.message,
                    }),
                ),
              );
              if (Option.isNone(agent)) {
                return yield* new VmAgentNotFoundError({ vmAgentId: input.vmAgentId });
              }
              if (agent.value.threadId === null) {
                return yield* new VmAgentWorkspaceOperationError({
                  operation: "generating task prompt",
                  detail: "The agent has no dedicated chat session.",
                });
              }
              const thread = yield* projectionSnapshotQuery
                .getThreadShellById(agent.value.threadId)
                .pipe(
                  Effect.mapError(
                    (error) =>
                      new VmAgentWorkspaceOperationError({
                        operation: "resolving task generation model",
                        detail: error.message,
                      }),
                  ),
                );
              if (Option.isNone(thread)) {
                return yield* new VmAgentWorkspaceOperationError({
                  operation: "generating task prompt",
                  detail: "The agent chat session no longer exists.",
                });
              }
              return yield* textGeneration.generateVmAgentTaskPrompt({
                cwd: config.agentsWorkspaceDir,
                agentName: agent.value.name,
                agentPurpose: agent.value.purpose,
                request: input.request,
                currentTime: yield* nowIso,
                modelSelection: thread.value.modelSelection,
              });
            }),
            { "rpc.aggregate": "vm-workspace" },
          ),
        [WS_METHODS.vmAgentNotificationMarkRead]: (input) =>
          observeRpcEffect(
            WS_METHODS.vmAgentNotificationMarkRead,
            vmAgentWorkspace.markNotificationRead(input.vmAgentId, input.notificationId),
            { "rpc.aggregate": "vm-workspace" },
          ),
        [WS_METHODS.vmAgentNotificationUpdate]: (input) =>
          observeRpcEffect(
            WS_METHODS.vmAgentNotificationUpdate,
            vmAgentWorkspace.updateNotification(input),
            { "rpc.aggregate": "vm-workspace" },
          ),
        [WS_METHODS.vmAgentBlockerResolve]: (input) =>
          observeRpcEffect(
            WS_METHODS.vmAgentBlockerResolve,
            Effect.gen(function* () {
              const resolvedBy = input.dismissed === true ? "dismissed" : "user";
              const resolved = yield* vmAgentWorkspace.resolveBlocker({
                vmAgentId: input.vmAgentId,
                blockerId: input.blockerId,
                resolvedBy,
              });
              // Only on a real transition: resolving an already-resolved
              // blocker (a double click, two clients racing) must not start a
              // second turn saying the same thing.
              if (Option.isNone(resolved)) return;
              const agent = yield* vmAgentStore
                .getById(input.vmAgentId)
                .pipe(Effect.orElseSucceed(() => Option.none()));
              const threadId = Option.isSome(agent) ? agent.value.threadId : null;
              if (threadId === null) return;
              yield* notifyAgentBlockerResolved({
                threadId,
                title: resolved.value.title,
                resolvedBy,
              });
            }).pipe(Effect.asVoid),
            { "rpc.aggregate": "vm-workspace" },
          ),
        [WS_METHODS.vmAgentNotificationPreferencesUpdate]: (input) =>
          observeRpcEffect(
            WS_METHODS.vmAgentNotificationPreferencesUpdate,
            vmAgentWorkspace.updateNotificationPreferences(input),
            { "rpc.aggregate": "vm-workspace" },
          ),
        [WS_METHODS.subscribePreviewEvents]: (_input) =>
          observeRpcStream(WS_METHODS.subscribePreviewEvents, previewManager.events, {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.subscribeDiscoveredLocalServers]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeDiscoveredLocalServers,
            Stream.callback<DiscoveredLocalServerList>((queue) =>
              Effect.gen(function* () {
                yield* portDiscovery.retain;
                const initial = yield* portDiscovery.scan();
                const initialScannedAt = DateTime.formatIso(yield* DateTime.now);
                yield* Queue.offer(queue, {
                  servers: initial,
                  scannedAt: initialScannedAt,
                });
                yield* portDiscovery.subscribe((servers) =>
                  Effect.gen(function* () {
                    const scannedAt = DateTime.formatIso(yield* DateTime.now);
                    yield* Queue.offer(queue, { servers, scannedAt });
                  }),
                );
              }),
            ),
            { "rpc.aggregate": "preview" },
          ),
        [WS_METHODS.subscribeServerConfig]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerConfig,
            Effect.gen(function* () {
              // Acquire the settings subscription before reading the initial
              // snapshot. `ServerSettingsService.streamChanges` subscribes
              // lazily when the stream starts, so putting it after the
              // snapshot leaves a gap where a settings write can be lost and
              // the client can remain on stale provider enablement until the
              // next unrelated settings change or reconnect.
              const subscribedSettingsChanges = yield* serverSettings.subscribeChanges;
              const subscribedProviderChanges = yield* providerRegistry.subscribeChanges;
              const keybindingsUpdates = keybindings.streamChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    keybindings: event.keybindings,
                    issues: event.issues,
                  },
                })),
              );
              const providerStatuses = subscribedProviderChanges.pipe(
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: "providerStatuses" as const,
                  payload: { providers },
                })),
                Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
              );
              const settingsUpdates = subscribedSettingsChanges.pipe(
                Stream.map((settings) => ServerSettings.redactServerSettingsForClient(settings)),
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: "settingsUpdated" as const,
                  payload: { settings },
                })),
              );

              yield* providerRegistry
                .refresh()
                .pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

              const liveUpdates = Stream.merge(
                keybindingsUpdates,
                Stream.merge(providerStatuses, settingsUpdates),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  type: "snapshot" as const,
                  config: yield* loadServerConfig,
                }),
                liveUpdates,
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerLifecycle,
            Effect.gen(function* () {
              const snapshot = yield* lifecycleEvents.snapshot;
              const snapshotEvents = Array.from(snapshot.events).toSorted(
                (left, right) => left.sequence - right.sequence,
              );
              const liveEvents = lifecycleEvents.stream.pipe(
                Stream.filter((event) => event.sequence > snapshot.sequence),
              );
              return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeAuthAccess]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeAuthAccess,
            Effect.gen(function* () {
              const initialSnapshot = yield* loadAuthAccessSnapshot();
              const revisionRef = yield* Ref.make(1);
              const accessChanges: Stream.Stream<
                PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange
              > = Stream.merge(bootstrapCredentials.streamChanges, sessions.streamChanges);

              const liveEvents: Stream.Stream<AuthAccessStreamEvent> = accessChanges.pipe(
                Stream.mapEffect((change) =>
                  Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                    Effect.map((revision) =>
                      toAuthAccessStreamEvent(change, revision, currentSessionId),
                    ),
                  ),
                ),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  revision: 1,
                  type: "snapshot" as const,
                  payload: initialSnapshot,
                }),
                liveEvents,
              );
            }),
            { "rpc.aggregate": "auth" },
          ),
        [WS_METHODS.subscribeBackgroundPolicy]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeBackgroundPolicy,
            Stream.unwrap(
              Effect.map(backgroundPolicy.subscribe, ({ latest, changes }) =>
                Stream.concat(Stream.make(latest), changes),
              ),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeResourceTelemetry]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeResourceTelemetry,
            Stream.unwrap(
              Effect.map(resourceTelemetry.subscribe, ({ latest, changes }) =>
                Stream.concat(Stream.make(latest), changes),
              ),
            ),
            { "rpc.aggregate": "server" },
          ),
      });
    }),
  );

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const previewAutomationBroker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const remoteControlBroker = yield* RemoteControlBroker.RemoteControlBroker;
    const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
          disableTracing: true,
        }).pipe(
          Effect.provide(
            makeWsRpcLayer(session, previewAutomationBroker, remoteControlBroker).pipe(
              Layer.provideMerge(RpcSerialization.layerJson),
              Layer.provide(ProviderMaintenanceRunner.layer),
              Layer.provide(ProviderAccountSwitch.layer),
              Layer.provide(Layer.succeed(ServerSelfUpdate.ServerSelfUpdate, serverSelfUpdate)),
              Layer.provide(
                SourceControlDiscovery.layer.pipe(
                  Layer.provide(
                    SourceControlProviderRegistry.layer.pipe(
                      Layer.provide(
                        Layer.mergeAll(
                          AzureDevOpsCli.layer,
                          BitbucketApi.layer,
                          GitHubCli.layer,
                          GitLabCli.layer,
                        ),
                      ),
                      Layer.provideMerge(GitVcsDriver.layer),
                      Layer.provide(
                        VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer)),
                      ),
                    ),
                  ),
                  Layer.provide(VcsProcess.layer),
                ),
              ),
            ),
          ),
        );
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () => rpcWebSocketHttpEffect,
          () => sessions.markDisconnected(session.sessionId),
        );
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
        }),
      ),
    );
  }),
);
