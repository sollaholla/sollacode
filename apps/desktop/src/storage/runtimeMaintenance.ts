import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { cleanupCodexRuntimes } from "./runtimeRetention.ts";
import { openStoragePaths } from "./openStoragePaths.ts";
import { availableStorageBytes } from "./availableStorage.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    // lsof supplies the required executable/lock inventory on macOS. Other hosts fail closed.
    if (!environment.isPackaged || environment.platform !== "darwin") return;
    const sweep = Effect.fn("runtimeMaintenance.sweep")(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const beforeBytes = yield* Effect.tryPromise(() =>
        availableStorageBytes(environment.homeDirectory),
      );
      const removed = yield* Effect.tryPromise(() =>
        cleanupCodexRuntimes({
          standaloneDir: environment.path.join(
            environment.homeDirectory,
            ".codex",
            "packages",
            "standalone",
          ),
          settingsPath: environment.serverSettingsPath,
          nowMs,
          openPaths: openStoragePaths,
        }),
      );
      const afterBytes = yield* Effect.tryPromise(() =>
        availableStorageBytes(environment.homeDirectory),
      );
      yield* Effect.logInfo("runtime storage cleanup complete", {
        removed,
        availableBytesDelta: afterBytes - beforeBytes,
      });
    });
    yield* Effect.sleep(Duration.minutes(2)).pipe(
      Effect.andThen(
        sweep().pipe(
          Effect.catch((error) => Effect.logWarning("runtime storage cleanup skipped", { error })),
          Effect.repeat(Schedule.spaced(Duration.hours(24))),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
