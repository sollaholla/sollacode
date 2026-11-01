import {
  DesktopPreviewAnnotationThemeInputSchema,
  DesktopPreviewArtifactInputSchema,
  DesktopPreviewAutomationClickInputSchema,
  DesktopPreviewAutomationContextMenuInputSchema,
  DesktopPreviewAutomationDragInputSchema,
  DesktopPreviewAutomationEvaluateInputSchema,
  DesktopPreviewAutomationPressInputSchema,
  DesktopPreviewAutomationScrollInputSchema,
  DesktopPreviewAutomationStatusSchema,
  DesktopPreviewAutomationTypeInputSchema,
  DesktopPreviewAccountPromptAnswerInputSchema,
  DesktopPreviewAccountsSnapshotInputSchema,
  DesktopPreviewCredentialFillInputSchema,
  DesktopPreviewCredentialListForTabInputSchema,
  DesktopPreviewCredentialRemoveInputSchema,
  DesktopPreviewCredentialSaveInputSchema,
  DesktopPreviewAutomationSelectOptionInputSchema,
  DesktopPreviewAutomationUploadInputSchema,
  DesktopPreviewAutomationWaitForDownloadInputSchema,
  DesktopPreviewAutomationWaitForInputSchema,
  DesktopPreviewConfigInputSchema,
  DesktopPreviewNavigateInputSchema,
  DesktopPreviewRecordingArtifactSchema,
  DesktopPreviewRecordingSaveInputSchema,
  DesktopPreviewRegisterWebviewInputSchema,
  DesktopPreviewRemoteFrameStartInputSchema,
  DesktopPreviewScreenshotArtifactSchema,
  DesktopPreviewSetColorSchemeInputSchema,
  DesktopPreviewSetDownloadDirectoryInputSchema,
  DesktopPreviewTabInputSchema,
  DesktopPreviewUiActivityInputSchema,
  DesktopPreviewWebviewConfigSchema,
  DesktopPreviewVideoSourceSchema,
  PreviewAnnotationPayloadSchema,
  PreviewAutomationContextMenuResult,
  PreviewAutomationWaitForDownloadResult,
  PreviewAutomationSnapshot,
  PreviewAutomationCredentialFillResult,
  PreviewAccountLinkInput,
  PreviewAccountSignOutInput,
  PreviewAccountsSnapshot,
  PreviewBrowserProfileInventory,
  PreviewCredentialId,
  PreviewCredentialSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeURL from "node:url";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { previewBrowserProfileScope } from "../../preview/browserProfileScope.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as BrowserCredentialVault from "../../preview/BrowserCredentialVault.ts";
import {
  BrowserSignInPrompts,
  isPersonOnlySignInOrigin,
  newSignInPromptId,
  signInPromptNowMs,
} from "../../preview/browserSignInPrompts.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { PREVIEW_WEBVIEW_PREFERENCES } from "../../preview/WebviewPreferences.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

let signInPrompts: BrowserSignInPrompts | null = null;

/** Sign-in signals become questions on a tab; account events reach every window. */
const installAccountForwarding = Effect.fn("desktop.ipc.preview.installAccountForwarding")(
  function* () {
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const manager = yield* PreviewManager.PreviewManager;
    const vault = yield* BrowserCredentialVault.BrowserCredentialVault;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const accounts = manager.browserAccounts;
    const prompts = new BrowserSignInPrompts({
      listCredentials: () => runPromise(vault.list),
      listCredentialsForOrigin: (origin) => runPromise(vault.listForUrl(origin)),
      readSecret: (id, origin) =>
        runPromise(
          vault.resolveForUrl(id as PreviewCredentialId, origin).pipe(
            Effect.map((resolved) => resolved.secret),
            Effect.orElseSucceed(() => null),
          ),
        ),
      saveCredential: (input) => runPromise(vault.save(input)),
      setPrompts: manager.setAccountPrompts,
      fillForPerson: (tabId, secret) => runPromise(manager.fillPasswordForPerson(tabId, secret)),
      profileKindOf: manager.browserProfileKind,
      hasLiveAccount: accounts.hasLiveAccount,
      findLiveElsewhere: accounts.findLiveElsewhere,
      linkAccount: accounts.link,
      newestLiveIdentity: (directory, provider) =>
        accounts
          .sessions()
          .find(
            (session) =>
              session.directory === directory && session.provider === provider && session.live,
          )?.identity ?? null,
      neverListPath: environment.path.join(environment.stateDir, "browser-never-remember.json"),
      newId: newSignInPromptId,
      nowMs: signInPromptNowMs,
      onFailure: (operation, cause) => {
        void runPromise(Effect.logWarning("A sign-in prompt failed.", { operation, cause }));
      },
    });
    signInPrompts = prompts;
    manager.subscribeSignInSignals((signal) => {
      switch (signal.kind) {
        case "username":
          prompts.noteUsername(signal.webContentsId, signal.origin, signal.username);
          return;
        case "attempt":
          prompts.noteAttempt(signal);
          return;
        case "page":
          void prompts.notePage(signal).catch((cause: unknown) => {
            void runPromise(Effect.logWarning("A sign-in check failed.", { cause }));
          });
          return;
        case "tab-closed":
          prompts.forgetTab(signal.tabId);
      }
    });
    manager.subscribeAccountEvents((event) => {
      void runPromise(
        electronWindow
          .sendAll(IpcChannels.PREVIEW_ACCOUNTS_EVENT_CHANNEL, event)
          .pipe(Effect.ignore),
      );
    });
  },
);

export const installPreviewEventForwarding = Effect.fn(
  "desktop.ipc.preview.installEventForwarding",
)(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const manager = yield* PreviewManager.PreviewManager;
  yield* manager.subscribeStateChanges((tabId, state) =>
    electronWindow.sendAll(IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, tabId, state),
  );
  yield* manager.subscribeVideoSourceChanges((tabId) =>
    electronWindow.sendAll(IpcChannels.PREVIEW_TAB_VIDEO_SOURCE_CHANGED_CHANNEL, tabId),
  );
  yield* installAccountForwarding();
  yield* manager.subscribeRecordingFrames((frame) =>
    electronWindow.sendAll(IpcChannels.PREVIEW_RECORDING_FRAME_CHANNEL, frame),
  );
  // Remote viewers' pictures go only to the main window: it hosts the guests
  // and the automation host that relays them, and a picture is large.
  yield* manager.subscribeRemoteFrames((frame) =>
    electronWindow.main.pipe(
      Effect.flatMap((main) =>
        Option.isSome(main)
          ? Effect.sync(() =>
              main.value.webContents.send(IpcChannels.PREVIEW_REMOTE_FRAME_CHANNEL, frame),
            )
          : electronWindow.sendAll(IpcChannels.PREVIEW_REMOTE_FRAME_CHANNEL, frame),
      ),
      Effect.ignore,
    ),
  );
  yield* manager.subscribePointerEvents((event) =>
    electronWindow.sendAll(IpcChannels.PREVIEW_POINTER_EVENT_CHANNEL, event),
  );
  yield* manager.subscribeNewTabRequests((request) =>
    electronWindow.sendAll(IpcChannels.PREVIEW_NEW_TAB_REQUEST_CHANNEL, request),
  );
});

