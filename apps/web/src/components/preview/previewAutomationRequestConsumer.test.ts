import {
  EnvironmentId,
  PREVIEW_AUTOMATION_OPERATIONS,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  type PreviewAutomationStreamEvent,
  PreviewTabId,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  PreviewAutomationHumanVerificationHostError,
  PreviewAutomationNavigationLoadFailedHostError,
  PreviewAutomationRecordingNotActiveError,
  PreviewAutomationTargetUnavailableError,
  PreviewAutomationViewportTimeoutError,
} from "./previewAutomationErrors";
import {
  createPreviewAutomationRequestConsumerAtom,
  serializePreviewAutomationError,
} from "./previewAutomationRequestConsumer";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const tabId = PreviewTabId.make("tab-1");
const clientId = "client-1";
const connectionId = "connection-1";
const renewAutomationForeground = async (): Promise<void> => undefined;

const request = (
  requestId: string,
  overrides: Partial<PreviewAutomationRequest> = {},
): PreviewAutomationRequest => ({
  requestId,
  threadId,
  operation: "status",
  input: {},
  timeoutMs: 15_000,
  expiresAt: Date.now() + 60_000,
  ...overrides,
});

const requestEvent = (
  requestId: string,
  overrides: Partial<PreviewAutomationRequest> = {},
  eventConnectionId = connectionId,
): PreviewAutomationStreamEvent => ({
  type: "request",
  connectionId: eventConnectionId,
  request: request(requestId, overrides),
});

const consumerState = (handleRequest: (request: PreviewAutomationRequest) => Promise<unknown>) => ({
  connectionAtom: Atom.make<string | null>(null),
  requestHandlerAtom: Atom.make({ handle: handleRequest }),
});

