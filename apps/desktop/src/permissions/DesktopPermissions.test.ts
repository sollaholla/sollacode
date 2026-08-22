import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { DesktopPermissionStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import { vi } from "vite-plus/test";

import {
  openMacPermissionSettings,
  probeFullDiskAccess,
  readMacPermissionStates,
  requestMacPermission,
  type MacPermissionRuntime,
} from "./DesktopPermissions.ts";

function runtime(overrides: Partial<MacPermissionRuntime> = {}): MacPermissionRuntime {
  return {
    probeFullDiskAccess: Effect.succeed("denied"),
    getMediaAccessStatus: () => "not-determined",
    askForMicrophoneAccess: async () => true,
    requestScreenRecordingAccess: async () => undefined,
    isTrustedAccessibilityClient: () => false,
    openExternal: async () => undefined,
    ...overrides,
  };
}

function openFailure(tag: PlatformError.SystemErrorTag): PlatformError.PlatformError {
  return new PlatformError.PlatformError(
    new PlatformError.SystemError({
      _tag: tag,
      module: "FileSystem",
      method: "open",
    }),
  );
}

describe("DesktopPermissions", () => {
  it.effect("infers Full Disk Access without reading protected contents", () =>
    Effect.gen(function* () {
      const close = vi.fn<() => void>(() => undefined);
      const openReadOnly = vi.fn<
        (path: string) => Effect.Effect<unknown, PlatformError.PlatformError, Scope.Scope>
      >(() => Effect.acquireRelease(Effect.void, () => Effect.sync(close)));
      assert.equal(yield* probeFullDiskAccess("/Users/test", openReadOnly), "granted");
      assert.equal(
        openReadOnly.mock.calls[0]?.[0],
        "/Users/test/Library/Application Support/com.apple.TCC/TCC.db",
      );
      assert.equal(close.mock.calls.length, 1);

      const denied = vi.fn<
        (path: string) => Effect.Effect<unknown, PlatformError.PlatformError, Scope.Scope>
      >(() => Effect.fail(openFailure("PermissionDenied")));
      assert.equal(yield* probeFullDiskAccess("/Users/test", denied), "denied");

      const missing = vi.fn<
        (path: string) => Effect.Effect<unknown, PlatformError.PlatformError, Scope.Scope>
      >(() => Effect.fail(openFailure("NotFound")));
      assert.equal(yield* probeFullDiskAccess("/Users/test", missing), "unknown");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns the four app-owned permission states without prompting", () =>
    Effect.gen(function* () {
      const accessibility = vi.fn(() => false);
      const states = yield* readMacPermissionStates(
        runtime({
          probeFullDiskAccess: Effect.succeed("granted"),
          getMediaAccessStatus: (mediaType): DesktopPermissionStatus =>
            mediaType === "microphone" ? "granted" : "denied",
          isTrustedAccessibilityClient: accessibility,
        }),
      );

      assert.deepEqual(states, [
        {
          id: "full-disk-access",
          status: "granted",
          canRequest: false,
          requiresRestart: false,
        },
        { id: "microphone", status: "granted", canRequest: false, requiresRestart: false },
        {
          id: "screen-recording",
          status: "denied",
          canRequest: false,
          requiresRestart: true,
        },
        { id: "accessibility", status: "denied", canRequest: true, requiresRestart: true },
      ]);
      assert.deepEqual(accessibility.mock.calls, [[false]]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("requests native consent only for the selected permission", async () => {
    const askForMicrophoneAccess = vi.fn(async () => true);
    const requestScreenRecordingAccess = vi.fn(async () => undefined);
    const isTrustedAccessibilityClient = vi.fn(() => false);
    const openExternal = vi.fn<(url: string) => Promise<void>>(async () => undefined);
    const permissionRuntime = runtime({
      askForMicrophoneAccess,
      requestScreenRecordingAccess,
      isTrustedAccessibilityClient,
      openExternal,
    });

    await requestMacPermission(permissionRuntime, "microphone");
    await requestMacPermission(permissionRuntime, "screen-recording");
    await requestMacPermission(permissionRuntime, "accessibility");
    await requestMacPermission(permissionRuntime, "full-disk-access");

    assert.equal(askForMicrophoneAccess.mock.calls.length, 1);
    assert.equal(requestScreenRecordingAccess.mock.calls.length, 1);
    assert.deepEqual(isTrustedAccessibilityClient.mock.calls, [[true]]);
    assert.match(openExternal.mock.calls[0]?.[0] ?? "", /Privacy_AllFiles/u);
  });

  it("falls back to the general Privacy pane when a targeted link fails", async () => {
    const openExternal = vi
      .fn<(url: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("unsupported link"))
      .mockResolvedValueOnce(undefined);
    await openMacPermissionSettings(runtime({ openExternal }), "microphone");
    assert.equal(openExternal.mock.calls.length, 2);
    assert.match(openExternal.mock.calls[0]?.[0] ?? "", /Privacy_Microphone/u);
    assert.match(openExternal.mock.calls[1]?.[0] ?? "", /\?Privacy$/u);
  });
});
