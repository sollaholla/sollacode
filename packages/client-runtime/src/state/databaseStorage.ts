import type { DatabaseCompactionResult, DatabaseStorageStatus } from "@t3tools/contracts";

/**
 * Wording for Settings → Storage's database row, shared by web and mobile so
 * both say the same thing about one environment's `state.sqlite`.
 */

const UNITS = ["KB", "MB", "GB", "TB"] as const;

export function formatStorageBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  let value = bytes;
  let unit: (typeof UNITS)[number] = "KB";
  for (const next of UNITS) {
    value /= 1024;
    unit = next;
    if (value < 1024) break;
  }
  return `${value.toFixed(value < 100 ? 1 : 0)} ${unit}`;
}

/** "about 4 minutes", rounded up; a start that takes long should not surprise. */
export function formatCompactionEstimate(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "about a minute" : `about ${minutes} minutes`;
}

function formatRunLength(durationMs: number | null): string | null {
  if (durationMs === null) return null;
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${Math.max(1, seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

export interface DatabaseCompactionResultView {
  readonly tone: "success" | "warning" | "error";
  readonly title: string;
  /** Empty when the title says everything. */
  readonly detail: string;
  readonly finishedAt: string;
}

export function describeCompactionResult(
  result: DatabaseCompactionResult,
): DatabaseCompactionResultView {
  const length = formatRunLength(result.durationMs);
  switch (result.outcome) {
    case "compacted":
      return {
        tone: "success",
        title: `Compacted ${formatStorageBytes(result.beforeBytes)} to ${formatStorageBytes(
          result.afterBytes ?? result.beforeBytes,
        )}${length === null ? "" : ` in ${length}`}`,
        detail: result.reason ?? "",
        finishedAt: result.finishedAt,
      };
    case "skipped":
      return {
        tone: "warning",
        title: "Compaction was skipped",
        detail: result.reason ?? "",
        finishedAt: result.finishedAt,
      };
    case "interrupted":
      return {
        tone: "warning",
        title: "Compaction was interrupted",
        detail: result.reason ?? "The original database was kept.",
        finishedAt: result.finishedAt,
      };
    case "failed":
      return {
        tone: "error",
        title: "Compaction failed; the original database was kept",
        detail: result.reason ?? "",
        finishedAt: result.finishedAt,
      };
  }
}

export interface DatabaseStorageView {
  /** "20.2 GB on disk · 11.4 GB (56%) is free space" */
  readonly summary: string;
  /** Whether compacting would return anything to the disk. */
  readonly reclaimable: boolean;
  /** Time and disk the next start will need, and whether the disk has it now. */
  readonly requirement: string;
  /** Set when the disk is too full right now; the start would skip compaction. */
  readonly diskWarning: string | null;
  /** Set while a compaction waits for the next start. */
  readonly scheduledNote: string | null;
  readonly lastResult: DatabaseCompactionResultView | null;
}

export function describeDatabaseStorage(status: DatabaseStorageStatus): DatabaseStorageView {
  const onDisk = status.fileBytes + status.walBytes;
  const percent =
    status.pageCount > 0 ? Math.round((status.freePageCount / status.pageCount) * 100) : 0;
  const summary =
    status.reclaimableBytes > 0
      ? `${formatStorageBytes(onDisk)} on disk · ${formatStorageBytes(status.reclaimableBytes)} (${percent}%) is free space compaction can return`
      : `${formatStorageBytes(onDisk)} on disk · no free space to return`;
  const available = status.availableDiskBytes;
  const requirement = `Takes ${formatCompactionEstimate(status.estimatedSeconds)} at the next start and needs ${formatStorageBytes(
    status.requiredFreeBytes,
  )} of free disk${available === null ? "" : ` (${formatStorageBytes(available)} free now)`}.`;
  const diskWarning =
    available !== null && available < status.requiredFreeBytes
      ? `Only ${formatStorageBytes(available)} is free. Free up ${formatStorageBytes(
          status.requiredFreeBytes - available,
        )} or the next start will skip compaction.`
      : null;
  const scheduledNote =
    status.scheduled === null
      ? null
      : status.scheduled.deferredReason === "update-launch"
        ? "Scheduled. Solla Code last started right after an update, so compaction waits for the next ordinary start."
        : "Scheduled for the next time Solla Code starts.";
  return {
    summary,
    reclaimable: status.reclaimableBytes > 0,
    requirement,
    diskWarning,
    scheduledNote,
    lastResult: status.lastResult === null ? null : describeCompactionResult(status.lastResult),
  };
}

/** The in-app confirmation shown before scheduling. */
export function databaseCompactionConfirmMessage(status: DatabaseStorageStatus): string {
  const view = describeDatabaseStorage(status);
  return [
    `Compact the database the next time Solla Code starts? It should shrink from ${formatStorageBytes(
      status.fileBytes + status.walBytes,
    )} to about ${formatStorageBytes(status.liveBytes)}.`,
    view.requirement,
    "Solla Code stays unavailable until it finishes. Nothing is deleted, and the original is kept if anything goes wrong.",
    ...(view.diskWarning === null ? [] : [view.diskWarning]),
  ].join(" ");
}
