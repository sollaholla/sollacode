// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { isAttachmentExpired, sweepExpiredAttachments } from "./attachmentRetention.ts";

describe("attachment retention", () => {
  it("expires files at the configured age boundary", () => {
    const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
    const fortyEightHoursMs = 48 * 60 * 60 * 1_000;

    expect(
      isAttachmentExpired({
        modifiedAtMs: nowMs - fortyEightHoursMs,
        nowMs,
        retentionHours: 48,
      }),
    ).toBe(true);
    expect(
      isAttachmentExpired({
        modifiedAtMs: nowMs - fortyEightHoursMs + 1,
        nowMs,
        retentionHours: 48,
      }),
    ).toBe(false);
  });

  it.effect("removes only expired regular files and reports reclaimed bytes", () =>
    Effect.gen(function* () {
      const attachmentsDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-attachment-retention-")),
      );
      const expiredPath = NodePath.join(attachmentsDir, "expired.bin");
      const currentPath = NodePath.join(attachmentsDir, "current.bin");
      const nestedDir = NodePath.join(attachmentsDir, "nested");
      const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
      const expiredAtSeconds = (nowMs - 49 * 60 * 60 * 1_000) / 1_000;
      const currentAtSeconds = (nowMs - 47 * 60 * 60 * 1_000) / 1_000;

      yield* Effect.promise(() => NodeFSP.writeFile(expiredPath, "expired"));
      yield* Effect.promise(() => NodeFSP.writeFile(currentPath, "current"));
      yield* Effect.promise(() => NodeFSP.mkdir(nestedDir));
      yield* Effect.promise(() => NodeFSP.utimes(expiredPath, expiredAtSeconds, expiredAtSeconds));
      yield* Effect.promise(() => NodeFSP.utimes(currentPath, currentAtSeconds, currentAtSeconds));

      const result = yield* sweepExpiredAttachments({
        attachmentsDir,
        retentionHours: 48,
        nowMs,
      });

      expect(result).toEqual({
        scannedFiles: 2,
        removedFiles: 1,
        removedBytes: 7,
        failedFiles: 0,
      });
      yield* Effect.promise(() =>
        expect(NodeFSP.readFile(expiredPath)).rejects.toMatchObject({ code: "ENOENT" }),
      );
      yield* Effect.promise(() =>
        expect(NodeFSP.readFile(currentPath, "utf8")).resolves.toBe("current"),
      );
    }),
  );
});