export const createTab = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CREATE_TAB_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.createTab")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.createTab(tabId);
  }),
});

export const closeTab = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLOSE_TAB_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.closeTab")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.closeTab(tabId);
  }),
});

export const registerWebview = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_REGISTER_WEBVIEW_CHANNEL,
  payload: DesktopPreviewRegisterWebviewInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.registerWebview")(function* ({ tabId, webContentsId }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.registerWebview(tabId, webContentsId);
  }),
});

export const setUiActivity = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_UI_ACTIVITY_CHANNEL,
  payload: DesktopPreviewUiActivityInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setUiActivity")(function* ({ tabId, leaseId, active }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.setUiActivity(tabId, leaseId, active);
  }),
});

export const navigate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_NAVIGATE_CHANNEL,
  payload: DesktopPreviewNavigateInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.navigate")(function* ({ tabId, url }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.navigate(tabId, url);
  }),
});

const tabMethod = (
  channel: string,
  name: string,
  invoke: (
    manager: PreviewManager.PreviewManager["Service"],
    tabId: string,
  ) => Effect.Effect<void, PreviewManager.PreviewManagerError>,
) =>
  DesktopIpc.makeIpcMethod({
    channel,
    payload: DesktopPreviewTabInputSchema,
    result: Schema.Void,
    handler: Effect.fn(name)(function* ({ tabId }) {
      const manager = yield* PreviewManager.PreviewManager;
      yield* invoke(manager, tabId);
    }),
  });

