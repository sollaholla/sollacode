import {
  PreviewAutomationScreenshotUnavailableError,
  ProviderInstanceId,
  type AuthSessionId,
  type EnvironmentId,
  type PreviewAutomationSnapshot,
  type PreviewRemoteSnapshotInput,
  type PreviewRemoteSnapshotResult,
  type PreviewRemoteSnapshotUnchangedResult,
  type PreviewRemoteViewSnapshotInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";

import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";

type RemotePreviewInvoker = Pick<
  PreviewAutomationBroker.PreviewAutomationBroker["Service"],
  "invoke"
>;

/**
 * Identifies one exact picture: its length plus a 32-bit FNV-1a over the base64.
 * If two different frames ever shared an id the viewer would keep the older
 * picture until the page next changed. At about 2^-32 per comparison that is
 * not worth a stronger hash on every frame of a 1 to 2.5 second poll.
 */
export function remoteFrameId(data: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < data.length; index += 1) {
    hash ^= data.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${data.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

/**
 * The frame, or, when the caller says it already holds exactly this picture,
 * everything about the frame except the picture. A phone watching a page that
 * is not moving otherwise downloads the same JPEG every poll.
 */
function answerFrame(
  frame: PreviewRemoteSnapshotResult,
  unchangedSince: string | undefined,
): PreviewRemoteSnapshotResult | PreviewRemoteSnapshotUnchangedResult {
  const frameId = remoteFrameId(frame.screenshot.data);
  if (unchangedSince !== frameId) {
    return { ...frame, frameId };
  }
  const { screenshot: _picture, ...rest } = frame;
  return { ...rest, unchanged: true, frameId };
}

export function captureRemotePreviewSnapshot(input: {
  readonly broker: RemotePreviewInvoker;
  readonly environmentId: EnvironmentId;
  readonly sessionId: AuthSessionId;
  readonly request: PreviewRemoteSnapshotInput;
  readonly issuedAt: number;
}): Effect.Effect<
  PreviewRemoteSnapshotResult | PreviewRemoteSnapshotUnchangedResult,
  import("@t3tools/contracts").PreviewAutomationError
> {
  return input.broker
    .invoke<PreviewAutomationSnapshot>({
      scope: {
        environmentId: input.environmentId,
        threadId: input.request.threadId,
        providerSessionId: `mobile-browser:${input.sessionId}:${input.request.threadId}`,
        providerInstanceId: ProviderInstanceId.make("mobileBrowser"),
        capabilities: new Set(["preview"]),
        issuedAt: input.issuedAt,
      },
      operation: "snapshot",
      input: { includeAgentPointer: true } satisfies PreviewRemoteViewSnapshotInput,
      tabId: input.request.tabId,
      timeoutMs: 10_000,
    })
    .pipe(
      // This feed exists to show the tab, so a snapshot with no picture is
      // nothing to show. Clients freeze the last valid page frame and expose
      // error details separately. Agents receive the snapshot itself, with
      // `screenshotError` explaining the gap.
      Effect.flatMap((snapshot) =>
        // Refuse a frame from a tab other than the one asked for. The host
        // resolves targets through a fallback chain, and this layer used to
        // echo the REQUESTED id back regardless, so a substitution surfaced as
        // one tab's title over another tab's picture. Hosts predating
        // `snapshot.tabId` report undefined and are trusted as before.
        snapshot.tabId !== undefined && snapshot.tabId !== input.request.tabId
          ? Effect.fail(
              new PreviewAutomationScreenshotUnavailableError({
                environmentId: input.environmentId,
                threadId: input.request.threadId,
                tabId: input.request.tabId,
                reason: `The desktop host answered with tab ${snapshot.tabId}. Showing a stale frame beats showing another tab's page under this tab's name.`,
              }),
            )
          : snapshot.screenshot === undefined
            ? Effect.fail(
                new PreviewAutomationScreenshotUnavailableError({
                  environmentId: input.environmentId,
                  threadId: input.request.threadId,
                  tabId: input.request.tabId,
                  reason: snapshot.screenshotError ?? "No reason was reported.",
                }),
              )
            : Effect.succeed(
                answerFrame(
                  {
                    tabId: input.request.tabId,
                    url: snapshot.url,
                    title: snapshot.title,
                    loading: snapshot.loading,
                    capturedAt: DateTime.formatIso(DateTime.makeUnsafe(input.issuedAt)),
                    screenshot: snapshot.screenshot,
                    ...(snapshot.pendingDownloadApprovals === undefined
                      ? {}
                      : { pendingDownloadApprovals: snapshot.pendingDownloadApprovals }),
                    ...(snapshot.agentPointer === undefined
                      ? {}
                      : { agentPointer: snapshot.agentPointer }),
                  },
                  input.request.unchangedSince,
                ),
              ),
      ),
    );
}
