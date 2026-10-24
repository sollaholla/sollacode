import { app, session, webContents } from "electron";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { storageCleanupEnabled } from "../storage/storageCleanupSettings.ts";
import { availableStorageBytes } from "../storage/availableStorage.ts";
import { sweepBrowserCaches } from "./browserCacheRetention.ts";

/** Explicit cache-only APIs. Account/storage reset APIs must never be used here. */
export async function clearPreviewCaches(profile: string) {
  const browserSession = session.fromPartition(`persist:${profile}`);
  await browserSession.clearCache();
  await browserSession.clearCodeCaches({});
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const sweep = Effect.fn("browserCacheMaintenance.sweep")(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const beforeBytes = yield* Effect.tryPromise(() =>
        availableStorageBytes(app.getPath("userData")),
      );
      const result = yield* Effect.tryPromise(() =>
        sweepBrowserCaches({
          partitionsDir: environment.path.join(app.getPath("userData"), "Partitions"),
          nowMs,
          isEnabled: () => storageCleanupEnabled(environment.serverSettingsPath),
          activeProfiles: () =>
            new Set(
              webContents.getAllWebContents().flatMap((contents) => {
                const path = contents.session.storagePath;
                return path ? [environment.path.basename(path)] : [];
              }),
            ),
          clearCaches: clearPreviewCaches,
        }),
      );
      const afterBytes = yield* Effect.tryPromise(() =>
        availableStorageBytes(app.getPath("userData")),
      );
      yield* Effect.logInfo("browser cache cleanup complete", {
        ...result,
        availableBytesDelta: afterBytes - beforeBytes,
      });
    });
    yield* Effect.sleep(Duration.minutes(1)).pipe(
      Effect.andThen(
        sweep().pipe(
          Effect.catch((error) => Effect.logWarning("browser cache cleanup skipped", { error })),
          Effect.repeat(Schedule.spaced(Duration.hours(24))),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
