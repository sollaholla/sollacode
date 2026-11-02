// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "./attachmentStore.ts";
import * as ServerConfig from "./config.ts";
import * as ServerSettings from "./serverSettings.ts";

const MILLIS_PER_HOUR = 60 * 60 * 1_000;
const ATTACHMENT_RETENTION_SWEEP_INTERVAL = Duration.hours(24);

export interface AttachmentRetentionSweepResult {
  readonly scannedFiles: number;
  /** Expired by age but kept, because a person sent them. */
  readonly keptFiles: number;
  readonly removedFiles: number;
  readonly removedBytes: number;
  readonly failedFiles: number;
}

export class AttachmentRetentionSweepError extends Schema.TaggedErrorClass<AttachmentRetentionSweepError>()(
  "AttachmentRetentionSweepError",
  {
    attachmentsDir: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Attachment retention sweep failed for ${this.attachmentsDir}.`;
  }
}

export function isAttachmentExpired(input: {
  readonly modifiedAtMs: number;
  readonly nowMs: number;
  readonly retentionHours: number;
}): boolean {
  return input.modifiedAtMs <= input.nowMs - input.retentionHours * MILLIS_PER_HOUR;
}

function isNotFoundError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { readonly code?: unknown }).code === "ENOENT"
  );
}

/** The expired regular files in the directory, gathered before anything is removed. */
const listExpiredAttachments = (input: {
  readonly attachmentsDir: string;
  readonly retentionHours: number;
  readonly nowMs: number;
}) =>
  Effect.tryPromise({
    try: async () => {
      const expired: Array<{ readonly name: string; readonly size: number }> = [];
      let scannedFiles = 0;
      let failedFiles = 0;
      let directory;
      try {
        directory = await NodeFSP.opendir(input.attachmentsDir, { bufferSize: 64 });
      } catch (cause) {
        if (isNotFoundError(cause)) return { expired, scannedFiles, failedFiles };
        throw cause;
      }
      for await (const entry of directory) {
        if (!entry.isFile()) {
          continue;
        }
        scannedFiles += 1;
        try {
          const fileInfo = await NodeFSP.stat(NodePath.join(input.attachmentsDir, entry.name));
          if (
            isAttachmentExpired({
              modifiedAtMs: fileInfo.mtimeMs,
              nowMs: input.nowMs,
              retentionHours: input.retentionHours,
            })
          ) {
            expired.push({ name: entry.name, size: fileInfo.size });
          }
        } catch (cause) {
          if (!isNotFoundError(cause)) {
            failedFiles += 1;
          }
        }
      }
      return { expired, scannedFiles, failedFiles };
    },
    catch: (cause) =>
      new AttachmentRetentionSweepError({
        attachmentsDir: input.attachmentsDir,
        cause,
      }),
  });

/**
 * Removes expired attachments, except those `keptAttachmentIds` names. That lookup
 * failing stops the sweep rather than risk deleting what cannot be recovered.
 */
export const sweepExpiredAttachments = Effect.fn("sweepExpiredAttachments")(function* (input: {
  readonly attachmentsDir: string;
  readonly retentionHours: number;
  readonly nowMs?: number;
  readonly keptAttachmentIds?: (
    attachmentIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlySet<string>, AttachmentRetentionSweepError>;
}) {
  const nowMs = input.nowMs ?? (yield* Clock.currentTimeMillis);
  const listed = yield* listExpiredAttachments({
    attachmentsDir: input.attachmentsDir,
    retentionHours: input.retentionHours,
    nowMs,
  });
  const attachmentIdOf = (fileName: string) => NodePath.parse(fileName).name;
  const kept: ReadonlySet<string> =
    input.keptAttachmentIds === undefined || listed.expired.length === 0
      ? new Set()
      : yield* input.keptAttachmentIds(listed.expired.map((file) => attachmentIdOf(file.name)));
  return yield* Effect.tryPromise({
    try: async (): Promise<AttachmentRetentionSweepResult> => {
      let keptFiles = 0;
      let removedFiles = 0;
      let removedBytes = 0;
      let failedFiles = listed.failedFiles;
      for (const file of listed.expired) {
        if (kept.has(attachmentIdOf(file.name))) {
          keptFiles += 1;
          continue;
        }
        try {
          await NodeFSP.unlink(NodePath.join(input.attachmentsDir, file.name));
          removedFiles += 1;
          removedBytes += file.size;
        } catch (cause) {
          if (!isNotFoundError(cause)) {
            failedFiles += 1;
          }
        }
      }
      return {
        scannedFiles: listed.scannedFiles,
        keptFiles,
        removedFiles,
        removedBytes,
        failedFiles,
      };
    },
    catch: (cause) =>
      new AttachmentRetentionSweepError({
        attachmentsDir: input.attachmentsDir,
        cause,
      }),
  });
});

const PersonSentAttachments = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ type: Schema.String, id: Schema.String })),
);
const decodePersonSentAttachments = Schema.decodeUnknownOption(PersonSentAttachments);

/**
 * Which of these attachments are images a person sent, so they stay until their
 * thread is deleted. Browser snapshots and read-image copies hang off activities and
 * voice notes are not images, so those keep the retention limit. Looked up one thread
 * at a time through the `(thread_id, role)` index, because this runs on the server's
 * single SQLite connection; a thread already deleted keeps nothing.
 */
export const personSentImageAttachmentIds = Effect.fn("personSentImageAttachmentIds")(function* (
  attachmentIds: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const wantedSegments = new Set(
    attachmentIds.flatMap((id) => {
      const segment = parseThreadSegmentFromAttachmentId(id);
      return segment === null ? [] : [segment];
    }),
  );
  const kept = new Set<string>();
  if (wantedSegments.size === 0) return kept;
  const threads = yield* sql<{ readonly threadId: string }>`
    SELECT thread_id AS "threadId"
    FROM projection_threads
    WHERE deleted_at IS NULL
  `;
  for (const { threadId } of threads) {
    const segment = toSafeThreadAttachmentSegment(threadId);
    if (segment === null || !wantedSegments.has(segment)) continue;
    const rows = yield* sql<{ readonly attachments: string }>`
      SELECT attachments_json AS "attachments"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
        AND role = 'user'
        AND attachments_json IS NOT NULL
    `;
    for (const row of rows) {
      const attachments = Option.getOrElse(decodePersonSentAttachments(row.attachments), () => []);
      for (const attachment of attachments) {
        if (attachment.type === "image") kept.add(attachment.id);
      }
    }
  }
  return kept;
});

export const startAttachmentRetention = Effect.fn("startAttachmentRetention")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const settingsChanges = yield* settingsService.subscribeChanges;
  yield* settingsService.ready;

  const initialSettings = yield* settingsService.getSettings;
  const lastRetentionHours = yield* Ref.make(initialSettings.attachmentRetentionHours);
  const sweepLock = yield* Semaphore.make(1);

  const runSweep = Effect.fn("runAttachmentRetentionSweep")(function* (retentionHours: number) {
    const result = yield* sweepExpiredAttachments({
      attachmentsDir: config.attachmentsDir,
      retentionHours,
      keptAttachmentIds: (attachmentIds) =>
        personSentImageAttachmentIds(attachmentIds).pipe(
          Effect.mapError(
            (cause) =>
              new AttachmentRetentionSweepError({
                attachmentsDir: config.attachmentsDir,
                cause,
              }),
          ),
          Effect.provideService(SqlClient.SqlClient, sql),
        ),
    });
    yield* Effect.logInfo("attachment retention sweep complete", {
      retentionHours,
      ...result,
    });
  });

  const runSweepSafely = (retentionHours: number) =>
    sweepLock.withPermits(1)(
      runSweep(retentionHours).pipe(
        Effect.catch((error) =>
          Effect.logWarning("attachment retention sweep failed", {
            attachmentsDir: error.attachmentsDir,
            cause: error.cause,
          }),
        ),
      ),
    );

  yield* runSweepSafely(initialSettings.attachmentRetentionHours).pipe(Effect.forkScoped);

  yield* Stream.runForEach(settingsChanges, (settings) =>
    Ref.modify(lastRetentionHours, (previous) => [
      previous !== settings.attachmentRetentionHours,
      settings.attachmentRetentionHours,
    ]).pipe(
      Effect.flatMap((changed) =>
        changed ? runSweepSafely(settings.attachmentRetentionHours) : Effect.void,
      ),
    ),
  ).pipe(Effect.forkScoped);

  yield* Effect.sleep(ATTACHMENT_RETENTION_SWEEP_INTERVAL).pipe(
    Effect.andThen(
      settingsService.getSettings.pipe(
        Effect.flatMap((settings) => runSweepSafely(settings.attachmentRetentionHours)),
        Effect.catch((cause) =>
          Effect.logWarning("failed to read attachment retention settings", { cause }),
        ),
      ),
    ),
    Effect.forever,
    Effect.forkScoped,
  );
});
