import type { DatabaseStorageStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  databaseCompactionConfirmMessage,
  describeCompactionResult,
  describeDatabaseStorage,
  formatCompactionEstimate,
  formatStorageBytes,
} from "./databaseStorage.ts";

const GIB = 1024 ** 3;

// The live database this feature was built for: 20.2 GB, 56% free pages.
const status: DatabaseStorageStatus = {
  fileBytes: Math.round(20.2 * GIB),
  walBytes: 0,
  pageSize: 4096,
  pageCount: Math.round((20.2 * GIB) / 4096),
  freePageCount: Math.round((11.4 * GIB) / 4096),
  liveBytes: Math.round(8.8 * GIB),
  reclaimableBytes: Math.round(11.4 * GIB),
  requiredFreeBytes: Math.round(10.2 * GIB),
  availableDiskBytes: Math.round(28 * GIB),
  estimatedSeconds: 264,
  scheduled: null,
  lastResult: null,
};

describe("formatStorageBytes", () => {
  it("uses the largest unit under 1024 with one decimal below a hundred", () => {
    expect(formatStorageBytes(512)).toBe("512 B");
    expect(formatStorageBytes(1536)).toBe("1.5 KB");
    expect(formatStorageBytes(486_051_840)).toBe("464 MB");
    expect(formatStorageBytes(20.2 * GIB)).toBe("20.2 GB");
    expect(formatStorageBytes(8.8 * GIB)).toBe("8.8 GB");
  });
});

describe("formatCompactionEstimate", () => {
  it("rounds up to whole minutes", () => {
    expect(formatCompactionEstimate(20)).toBe("under a minute");
    expect(formatCompactionEstimate(60)).toBe("about a minute");
    expect(formatCompactionEstimate(264)).toBe("about 5 minutes");
  });
});

describe("describeDatabaseStorage", () => {
  it("says how much compaction returns and what the next start needs", () => {
    const view = describeDatabaseStorage(status);
    expect(view.summary).toBe(
      "20.2 GB on disk · 11.4 GB (56%) is free space compaction can return",
    );
    expect(view.reclaimable).toBe(true);
    expect(view.requirement).toBe(
      "Takes about 5 minutes at the next start and needs 10.2 GB of free disk (28.0 GB free now).",
    );
    expect(view.diskWarning).toBeNull();
    expect(view.scheduledNote).toBeNull();
    expect(view.lastResult).toBeNull();
  });

  it("warns when the disk is too full for the next start", () => {
    const view = describeDatabaseStorage({ ...status, availableDiskBytes: 6 * GIB });
    expect(view.diskWarning).toBe(
      "Only 6.0 GB is free. Free up 4.2 GB or the next start will skip compaction.",
    );
  });

  it("explains a compaction an update launch left for later", () => {
    const scheduled = {
      requestedAt: "2026-10-24T10:00:00.000Z",
      deferredAt: null,
      deferredReason: null,
    };
    expect(describeDatabaseStorage({ ...status, scheduled }).scheduledNote).toBe(
      "Scheduled for the next time Solla Code starts.",
    );
    expect(
      describeDatabaseStorage({
        ...status,
        scheduled: {
          ...scheduled,
          deferredAt: "2026-10-24T10:05:00.000Z",
          deferredReason: "update-launch",
        },
      }).scheduledNote,
    ).toContain("waits for the next ordinary start");
  });

  it("has nothing to offer for a database without free pages", () => {
    const view = describeDatabaseStorage({ ...status, freePageCount: 0, reclaimableBytes: 0 });
    expect(view.reclaimable).toBe(false);
    expect(view.summary).toBe("20.2 GB on disk · no free space to return");
  });
});

describe("describeCompactionResult", () => {
  const base = {
    startedAt: "2026-10-24T10:00:00.000Z",
    finishedAt: "2026-10-24T10:02:05.000Z",
    durationMs: 125_000,
    beforeBytes: Math.round(20.2 * GIB),
  };

  it("reports each outcome with its reason", () => {
    expect(
      describeCompactionResult({
        ...base,
        outcome: "compacted",
        afterBytes: Math.round(8.8 * GIB),
        reason: null,
      }),
    ).toEqual({
      tone: "success",
      title: "Compacted 20.2 GB to 8.8 GB in 2 min 5 s",
      detail: "",
      finishedAt: base.finishedAt,
    });
    const skipped = describeCompactionResult({
      ...base,
      outcome: "skipped",
      afterBytes: null,
      reason: "Not enough free disk space.",
    });
    expect([skipped.tone, skipped.title, skipped.detail]).toEqual([
      "warning",
      "Compaction was skipped",
      "Not enough free disk space.",
    ]);
    expect(
      describeCompactionResult({ ...base, outcome: "failed", afterBytes: null, reason: "x" }).tone,
    ).toBe("error");
    expect(
      describeCompactionResult({
        ...base,
        outcome: "interrupted",
        durationMs: null,
        afterBytes: null,
        reason: null,
      }).detail,
    ).toBe("The original database was kept.");
  });
});

describe("databaseCompactionConfirmMessage", () => {
  it("names the expected size, time, disk, and safety", () => {
    const message = databaseCompactionConfirmMessage(status);
    expect(message).toContain("shrink from 20.2 GB to about 8.8 GB");
    expect(message).toContain("about 5 minutes");
    expect(message).toContain("original is kept if anything goes wrong");
  });
});
