// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { OrchestrationProjectFolderUsage } from "@t3tools/contracts";

import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  layer,
  ProjectFolderUsage,
  protectedFoldersToSkip,
  walkFolder,
} from "./ProjectFolderUsage.ts";

const makeTree = Effect.promise(async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-folder-usage-"));
  await NodeFSP.writeFile(NodePath.join(root, "a.bin"), Buffer.alloc(1_000));
  await NodeFSP.mkdir(NodePath.join(root, "sub"));
  await NodeFSP.writeFile(NodePath.join(root, "sub", "b.bin"), Buffer.alloc(2_000));
  // A second name for a.bin: one file on disk, counted once.
  await NodeFSP.link(NodePath.join(root, "a.bin"), NodePath.join(root, "sub", "a-again.bin"));
  await NodeFSP.mkdir(NodePath.join(root, "skipped"));
  await NodeFSP.writeFile(NodePath.join(root, "skipped", "c.bin"), Buffer.alloc(5_000));
  return root;
});

const lstatSize = (path: string) =>
  Effect.promise(() => NodeFSP.lstat(path)).pipe(Effect.map((info) => info.size));

describe("protectedFoldersToSkip", () => {
  const path = NodePath.posix;

  it("leaves out what macOS guards, unless a project already lives there", () => {
    expect(
      protectedFoldersToSkip({
        root: "/Users/me",
        home: "/Users/me",
        fullDiskAccess: false,
        projectRoots: ["/Users/me", "/Users/me/Desktop/game", "/Users/me/Documents"],
        path,
      }),
    ).toEqual([
      "/Users/me/Downloads",
      "/Users/me/Movies",
      "/Users/me/Music",
      "/Users/me/Pictures",
      "/Users/me/Library/CloudStorage",
      "/Users/me/Library/Containers",
      "/Users/me/Library/Group Containers",
      "/Users/me/Library/Mobile Documents",
    ]);
  });

  it("skips nothing with Full Disk Access, or for a folder that holds none of them", () => {
    const base = { home: "/Users/me", projectRoots: [], path };
    expect(protectedFoldersToSkip({ ...base, root: "/Users/me", fullDiskAccess: true })).toEqual(
      [],
    );
    expect(
      protectedFoldersToSkip({ ...base, root: "/Users/me/Documents/app", fullDiskAccess: false }),
    ).toEqual([]);
  });
});

describe("walkFolder", () => {
  it.effect("totals a folder once per file, leaving out skipped folders and symlink targets", () =>
    Effect.gen(function* () {
      const root = yield* makeTree;
      yield* Effect.promise(() => NodeFSP.symlink("/usr", NodePath.join(root, "outside")));
      const walked = yield* walkFolder({
        root,
        skip: [NodePath.join(root, "skipped")],
        known: [],
        measure: "apparent",
      });
      const folders = (yield* lstatSize(root)) + (yield* lstatSize(NodePath.join(root, "sub")));
      const link = yield* lstatSize(NodePath.join(root, "outside"));
      expect(walked).toEqual({ bytes: folders + 1_000 + 2_000 + link, unreadable: 0 });
    }),
  );

  it.effect("counts a folder inside with a fresh total of its own without walking it", () =>
    Effect.gen(function* () {
      const root = yield* makeTree;
      const sub = NodePath.join(root, "sub");
      const walked = yield* walkFolder({
        root,
        skip: [NodePath.join(root, "skipped")],
        known: [{ path: sub, bytes: 7, unreadable: 2 }],
        measure: "apparent",
      });
      expect(walked).toEqual({ bytes: (yield* lstatSize(root)) + 1_000 + 7, unreadable: 2 });
    }),
  );

  it.effect("reports a folder that isn't there", () =>
    Effect.gen(function* () {
      const failure = yield* walkFolder({
        root: NodePath.join(NodeOS.tmpdir(), "t3-folder-usage-missing", "nowhere"),
        skip: [],
        known: [],
        measure: "apparent",
      }).pipe(Effect.flip);
      expect(failure.reason).toBe("missing");
    }),
  );
});

describe("ProjectFolderUsage", () => {
  it.effect("measures each live project's folder and sends the result as it lands", () =>
    Effect.gen(function* () {
      const root = yield* makeTree;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE projection_projects (
          project_id TEXT PRIMARY KEY,
          workspace_root TEXT NOT NULL,
          deleted_at TEXT
        )
      `;
      yield* sql`
        INSERT INTO projection_projects (project_id, workspace_root, deleted_at) VALUES
          ('present', ${root}, NULL),
          ('missing', ${NodePath.join(root, "gone")}, NULL),
          ('deleted', ${root}, '2026-10-11T00:00:00.000Z')
      `;
      const usage = yield* ProjectFolderUsage;
      const settled = yield* usage.stream.pipe(
        Stream.filter(({ folders }) => folders.every((folder) => !folder.measuring)),
        Stream.runHead,
      );
      const folders = new Map<string, OrchestrationProjectFolderUsage>(
        (settled._tag === "Some" ? settled.value.folders : []).map((folder) => [
          folder.projectId,
          folder,
        ]),
      );
      expect([...folders.keys()].toSorted()).toEqual(["missing", "present"]);
      expect(folders.get("present")?.bytes).toBeGreaterThan(8_000);
      expect(folders.get("present")?.error).toBeNull();
      expect(folders.get("present")?.measuredAt).not.toBeNull();
      expect(folders.get("missing")).toMatchObject({
        bytes: null,
        error: "This folder doesn't exist.",
      });
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provideMerge(NodeSqliteClient.layerMemory()),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
});