export const goBack = tabMethod(
  IpcChannels.PREVIEW_GO_BACK_CHANNEL,
  "desktop.ipc.preview.goBack",
  (manager, tabId) => manager.goBack(tabId),
);
export const goForward = tabMethod(
  IpcChannels.PREVIEW_GO_FORWARD_CHANNEL,
  "desktop.ipc.preview.goForward",
  (manager, tabId) => manager.goForward(tabId),
);
export const refresh = tabMethod(
  IpcChannels.PREVIEW_REFRESH_CHANNEL,
  "desktop.ipc.preview.refresh",
  (manager, tabId) => manager.refresh(tabId),
);
export const zoomIn = tabMethod(
  IpcChannels.PREVIEW_ZOOM_IN_CHANNEL,
  "desktop.ipc.preview.zoomIn",
  (manager, tabId) => manager.zoomIn(tabId),
);
export const zoomOut = tabMethod(
  IpcChannels.PREVIEW_ZOOM_OUT_CHANNEL,
  "desktop.ipc.preview.zoomOut",
  (manager, tabId) => manager.zoomOut(tabId),
);
export const resetZoom = tabMethod(
  IpcChannels.PREVIEW_RESET_ZOOM_CHANNEL,
  "desktop.ipc.preview.resetZoom",
  (manager, tabId) => manager.resetZoom(tabId),
);
export const hardReload = tabMethod(
  IpcChannels.PREVIEW_HARD_RELOAD_CHANNEL,
  "desktop.ipc.preview.hardReload",
  (manager, tabId) => manager.hardReload(tabId),
);
export const setColorScheme = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_COLOR_SCHEME_CHANNEL,
  payload: DesktopPreviewSetColorSchemeInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setColorScheme")(function* ({ tabId, colorScheme }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.setColorScheme(tabId, colorScheme);
  }),
});
export const openDevTools = tabMethod(
  IpcChannels.PREVIEW_OPEN_DEVTOOLS_CHANNEL,
  "desktop.ipc.preview.openDevTools",
  (manager, tabId) => manager.openDevTools(tabId),
);
export const cancelPickElement = tabMethod(
  IpcChannels.PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL,
  "desktop.ipc.preview.cancelPickElement",
  (manager, tabId) => manager.cancelPickElement(tabId),
);
export const startRecording = tabMethod(
  IpcChannels.PREVIEW_RECORDING_START_CHANNEL,
  "desktop.ipc.preview.startRecording",
  (manager, tabId) => manager.startRecording(tabId),
);
export const stopRecording = tabMethod(
  IpcChannels.PREVIEW_RECORDING_STOP_CHANNEL,
  "desktop.ipc.preview.stopRecording",
  (manager, tabId) => manager.stopRecording(tabId),
);
export const openPictureInPicture = tabMethod(
  IpcChannels.PREVIEW_PICTURE_IN_PICTURE_OPEN_CHANNEL,
  "desktop.ipc.preview.openPictureInPicture",
  (manager, tabId) => manager.openPictureInPicture(tabId),
);
export const closePictureInPicture = tabMethod(
  IpcChannels.PREVIEW_PICTURE_IN_PICTURE_CLOSE_CHANNEL,
  "desktop.ipc.preview.closePictureInPicture",
  (manager, tabId) => manager.closePictureInPicture(tabId),
);

