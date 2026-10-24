import {
  AuthSessionId,
  EnvironmentId,
  PreviewTabId,
  ThreadId,
  type PreviewAutomationSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { PreviewAutomationInvokeInput } from "../mcp/PreviewAutomationBroker.ts";
import { captureRemotePreviewSnapshot, remoteFrameId } from "./RemotePreviewCapture.ts";

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

      expect(requests[0]).toMatchObject({
        operation: "snapshot",
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
        frameId: remoteFrameId(snapshot.screenshot!.data),
      });
      expect(result).not.toHaveProperty("visibleText");
      expect(result).not.toHaveProperty("consoleEntries");
    }),
  );

  it.effect("asks for the agent's pointer and hands it to the phone", () =>
    Effect.gen(function* () {
      const requests: PreviewAutomationInvokeInput[] = [];
      const agentPointer = { x: 0.25, y: 0.75, phase: "click" as const, sequence: 4 };
      const result = yield* captureRemotePreviewSnapshot({
        broker: {
          invoke: <A = unknown>(request: PreviewAutomationInvokeInput) => {
            requests.push(request);
            return Effect.succeed({ ...snapshot, agentPointer } as A);
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

      // Agents' own snapshots never carry it; only this capture requests it.
      expect(requests[0]?.input).toEqual({ includeAgentPointer: true });
      expect((result as { agentPointer?: unknown }).agentPointer).toEqual(agentPointer);
    }),
  );

  const capture = (
    unchangedSince: string | undefined,
    next: PreviewAutomationSnapshot = snapshot,
  ) =>
    captureRemotePreviewSnapshot({
      broker: {
        invoke: <A = unknown>(_request: PreviewAutomationInvokeInput) => Effect.succeed(next as A),
      },
      environmentId: EnvironmentId.make("environment-mobile-preview"),
      sessionId: AuthSessionId.make("session-mobile-preview"),
      request: {
        threadId: ThreadId.make("thread-mobile-preview"),
        tabId: PreviewTabId.make("tab-mobile-preview"),
        ...(unchangedSince === undefined ? {} : { unchangedSince }),
      },
      issuedAt: Date.parse("2026-08-26T00:00:00.000Z"),
    });

  it.effect("answers a picture the viewer already holds with the frame minus the picture", () =>
    Effect.gen(function* () {
      const held = remoteFrameId(snapshot.screenshot!.data);
      const agentPointer = { x: 0.5, y: 0.5, phase: "move" as const, sequence: 9 };
      const result = yield* capture(held, { ...snapshot, agentPointer });
      expect(result).toEqual({
        unchanged: true,
        frameId: held,
        tabId: "tab-mobile-preview",
        url: "https://example.com/",
        title: "Example",
        loading: false,
        capturedAt: "2026-08-26T00:00:00.000Z",
        agentPointer,
      });
      expect(result).not.toHaveProperty("screenshot");
    }),
  );

  it.effect("sends the picture when it changed, or when the viewer holds nothing", () =>
    Effect.gen(function* () {
      const held = remoteFrameId(snapshot.screenshot!.data);
      const moved = {
        ...snapshot,
        screenshot: { ...snapshot.screenshot!, data: "a different frame" },
      };
      const changed = yield* capture(held, moved);
      expect(changed).toHaveProperty("screenshot");
      expect(changed).not.toHaveProperty("unchanged");
      expect((changed as { frameId?: string }).frameId).toBe(remoteFrameId("a different frame"));

      const fresh = yield* capture(undefined);
      expect(fresh).toHaveProperty("screenshot");
    }),
  );

  it("gives different pictures different ids and the same picture the same id", () => {
    expect(remoteFrameId("frame")).toBe(remoteFrameId("frame"));
    expect(remoteFrameId("frame")).not.toBe(remoteFrameId("framf"));
    expect(remoteFrameId("frame")).not.toBe(remoteFrameId("frame "));
  });
});
