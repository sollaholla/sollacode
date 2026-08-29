import {
  AuthSessionId,
  EnvironmentId,
  PreviewTabId,
  ThreadId,
  PreviewAutomationNoAvailableHostError,
  type PreviewAutomationError,
  ProviderInstanceId,
  type PreviewAutomationSnapshot,
  type PreviewRemoteInputAction,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { PreviewAutomationInvokeInput } from "../mcp/PreviewAutomationBroker.ts";
import type * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";

type RemotePreviewInvokeFn = PreviewAutomationBroker.PreviewAutomationBroker["Service"]["invoke"];
import {
  applyRemotePreviewInput,
  captureRemotePreviewSnapshot,
  requestRemotePreviewPick,
} from "./RemotePreviewCapture.ts";

const snapshot: PreviewAutomationSnapshot = {
  url: "https://example.com/",
  title: "Example",
  loading: false,
  visibleText: "private diagnostic text that mobile does not need",
  interactiveElements: [],
  accessibilityTree: {},
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
  screenshot: {
    mimeType: "image/jpeg",
    data: "frame",
    width: 1024,
    height: 640,
  },
};

describe("captureRemotePreviewSnapshot", () => {
  it.effect("targets the exact host tab and strips browser diagnostics", () =>
    Effect.gen(function* () {
      const requests: PreviewAutomationInvokeInput[] = [];
      const result = yield* captureRemotePreviewSnapshot({
        broker: {
          invoke: <A = unknown>(request: PreviewAutomationInvokeInput) => {
            requests.push(request);
            return Effect.succeed(snapshot as A);
          },
        },
        environmentId: EnvironmentId.make("environment-mobile-preview"),
        sessionId: AuthSessionId.make("session-mobile-preview"),
        request: {
          threadId: ThreadId.make("thread-mobile-preview"),
          tabId: PreviewTabId.make("tab-mobile-preview"),
        },
        issuedAt: Date.parse("2026-08-26T00:00:00.000Z"),
      });

      // Only one request, and the cheap one: building the snapshot fallback
      // must not also dispatch it.
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        operation: "frame",
        tabId: "tab-mobile-preview",
        timeoutMs: 10_000,
        scope: {
          environmentId: "environment-mobile-preview",
          threadId: "thread-mobile-preview",
          providerInstanceId: "mobileBrowser",
        },
      });
      expect(result).toEqual({
        tabId: "tab-mobile-preview",
        url: "https://example.com/",
        title: "Example",
        loading: false,
        capturedAt: "2026-08-26T00:00:00.000Z",
        screenshot: snapshot.screenshot,
      });
      expect(result).not.toHaveProperty("visibleText");
      expect(result).not.toHaveProperty("consoleEntries");
    }),
  );
});

describe("applyRemotePreviewInput", () => {
  const record = (action: PreviewRemoteInputAction) =>
    Effect.gen(function* () {
      const requests: PreviewAutomationInvokeInput[] = [];
      yield* applyRemotePreviewInput({
        broker: {
          invoke: <A = unknown>(request: PreviewAutomationInvokeInput) => {
            requests.push(request);
            return Effect.succeed(undefined as A);
          },
        },
        environmentId: EnvironmentId.make("environment-remote-viewer"),
        sessionId: AuthSessionId.make("session-remote-viewer"),
        request: {
          threadId: ThreadId.make("thread-remote-viewer"),
          tabId: PreviewTabId.make("tab-remote-viewer"),
          action,
        },
        issuedAt: Date.parse("2026-08-29T00:00:00.000Z"),
      });
      return requests;
    });

  it.effect("aims a click at the page, on the host's own tab", () =>
    Effect.gen(function* () {
      const requests = yield* record({ kind: "click", x: 120, y: 48 });
      expect(requests[0]).toMatchObject({
        operation: "click",
        input: { x: 120, y: 48 },
        tabId: "tab-remote-viewer",
        scope: {
          environmentId: "environment-remote-viewer",
          threadId: "thread-remote-viewer",
          providerInstanceId: "remoteViewer",
        },
      });
    }),
  );

  it.effect("types into whatever the person just focused, with no locator", () =>
    Effect.gen(function* () {
      const requests = yield* record({ kind: "type", text: "hello" });
      expect(requests[0]).toMatchObject({ operation: "type", input: { text: "hello" } });
      // A locator would aim this somewhere the person did not click.
      expect(requests[0]?.input).not.toHaveProperty("locator");
      expect(requests[0]?.input).not.toHaveProperty("selector");
    }),
  );

  it.effect("carries modifiers only when the person held some", () =>
    Effect.gen(function* () {
      expect((yield* record({ kind: "press", key: "Enter" }))[0]).toMatchObject({
        operation: "press",
        input: { key: "Enter" },
      });
      expect((yield* record({ kind: "press", key: "a", modifiers: ["Meta"] }))[0]).toMatchObject({
        operation: "press",
        input: { key: "a", modifiers: ["Meta"] },
      });
    }),
  );

  it.effect("scrolls the viewport rather than an element", () =>
    Effect.gen(function* () {
      const requests = yield* record({ kind: "scroll", deltaX: 0, deltaY: 240 });
      expect(requests[0]).toMatchObject({
        operation: "scroll",
        input: { deltaX: 0, deltaY: 240 },
      });
    }),
  );

  it.effect("walks history and reloads in the page, which have no operation", () =>
    Effect.gen(function* () {
      expect((yield* record({ kind: "history", direction: "back" }))[0]).toMatchObject({
        operation: "evaluate",
        input: { expression: "history.back()" },
      });
      expect((yield* record({ kind: "history", direction: "forward" }))[0]).toMatchObject({
        operation: "evaluate",
        input: { expression: "history.forward()" },
      });
      expect((yield* record({ kind: "reload" }))[0]).toMatchObject({
        operation: "evaluate",
        input: { expression: "location.reload()" },
      });
    }),
  );

  it.effect("sends the URL bar through the host's own navigation", () =>
    Effect.gen(function* () {
      const requests = yield* record({ kind: "navigate", url: "https://example.com/next" });
      expect(requests[0]).toMatchObject({
        operation: "navigate",
        input: { url: "https://example.com/next" },
      });
    }),
  );
});