export const clearCookies = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLEAR_COOKIES_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.clearCookies")(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.clearCookies();
  }),
});

export const clearCache = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLEAR_CACHE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.clearCache")(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.clearCache();
  }),
});

export const getPreviewConfig = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_GET_CONFIG_CHANNEL,
  payload: DesktopPreviewConfigInputSchema,
  result: DesktopPreviewWebviewConfigSchema,
  handler: Effect.fn("desktop.ipc.preview.getConfig")(function* ({
    environmentId,
    browserProfile,
  }) {
    const manager = yield* PreviewManager.PreviewManager;
    const scope = previewBrowserProfileScope(environmentId, browserProfile);
    yield* manager.getBrowserSession(scope);
    const partition = yield* manager.getBrowserPartition(scope);
    // Which jar a guest attached to is otherwise invisible from outside the
    // process, and "the agent sees a logged-out page" is almost always this.
    yield* Effect.logInfo("Resolved a preview browser profile.", { scope, partition });
    return {
      partition,
      webPreferences: PREVIEW_WEBVIEW_PREFERENCES,
      preloadUrl: NodeURL.pathToFileURL(`${__dirname}/preview-pick-preload.cjs`).href,
    };
  }),
});

export const setPreviewDownloadDirectory = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_DOWNLOAD_DIRECTORY_CHANNEL,
  payload: DesktopPreviewSetDownloadDirectoryInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setDownloadDirectory")(function* ({
    environmentId,
    threadId,
    browserProfile,
    directory,
  }) {
    const manager = yield* PreviewManager.PreviewManager;
    // The same scope `getConfig` derives, so the directory lands on the very
    // partition this thread's tabs download through. A project's threads share
    // that partition but can sit in different worktrees, so it is held per thread.
    yield* manager.setDownloadDirectory(
      previewBrowserProfileScope(environmentId, browserProfile),
      directory,
      threadId,
    );
  }),
});

export const accountsSnapshot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_ACCOUNTS_SNAPSHOT_CHANNEL,
  payload: DesktopPreviewAccountsSnapshotInputSchema,
  result: PreviewAccountsSnapshot,
  handler: Effect.fn("desktop.ipc.preview.accountsSnapshot")(function* ({ refresh }) {
    const manager = yield* PreviewManager.PreviewManager;
    if (refresh) {
      yield* Effect.tryPromise(() => manager.browserAccounts.refreshAll()).pipe(Effect.ignore);
    }
    const counts = manager.browserProfileCounts();
    return {
      sessions: manager.browserAccounts.sessions(),
      recentEvents: manager.browserAccounts.recentEvents().slice(0, 20),
      profileCount: counts.profiles,
      retiredProfileCount: counts.retired,
      encryptedProfileCount: counts.encrypted,
    };
  }),
});

export const accountsSignOut = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_ACCOUNTS_SIGN_OUT_CHANNEL,
  payload: PreviewAccountSignOutInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.accountsSignOut")(function* ({ provider, directory }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* Effect.tryPromise(() => manager.browserAccounts.signOut(provider, directory)).pipe(
      Effect.orDie,
    );
  }),
});

export const accountsLink = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_ACCOUNTS_LINK_CHANNEL,
  payload: PreviewAccountLinkInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.accountsLink")(function* (input) {
    const manager = yield* PreviewManager.PreviewManager;
    const scope = previewBrowserProfileScope(input.environmentId, input.to);
    // Opening it records its owner, so a project with no tabs yet can be given one.
    yield* manager.getBrowserSession(scope);
    const toDirectory = yield* manager.browserProfileDirectory(scope);
    yield* Effect.tryPromise(() =>
      manager.browserAccounts.link(input.provider, input.fromDirectory, toDirectory),
    ).pipe(Effect.orDie);
  }),
});

