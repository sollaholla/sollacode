import type {
  DesktopPermissionId,
  DesktopPermissionState,
  DesktopPermissionStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Electron from "electron";

export interface MacPermissionRuntime {
  readonly probeFullDiskAccess: Effect.Effect<
    DesktopPermissionStatus,
    never,
    FileSystem.FileSystem | Path.Path
  >;
  readonly getMediaAccessStatus: (mediaType: "microphone" | "screen") => DesktopPermissionStatus;
  readonly askForMicrophoneAccess: () => Promise<boolean>;
  readonly requestScreenRecordingAccess: () => Promise<void>;
  readonly isTrustedAccessibilityClient: (prompt: boolean) => boolean;
  readonly openExternal: (url: string) => Promise<void>;
}

const SYSTEM_SETTINGS_URLS: Readonly<Record<DesktopPermissionId, string>> = {
  "full-disk-access": "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  "screen-recording":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};

const GENERAL_PRIVACY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy";

function isPermissionStatus(value: string): value is DesktopPermissionStatus {
  return (
    value === "granted" ||
    value === "denied" ||
    value === "not-determined" ||
    value === "restricted" ||
    value === "unknown"
  );
}

function normalizeMediaStatus(value: string): DesktopPermissionStatus {
  return isPermissionStatus(value) ? value : "unknown";
}

type OpenReadOnly = (
  path: string,
) => Effect.Effect<unknown, PlatformError.PlatformError, Scope.Scope>;

function isPermissionDenied(cause: PlatformError.PlatformError): boolean {
  return cause.reason._tag === "PermissionDenied";
}

export const probeFullDiskAccess = Effect.fn("desktop.permissions.probeFullDiskAccess")(function* (
  homeDirectory: string,
  openReadOnly?: OpenReadOnly,
): Effect.fn.Return<DesktopPermissionStatus, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tccDatabasePath = path.join(
    homeDirectory,
    "Library",
    "Application Support",
    "com.apple.TCC",
    "TCC.db",
  );
  const open = openReadOnly ?? ((target: string) => fileSystem.open(target, { flag: "r" }));

  // `exists` and `access` can report POSIX readability without exercising
  // macOS TCC. Opening a scoped read-only handle forces the privacy check;
  // the Effect FileSystem closes it as soon as this probe finishes.
  return yield* Effect.scoped(
    open(tccDatabasePath).pipe(
      Effect.as<DesktopPermissionStatus>("granted"),
      Effect.catch((cause) =>
        Effect.succeed<DesktopPermissionStatus>(isPermissionDenied(cause) ? "denied" : "unknown"),
      ),
    ),
  );
});

export function makeLiveMacPermissionRuntime(homeDirectory: string): MacPermissionRuntime {
  return {
    probeFullDiskAccess: probeFullDiskAccess(homeDirectory),
    getMediaAccessStatus: (mediaType) =>
      normalizeMediaStatus(Electron.systemPreferences.getMediaAccessStatus(mediaType)),
    askForMicrophoneAccess: () => Electron.systemPreferences.askForMediaAccess("microphone"),
    requestScreenRecordingAccess: async () => {
      // A tiny, discarded source enumeration is Chromium's native request path.
      // It is only reached after the user clicks Enable.
      await Electron.desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1, height: 1 },
        fetchWindowIcons: false,
      });
    },
    isTrustedAccessibilityClient: (prompt) =>
      Electron.systemPreferences.isTrustedAccessibilityClient(prompt),
    openExternal: (url) => Electron.shell.openExternal(url),
  };
}

function state(id: DesktopPermissionId, status: DesktopPermissionStatus): DesktopPermissionState {
  switch (id) {
    case "full-disk-access":
      return { id, status, canRequest: false, requiresRestart: status !== "granted" };
    case "microphone":
      return {
        id,
        status,
        canRequest: status === "not-determined",
        requiresRestart: status === "denied" || status === "restricted",
      };
    case "screen-recording":
      return {
        id,
        status,
        canRequest: status === "not-determined",
        requiresRestart: status !== "granted",
      };
    case "accessibility":
      return {
        id,
        status,
        canRequest: status !== "granted",
        // macOS may keep the old process's Accessibility trust decision until
        // the application exits, even after the current bundle is re-enabled.
        requiresRestart: status !== "granted",
      };
  }
}

export const readMacPermissionStates = Effect.fn("desktop.permissions.readStates")(function* (
  runtime: MacPermissionRuntime,
): Effect.fn.Return<readonly DesktopPermissionState[], never, FileSystem.FileSystem | Path.Path> {
  const [fullDiskAccess, microphone, screenRecording] = yield* Effect.all([
    runtime.probeFullDiskAccess,
    Effect.sync(() => runtime.getMediaAccessStatus("microphone")),
    Effect.sync(() => runtime.getMediaAccessStatus("screen")),
  ]);
  const accessibility = runtime.isTrustedAccessibilityClient(false) ? "granted" : "denied";
  return [
    state("full-disk-access", fullDiskAccess),
    state("microphone", microphone),
    state("screen-recording", screenRecording),
    state("accessibility", accessibility),
  ];
});

export async function requestMacPermission(
  runtime: MacPermissionRuntime,
  id: DesktopPermissionId,
): Promise<void> {
  switch (id) {
    case "full-disk-access":
      await openMacPermissionSettings(runtime, id);
      return;
    case "microphone":
      await runtime.askForMicrophoneAccess();
      return;
    case "screen-recording":
      await runtime.requestScreenRecordingAccess();
      return;
    case "accessibility":
      runtime.isTrustedAccessibilityClient(true);
      return;
  }
}

export async function openMacPermissionSettings(
  runtime: MacPermissionRuntime,
  id: DesktopPermissionId,
): Promise<void> {
  try {
    await runtime.openExternal(SYSTEM_SETTINGS_URLS[id]);
  } catch {
    await runtime.openExternal(GENERAL_PRIVACY_SETTINGS_URL);
  }
}
