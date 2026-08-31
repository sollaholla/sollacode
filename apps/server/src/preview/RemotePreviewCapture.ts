import {
  PreviewAutomationScreenshotUnavailableError,
  ProviderInstanceId,
  type AuthSessionId,
  type EnvironmentId,
  type PreviewAutomationSnapshot,
  type PreviewRemoteSnapshotInput,
  type PreviewRemoteSnapshotResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";

import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";

type RemotePreviewInvoker = Pick<
  PreviewAutomationBroker.PreviewAutomationBroker["Service"],
  "invoke"
>;

export function captureRemotePreviewSnapshot(input: {
  readonly broker: RemotePreviewInvoker;
  readonly environmentId: EnvironmentId;
  readonly sessionId: AuthSessionId;
  readonly request: PreviewRemoteSnapshotInput;
  readonly issuedAt: number;
}): Effect.Effect<
  PreviewRemoteSnapshotResult,
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
      input: {},
      tabId: input.request.tabId,
      timeoutMs: 10_000,
    })
    .pipe(
      // This feed exists to show the tab, so a snapshot with no picture is
      // nothing to show. Failing lets the phone keep its last good frame and
      // say why, rather than going blank. Agents are handed the snapshot
      // itself, with `screenshotError` explaining the gap.
      Effect.flatMap((snapshot) =>
        snapshot.screenshot === undefined
          ? Effect.fail(
              new PreviewAutomationScreenshotUnavailableError({
                environmentId: input.environmentId,
                threadId: input.request.threadId,
                tabId: input.request.tabId,
                reason: snapshot.screenshotError ?? "No reason was reported.",
              }),
            )
          : Effect.succeed({
              tabId: input.request.tabId,
              url: snapshot.url,
              title: snapshot.title,
              loading: snapshot.loading,
              capturedAt: DateTime.formatIso(DateTime.makeUnsafe(input.issuedAt)),
              screenshot: snapshot.screenshot,
              ...(snapshot.pendingDownloadApprovals === undefined
                ? {}
                : { pendingDownloadApprovals: snapshot.pendingDownloadApprovals }),
            }),
      ),
    );
}
