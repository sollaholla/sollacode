import type {
  PreviewAutomationHost,
  PreviewAutomationRequest,
  PreviewAutomationResponse,
  PreviewAutomationStreamEvent,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import {
  isCuratedPreviewFailureCause,
  PreviewAutomationOperationError,
  type PreviewAutomationOperationContext,
  serializePreviewAutomationHostError,
} from "./previewAutomationErrors";

type AutomationStreamResult<E> = AsyncResult.AsyncResult<PreviewAutomationStreamEvent, E>;

const PREVIEW_AUTOMATION_FOREGROUND_KEEPALIVE_MS = 20_000;

export function serializePreviewAutomationError(
  error: unknown,
  context: PreviewAutomationOperationContext,
): NonNullable<PreviewAutomationResponse["error"]> {
  if (isCuratedPreviewFailureCause(error)) {
    return serializePreviewAutomationHostError(
      PreviewAutomationOperationError.fromCause({ ...context, cause: error }),
    );
  }
  // This response crosses to an agent. An unrecognised failure's message is
  // arbitrary text - a bridge token, an IPC secret, a local path - so drop it
  // and let the request id correlate the response to the full error in our own
  // logs. Reported at the boundary rather than in `fromCause`, which stays
  // faithful for logging.
  return serializePreviewAutomationHostError(
    PreviewAutomationOperationError.fromCause({ ...context, cause: undefined }),
  );
}

export function createPreviewAutomationRequestConsumerAtom<E>(options: {
  readonly requestsAtom: Atom.Atom<AutomationStreamResult<E>>;
  readonly clientId: PreviewAutomationHost["clientId"];
  readonly connectionAtom: Atom.Writable<PreviewAutomationStreamEvent["connectionId"] | null>;
  readonly environmentId: PreviewAutomationHost["environmentId"];
  readonly requestHandlerAtom: Atom.Atom<{
    readonly handle: (request: PreviewAutomationRequest) => Promise<unknown>;
  }>;
  readonly renewAutomationForeground: () => Promise<unknown>;
  readonly respond: (response: PreviewAutomationResponse) => Promise<unknown>;
  readonly label: string;
}): Atom.Atom<void> {
  return Atom.make((get) => {
    get.mount(options.connectionAtom);
    get.mount(options.requestHandlerAtom);
    let disposed = false;
    let activeConnectionId: PreviewAutomationStreamEvent["connectionId"] | null = null;
    let connectionExplicitlyAnnounced = false;
    let reportedConnectionId: PreviewAutomationStreamEvent["connectionId"] | null = null;
    let requestsVersion = 0;
    let foregroundOperationsInFlight = 0;
    let foregroundKeepaliveTimer: ReturnType<typeof setTimeout> | undefined;
    let foregroundKeepaliveError: unknown;

    const clearForegroundKeepalive = () => {
      if (foregroundKeepaliveTimer === undefined) return;
      clearTimeout(foregroundKeepaliveTimer);
      foregroundKeepaliveTimer = undefined;
    };
    const scheduleForegroundKeepalive = () => {
      if (
        disposed ||
        foregroundOperationsInFlight === 0 ||
        foregroundKeepaliveTimer !== undefined
      ) {
        return;
      }
      foregroundKeepaliveTimer = setTimeout(() => {
        foregroundKeepaliveTimer = undefined;
        void Promise.resolve()
          .then(() => options.renewAutomationForeground())
          .catch((error) => {
            foregroundKeepaliveError ??= error;
          })
          .finally(scheduleForegroundKeepalive);
      }, PREVIEW_AUTOMATION_FOREGROUND_KEEPALIVE_MS);
    };
    const withAutomationForeground = async <A>(operation: () => Promise<A>): Promise<A> => {
      await options.renewAutomationForeground();
      if (foregroundOperationsInFlight === 0) foregroundKeepaliveError = undefined;
      foregroundOperationsInFlight += 1;
      scheduleForegroundKeepalive();

      let value: A | undefined;
      let operationError: unknown;
      try {
        value = await operation();
      } catch (error) {
        operationError = error;
      }

      foregroundOperationsInFlight -= 1;
      let finalRenewalError: unknown;
      if (foregroundOperationsInFlight === 0) {
        clearForegroundKeepalive();
        if (!disposed) {
          try {
            // This is the renewal that starts the 60-second idle countdown. It
            // happens only after the last concurrent MCP operation has settled.
            await options.renewAutomationForeground();
          } catch (error) {
            finalRenewalError = error;
          }
        }
      }

      if (operationError !== undefined) throw operationError;
      if (foregroundKeepaliveError !== undefined) throw foregroundKeepaliveError;
      if (finalRenewalError !== undefined) throw finalRenewalError;
      return value as A;
    };

    const consume = (result: AutomationStreamResult<E>) => {
      if (!AsyncResult.isSuccess(result)) return;
      const event = result.value;
      if (event.type === "connected") {
        activeConnectionId = event.connectionId;
        connectionExplicitlyAnnounced = true;
      } else if (activeConnectionId === null) {
        activeConnectionId = event.connectionId;
      } else if (activeConnectionId !== event.connectionId) {
        if (connectionExplicitlyAnnounced) return;
        activeConnectionId = event.connectionId;
      }
      if (reportedConnectionId !== event.connectionId) {
        reportedConnectionId = event.connectionId;
        get.set(options.connectionAtom, event.connectionId);
      }
      if (event.type === "connected") {
        // Wake the full desktop guest fleet as soon as an agent attaches, not
        // only when its first snapshot arrives. Auth SDKs can then finish
        // foreground-only session hydration before that first observation.
        void Promise.resolve()
          .then(() => options.renewAutomationForeground())
          .catch(() => undefined);
        return;
      }
      if (Date.now() >= event.request.expiresAt) {
        return;
      }
      const request = {
        ...event.request,
        timeoutMs: Math.max(1, event.request.expiresAt - Date.now()),
      };
      const handleRequest = get.once(options.requestHandlerAtom).handle;
      void Promise.resolve()
        .then(() => withAutomationForeground(() => handleRequest(request)))
        .then(
          (value) =>
            options.respond({
              clientId: options.clientId,
              connectionId: event.connectionId,
              requestId: request.requestId,
              ok: true,
              ...(value === undefined ? {} : { result: value }),
            }),
          (error) =>
            options.respond({
              clientId: options.clientId,
              connectionId: event.connectionId,
              requestId: request.requestId,
              ok: false,
              error: serializePreviewAutomationError(error, {
                requestId: request.requestId,
                operation: request.operation,
                environmentId: options.environmentId,
                threadId: request.threadId,
                tabId: request.tabId ?? null,
              }),
            }),
        );
    };

    get.addFinalizer(() => {
      disposed = true;
      clearForegroundKeepalive();
    });
    const initialRequest = get.once(options.requestsAtom);
    if (AsyncResult.isSuccess(initialRequest)) {
      activeConnectionId = initialRequest.value.connectionId;
      connectionExplicitlyAnnounced = initialRequest.value.type === "connected";
      if (initialRequest.value.type === "connected") {
        reportedConnectionId = initialRequest.value.connectionId;
        get.set(options.connectionAtom, initialRequest.value.connectionId);
      }
    }
    get.subscribe(options.requestsAtom, (result) => {
      requestsVersion += 1;
      consume(result);
    });
    queueMicrotask(() => {
      const initialConnectionWasSkipped =
        AsyncResult.isSuccess(initialRequest) &&
        initialRequest.value.connectionId === activeConnectionId &&
        initialRequest.value.connectionId !== reportedConnectionId;
      if (!disposed && (requestsVersion === 0 || initialConnectionWasSkipped)) {
        consume(initialRequest);
      }
    });
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(options.label));
}
