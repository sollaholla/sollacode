// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import * as ServerSettings from "./serverSettings.ts";

const MILLIS_PER_HOUR = 60 * 60 * 1_000;
const ATTACHMENT_RETENTION_SWEEP_INTERVAL = Duration.hours(24);

export interface AttachmentRetentionSweepResult {
  readonly scannedFiles: number;
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

export const sweepExpiredAttachments = Effect.fn("sweepExpiredAttachments")(function* (input: {
  readonly attachmentsDir: string;
  readonly retentionHours: number;
  readonly nowMs?: number;
}) {
  const nowMs = input.nowMs ?? (yield* Clock.currentTimeMillis);
  return yield* Effect.tryPromise({
    try: async (): Promise<AttachmentRetentionSweepResult> => {
      let directory;
      try {
        directory = await NodeFSP.opendir(input.attachmentsDir, { bufferSize: 64 });
      } catch (cause) {
        if (isNotFoundError(cause)) {
          return {
            scannedFiles: 0,
            removedFiles: 0,
            removedBytes: 0,
            failedFiles: 0,
          };
        }
        throw cause;
      }

      let scannedFiles = 0;
      let removedFiles = 0;
      let removedBytes = 0;
      let failedFiles = 0;

      for await (const entry of directory) {
        if (!entry.isFile()) {
          continue;
        }

        scannedFiles += 1;
        const attachmentPath = NodePath.join(input.attachmentsDir, entry.name);
        try {
          const fileInfo = await NodeFSP.stat(attachmentPath);
          if (
            !isAttachmentExpired({
              modifiedAtMs: fileInfo.mtimeMs,
              nowMs,
              retentionHours: input.retentionHours,
            })
          ) {
            continue;
          }
          await NodeFSP.unlink(attachmentPath);
          removedFiles += 1;
          removedBytes += fileInfo.size;
        } catch (cause) {
          if (!isNotFoundError(cause)) {
            failedFiles += 1;
          }
        }
      }

      return { scannedFiles, removedFiles, removedBytes, failedFiles };
    },
    catch: (cause) =>
      new AttachmentRetentionSweepError({
        attachmentsDir: input.attachmentsDir,
        cause,
      }),
  });
});

export const startAttachmentRetention = Effect.fn("startAttachmentRetention")(function* () {
  const config = yield* ServerConfig.ServerConfig;
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
