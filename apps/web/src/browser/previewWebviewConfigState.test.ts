import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  loadPreviewWebviewConfig,
  PreviewWebviewBridgeUnavailableError,
  PreviewWebviewConfigLoadError,
} from "./previewWebviewConfigState";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");

describe("loadPreviewWebviewConfig", () => {
  it.effect("reports a structurally distinct missing-bridge failure", () =>
    Effect.gen(function* () {
      const error = yield* loadPreviewWebviewConfig(environmentId, threadId, null).pipe(
        Effect.flip,
      );

      expect(error).toBeInstanceOf(PreviewWebviewBridgeUnavailableError);
      expect(error.environmentId).toBe(environmentId);
      expect(error.message).toContain(environmentId);
      expect("cause" in error).toBe(false);
    }),
  );

  it.effect("preserves the bridge rejection as the load failure cause", () =>
    Effect.gen(function* () {
      const cause = new Error("ipc unavailable");
      const error = yield* loadPreviewWebviewConfig(environmentId, threadId, {
        getPreviewConfig: () => Promise.reject(cause),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(PreviewWebviewConfigLoadError);
      expect(error.environmentId).toBe(environmentId);
      expect(error.cause).toBe(cause);
      expect(error.message).not.toContain(cause.message);
    }),
  );

  it.effect("forwards the environment and thread ids to the bridge", () =>
    Effect.gen(function* () {
      let requestedEnvironmentId: EnvironmentId | null = null;
      let requestedThreadId: ThreadId | null | undefined = null;
      const config = {
        partition: "persist:test-preview",
        webPreferences: "sandbox=yes",
        preloadUrl: null,
      };
      const result = yield* loadPreviewWebviewConfig(environmentId, threadId, {
        getPreviewConfig: (input, thread) => {
          requestedEnvironmentId = input;
          requestedThreadId = thread;
          return Promise.resolve(config);
        },
      });

      expect(requestedEnvironmentId).toBe(environmentId);
      expect(requestedThreadId).toBe(threadId);
      expect(result).toEqual(config);
    }),
  );

  it.effect("forwards an inherited browser-profile owner separately from the host thread", () =>
    Effect.gen(function* () {
      const profileThreadId = ThreadId.make("agent-thread");
      let requestedProfileThreadId: ThreadId | undefined;
      const config = {
        partition: "persist:test-preview",
        webPreferences: "sandbox=yes",
        preloadUrl: null,
      };
      const result = yield* loadPreviewWebviewConfig(
        environmentId,
        threadId,
        {
          getPreviewConfig: (_environment, _thread, profileThread) => {
            requestedProfileThreadId = profileThread;
            return Promise.resolve(config);
          },
        },
        profileThreadId,
      );

      expect(requestedProfileThreadId).toBe(profileThreadId);
      expect(result).toEqual(config);
    }),
  );

  it.effect("omits the thread id for threadless callers", () =>
    Effect.gen(function* () {
      let requestedThreadId: ThreadId | null | undefined = null;
      const config = {
        partition: "persist:test-preview",
        webPreferences: "sandbox=yes",
        preloadUrl: null,
      };
      const result = yield* loadPreviewWebviewConfig(environmentId, undefined, {
        getPreviewConfig: (_input, thread) => {
          requestedThreadId = thread;
          return Promise.resolve(config);
        },
      });

      expect(requestedThreadId).toBeUndefined();
      expect(result).toEqual(config);
    }),
  );
});
