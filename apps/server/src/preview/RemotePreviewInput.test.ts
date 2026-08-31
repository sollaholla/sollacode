import {
  AuthSessionId,
  EnvironmentId,
  PreviewTabId,
  ThreadId,
  type PreviewAutomationStatus,
  type PreviewRemoteInputInput,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { PreviewAutomationInvokeInput } from "../mcp/PreviewAutomationBroker.ts";
import { dispatchRemotePreviewInput } from "./RemotePreviewInput.ts";

const environmentId = EnvironmentId.make("environment-mobile-input");
const sessionId = AuthSessionId.make("session-mobile-input");
const threadId = ThreadId.make("thread-mobile-input");
const tabId = PreviewTabId.make("tab-mobile-input");

const status: PreviewAutomationStatus = {
  available: true,
  visible: true,
  tabId,
  url: "https://example.com/",
  title: "Example",
  loading: false,
  viewport: { width: 1280, height: 800 },
};

function run(
  action: PreviewRemoteInputInput["action"],
  options?: { readonly status?: PreviewAutomationStatus },
) {
  const requests: PreviewAutomationInvokeInput[] = [];
  const effect = dispatchRemotePreviewInput({
    broker: {
      invoke: <A = unknown>(request: PreviewAutomationInvokeInput) => {
        requests.push(request);
        return Effect.succeed(
          (request.operation === "status" ? (options?.status ?? status) : {}) as A,
        );
      },
    },
    environmentId,
    sessionId,
    request: { threadId, tabId, action },
    issuedAt: Date.parse("2026-08-31T00:00:00.000Z"),
  });
  return { effect, requests };
}

describe("dispatchRemotePreviewInput", () => {
  it.effect("converts click fractions to CSS pixels against the measured viewport", () =>
    Effect.gen(function* () {
      const { effect, requests } = run({ kind: "click", position: { x: 0.25, y: 0.5 } });
      const result = yield* effect;

      expect(requests.map((request) => request.operation)).toEqual(["status", "click"]);
      expect(requests[0]).toMatchObject({
        operation: "status",
        tabId,
        timeoutMs: 10_000,
        scope: {
          environmentId,
          threadId,
          providerInstanceId: "mobileBrowser",
        },
      });
      expect(requests[1]).toMatchObject({
        operation: "click",
        tabId,
        timeoutMs: 15_000,
        input: { x: 320, y: 400 },
      });
      expect(result).toEqual({ deliveredAt: "2026-08-31T00:00:00.000Z" });
    }),
  );

  it.effect("converts drag endpoints with the same mapping", () =>
    Effect.gen(function* () {
      const { effect, requests } = run({
        kind: "drag",
        from: { x: 0, y: 0.25 },
        to: { x: 1, y: 0.75 },
      });
      yield* effect;

      expect(requests[1]).toMatchObject({
        operation: "drag",
        input: { from: { x: 0, y: 200 }, to: { x: 1280, y: 600 } },
      });
    }),
  );

  it.effect("scales scroll deltas by the viewport, keeping their sign", () =>
    Effect.gen(function* () {
      const { effect, requests } = run({ kind: "scroll", deltaX: 0.5, deltaY: -0.25 });
      yield* effect;

      expect(requests[1]).toMatchObject({
        operation: "scroll",
        input: { deltaX: 640, deltaY: -200 },
      });
    }),
  );

  it.effect("forwards typing to the focused element without a status round-trip", () =>
    Effect.gen(function* () {
      const { effect, requests } = run({ kind: "type", text: "hello from the phone" });
      yield* effect;

      expect(requests.map((request) => request.operation)).toEqual(["type"]);
      expect(requests[0]).toMatchObject({ input: { text: "hello from the phone" } });
    }),
  );

  it.effect("forwards key presses without a status round-trip", () =>
    Effect.gen(function* () {
      const { effect, requests } = run({ kind: "press", key: "Enter" });
      yield* effect;

      expect(requests.map((request) => request.operation)).toEqual(["press"]);
      expect(requests[0]).toMatchObject({ input: { key: "Enter" } });
    }),
  );

  it.effect("refuses coordinate input when the host has no measured viewport", () =>
    Effect.gen(function* () {
      const { effect, requests } = run(
        { kind: "click", position: { x: 0.5, y: 0.5 } },
        { status: { ...status, viewport: undefined } },
      );
      const error = yield* Effect.flip(effect);

      expect(error._tag).toBe("PreviewAutomationViewportUnavailableError");
      expect(requests.map((request) => request.operation)).toEqual(["status"]);
    }),
  );
});