export const accountsAnswerPrompt = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_ACCOUNTS_ANSWER_PROMPT_CHANNEL,
  payload: DesktopPreviewAccountPromptAnswerInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.accountsAnswerPrompt")(function* ({ id, answer }) {
    const prompts = signInPrompts;
    if (prompts === null) return;
    yield* Effect.tryPromise(() => prompts.answer(id, answer)).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not act on a sign-in answer.", { cause }),
      ),
    );
  }),
});

export const reconcileBrowserProfiles = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_RECONCILE_PROFILES_CHANNEL,
  payload: PreviewBrowserProfileInventory,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.reconcileBrowserProfiles")(function* (inventory) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.reconcileBrowserProfiles(inventory);
  }),
});

export const revealPreviewDownload = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_REVEAL_DOWNLOAD_CHANNEL,
  payload: Schema.Struct({ path: Schema.String }),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.revealDownload")(function* ({ path }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.revealDownload(path);
  }),
});

export const answerPreviewDownloadApproval = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_ANSWER_DOWNLOAD_APPROVAL_CHANNEL,
  payload: Schema.Struct({
    id: Schema.String,
    decision: Schema.Literals(["allow-domain", "allow-once", "deny"]),
  }),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.answerDownloadApproval")(function* ({ id, decision }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.answerDownloadApproval(id, decision);
  }),
});

export const forgetDownloadDomains = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_FORGET_DOWNLOAD_DOMAINS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.forgetDownloadDomains")(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.forgetDownloadDomains();
  }),
});

export const setAnnotationTheme = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_ANNOTATION_THEME_CHANNEL,
  payload: DesktopPreviewAnnotationThemeInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setAnnotationTheme")(function* ({ theme }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.setAnnotationTheme(theme);
  }),
});

export const pickElement = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_PICK_ELEMENT_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: Schema.NullOr(PreviewAnnotationPayloadSchema),
  handler: Effect.fn("desktop.ipc.preview.pickElement")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.pickElement(tabId);
  }),
});

export const captureScreenshot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CAPTURE_SCREENSHOT_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: DesktopPreviewScreenshotArtifactSchema,
  handler: Effect.fn("desktop.ipc.preview.captureScreenshot")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.captureScreenshot(tabId);
  }),
});

export const getTabVideoSource = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_GET_TAB_VIDEO_SOURCE_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: Schema.NullOr(DesktopPreviewVideoSourceSchema),
  handler: Effect.fn("desktop.ipc.preview.getTabVideoSource")(function* ({ tabId }, event) {
    if (event.sender === undefined) return null;
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.getTabVideoSource(tabId, event.sender.id);
  }),
});

export const getTabAudioSource = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_GET_TAB_AUDIO_SOURCE_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.preview.getTabAudioSource")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.getTabAudioSource(tabId);
  }),
});

export const startRemoteFrames = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_REMOTE_FRAMES_START_CHANNEL,
  payload: DesktopPreviewRemoteFrameStartInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.startRemoteFrames")(function* ({
    tabId,
    maxWidth,
    maxHeight,
  }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.startRemoteFrames(tabId, { maxWidth, maxHeight });
  }),
});
export const stopRemoteFrames = tabMethod(
  IpcChannels.PREVIEW_REMOTE_FRAMES_STOP_CHANNEL,
  "desktop.ipc.preview.stopRemoteFrames",
  (manager, tabId) => manager.stopRemoteFrames(tabId),
);
export const refreshRemoteFrame = tabMethod(
  IpcChannels.PREVIEW_REMOTE_FRAMES_REFRESH_CHANNEL,
  "desktop.ipc.preview.refreshRemoteFrame",
  (manager, tabId) => manager.refreshRemoteFrame(tabId),
);

export const revealArtifact = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_REVEAL_ARTIFACT_CHANNEL,
  payload: DesktopPreviewArtifactInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.revealArtifact")(function* ({ path }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.revealArtifact(path);
  }),
});