describe("previewAutomationRequestConsumer", () => {
  it("foregrounds the guest fleet when an automation client connects", async () => {
    const requestsAtom = Atom.make(
      AsyncResult.success<PreviewAutomationStreamEvent, Error>({
        type: "connected",
        connectionId,
      }),
    );
    const renewForeground = vi.fn(async () => undefined);
    const handleRequest = vi.fn(async () => undefined);
    const respond = vi.fn(async () => undefined);
    const state = consumerState(handleRequest);
    const consumerAtom = createPreviewAutomationRequestConsumerAtom({
      requestsAtom,
      clientId,
      connectionAtom: state.connectionAtom,
      environmentId,
      requestHandlerAtom: state.requestHandlerAtom,
      renewAutomationForeground: renewForeground,
      respond,
      label: "test:preview-automation-connect-foreground",
    });
    const registry = AtomRegistry.make();

    registry.mount(consumerAtom);

    await vi.waitFor(() => expect(renewForeground).toHaveBeenCalledOnce());
    expect(handleRequest).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    registry.dispose();
  });

  it("acknowledges a replacement stream before consuming requests from it", async () => {
    const requestsAtom = Atom.make(
      AsyncResult.success<PreviewAutomationStreamEvent, Error>({
        type: "connected",
        connectionId,
      }),
    );
    const handleRequest = vi.fn(async () => undefined);
    const respond = vi.fn(async () => undefined);
    const state = consumerState(handleRequest);
    const consumerAtom = createPreviewAutomationRequestConsumerAtom({
      requestsAtom,
      clientId,
      connectionAtom: state.connectionAtom,
      environmentId,
      requestHandlerAtom: state.requestHandlerAtom,
      renewAutomationForeground,
      respond,
      label: "test:preview-automation-connected",
    });
    const registry = AtomRegistry.make();

    registry.mount(consumerAtom);
    registry.set(requestsAtom, AsyncResult.success(requestEvent("request-after-connect")));

    await vi.waitFor(() => expect(registry.get(state.connectionAtom)).toBe(connectionId));
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(handleRequest).toHaveBeenCalledTimes(1);
    registry.dispose();
  });

  it("drops late requests from an older stream generation", async () => {
    const requestsAtom = Atom.make(
      AsyncResult.success<PreviewAutomationStreamEvent, Error>({
        type: "connected",
        connectionId: "connection-2",
      }),
    );
    const handleRequest = vi.fn(async () => undefined);
    const respond = vi.fn(async () => undefined);
    const state = consumerState(handleRequest);
    const consumerAtom = createPreviewAutomationRequestConsumerAtom({
      requestsAtom,
      clientId,
      connectionAtom: state.connectionAtom,
      environmentId,
      requestHandlerAtom: state.requestHandlerAtom,
      renewAutomationForeground,
      respond,
      label: "test:preview-automation-stale-generation",
    });
    const registry = AtomRegistry.make();

    registry.mount(consumerAtom);
    registry.set(
      requestsAtom,
      AsyncResult.success(requestEvent("request-stale", {}, "connection-1")),
    );

    await vi.waitFor(() => expect(registry.get(state.connectionAtom)).toBe("connection-2"));
    expect(handleRequest).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    registry.dispose();
  });

  it("consumes every request emitted before React can render", async () => {
    const requestsAtom = Atom.make<AsyncResult.AsyncResult<PreviewAutomationStreamEvent, Error>>(
      AsyncResult.initial<PreviewAutomationStreamEvent, Error>(false),
    );
    const handleRequest = vi.fn(async (value: PreviewAutomationRequest) => ({
      requestId: value.requestId,
    }));
    const responses: PreviewAutomationResponse[] = [];
    const respond = vi.fn(async (response: PreviewAutomationResponse) => {
      responses.push(response);
    });
    const state = consumerState(handleRequest);
    const consumerAtom = createPreviewAutomationRequestConsumerAtom({
      requestsAtom,
      clientId,
      connectionAtom: state.connectionAtom,
      environmentId,
      requestHandlerAtom: state.requestHandlerAtom,
      renewAutomationForeground,
      respond,
      label: "test:preview-automation-consumer",
    });
    const registry = AtomRegistry.make();
    registry.mount(consumerAtom);

    registry.set(requestsAtom, AsyncResult.success(requestEvent("request-1")));
    registry.set(requestsAtom, AsyncResult.success(requestEvent("request-2")));

    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    expect(handleRequest.mock.calls.map(([value]) => value.requestId)).toEqual([
      "request-1",
      "request-2",
    ]);
    expect(responses.map((response) => response.requestId)).toEqual(["request-1", "request-2"]);
    registry.dispose();
  });

  it("renews foreground before dispatching every automation operation", async () => {
    const requestsAtom = Atom.make<AsyncResult.AsyncResult<PreviewAutomationStreamEvent, Error>>(
      AsyncResult.initial<PreviewAutomationStreamEvent, Error>(false),
    );
    const order: string[] = [];
    const renewForeground = vi.fn(async () => {
      order.push("renew");
    });
    const handleRequest = vi.fn(async (value: PreviewAutomationRequest) => {
      order.push(`handle:${value.operation}`);
    });
    const respond = vi.fn(async (_response: PreviewAutomationResponse) => undefined);
    const state = consumerState(handleRequest);
    const consumerAtom = createPreviewAutomationRequestConsumerAtom({
      requestsAtom,
      clientId,
      connectionAtom: state.connectionAtom,
      environmentId,
      requestHandlerAtom: state.requestHandlerAtom,
      renewAutomationForeground: renewForeground,
      respond,
      label: "test:preview-automation-renew-foreground",
    });
    const registry = AtomRegistry.make();
    registry.mount(consumerAtom);

    for (const [index, operation] of PREVIEW_AUTOMATION_OPERATIONS.entries()) {
      registry.set(
        requestsAtom,
        AsyncResult.success(
          requestEvent(`request-${operation}`, {
            operation,
          }),
        ),
      );
      await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(index + 1));
    }

    expect(renewForeground).toHaveBeenCalledTimes(PREVIEW_AUTOMATION_OPERATIONS.length * 2);
    expect(order).toEqual(
      PREVIEW_AUTOMATION_OPERATIONS.flatMap((operation) => [
        "renew",
        `handle:${operation}`,
        "renew",
      ]),
    );
    registry.dispose();
  });

  it("keeps renewing foreground throughout an operation longer than the idle lease", async () => {
    vi.useFakeTimers();
    const requestsAtom = Atom.make<AsyncResult.AsyncResult<PreviewAutomationStreamEvent, Error>>(
      AsyncResult.initial<PreviewAutomationStreamEvent, Error>(false),
    );
    let finish: ((value: string) => void) | undefined;
    const handleRequest = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const renewForeground = vi.fn(async () => undefined);
    const respond = vi.fn(async (_response: PreviewAutomationResponse) => undefined);
    const state = consumerState(handleRequest);
    const registry = AtomRegistry.make();
    try {
      registry.mount(
        createPreviewAutomationRequestConsumerAtom({
          requestsAtom,
          clientId,
          connectionAtom: state.connectionAtom,
          environmentId,
          requestHandlerAtom: state.requestHandlerAtom,
          renewAutomationForeground: renewForeground,
          respond,
          label: "test:preview-automation-long-foreground",
        }),
      );
      registry.set(requestsAtom, AsyncResult.success(requestEvent("request-long")));
      await vi.advanceTimersByTimeAsync(0);

      expect(handleRequest).toHaveBeenCalledOnce();
      expect(renewForeground).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(renewForeground.mock.calls.length).toBeGreaterThanOrEqual(7);
      expect(respond).not.toHaveBeenCalled();

      finish?.("complete");
      await vi.advanceTimersByTimeAsync(0);
      expect(renewForeground.mock.calls.length).toBeGreaterThanOrEqual(8);
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: "request-long", ok: true, result: "complete" }),
      );
    } finally {
      registry.dispose();
      vi.useRealTimers();
    }
  });

  it("starts the idle countdown only after all concurrent operations finish", async () => {
    const requestsAtom = Atom.make<AsyncResult.AsyncResult<PreviewAutomationStreamEvent, Error>>(
      AsyncResult.initial<PreviewAutomationStreamEvent, Error>(false),
    );
    const finishes = new Map<string, () => void>();
    const handleRequest = vi.fn(
      (value: PreviewAutomationRequest) =>
        new Promise<void>((resolve) => {
          finishes.set(value.requestId, resolve);
        }),
    );
    const renewForeground = vi.fn(async () => undefined);
    const respond = vi.fn(async (_response: PreviewAutomationResponse) => undefined);
    const state = consumerState(handleRequest);
    const registry = AtomRegistry.make();
    registry.mount(
      createPreviewAutomationRequestConsumerAtom({
        requestsAtom,
        clientId,
        connectionAtom: state.connectionAtom,
        environmentId,
        requestHandlerAtom: state.requestHandlerAtom,
        renewAutomationForeground: renewForeground,
        respond,
        label: "test:preview-automation-concurrent-foreground",
      }),
    );

    registry.set(requestsAtom, AsyncResult.success(requestEvent("request-one")));
    registry.set(requestsAtom, AsyncResult.success(requestEvent("request-two")));
    await vi.waitFor(() => expect(handleRequest).toHaveBeenCalledTimes(2));
    expect(renewForeground).toHaveBeenCalledTimes(2);

    finishes.get("request-one")?.();
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(renewForeground).toHaveBeenCalledTimes(2);

    finishes.get("request-two")?.();
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    expect(renewForeground).toHaveBeenCalledTimes(3);
    registry.dispose();
  });

  it("stops foreground keepalives when the automation host unmounts", async () => {
    vi.useFakeTimers();
    const requestsAtom = Atom.make<AsyncResult.AsyncResult<PreviewAutomationStreamEvent, Error>>(
      AsyncResult.initial<PreviewAutomationStreamEvent, Error>(false),
    );
    let finish: (() => void) | undefined;
    const handleRequest = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const renewForeground = vi.fn(async () => undefined);
    const state = consumerState(handleRequest);
    const registry = AtomRegistry.make();
    try {
      registry.mount(
        createPreviewAutomationRequestConsumerAtom({
          requestsAtom,
          clientId,
          connectionAtom: state.connectionAtom,
          environmentId,
          requestHandlerAtom: state.requestHandlerAtom,
          renewAutomationForeground: renewForeground,
          respond: async () => undefined,
          label: "test:preview-automation-unmount-foreground",
        }),
      );
      registry.set(requestsAtom, AsyncResult.success(requestEvent("request-unmounted")));
      await vi.advanceTimersByTimeAsync(0);
      expect(renewForeground).toHaveBeenCalledOnce();

      registry.dispose();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(renewForeground).toHaveBeenCalledOnce();
      finish?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(renewForeground).toHaveBeenCalledOnce();
    } finally {
      registry.dispose();
      vi.useRealTimers();
    }
  });

  it("does not dispatch an operation when foreground renewal fails", async () => {
    const requestsAtom = Atom.make<AsyncResult.AsyncResult<PreviewAutomationStreamEvent, Error>>(
      AsyncResult.initial<PreviewAutomationStreamEvent, Error>(false),
    );
    const renewForeground = vi.fn(async () => {
      throw new Error("foreground lease unavailable");
    });
    const handleRequest = vi.fn(async () => undefined);
    const responses: PreviewAutomationResponse[] = [];
    const state = consumerState(handleRequest);
    const consumerAtom = createPreviewAutomationRequestConsumerAtom({
      requestsAtom,
      clientId,
      connectionAtom: state.connectionAtom,
      environmentId,
      requestHandlerAtom: state.requestHandlerAtom,
      renewAutomationForeground: renewForeground,
      respond: async (response) => {
        responses.push(response);
      },
      label: "test:preview-automation-renew-failure",
    });
    const registry = AtomRegistry.make();
    registry.mount(consumerAtom);

    registry.set(requestsAtom, AsyncResult.success(requestEvent("request-renew-failed")));

    await vi.waitFor(() => expect(responses).toHaveLength(1));
    expect(handleRequest).not.toHaveBeenCalled();
    expect(responses[0]).toMatchObject({
      requestId: "request-renew-failed",
      ok: false,
      error: {
        _tag: "PreviewAutomationExecutionError",
        detail: { operation: "status" },
      },
    });
    registry.dispose();
  });

  it("discards an expired queued request without executing its side effect", async () => {
    const requestsAtom = Atom.make<AsyncResult.AsyncResult<PreviewAutomationStreamEvent, Error>>(
      AsyncResult.initial<PreviewAutomationStreamEvent, Error>(false),
    );
    const handleRequest = vi.fn(async () => undefined);
    const renewForeground = vi.fn(async () => undefined);
    const respond = vi.fn(async () => undefined);
    const state = consumerState(handleRequest);
    const consumerAtom = createPreviewAutomationRequestConsumerAtom({
      requestsAtom,
      clientId,
      connectionAtom: state.connectionAtom,
      environmentId,
      requestHandlerAtom: state.requestHandlerAtom,
      renewAutomationForeground: renewForeground,
      respond,
      label: "test:preview-automation-expired-request",
    });
    const registry = AtomRegistry.make();
    registry.mount(consumerAtom);

    registry.set(
      requestsAtom,
      AsyncResult.success(requestEvent("request-expired", { expiresAt: Date.now() - 1 })),
    );
    await Promise.resolve();

    expect(handleRequest).not.toHaveBeenCalled();
    expect(renewForeground).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    registry.dispose();
  });

  it("uses the latest request handler without rebuilding the stream consumer", async () => {
    const requestsAtom = Atom.make<AsyncResult.AsyncResult<PreviewAutomationStreamEvent, Error>>(
      AsyncResult.initial<PreviewAutomationStreamEvent, Error>(false),
    );
    const firstHandler = vi.fn(async () => "first");
    const secondHandler = vi.fn(async () => "second");
    const respond = vi.fn(async (_response: PreviewAutomationResponse) => undefined);
    const state = consumerState(firstHandler);
    const consumerAtom = createPreviewAutomationRequestConsumerAtom({
      requestsAtom,
      clientId,
      connectionAtom: state.connectionAtom,
      environmentId,
      requestHandlerAtom: state.requestHandlerAtom,
      renewAutomationForeground,
      respond,
      label: "test:preview-automation-latest-handler",
    });
    const registry = AtomRegistry.make();
    registry.mount(consumerAtom);

    registry.set(requestsAtom, AsyncResult.success(requestEvent("request-first")));
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    registry.set(state.requestHandlerAtom, { handle: secondHandler });
    registry.set(requestsAtom, AsyncResult.success(requestEvent("request-second")));

    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    expect(firstHandler).toHaveBeenCalledTimes(1);
    expect(secondHandler).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls.map(([response]) => response.result)).toEqual(["first", "second"]);
    registry.dispose();
  });

  it("consumes a request that arrived immediately before the consumer mounted", async () => {
    const requestsAtom = Atom.make(
      AsyncResult.success<PreviewAutomationStreamEvent, Error>(requestEvent("request-ready")),
    );
    const respond = vi.fn(async (_response: PreviewAutomationResponse) => undefined);
    const state = consumerState(async () => undefined);
    const consumerAtom = createPreviewAutomationRequestConsumerAtom({
      requestsAtom,
      clientId,
      connectionAtom: state.connectionAtom,
      environmentId,
      requestHandlerAtom: state.requestHandlerAtom,
      renewAutomationForeground,
      respond,
      label: "test:preview-automation-initial-request",
    });
    const registry = AtomRegistry.make();

    registry.mount(consumerAtom);

    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond).toHaveBeenCalledWith({
      clientId,
      connectionId,
      requestId: "request-ready",
      ok: true,
    });
    registry.dispose();
  });

  it("preserves tagged automation errors and their structured diagnostics", () => {
    const error = new PreviewAutomationTargetUnavailableError({
      requestId: "request-1",
      operation: "click",
      environmentId,
      threadId,
      tabId,
      bridgeAvailable: false,
    });

    expect(
      serializePreviewAutomationError(error, {
        requestId: "request-1",
        operation: "click",
        environmentId,
        threadId,
        tabId,
      }),
    ).toEqual({
      _tag: "PreviewAutomationTabNotFoundError",
      message:
        "Preview automation target for click request request-1 is unavailable on environment environment-1 thread thread-1 (tab tab-1, bridge unavailable).",
      detail: {
        requestId: "request-1",
        operation: "click",
        environmentId: "environment-1",
        threadId: "thread-1",
        tabId: "tab-1",
        bridgeAvailable: false,
      },
    });
  });

  it("reports a missing recording even when no preview tab remains", () => {
    const error = new PreviewAutomationRecordingNotActiveError({
      requestId: "request-recording-stop",
      environmentId,
      threadId,
      tabId: null,
    });

    expect(
      serializePreviewAutomationError(error, {
        requestId: "request-recording-stop",
        operation: "recordingStop",
        environmentId,
        threadId,
        tabId: null,
      }),
    ).toMatchObject({
      _tag: "PreviewAutomationExecutionError",
      detail: { tabId: null },
    });
  });

  it("preserves viewport render timeouts as timeout responses", () => {
    const error = new PreviewAutomationViewportTimeoutError({
      requestId: "request-resize",
      environmentId,
      threadId,
      tabId,
      timeoutMs: 2_500,
    });

    expect(
      serializePreviewAutomationError(error, {
        requestId: "request-resize",
        operation: "resize",
        environmentId,
        threadId,
        tabId,
      }),
    ).toMatchObject({
      _tag: "PreviewAutomationTimeoutError",
      detail: { tabId: "tab-1", timeoutMs: 2_500 },
    });
  });

  it("serializes navigation load failures as actionable execution errors", () => {
    const error = new PreviewAutomationNavigationLoadFailedHostError({
      requestId: "request-navigate",
      operation: "navigate",
      environmentId,
      threadId,
      tabId,
      code: -105,
      description: "ERR_NAME_NOT_RESOLVED",
    });

    expect(
      serializePreviewAutomationError(error, {
        requestId: "request-navigate",
        operation: "navigate",
        environmentId,
        threadId,
        tabId,
      }),
    ).toEqual({
      _tag: "PreviewAutomationExecutionError",
      message:
        "Preview navigation for navigate request request-navigate failed in tab tab-1: ERR_NAME_NOT_RESOLVED (-105). Correct the URL or underlying network/site error before retrying.",
      detail: {
        requestId: "request-navigate",
        operation: "navigate",
        environmentId: "environment-1",
        threadId: "thread-1",
        tabId: "tab-1",
        code: -105,
        description: "ERR_NAME_NOT_RESOLVED",
      },
    });
  });

  it("preserves a human-verification gate and its privacy-safe diagnostics", () => {
    const verification = {
      state: "human_verification_required" as const,
      kind: "bot-detection" as const,
      code: "600010",
      detectedAt: "2026-08-26T12:00:00.000Z",
      url: "https://suno.com/create",
      retryCount: 0,
      retryAvailable: false,
      message: "Automation is paused for this tab.",
      compatibilityCheckUrl: "https://debug.challenges.cloudflare.com/" as const,
      feedbackUrl:
        "https://developers.cloudflare.com/turnstile/troubleshooting/feedback-reports/" as const,
      diagnostic: {
        browserProduct: "Chrome",
        browserVersion: "140.0.0.0",
        browserUserAgent: "Mozilla/5.0 Chrome/140.0.0.0",
        embeddedBrowser: true,
        headedBrowser: true,
        automationAvailable: true,
        cdpAttached: true,
        viewportMode: null,
        colorSchemeOverride: null,
        userAgentOverride: null,
        canvasOverride: null,
        webglOverride: null,
        extensionsEnabled: null,
        proxyOrVpn: null,
        cfMitigated: null,
        responseStatusCode: null,
        challengesCloudflareReachable: null,
        rayId: null,
        qrIdentifier: null,
        systemClockIso: "2026-08-26T12:00:00.000Z",
        systemClockCorrect: null,
      },
    };
    const error = new PreviewAutomationHumanVerificationHostError({
      requestId: "request-challenge",
      operation: "click",
      environmentId,
      threadId,
      tabId,
      verification,
    });

    expect(
      serializePreviewAutomationError(error, {
        requestId: "request-challenge",
        operation: "click",
        environmentId,
        threadId,
        tabId,
      }),
    ).toMatchObject({
      _tag: "PreviewAutomationHumanVerificationRequiredError",
      detail: { tabId: "tab-1", verification },
    });
  });

  it("maps desktop non-editable targets to the public typed response", () => {
    expect(
      serializePreviewAutomationError(
        {
          _tag: "PreviewAutomationTargetNotEditableError",
          tabId: "tab-1",
          selectorKind: "selector",
          selectorLength: 6,
        },
        {
          requestId: "request-type",
          operation: "type",
          environmentId,
          threadId,
          tabId,
        },
      ),
    ).toEqual({
      _tag: "PreviewAutomationTargetNotEditableError",
      message:
        "Preview automation type request request-type requires an editable target in tab tab-1.",
      detail: {
        requestId: "request-type",
        operation: "type",
        environmentId: "environment-1",
        threadId: "thread-1",
        tabId: "tab-1",
        selectorKind: "selector",
        selectorLength: 6,
      },
    });
  });

  it("correlates unexpected failures without exposing cause details", () => {
    const cause = new Error("private bridge token: preview-secret");
    const context = {
      requestId: "request-2",
      operation: "snapshot" as const,
      environmentId,
      threadId,
      tabId,
    };
    const response = serializePreviewAutomationError(cause, context);

    expect(response).toEqual({
      _tag: "PreviewAutomationExecutionError",
      message:
        "Preview automation snapshot request request-2 failed on environment environment-1 thread thread-1 (tab tab-1).",
      detail: {
        requestId: "request-2",
        operation: "snapshot",
        environmentId: "environment-1",
        threadId: "thread-1",
        tabId: "tab-1",
      },
    });
    expect(JSON.stringify(response)).not.toContain("preview-secret");
  });

  it("sanitizes unexpected handler failures at the response boundary", async () => {
    const requestsAtom = Atom.make<AsyncResult.AsyncResult<PreviewAutomationStreamEvent, Error>>(
      AsyncResult.initial<PreviewAutomationStreamEvent, Error>(false),
    );
    const responses: PreviewAutomationResponse[] = [];
    const state = consumerState(async () => {
      throw new Error("desktop IPC secret: do-not-return");
    });
    const consumerAtom = createPreviewAutomationRequestConsumerAtom({
      requestsAtom,
      clientId,
      connectionAtom: state.connectionAtom,
      environmentId,
      requestHandlerAtom: state.requestHandlerAtom,
      renewAutomationForeground,
      respond: async (response) => {
        responses.push(response);
      },
      label: "test:preview-automation-failure-boundary",
    });
    const registry = AtomRegistry.make();
    registry.mount(consumerAtom);

    registry.set(
      requestsAtom,
      AsyncResult.success(
        requestEvent("request-failed", {
          operation: "click",
          tabId,
        }),
      ),
    );

    await vi.waitFor(() => expect(responses).toHaveLength(1));
    expect(responses[0]).toEqual({
      clientId,
      connectionId,
      requestId: "request-failed",
      ok: false,
      error: {
        _tag: "PreviewAutomationExecutionError",
        message:
          "Preview automation click request request-failed failed on environment environment-1 thread thread-1 (tab tab-1).",
        detail: {
          requestId: "request-failed",
          operation: "click",
          environmentId: "environment-1",
          threadId: "thread-1",
          tabId: "tab-1",
        },
      },
    });
    expect(JSON.stringify(responses[0])).not.toContain("do-not-return");
    registry.dispose();
  });
});
