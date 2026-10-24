/**
 * Names and estimates shared by the server, which compacts `state.sqlite` when
 * it starts, and the desktop, which defers that work on update launches and
 * labels its splash while it runs. See docs/user/storage.md.
 */

/**
 * Set on a backend's environment when this start must leave a scheduled
 * compaction for a later one. The desktop sets it for launches made by the app
 * updater, whose health check would roll back an update that spent minutes
 * compacting before it answered.
 */
export const DEFER_DATABASE_COMPACTION_ENV = "T3CODE_DEFER_DATABASE_COMPACTION";

/** Added by the macOS and Windows updaters to the launch they health-check. */
export const UPDATE_LAUNCH_ARGUMENT_PREFIX = "--solla-update-launch=";

export function isUpdateLaunch(argv: ReadonlyArray<string>): boolean {
  return argv.some((argument) => argument.startsWith(UPDATE_LAUNCH_ARGUMENT_PREFIX));
}

export function withoutUpdateLaunchArgument(argv: ReadonlyArray<string>): ReadonlyArray<string> {
  return argv.filter((argument) => !argument.startsWith(UPDATE_LAUNCH_ARGUMENT_PREFIX));
}

/** Present while a compaction is scheduled for the next start. */
export function databaseCompactionRequestPath(dbPath: string): string {
  return `${dbPath}.compact-request.json`;
}

/** The last compaction's outcome, or the run in progress when the server stopped. */
export function databaseCompactionResultPath(dbPath: string): string {
  return `${dbPath}.compact-result.json`;
}

/** Copies being written start with this name; any found at startup are from an interrupted run. */
export function databaseCompactionTempPrefix(dbFileName: string): string {
  return `${dbFileName}.compacting-`;
}

/** Room left for the rest of the machine while the copy is written. */
export const COMPACTION_FREE_SPACE_MARGIN_BYTES = 512 * 1024 * 1024;

/**
 * Free space a compaction needs on the database's volume. `VACUUM INTO` writes
 * a copy about the size of the live pages (measured at 0.88x); the original
 * stays until the copy is checked.
 */
export function compactionRequiredFreeBytes(liveBytes: number): number {
  return Math.ceil(Math.max(0, liveBytes) * 1.1) + COMPACTION_FREE_SPACE_MARGIN_BYTES;
}

/**
 * Seconds per GiB of live content for the copy, the integrity check, and the
 * row comparison together. Measured end to end on a 0.9 GB scratch database:
 * 2.5–5 s/GiB with the file cached on an idle machine, 25–60 s/GiB on a busy
 * one; the copy alone measured 9–14 s/GiB against a large uncached database.
 * The estimate takes the busy end so a start that runs long is not a surprise.
 */
const COMPACTION_SECONDS_PER_GIB = 30;
const GIB = 1024 * 1024 * 1024;

export function compactionEstimatedSeconds(liveBytes: number): number {
  return Math.max(5, Math.ceil((Math.max(0, liveBytes) / GIB) * COMPACTION_SECONDS_PER_GIB));
}