describe("requestRemotePreviewPick", () => {
  it.effect("waits on a person rather than a request round trip", () =>
    Effect.gen(function* () {
      const requests: PreviewAutomationInvokeInput[] = [];
      const annotation = yield* requestRemotePreviewPick({
        broker: {
          invoke: <A = unknown>(request: PreviewAutomationInvokeInput) => {
            requests.push(request);
            return Effect.succeed({ id: "annotation-1" } as A);
          },
        },
        environmentId: EnvironmentId.make("environment-remote-viewer"),
        sessionId: AuthSessionId.make("session-remote-viewer"),
        request: {
          threadId: ThreadId.make("thread-remote-viewer"),
          tabId: PreviewTabId.make("tab-remote-viewer"),
        },
        issuedAt: Date.parse("2026-08-29T00:00:00.000Z"),
      });

      expect(requests[0]).toMatchObject({
        operation: "pickElement",
        tabId: "tab-remote-viewer",
      });
      // Someone is selecting elements and typing a comment; a browsing-length
      // timeout would abandon them mid-annotation.
      expect(requests[0]?.timeoutMs).toBeGreaterThanOrEqual(120_000);
      expect(annotation).toMatchObject({ id: "annotation-1" });
    }),
  );

  it.effect("reports a closed picker as nothing picked, not a failure", () =>
    Effect.gen(function* () {
      const annotation = yield* requestRemotePreviewPick({
        broker: { invoke: <A = unknown>() => Effect.succeed(null as A) },
        environmentId: EnvironmentId.make("environment-remote-viewer"),
        sessionId: AuthSessionId.make("session-remote-viewer"),
        request: {
          threadId: ThreadId.make("thread-remote-viewer"),
          tabId: PreviewTabId.make("tab-remote-viewer"),
        },
        issuedAt: Date.parse("2026-08-29T00:00:00.000Z"),
      });
      expect(annotation).toBeNull();
    }),
  );
});

describe("captureRemotePreviewSnapshot host compatibility", () => {
  const capture = (
    invoke: (
      request: PreviewAutomationInvokeInput,
    ) => Effect.Effect<unknown, PreviewAutomationError>,
    includeDiagnostics?: boolean,
  ) =>
    captureRemotePreviewSnapshot({
      broker: { invoke: invoke as RemotePreviewInvokeFn },
      environmentId: EnvironmentId.make("environment-mobile-preview"),
      sessionId: AuthSessionId.make("session-mobile-preview"),
      request: {
        threadId: ThreadId.make("thread-mobile-preview"),
        tabId: PreviewTabId.make("tab-mobile-preview"),
        ...(includeDiagnostics === undefined ? {} : { includeDiagnostics }),
      },
      issuedAt: Date.parse("2026-08-26T00:00:00.000Z"),
    });

  it.effect("falls back to a snapshot on a host that has no frame operation", () =>
    Effect.gen(function* () {
      const operations: string[] = [];
      const result = yield* capture((request) => {
        operations.push(request.operation);
        return request.operation === "frame"
          ? Effect.fail(
              // What the broker raises when no connected host advertises the
              // operation — an older desktop, exactly the case being covered.
              new PreviewAutomationNoAvailableHostError({
                operation: "frame",
                environmentId: EnvironmentId.make("environment-mobile-preview"),
                threadId: ThreadId.make("thread-mobile-preview"),
                providerSessionId: "session-mobile-preview",
                providerInstanceId: ProviderInstanceId.make("mobileBrowser"),
              }),
            )
          : Effect.succeed(snapshot);
      });

      expect(operations).toEqual(["frame", "snapshot"]);
      expect(result.screenshot.data).toBe("frame");
    }),
  );

  it.effect("asks for a snapshot when the caller wants diagnostics too", () =>
    Effect.gen(function* () {
      const operations: string[] = [];
      const result = yield* capture((request) => {
        operations.push(request.operation);
        return Effect.succeed({
          ...snapshot,
          consoleEntries: [{ level: "error", text: "boom", timestamp: "2026-08-26T00:00:00.000Z" }],
        });
      }, true);

      // A frame cannot answer for console output, so the cheap path is skipped.
      expect(operations).toEqual(["snapshot"]);
      expect(result.consoleEntries).toHaveLength(1);
    }),
  );
});
