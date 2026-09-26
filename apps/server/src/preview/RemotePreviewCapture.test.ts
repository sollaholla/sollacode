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
import { captureRemotePreviewSnapshot } from "./RemotePreviewCapture.ts";

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
      expect(result.agentPointer).toEqual(agentPointer);
    }),
  );
});
