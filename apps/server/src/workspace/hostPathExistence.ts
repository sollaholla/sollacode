import type { FilesystemPathExistence } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Which of these absolute paths exist on this host, and as what.
 *
 * This backs bare-path detection in chat prose: the client finds things that
 * look like `/Users/me/project/report.png` in plain text and asks here before
 * drawing a clickable reference, so a path the assistant merely guessed at
 * never becomes a dead chip. One `stat` per path, a bounded batch, nothing
 * read. A relative path, an embedded NUL, or anything `stat` refuses is
 * simply `missing`; the caller's cache remembers that answer too.
 */
export const classifyHostPaths = Effect.fn("hostPathExistence.classify")(function* (
  paths: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.forEach(
    paths,
    (candidate): Effect.Effect<FilesystemPathExistence> => {
      if (candidate.includes("\0") || !path.isAbsolute(candidate)) {
        return Effect.succeed({ path: candidate, kind: "missing" });
      }
      return fileSystem.stat(candidate).pipe(
        Effect.map(
          (info): FilesystemPathExistence => ({
            path: candidate,
            kind:
              info.type === "Directory" ? "directory" : info.type === "File" ? "file" : "missing",
          }),
        ),
        Effect.orElseSucceed((): FilesystemPathExistence => ({ path: candidate, kind: "missing" })),
      );
    },
    { concurrency: 8 },
  );
});
