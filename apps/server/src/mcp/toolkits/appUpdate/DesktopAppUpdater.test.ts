import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../../config.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import {
  buildDesktopAppUpdaterInvocation,
  make,
  parseDesktopAppUpdatePreflight,
} from "./DesktopAppUpdater.ts";

it("builds argument-safe macOS and Windows updater invocations", () => {
  expect(
    buildDesktopAppUpdaterInvocation({
      platform: "darwin",
      mode: "install",
      updaterScriptPath: "/Applications/Solla Code.app/update.sh",
      artifactPath: "/tmp/Solla Code 0.1.96.dmg",
      targetPath: "/Applications/Solla Code.app",
      desktopPid: 101,
      backendPid: 202,
      healthUrl: "http://127.0.0.1:3773/",
      logPath: "/tmp/update log.txt",
    }),
  ).toEqual({
    command: "/bin/zsh",
    args: [
      "/Applications/Solla Code.app/update.sh",
      "--mode",
      "install",
      "--artifact",
      "/tmp/Solla Code 0.1.96.dmg",
      "--target",
      "/Applications/Solla Code.app",
      "--wait-pid",
      "101",
      "--wait-backend-pid",
      "202",
      "--health-url",
      "http://127.0.0.1:3773/",
      "--log-path",
      "/tmp/update log.txt",
    ],
  });

  expect(
    buildDesktopAppUpdaterInvocation({
      platform: "win32",
      mode: "preflight",
      updaterScriptPath: "C:\\Program Files\\Solla Code\\resources\\update.ps1",
      artifactPath: "C:\\Updates\\Solla Code Setup.exe",
      targetPath: "C:\\Program Files\\Solla Code\\Solla Code.exe",
    }),
  ).toEqual({
    command: "powershell.exe",
    args: [
      "-WindowStyle",
      "Hidden",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\Program Files\\Solla Code\\resources\\update.ps1",
      "-Mode",
      "Preflight",
      "-Artifact",
      "C:\\Updates\\Solla Code Setup.exe",
      "-Target",
      "C:\\Program Files\\Solla Code\\Solla Code.exe",
    ],
  });
});

it.effect("parses only the final bounded verifier metadata line", () =>
  Effect.gen(function* () {
    expect(
      yield* parseDesktopAppUpdatePreflight(
        "/tmp/update.dmg",
        'diagnostic\n{"platform":"darwin","artifactKind":"dmg","version":"0.1.96","productName":"Solla Code"}\n',
      ),
    ).toEqual({
      platform: "darwin",
      artifactKind: "dmg",
      version: "0.1.96",
      productName: "Solla Code",
    });
  }),
);

it.effect("inspects before scheduling and blocks a concurrent installer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "solla-app-update-test-",
      });
      const updaterDir = `${baseDir}/updater`;
      const updaterScriptPath = `${updaterDir}/install-solla-code-update.sh`;
      const artifactPath = `${baseDir}/Solla Code.dmg`;
      const targetPath = `${baseDir}/Solla Code.app`;
      yield* fileSystem.makeDirectory(updaterDir, { recursive: true });
      yield* fileSystem.makeDirectory(targetPath, { recursive: true });
      yield* fileSystem.writeFileString(updaterScriptPath, "#!/bin/zsh\n");
      yield* fileSystem.writeFileString(artifactPath, "artifact");

      const invocations: ProcessRunner.ProcessRunInput[] = [];
      const detached: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      const testRunner = ProcessRunner.ProcessRunner.of({
        run: (input) => {
          invocations.push(input);
          return Effect.succeed({
            stdout:
              '{"platform":"darwin","artifactKind":"dmg","version":"0.1.96","productName":"Solla Code"}\n',
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        },
      });
      const updater = yield* make({
        host: {
          platform: "darwin",
          backendPid: 202,
          environment: {
            T3CODE_DESKTOP_UPDATER_DIR: updaterDir,
            T3CODE_DESKTOP_APP_PATH: targetPath,
            T3CODE_DESKTOP_ROOT_PID: "101",
            T3CODE_DESKTOP_UPDATE_HEALTH_URL: "http://127.0.0.1:3773/",
          },
          spawnDetached: (command, args) => {
            detached.push({ command, args });
            return Effect.void;
          },
        },
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, testRunner));

      const inspection = yield* updater.inspect(artifactPath);
      expect(inspection).toMatchObject({
        platform: "darwin",
        artifactKind: "dmg",
        version: "0.1.96",
        targetPath,
        desktopPid: 101,
        backendPid: 202,
      });
      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toMatchObject({
        command: "/bin/zsh",
        args: [
          updaterScriptPath,
          "--mode",
          "preflight",
          "--artifact",
          yield* fileSystem.realPath(artifactPath),
          "--target",
          targetPath,
        ],
      });

      yield* updater.schedule(inspection);
      expect(detached).toHaveLength(1);
      expect(detached[0]?.args).toContain("--wait-backend-pid");
      const duplicate = yield* Effect.flip(updater.schedule(inspection));
      expect(duplicate._tag).toBe("AppUpdateAlreadyInProgressError");
    }),
  ).pipe(
    Effect.provide(
      Layer.merge(
        Layer.effect(
          ServerConfig.ServerConfig,
          Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            return ServerConfig.ServerConfig.of({ ...config, mode: "desktop" });
          }),
        ).pipe(
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "solla-app-update-config-" }),
          ),
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
      ),
    ),
  ),
);