export const copyArtifactToClipboard = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_COPY_ARTIFACT_CHANNEL,
  payload: DesktopPreviewArtifactInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.copyArtifactToClipboard")(function* ({ path }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.copyArtifactToClipboard(path);
  }),
});

export const automationRenewForeground = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_RENEW_FOREGROUND_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationRenewForeground")(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.renewAutomationForeground();
  }),
});

export const automationStatus = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_STATUS_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: DesktopPreviewAutomationStatusSchema,
  handler: Effect.fn("desktop.ipc.preview.automationStatus")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.automationStatus(tabId);
  }),
});

export const automationSnapshot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_SNAPSHOT_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: PreviewAutomationSnapshot,
  handler: Effect.fn("desktop.ipc.preview.automationSnapshot")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.automationSnapshot(tabId);
  }),
});

/**
 * Interrupts focus-taking input when its server caller has already stopped
 * waiting. Without carrying the deadline across IPC, a request parked behind
 * push-to-talk could time out remotely and still click or type after release.
 */
const runAutomationInputBeforeExpiry = <A, E, R>(input: {
  readonly operation: "click" | "drag" | "contextMenu" | "type" | "press" | "credentialFill";
  readonly tabId: string;
  readonly expiresAt: number | undefined;
  readonly effect: Effect.Effect<A, E, R>;
}): Effect.Effect<A, E | PreviewManager.PreviewOperationError, R> => {
  const expiresAt = input.expiresAt;
  if (expiresAt === undefined) return input.effect;
  return Effect.gen(function* () {
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    const remainingMs = expiresAt - now;
    if (remainingMs <= 0) {
      return yield* new PreviewManager.PreviewOperationError({
        operation: `automation.${input.operation}.requestExpired`,
        tabId: input.tabId,
        cause: new Error("Preview automation request expired before input could be dispatched."),
      });
    }
    const result = yield* input.effect.pipe(Effect.timeoutOption(remainingMs));
    return yield* Option.match(result, {
      onNone: () =>
        Effect.fail(
          new PreviewManager.PreviewOperationError({
            operation: `automation.${input.operation}.requestExpired`,
            tabId: input.tabId,
            cause: new Error(
              "Preview automation request expired before input could be dispatched.",
            ),
          }),
        ),
      onSome: Effect.succeed,
    });
  });
};

export const automationClick = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_CLICK_CHANNEL,
  payload: DesktopPreviewAutomationClickInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationClick")(function* ({
    tabId,
    input,
    expiresAt,
  }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* runAutomationInputBeforeExpiry({
      operation: "click",
      tabId,
      expiresAt,
      effect: manager.automationClick(tabId, input, { expiresAt }),
    });
  }),
});

export const automationDrag = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_DRAG_CHANNEL,
  payload: DesktopPreviewAutomationDragInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationDrag")(function* ({ tabId, input, expiresAt }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* runAutomationInputBeforeExpiry({
      operation: "drag",
      tabId,
      expiresAt,
      effect: manager.automationDrag(tabId, input, { expiresAt }),
    });
  }),
});

export const automationContextMenu = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_CONTEXT_MENU_CHANNEL,
  payload: DesktopPreviewAutomationContextMenuInputSchema,
  result: PreviewAutomationContextMenuResult,
  handler: Effect.fn("desktop.ipc.preview.automationContextMenu")(function* ({
    tabId,
    input,
    expiresAt,
  }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* runAutomationInputBeforeExpiry({
      operation: "contextMenu",
      tabId,
      expiresAt,
      effect: manager.automationContextMenu(tabId, input, { expiresAt }),
    });
  }),
});

export const automationType = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_TYPE_CHANNEL,
  payload: DesktopPreviewAutomationTypeInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationType")(function* ({ tabId, input, expiresAt }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* runAutomationInputBeforeExpiry({
      operation: "type",
      tabId,
      expiresAt,
      effect: manager.automationType(tabId, input, { expiresAt }),
    });
  }),
});

