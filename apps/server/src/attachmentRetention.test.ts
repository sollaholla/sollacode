// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  AttachmentRetentionSweepError,
  isAttachmentExpired,
  personSentImageAttachmentIds,
  sweepExpiredAttachments,
} from "./attachmentRetention.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";

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
        keptFiles: 0,
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

  it.effect("keeps expired attachments the lookup names", () =>
    Effect.gen(function* () {
      const attachmentsDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-attachment-retention-")),
      );
      const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
      const expiredAtSeconds = (nowMs - 49 * 60 * 60 * 1_000) / 1_000;
      for (const name of ["sent.png", "snapshot.jpg"]) {
        const filePath = NodePath.join(attachmentsDir, name);
        yield* Effect.promise(() => NodeFSP.writeFile(filePath, "bytes"));
        yield* Effect.promise(() => NodeFSP.utimes(filePath, expiredAtSeconds, expiredAtSeconds));
      }

      const result = yield* sweepExpiredAttachments({
        attachmentsDir,
        retentionHours: 48,
        nowMs,
        keptAttachmentIds: (attachmentIds) =>
          Effect.succeed(new Set(attachmentIds.filter((id) => id === "sent"))),
      });

      expect(result).toMatchObject({ keptFiles: 1, removedFiles: 1 });
      expect(yield* Effect.promise(() => NodeFSP.readdir(attachmentsDir))).toEqual(["sent.png"]);
    }),
  );

  it.effect("removes nothing when the lookup fails", () =>
    Effect.gen(function* () {
      const attachmentsDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-attachment-retention-")),
      );
      const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
      const expiredAtSeconds = (nowMs - 49 * 60 * 60 * 1_000) / 1_000;
      const filePath = NodePath.join(attachmentsDir, "sent.png");
      yield* Effect.promise(() => NodeFSP.writeFile(filePath, "bytes"));
      yield* Effect.promise(() => NodeFSP.utimes(filePath, expiredAtSeconds, expiredAtSeconds));

      const exit = yield* Effect.exit(
        sweepExpiredAttachments({
          attachmentsDir,
          retentionHours: 48,
          nowMs,
          keptAttachmentIds: () =>
            Effect.fail(new AttachmentRetentionSweepError({ attachmentsDir, cause: "offline" })),
        }),
      );

      expect(exit._tag).toBe("Failure");
      expect(yield* Effect.promise(() => NodeFSP.readdir(attachmentsDir))).toEqual(["sent.png"]);
    }),
  );

  it.layer(SqlitePersistenceMemory)("person-sent images", (it) => {
    const THREAD = "11111111-1111-4111-8111-111111111111";
    const GONE = "22222222-2222-4222-8222-222222222222";
    const SENT = `${THREAD}-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    const VOICE = `${THREAD}-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
    const SNAPSHOT = `${THREAD}-cccccccc-cccc-4ccc-8ccc-cccccccccccc`;
    const ASSISTANT = `${THREAD}-dddddddd-dddd-4ddd-8ddd-dddddddddddd`;
    const SENT_IN_DELETED = `${GONE}-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee`;
    const insertThread = (threadId: string, deletedAt: string | null) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, branch, worktree_path, latest_turn_id, created_at, updated_at,
            deleted_at
          )
          VALUES (
            ${threadId}, 'project', 'Title', '{"instanceId":"codex","model":"gpt"}',
            'full-access', 'default', NULL, NULL, NULL, '2026-08-25T00:00:00.000Z',
            '2026-08-25T00:00:00.000Z', ${deletedAt}
          )
        `;
      });
    const insertMessage = (
      messageId: string,
      threadId: string,
      role: string,
      attachmentsJson: string,
    ) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, role, text, is_streaming, created_at, updated_at,
            attachments_json
          )
          VALUES (
            ${messageId}, ${threadId}, ${role}, 'text', 0, '2026-08-25T00:00:00.000Z',
            '2026-08-25T00:00:00.000Z', ${attachmentsJson}
          )
        `;
      });

    it.effect("names only images on a person's message in a thread that still exists", () =>
      Effect.gen(function* () {
        yield* insertThread(THREAD, null);
        yield* insertThread(GONE, "2026-08-25T01:00:00.000Z");
        yield* insertMessage(
          "m1",
          THREAD,
          "user",
          `[{"type":"image","id":"${SENT}"},{"type":"audio","id":"${VOICE}"}]`,
        );
        yield* insertMessage("m2", THREAD, "assistant", `[{"type":"image","id":"${ASSISTANT}"}]`);
        yield* insertMessage("m3", GONE, "user", `[{"type":"image","id":"${SENT_IN_DELETED}"}]`);

        const kept = yield* personSentImageAttachmentIds([
          SENT,
          VOICE,
          SNAPSHOT,
          ASSISTANT,
          SENT_IN_DELETED,
          "not-an-attachment-id",
        ]);

        expect([...kept]).toEqual([SENT]);
      }),
    );
  });
});
