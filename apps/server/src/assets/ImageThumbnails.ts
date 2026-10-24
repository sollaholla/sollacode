// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";

/** Longest side of a thumbnail: sharp on a phone's 44-point tiles and the 112-point gallery. */
export const THUMBNAIL_MAX_PX = 320;
/** Smaller images are sent as they are; `sips` would only enlarge them. */
export const THUMBNAIL_MIN_SOURCE_BYTES = 96 * 1024;
/** Formats `sips` reads. SVG and ICO stay as they are. */
const THUMBNAIL_SOURCE_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);
const THUMBNAIL_TIMEOUT = Duration.seconds(10);
const THUMBNAIL_CONCURRENCY = 2;
/** Thumbnails are rebuilt on demand, so old ones only take space. */
const THUMBNAIL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export class ImageThumbnails extends Context.Service<
  ImageThumbnails,
  {
    /**
     * A small JPEG of the image at `path`, cached by the file's size and
     * modification time, or null when the original should be sent instead:
     * a small or unsupported file, a host without `sips`, or a failed resize.
     */
    readonly thumbnail: (path: string) => Effect.Effect<Uint8Array | null>;
  }
>()("t3/assets/ImageThumbnails") {}

export function isThumbnailSourcePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && THUMBNAIL_SOURCE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

export const layer = Layer.effect(
  ImageThumbnails,
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    // `sips` ships with macOS. Elsewhere tiles fetch the original, as before.
    if (platform !== "darwin") return ImageThumbnails.of({ thumbnail: () => Effect.succeed(null) });

    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = path.join(config.stateDir, "thumbnails");
    const permits = yield* Semaphore.make(THUMBNAIL_CONCURRENCY);

    const prune = Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const names = yield* fileSystem.readDirectory(directory);
      yield* Effect.forEach(
        names,
        (name) => {
          const file = path.join(directory, name);
          return fileSystem.stat(file).pipe(
            Effect.flatMap((info) => {
              const modifiedMs = Option.getOrUndefined(info.mtime)?.getTime() ?? 0;
              return nowMs - modifiedMs > THUMBNAIL_MAX_AGE_MS
                ? fileSystem.remove(file)
                : Effect.void;
            }),
            Effect.ignore,
          );
        },
        { concurrency: 4, discard: true },
      );
    }).pipe(Effect.ignore);
    yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(Effect.ignore);
    yield* Effect.forkScoped(prune);

    const resize = (source: string, target: string) =>
      permits.withPermits(1)(
        Effect.gen(function* () {
          const temp = path.join(directory, `${NodeCrypto.randomUUID()}.tmp.jpg`);
          const exitCode = yield* spawner
            .exitCode(
              ChildProcess.make("/usr/bin/sips", [
                "-s",
                "format",
                "jpeg",
                "-s",
                "formatOptions",
                "70",
                "-Z",
                String(THUMBNAIL_MAX_PX),
                source,
                "--out",
                temp,
              ]),
            )
            .pipe(Effect.timeout(THUMBNAIL_TIMEOUT));
          if (Number(exitCode) !== 0) {
            yield* fileSystem.remove(temp).pipe(Effect.ignore);
            return null;
          }
          yield* fileSystem.rename(temp, target);
          return yield* fileSystem.readFile(target);
        }),
      );

    const thumbnail = (source: string): Effect.Effect<Uint8Array | null> =>
      Effect.gen(function* () {
        if (!isThumbnailSourcePath(source)) return null;
        const info = yield* fileSystem.stat(source);
        const bytes = Number(info.size);
        if (info.type !== "File" || bytes <= THUMBNAIL_MIN_SOURCE_BYTES) return null;
        const modifiedMs = Option.getOrUndefined(info.mtime)?.getTime() ?? 0;
        // Not a template with `\0${…}`: the bundler inlines the constant, and
        // `\0` followed by its digits is an octal escape that fails to load.
        const key = NodeCrypto.createHash("sha256")
          .update([source, bytes, modifiedMs, THUMBNAIL_MAX_PX].join("\0"))
          .digest("hex");
        const target = path.join(directory, `${key}.jpg`);
        const cached = yield* fileSystem.readFile(target).pipe(Effect.option);
        if (Option.isSome(cached)) return cached.value;
        return yield* resize(source, target);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("image thumbnail unavailable; sending the original", {
            path: source,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );

    return ImageThumbnails.of({ thumbnail });
  }),
);
