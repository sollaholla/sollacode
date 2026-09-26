import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { classifyHostPaths } from "./hostPathExistence.ts";

describe("classifyHostPaths", () => {
  it.effect("reports files, directories, and everything else as missing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const file = path.join(directory, "report.png");
      yield* fileSystem.writeFileString(file, "png");

      const entries = yield* classifyHostPaths([
        file,
        directory,
        path.join(directory, "nope.png"),
        "relative/report.png",
        `${file}\0`,
      ]);
      expect(entries).toEqual([
        { path: file, kind: "file" },
        { path: directory, kind: "directory" },
        { path: path.join(directory, "nope.png"), kind: "missing" },
        { path: "relative/report.png", kind: "missing" },
        { path: `${file}\0`, kind: "missing" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
