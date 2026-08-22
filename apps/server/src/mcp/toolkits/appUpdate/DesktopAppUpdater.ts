// @effect-diagnostics nodeBuiltinImport:off
// node:child_process is intentional: the installer must be detached so it can
// outlive the desktop backend that it closes and replaces.
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../../config.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import {
  AppUpdateAlreadyInProgressError,
  AppUpdateCapabilityUnavailableError,
  AppUpdateInvalidArtifactError,
  AppUpdatePreflightError,
  AppUpdateScheduleError,
  DesktopAppUpdatePreflight,
  type DesktopAppUpdatePlatform,
} from "./types.ts";

const PREFLIGHT_TIMEOUT = Duration.seconds(90);
const MAX_DIAGNOSTIC_CHARS = 4_096;

export interface DesktopAppUpdateInspection extends DesktopAppUpdatePreflight {
  readonly artifactPath: string;
  readonly targetPath: string;
  readonly updaterScriptPath: string;
  readonly desktopPid: number;
  readonly backendPid: number;
  readonly healthUrl: string;
  readonly logPath: string;
}

export interface DesktopAppUpdaterHost {
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly backendPid: number;
  readonly spawnDetached: (
    command: string,
    args: ReadonlyArray<string>,
    onExit: () => void,
  ) => Effect.Effect<void, ProcessRunner.ProcessSpawnError>;
}

export interface DesktopAppUpdaterInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export class DesktopAppUpdater extends Context.Service<
  DesktopAppUpdater,
  {
    readonly inspect: (
      artifactPath: string,
    ) => Effect.Effect<
      DesktopAppUpdateInspection,
      AppUpdateCapabilityUnavailableError | AppUpdateInvalidArtifactError | AppUpdatePreflightError
    >;
    readonly schedule: (
      inspection: DesktopAppUpdateInspection,
    ) => Effect.Effect<void, AppUpdateAlreadyInProgressError | AppUpdateScheduleError>;
  }
>()("t3/mcp/toolkits/appUpdate/DesktopAppUpdater") {}

function platformPath(platform: DesktopAppUpdatePlatform): typeof NodePath.posix {
  return platform === "win32" ? NodePath.win32 : NodePath.posix;
}

function updaterScriptName(platform: DesktopAppUpdatePlatform): string {
  return platform === "win32" ? "install-solla-code-update.ps1" : "install-solla-code-update.sh";
}

export function buildDesktopAppUpdaterInvocation(input: {
  readonly platform: DesktopAppUpdatePlatform;
  readonly mode: "preflight" | "install";
  readonly updaterScriptPath: string;
  readonly artifactPath: string;
  readonly targetPath: string;
  readonly desktopPid?: number;
  readonly backendPid?: number;
  readonly healthUrl?: string;
  readonly logPath?: string;
}): DesktopAppUpdaterInvocation {
  if (input.platform === "darwin") {
    return {
      command: "/bin/zsh",
      args: [
        input.updaterScriptPath,
        "--mode",
        input.mode,
        "--artifact",
        input.artifactPath,
        "--target",
        input.targetPath,
        ...(input.mode === "install"
          ? [
              "--wait-pid",
              String(input.desktopPid),
              "--wait-backend-pid",
              String(input.backendPid),
              "--health-url",
              input.healthUrl ?? "",
              "--log-path",
              input.logPath ?? "",
            ]
          : []),
      ],
    };
  }

  return {
    command: "powershell.exe",
    args: [
      "-WindowStyle",
      "Hidden",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      input.updaterScriptPath,
      "-Mode",
      input.mode === "install" ? "Install" : "Preflight",
      "-Artifact",
      input.artifactPath,
      "-Target",
      input.targetPath,
      ...(input.mode === "install"
        ? [
            "-WaitPid",
            String(input.desktopPid),
            "-WaitBackendPid",
            String(input.backendPid),
            "-HealthUrl",
            input.healthUrl ?? "",
            "-LogPath",
            input.logPath ?? "",
          ]
        : []),
    ],
  };
}

