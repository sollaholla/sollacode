import {
  PreviewAutomationScreenshotUnavailableError,
  ProviderInstanceId,
  type AuthSessionId,
  type EnvironmentId,
  type PreviewAutomationSnapshot,
  type PreviewAutomationOperation,
  type PreviewAnnotationPayload,
  type PreviewRemoteInputInput,
  type PreviewRemotePickInput,
  type PreviewRemoteSnapshotInput,
  type PreviewRemoteSnapshotResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";

import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";

/** Long enough for a person to annotate a page, not a machine round trip. */
const REMOTE_PICK_TIMEOUT_MS = 300_000;

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
              // Carried so a viewer can aim input at the page rather than at
              // the picture of it. Older hosts omit it and stay view-only.
              ...(snapshot.viewport === undefined ? {} : { viewport: snapshot.viewport }),
            }),
      ),
    );
}

/**
 * Applies one viewer action to the guest, through the same broker that routes
 * agent automation — so it lands on the machine actually hosting the tab, and
 * runs the operations that machine already implements rather than a second
 * input path with its own bugs.
 */
export function applyRemotePreviewInput(input: {
  readonly broker: RemotePreviewInvoker;
  readonly environmentId: EnvironmentId;
  readonly sessionId: AuthSessionId;
  readonly request: PreviewRemoteInputInput;
  readonly issuedAt: number;
}): Effect.Effect<void, import("@t3tools/contracts").PreviewAutomationError> {
  const { action } = input.request;
  // History is the one intent with no operation of its own. Evaluating it in
  // the page is how the guest's own back button behaves, and it keeps this
  // free of a new host capability to negotiate.
  const [operation, operationInput] = ((): [PreviewAutomationOperation, unknown] => {
    switch (action.kind) {
      case "click":
        return ["click", { x: action.x, y: action.y }];
      case "scroll":
        return ["scroll", { deltaX: action.deltaX, deltaY: action.deltaY }];
      case "type":
        // No locator: the guest's focused element, which is what the person
        // just clicked.
        return ["type", { text: action.text }];
      case "press":
        return [
          "press",
          action.modifiers === undefined
            ? { key: action.key }
            : { key: action.key, modifiers: action.modifiers },
        ];
      case "history":
        return [
          "evaluate",
          {
            expression: action.direction === "back" ? "history.back()" : "history.forward()",
            returnByValue: false,
          },
        ];
      case "navigate":
        return ["navigate", { url: action.url }];
      case "reload":
        // The server's refresh deliberately emits nothing — the local bridge
        // reloads its own guest — so a viewer with no guest here has to ask
        // the page itself.
        return ["evaluate", { expression: "location.reload()", returnByValue: false }];
    }
  })();

  return input.broker
    .invoke({
      scope: {
        environmentId: input.environmentId,
        threadId: input.request.threadId,
        providerSessionId: `remote-viewer:${input.sessionId}:${input.request.threadId}`,
        providerInstanceId: ProviderInstanceId.make("remoteViewer"),
        capabilities: new Set(["preview"]),
        issuedAt: input.issuedAt,
      },
      operation,
      input: operationInput,
      tabId: input.request.tabId,
      timeoutMs: 10_000,
    })
    .pipe(Effect.asVoid);
}

/**
 * Starts the guest's element picker on its host and waits for the person to
 * finish with it.
 *
 * The wait is human-length on purpose. Every other operation here is a machine
 * round trip, but this one is blocked on somebody selecting elements, drawing
 * on the page and typing a comment — the same reason waiting for a download
 * approval gets a longer bound than a page condition does.
 */
export function requestRemotePreviewPick(input: {
  readonly broker: RemotePreviewInvoker;
  readonly environmentId: EnvironmentId;
  readonly sessionId: AuthSessionId;
  readonly request: PreviewRemotePickInput;
  readonly issuedAt: number;
}): Effect.Effect<
  PreviewAnnotationPayload | null,
  import("@t3tools/contracts").PreviewAutomationError
> {
  return input.broker
    .invoke<PreviewAnnotationPayload | null>({
      scope: {
        environmentId: input.environmentId,
        threadId: input.request.threadId,
        providerSessionId: `remote-viewer:${input.sessionId}:${input.request.threadId}`,
        providerInstanceId: ProviderInstanceId.make("remoteViewer"),
        capabilities: new Set(["preview"]),
        issuedAt: input.issuedAt,
      },
      operation: "pickElement",
      input: {},
      tabId: input.request.tabId,
      timeoutMs: REMOTE_PICK_TIMEOUT_MS,
    })
    .pipe(Effect.map((annotation) => annotation ?? null));
}