export const listCredentials = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CREDENTIAL_LIST_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(PreviewCredentialSummary),
  handler: Effect.fn("desktop.ipc.preview.listCredentials")(function* () {
    return yield* (yield* BrowserCredentialVault.BrowserCredentialVault).list;
  }),
});

export const saveCredential = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CREDENTIAL_SAVE_CHANNEL,
  payload: DesktopPreviewCredentialSaveInputSchema,
  result: PreviewCredentialSummary,
  handler: Effect.fn("desktop.ipc.preview.saveCredential")(function* (input) {
    return yield* (yield* BrowserCredentialVault.BrowserCredentialVault).save({
      label: input.label,
      origin: input.origin,
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.secret === undefined ? {} : { secret: input.secret }),
      ...(input.id === undefined ? {} : { id: input.id }),
      ...(input.username === undefined ? {} : { username: input.username }),
    });
  }),
});

export const removeCredential = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CREDENTIAL_REMOVE_CHANNEL,
  payload: DesktopPreviewCredentialRemoveInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.removeCredential")(function* ({ id }) {
    yield* (yield* BrowserCredentialVault.BrowserCredentialVault).remove(id);
  }),
});

export const listCredentialsForTab = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CREDENTIAL_LIST_FOR_TAB_CHANNEL,
  payload: DesktopPreviewCredentialListForTabInputSchema,
  result: Schema.Array(PreviewCredentialSummary),
  handler: Effect.fn("desktop.ipc.preview.listCredentialsForTab")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    const status = yield* manager.automationStatus(tabId);
    if (status.url === null) {
      return yield* new BrowserCredentialVault.BrowserCredentialOriginError({
        reason: "The browser tab has no active website origin.",
      });
    }
    const saved = yield* (yield* BrowserCredentialVault.BrowserCredentialVault).listForUrl(
      status.url,
    );
    return saved.filter((credential) => !isPersonOnlySignInOrigin(credential.origin));
  }),
});

export const fillCredential = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CREDENTIAL_FILL_CHANNEL,
  payload: DesktopPreviewCredentialFillInputSchema,
  result: PreviewAutomationCredentialFillResult,
  handler: Effect.fn("desktop.ipc.preview.fillCredential")(function* ({ tabId, input, expiresAt }) {
    const manager = yield* PreviewManager.PreviewManager;
    const vault = yield* BrowserCredentialVault.BrowserCredentialVault;
    const status = yield* manager.automationStatus(tabId);
    if (status.url === null) {
      return yield* new BrowserCredentialVault.BrowserCredentialOriginError({
        reason: "The browser tab has no active website origin.",
      });
    }
    const resolved = yield* vault.resolveForUrl(input.credentialId, status.url);
    if (isPersonOnlySignInOrigin(resolved.summary.origin)) {
      return yield* new BrowserCredentialVault.BrowserCredentialOriginError({
        reason:
          "Google sign-in is left to the person: ask them to sign in on this tab. An agent's Google password fill can be refused by Google and would expose the whole account.",
      });
    }
    yield* runAutomationInputBeforeExpiry({
      operation: "credentialFill",
      tabId,
      expiresAt,
      effect: manager.automationFillCredential(
        tabId,
        resolved.summary.kind ?? "password",
        {
          text: resolved.secret,
          ...(input.selector === undefined ? {} : { selector: input.selector }),
          ...(input.locator === undefined ? {} : { locator: input.locator }),
          ...(input.x === undefined ? {} : { x: input.x }),
          ...(input.y === undefined ? {} : { y: input.y }),
          clear: input.clear ?? true,
        },
        { expiresAt },
      ),
    });
    return {
      credentialId: resolved.summary.id,
      label: resolved.summary.label,
      origin: resolved.summary.origin,
    };
  }),
});

