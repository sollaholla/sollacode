import {
  PreviewAutomationViewportUnavailableError,
  ProviderInstanceId,
  type AuthSessionId,
  type EnvironmentId,
  type PreviewAutomationOperation,
  type PreviewAutomationStatus,
  type PreviewRemoteInputInput,
  type PreviewRemoteInputResult,
  type PreviewRenderedViewportSize,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";

type RemotePreviewInvoker = Pick<
  PreviewAutomationBroker.PreviewAutomationBroker["Service"],
  "invoke"
>;

const STATUS_TIMEOUT_MS = 10_000;
const ACTION_TIMEOUT_MS = 15_000;

export function dispatchRemotePreviewInput(input: {
  readonly broker: RemotePreviewInvoker;
  readonly environmentId: EnvironmentId;
  readonly sessionId: AuthSessionId;
  readonly request: PreviewRemoteInputInput;
  readonly issuedAt: number;
}): Effect.Effect<PreviewRemoteInputResult, import("@t3tools/contracts").PreviewAutomationError> {
  const invoke = <A>(
    operation: PreviewAutomationOperation,
    operationInput: unknown,
    timeoutMs: number,
  ) =>
    input.broker.invoke<A>({
      scope: {
        environmentId: input.environmentId,
        threadId: input.request.threadId,
        providerSessionId: `mobile-browser:${input.sessionId}:${input.request.threadId}`,
        providerInstanceId: ProviderInstanceId.make("mobileBrowser"),
        capabilities: new Set(["preview"]),
        issuedAt: input.issuedAt,
      },
      operation,
      input: operationInput,
      tabId: input.request.tabId,
      timeoutMs,
    });

  // Coordinate actions arrive as frame fractions; the guest's CSS viewport is
  // measured on the host at dispatch time so a desktop panel resize between
  // frame and tap cannot skew the mapping (fractions are scale-invariant).
  const measuredViewport = Effect.gen(function* () {
    const status = yield* invoke<PreviewAutomationStatus>("status", {}, STATUS_TIMEOUT_MS);
    if (status.viewport === undefined) {
      return yield* Effect.fail(
        new PreviewAutomationViewportUnavailableError({
          environmentId: input.environmentId,
          threadId: input.request.threadId,
          tabId: input.request.tabId,
          reason: "The tab has not reported a rendered page size yet.",
        }),
      );
    }
    return status.viewport;
  });

  const toCss = (
    viewport: PreviewRenderedViewportSize,
    point: { readonly x: number; readonly y: number },
  ) => ({ x: point.x * viewport.width, y: point.y * viewport.height });

  const action = input.request.action;
  const dispatch = Effect.gen(function* () {
    switch (action.kind) {
      case "click": {
        const viewport = yield* measuredViewport;
        yield* invoke("click", toCss(viewport, action.position), ACTION_TIMEOUT_MS);
        return;
      }
      case "drag": {
        const viewport = yield* measuredViewport;
        yield* invoke(
          "drag",
          { from: toCss(viewport, action.from), to: toCss(viewport, action.to) },
          ACTION_TIMEOUT_MS,
        );
        return;
      }
      case "scroll": {
        const viewport = yield* measuredViewport;
        yield* invoke(
          "scroll",
          {
            deltaX: action.deltaX * viewport.width,
            deltaY: action.deltaY * viewport.height,
          },
          ACTION_TIMEOUT_MS,
        );
        return;
      }
      case "type": {
        // No locator: the host types into the currently focused element, which
        // a preceding click gesture selected — same contract agents rely on.
        yield* invoke("type", { text: action.text }, ACTION_TIMEOUT_MS);
        return;
      }
      case "press": {
        yield* invoke("press", { key: action.key }, ACTION_TIMEOUT_MS);
        return;
      }
    }
  });

  return dispatch.pipe(
    Effect.map(() => ({
      deliveredAt: DateTime.formatIso(DateTime.makeUnsafe(input.issuedAt)),
    })),
  );
}