function boundedDiagnostic(value: string, fallback: string): string {
  const normalized = value.trim().replaceAll(/\s+/g, " ");
  return (normalized.length > 0 ? normalized : fallback).slice(0, MAX_DIAGNOSTIC_CHARS);
}

const decodePreflight = Schema.decodeUnknownEffect(DesktopAppUpdatePreflight);
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

export const parseDesktopAppUpdatePreflight = Effect.fn("DesktopAppUpdater.parsePreflight")(
  function* (artifactPath: string, stdout: string) {
    const line = stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .at(-1);
    if (!line) {
      return yield* new AppUpdatePreflightError({
        path: artifactPath,
        reason: "the verifier returned no metadata",
      });
    }

    const parsed = yield* decodeUnknownJson(line).pipe(
      Effect.mapError(
        () =>
          new AppUpdatePreflightError({
            path: artifactPath,
            reason: "the verifier returned malformed metadata",
          }),
      ),
    );
    return yield* decodePreflight(parsed).pipe(
      Effect.mapError(
        () =>
          new AppUpdatePreflightError({
            path: artifactPath,
            reason: "the verifier returned incompatible metadata",
          }),
      ),
    );
  },
);

export const make = Effect.fn("DesktopAppUpdater.make")(function* (options?: {
  readonly host?: Partial<DesktopAppUpdaterHost>;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  const hostPlatform = yield* HostProcessPlatform;
  const hostEnvironment = yield* HostProcessEnvironment;
  const inFlight = yield* Ref.make(false);
  const runtimeContext = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(runtimeContext);

  const host: DesktopAppUpdaterHost = {
    platform: options?.host?.platform ?? hostPlatform,
    environment: options?.host?.environment ?? hostEnvironment,
    backendPid: options?.host?.backendPid ?? process.pid,
    spawnDetached:
      options?.host?.spawnDetached ??
      ((command, args, onExit) =>
        Effect.callback<void, ProcessRunner.ProcessSpawnError>((resume) => {
          const spawnError = (cause: unknown) =>
            new ProcessRunner.ProcessSpawnError({
              command,
              argumentCount: args.length,
              cause,
            });
          let child: NodeChildProcess.ChildProcess;
          try {
            child = NodeChildProcess.spawn(command, [...args], {
              detached: true,
              stdio: "ignore",
              windowsHide: host.platform === "win32",
            });
          } catch (cause) {
            resume(Effect.fail(spawnError(cause)));
            return;
          }

          const onSpawnError = (cause: Error) => resume(Effect.fail(spawnError(cause)));
          child.once("error", onSpawnError);
          child.once("spawn", () => {
            child.removeListener("error", onSpawnError);
            child.on("error", () => undefined);
            child.once("close", onExit);
            child.unref();
            resume(Effect.void);
          });
        })),
  };

  const inspect: DesktopAppUpdater["Service"]["inspect"] = Effect.fn("DesktopAppUpdater.inspect")(
    function* (requestedArtifactPath) {
      if (config.mode !== "desktop") {
        return yield* new AppUpdateCapabilityUnavailableError({ reason: "not_desktop" });
      }
      if (host.platform !== "darwin" && host.platform !== "win32") {
        return yield* new AppUpdateCapabilityUnavailableError({
          reason: "unsupported_platform",
        });
      }
      const platform = host.platform;
      const paths = platformPath(platform);
      if (!paths.isAbsolute(requestedArtifactPath)) {
        return yield* new AppUpdateInvalidArtifactError({
          path: requestedArtifactPath,
          reason: "the path must be absolute",
        });
      }

      const updaterDir = host.environment.T3CODE_DESKTOP_UPDATER_DIR ?? "";
      const targetPath = host.environment.T3CODE_DESKTOP_APP_PATH ?? "";
      const desktopPid = Number(host.environment.T3CODE_DESKTOP_ROOT_PID ?? "");
      const healthUrl = host.environment.T3CODE_DESKTOP_UPDATE_HEALTH_URL ?? "";
      if (
        !paths.isAbsolute(updaterDir) ||
        !paths.isAbsolute(targetPath) ||
        !Number.isSafeInteger(desktopPid) ||
        desktopPid <= 1 ||
        !Number.isSafeInteger(host.backendPid) ||
        host.backendPid <= 1 ||
        !URL.canParse(healthUrl)
      ) {
        return yield* new AppUpdateCapabilityUnavailableError({
          reason: "missing_desktop_configuration",
        });
      }

      const updaterScriptPath = paths.join(updaterDir, updaterScriptName(platform));
      const requiredPathsExist = yield* Effect.all(
        [fileSystem.exists(updaterScriptPath), fileSystem.exists(targetPath)],
        { concurrency: "unbounded" },
      ).pipe(Effect.orElseSucceed(() => [false, false] as const));
      if (!requiredPathsExist[0] || !requiredPathsExist[1]) {
        return yield* new AppUpdateCapabilityUnavailableError({
          reason: "missing_desktop_configuration",
        });
      }

      const artifactPath = yield* fileSystem.realPath(requestedArtifactPath).pipe(
        Effect.mapError(
          () =>
            new AppUpdateInvalidArtifactError({
              path: requestedArtifactPath,
              reason: "the path does not exist or cannot be read",
            }),
        ),
      );
      const invocation = buildDesktopAppUpdaterInvocation({
        platform,
        mode: "preflight",
        updaterScriptPath,
        artifactPath,
        targetPath,
      });
      const result = yield* runner
        .run({
          ...invocation,
          timeout: PREFLIGHT_TIMEOUT,
          maxOutputBytes: 64 * 1024,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new AppUpdatePreflightError({
                path: artifactPath,
                reason: boundedDiagnostic(cause.message, "the verifier could not be started"),
              }),
          ),
        );
      if (result.code !== 0) {
        return yield* new AppUpdatePreflightError({
          path: artifactPath,
          reason: boundedDiagnostic(
            result.stderr || result.stdout,
            `the verifier exited with code ${String(result.code)}`,
          ),
        });
      }
      const preflight = yield* parseDesktopAppUpdatePreflight(artifactPath, result.stdout);
      if (preflight.platform !== platform) {
        return yield* new AppUpdatePreflightError({
          path: artifactPath,
          reason: `the artifact targets ${preflight.platform}, not ${platform}`,
        });
      }

      return {
        ...preflight,
        artifactPath,
        targetPath,
        updaterScriptPath,
        desktopPid,
        backendPid: host.backendPid,
        healthUrl,
        logPath: paths.join(config.logsDir, "desktop-app-update.log"),
      };
    },
  );

  const schedule: DesktopAppUpdater["Service"]["schedule"] = Effect.fn(
    "DesktopAppUpdater.schedule",
  )(function* (inspection) {
    const alreadyRunning = yield* Ref.getAndSet(inFlight, true);
    if (alreadyRunning) {
      return yield* new AppUpdateAlreadyInProgressError({});
    }

    const invocation = buildDesktopAppUpdaterInvocation({
      platform: inspection.platform,
      mode: "install",
      updaterScriptPath: inspection.updaterScriptPath,
      artifactPath: inspection.artifactPath,
      targetPath: inspection.targetPath,
      desktopPid: inspection.desktopPid,
      backendPid: inspection.backendPid,
      healthUrl: inspection.healthUrl,
      logPath: inspection.logPath,
    });
    const resetInFlight = () => {
      runFork(Ref.set(inFlight, false));
    };
    yield* host.spawnDetached(invocation.command, invocation.args, resetInFlight).pipe(
      Effect.mapError(
        (cause) =>
          new AppUpdateScheduleError({
            reason: boundedDiagnostic(cause.message, "the installer process could not be started"),
          }),
      ),
      Effect.onError(() => Ref.set(inFlight, false)),
    );
  });

  return DesktopAppUpdater.of({ inspect, schedule });
});

export const layer = Layer.effect(DesktopAppUpdater, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