export const automationUpload = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_UPLOAD_CHANNEL,
  payload: DesktopPreviewAutomationUploadInputSchema,
  result: Schema.Struct({
    fileCount: Schema.Int.check(Schema.isGreaterThan(0)),
    fileNames: Schema.Array(Schema.String),
  }),
  handler: Effect.fn("desktop.ipc.preview.automationUpload")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.automationUpload(tabId, input);
  }),
});

export const automationSelectOption = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_SELECT_OPTION_CHANNEL,
  payload: DesktopPreviewAutomationSelectOptionInputSchema,
  result: Schema.Struct({
    value: Schema.String,
    label: Schema.String,
    index: Schema.Int,
  }),
  handler: Effect.fn("desktop.ipc.preview.automationSelectOption")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.automationSelectOption(tabId, input);
  }),
});

export const automationPress = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_PRESS_CHANNEL,
  payload: DesktopPreviewAutomationPressInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationPress")(function* ({
    tabId,
    input,
    expiresAt,
  }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* runAutomationInputBeforeExpiry({
      operation: "press",
      tabId,
      expiresAt,
      effect: manager.automationPress(tabId, input, { expiresAt }),
    });
  }),
});

export const automationScroll = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_SCROLL_CHANNEL,
  payload: DesktopPreviewAutomationScrollInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationScroll")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.automationScroll(tabId, input);
  }),
});

export const automationEvaluate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_EVALUATE_CHANNEL,
  payload: DesktopPreviewAutomationEvaluateInputSchema,
  result: Schema.Unknown,
  handler: Effect.fn("desktop.ipc.preview.automationEvaluate")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.automationEvaluate(tabId, input);
  }),
});

export const automationWaitFor = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_WAIT_FOR_CHANNEL,
  payload: DesktopPreviewAutomationWaitForInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationWaitFor")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.automationWaitFor(tabId, input);
  }),
});

export const automationWaitForDownload = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_WAIT_FOR_DOWNLOAD_CHANNEL,
  payload: DesktopPreviewAutomationWaitForDownloadInputSchema,
  result: PreviewAutomationWaitForDownloadResult,
  handler: Effect.fn("desktop.ipc.preview.automationWaitForDownload")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.automationWaitForDownload(tabId, input);
  }),
});

export const saveRecording = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_RECORDING_SAVE_CHANNEL,
  payload: DesktopPreviewRecordingSaveInputSchema,
  result: DesktopPreviewRecordingArtifactSchema,
  handler: Effect.fn("desktop.ipc.preview.saveRecording")(function* ({ tabId, mimeType, data }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.saveRecording(tabId, mimeType, data);
  }),
});

export const methods = [
  createTab,
  closeTab,
  registerWebview,
  setUiActivity,
  navigate,
  goBack,
  goForward,
  refresh,
  zoomIn,
  zoomOut,
  resetZoom,
  hardReload,
  setColorScheme,
  openDevTools,
  clearCookies,
  clearCache,
  getPreviewConfig,
  setPreviewDownloadDirectory,
  revealPreviewDownload,
  answerPreviewDownloadApproval,
  reconcileBrowserProfiles,
  accountsSnapshot,
  accountsSignOut,
  accountsLink,
  accountsAnswerPrompt,
  forgetDownloadDomains,
  setAnnotationTheme,
  pickElement,
  cancelPickElement,
  captureScreenshot,
  getTabAudioSource,
  getTabVideoSource,
  startRemoteFrames,
  stopRemoteFrames,
  refreshRemoteFrame,
  revealArtifact,
  copyArtifactToClipboard,
  openPictureInPicture,
  closePictureInPicture,
  automationRenewForeground,
  automationStatus,
  automationSnapshot,
  automationClick,
  automationDrag,
  automationContextMenu,
  automationType,
  listCredentials,
  saveCredential,
  removeCredential,
  listCredentialsForTab,
  fillCredential,
  automationUpload,
  automationSelectOption,
  automationPress,
  automationScroll,
  automationEvaluate,
  automationWaitFor,
  automationWaitForDownload,
  startRecording,
  stopRecording,
  saveRecording,
] as const;
