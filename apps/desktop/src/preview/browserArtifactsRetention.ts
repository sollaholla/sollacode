// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const MILLIS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * What the browser artifacts folder keeps: recordings, screenshots and the
 * downloads an agent pulled through the preview browser. Nothing else ever
 * removed them, so agents fetching texture packs and installers grew the
 * folder without bound (2.4 GB of downloads and 193 recordings in a month).
 */
export const BROWSER_ARTIFACT_RETENTION = {
  /** Older than this is gone, however little space is used. */
  maxAgeMs: 7 * MILLIS_PER_DAY,
  /** Over this, the oldest go first until the folder fits. */
  maxTotalBytes: 2 * 1024 ** 3,
  /**
   * Never touch anything newer: a download or recording still being written
   * has a fresh mtime, and an agent may be about to hand the path to a person.
   */
  minAgeMs: MILLIS_PER_DAY,
} as const;

export interface BrowserArtifactEntry {
  readonly path: string;
  readonly sizeBytes: number;
  readonly modifiedAtMs: number;
}

/** Which entries to delete: everything expired, then the oldest until under the cap. */
export function planBrowserArtifactSweep(
  entries: ReadonlyArray<BrowserArtifactEntry>,
  input: {
    readonly nowMs: number;
    readonly maxAgeMs: number;
    readonly maxTotalBytes: number;
    readonly minAgeMs: number;
  },
): ReadonlyArray<BrowserArtifactEntry> {
  const removable = entries.filter((entry) => entry.modifiedAtMs <= input.nowMs - input.minAgeMs);
  const doomed = new Set(
    removable.filter((entry) => entry.modifiedAtMs <= input.nowMs - input.maxAgeMs),
  );
  let total = entries.reduce((sum, entry) => (doomed.has(entry) ? sum : sum + entry.sizeBytes), 0);
  for (const entry of removable.toSorted((left, right) => left.modifiedAtMs - right.modifiedAtMs)) {
    if (total <= input.maxTotalBytes) break;
    if (doomed.has(entry)) continue;
    doomed.add(entry);
    total -= entry.sizeBytes;
  }
  return entries.filter((entry) => doomed.has(entry));
}

async function listFiles(directory: string): Promise<ReadonlyArray<BrowserArtifactEntry>> {
  let names: ReadonlyArray<string>;
  try {
    names = await NodeFSP.readdir(directory);
  } catch {
    return [];
  }
  const entries: Array<BrowserArtifactEntry> = [];
  for (const name of names) {
    const entryPath = NodePath.join(directory, name);
    try {
      const info = await NodeFSP.lstat(entryPath);
      if (info.isFile()) {
        entries.push({ path: entryPath, sizeBytes: info.size, modifiedAtMs: info.mtimeMs });
      }
    } catch {
      // Vanished between readdir and stat.
    }
  }
  return entries;
}

export const sweepBrowserArtifacts = Effect.fn("sweepBrowserArtifacts")(function* (input: {
  readonly artifactsDir: string;
}) {
  const nowMs = yield* Clock.currentTimeMillis;
  return yield* Effect.promise(async () => {
    const entries = [
      ...(await listFiles(input.artifactsDir)),
      ...(await listFiles(NodePath.join(input.artifactsDir, "downloads"))),
    ];
    const doomed = planBrowserArtifactSweep(entries, { nowMs, ...BROWSER_ARTIFACT_RETENTION });
    let removedFiles = 0;
    let removedBytes = 0;
    for (const entry of doomed) {
      try {
        await NodeFSP.unlink(entry.path);
        removedFiles += 1;
        removedBytes += entry.sizeBytes;
      } catch {
        // Already gone, or held open on Windows; the next sweep retries.
      }
    }
    return { scannedFiles: entries.length, removedFiles, removedBytes };
  });
});

/** Sweeps a minute after launch (not during startup), then hourly. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const sweep = sweepBrowserArtifacts({ artifactsDir: environment.browserArtifactsDir }).pipe(
      Effect.flatMap((result) =>
        result.removedFiles > 0
          ? Effect.logInfo("browser artifact retention sweep complete", result)
          : Effect.void,
      ),
    );
    yield* Effect.sleep(Duration.minutes(1)).pipe(
      Effect.andThen(sweep.pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))))),
      Effect.forkScoped,
    );
  }),
);
