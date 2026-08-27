import {
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
      Effect.map((snapshot) => ({
        tabId: input.request.tabId,
        url: snapshot.url,
        title: snapshot.title,
        loading: snapshot.loading,
        capturedAt: DateTime.formatIso(DateTime.makeUnsafe(input.issuedAt)),
        screenshot: snapshot.screenshot,
      })),
    );
}
