// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodeWorkerThreads from "node:worker_threads";

import {
  ProjectId,
  type OrchestrationProjectFolderUsage,
  type OrchestrationProjectFolders,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** A measurement this recent is shown as it is rather than taken again. */
export const FOLDER_USAGE_FRESH_MS = 6 * 60 * 60 * 1000;
/** A walk still going after this long is stopped and reported. */
const FOLDER_WALK_TIMEOUT = Duration.minutes(20);

/**
 * Folders macOS asks the person about before an app reads them, relative to
 * their home: walking into one without Full Disk Access can raise a prompt
 * for Music, another app's data, or a cloud drive.
 */
export const MACOS_PROTECTED_HOME_FOLDERS = [
  "Desktop",
  "Documents",
  "Downloads",
  "Movies",
  "Music",
  "Pictures",
  "Library/CloudStorage",
  "Library/Containers",
  "Library/Group Containers",
  "Library/Mobile Documents",
] as const;

export class ProjectFolderWalkError extends Schema.TaggedErrorClass<ProjectFolderWalkError>()(
  "ProjectFolderWalkError",
  {
    reason: Schema.Literals(["missing", "timeout", "failed"]),
    detail: Schema.String,
  },
) {}

export class ProjectFolderUsage extends Context.Service<
  ProjectFolderUsage,
  {
    /**
     * Every live project's folder now, then again whenever a measurement
     * starts or ends. Subscribing measures the folders not measured recently.
     */
    readonly stream: Stream.Stream<OrchestrationProjectFolders>;
    /** Measures these projects' folders again, even if they were measured recently. */
    readonly refresh: (projectIds: ReadonlyArray<string>) => Effect.Effect<void>;
  }
>()("t3/project/ProjectFolderUsage") {}

export function isInsideFolder(child: string, parent: string, separator: string): boolean {
  const prefix = parent.endsWith(separator) ? parent : `${parent}${separator}`;
  return child.startsWith(prefix);
}

/**
 * The protected folders a walk of `root` leaves out: those inside it, unless
 * Full Disk Access covers them or a project already lives there, which means
 * the person let the app in.
 */
export function protectedFoldersToSkip(input: {
  readonly root: string;
  readonly home: string;
  readonly fullDiskAccess: boolean;
  readonly projectRoots: ReadonlyArray<string>;
  readonly path: Pick<Path.Path, "join" | "sep">;
}): string[] {
  if (input.fullDiskAccess) return [];
  return MACOS_PROTECTED_HOME_FOLDERS.map((relative) =>
    input.path.join(input.home, relative),
  ).filter(
    (folder) =>
      isInsideFolder(folder, input.root, input.path.sep) &&
      !input.projectRoots.some(
        (projectRoot) =>
          projectRoot === folder || isInsideFolder(projectRoot, folder, input.path.sep),
      ),
  );
}

export interface FolderWalkInput {
  readonly root: string;
  /** Absolute folders to leave out. */
  readonly skip: ReadonlyArray<string>;
  /** Folders inside with a fresh total of their own, counted without walking them again. */
  readonly known: ReadonlyArray<{
    readonly path: string;
    readonly bytes: number;
    readonly unreadable: number;
  }>;
  /** "allocated" counts the blocks files take, as `du` does; "apparent" their lengths. */
  readonly measure: "allocated" | "apparent";
}

export interface FolderWalkResult {
  readonly bytes: number;
  /** Folders inside that couldn't be listed. */
  readonly unreadable: number;
}

// Runs in a worker thread, so a walk of a million files never holds up the
// server's own work. Same volume only, symlinks not followed, hard links once.
const FOLDER_WALK_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs/promises");
const path = require("node:path");

const BATCH = 16;
const CONCURRENCY = 2;

(async () => {
  const { root, skip, known, measure } = workerData;
  const skipped = new Set(skip);
  const knownTotals = new Map(known.map((entry) => [entry.path, entry]));
  const sizeOf = (info) => (measure === "allocated" ? Number(info.blocks) * 512 : Number(info.size));
  const rootInfo = await fs.lstat(root);
  if (!rootInfo.isDirectory()) {
    parentPort.postMessage({ type: "done", bytes: sizeOf(rootInfo), unreadable: 0 });
    return;
  }
  const device = rootInfo.dev;
  const linked = new Set();
  let bytes = sizeOf(rootInfo);
  let unreadable = 0;
  const pending = [root];
  let active = 0;

  const visit = async (directory) => {
    let names;
    try {
      names = await fs.readdir(directory);
    } catch {
      unreadable += 1;
      return;
    }
    for (let at = 0; at < names.length; at += BATCH) {
      await Promise.all(
        names.slice(at, at + BATCH).map(async (name) => {
          const entry = path.join(directory, name);
          if (skipped.has(entry)) return;
          const total = knownTotals.get(entry);
          if (total) {
            bytes += total.bytes;
            unreadable += total.unreadable;
            return;
          }
          let info;
          try {
            info = await fs.lstat(entry);
          } catch {
            return;
          }
          if (info.dev !== device) return;
          if (info.isDirectory()) {
            bytes += sizeOf(info);
            pending.push(entry);
            return;
          }
          if (info.nlink > 1) {
            if (linked.has(info.ino)) return;
            linked.add(info.ino);
          }
          bytes += sizeOf(info);
        }),
      );
    }
  };

  await new Promise((resolve, reject) => {
    const pump = () => {
      if (pending.length === 0 && active === 0) {
        resolve();
        return;
      }
      while (active < CONCURRENCY && pending.length > 0) {
        const directory = pending.pop();
        active += 1;
        visit(directory).then(() => {
          active -= 1;
          pump();
        }, reject);
      }
    };
    pump();
  });
  parentPort.postMessage({ type: "done", bytes: Math.round(bytes), unreadable });
})().catch((cause) => {
  parentPort.postMessage({
    type: "failed",
    code: cause && cause.code ? String(cause.code) : null,
    message: cause instanceof Error ? cause.message : String(cause),
  });
});
`;

type WorkerMessage =
  | { readonly type: "done"; readonly bytes: number; readonly unreadable: number }
  | { readonly type: "failed"; readonly code: string | null; readonly message: string };

/** Totals a folder in a worker thread, stopping it if the walk is interrupted or runs long. */
export const walkFolder = (
  input: FolderWalkInput,
): Effect.Effect<FolderWalkResult, ProjectFolderWalkError> =>
  Effect.callback<FolderWalkResult, ProjectFolderWalkError>((resume) => {
    const worker = new NodeWorkerThreads.Worker(FOLDER_WALK_WORKER_SOURCE, {
      eval: true,
      workerData: {
        root: input.root,
        skip: [...input.skip],
        known: input.known.map((entry) => ({ ...entry })),
        measure: input.measure,
      },
    });
    let settled = false;
    const settle = (effect: Effect.Effect<FolderWalkResult, ProjectFolderWalkError>) => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      resume(effect);
    };
    worker.once("message", (message: WorkerMessage) =>
      settle(
        message.type === "done"
          ? Effect.succeed({ bytes: message.bytes, unreadable: message.unreadable })
          : Effect.fail(
              new ProjectFolderWalkError({
                reason:
                  message.code === "ENOENT" || message.code === "ENOTDIR" ? "missing" : "failed",
                detail: message.message,
              }),
            ),
      ),
    );
    worker.once("error", (cause) =>
      settle(Effect.fail(new ProjectFolderWalkError({ reason: "failed", detail: String(cause) }))),
    );
    worker.once("exit", (code) =>
      settle(
        Effect.fail(
          new ProjectFolderWalkError({ reason: "failed", detail: `The walk stopped (${code}).` }),
        ),
      ),
    );
    return Effect.sync(() => {
      settled = true;
      void worker.terminate();
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: FOLDER_WALK_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new ProjectFolderWalkError({ reason: "timeout", detail: "The walk took too long." }),
        ),
    }),
  );

interface FolderEntry {
  readonly bytes: number | null;
  readonly measuredAtMs: number | null;
  readonly measuring: boolean;
  readonly skippedFolders: ReadonlyArray<string>;
  readonly unreadableFolders: number;
  readonly error: string | null;
}

const UNMEASURED: FolderEntry = {
  bytes: null,
  measuredAtMs: null,
  measuring: false,
  skippedFolders: [],
  unreadableFolders: 0,
  error: null,
};

interface LiveProject {
  readonly projectId: string;
  readonly workspaceRoot: string;
}

function toUsage(
  project: LiveProject,
  entry: FolderEntry | undefined,
): OrchestrationProjectFolderUsage {
  const folder = entry ?? UNMEASURED;
  return {
    projectId: ProjectId.make(project.projectId),
    bytes: folder.bytes,
    measuredAt:
      folder.measuredAtMs === null
        ? null
        : DateTime.formatIso(DateTime.makeUnsafe(folder.measuredAtMs)),
    measuring: folder.measuring,
    skippedFolders: folder.skippedFolders,
    unreadableFolders: folder.unreadableFolders,
    error: folder.error,
  };
}

export const layer = Layer.effect(
  ProjectFolderUsage,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcessPlatform;
    const home = NodeOS.homedir();
    // Kept by folder: two projects can share one, and a folder holding others
    // reuses their totals.
    const state = yield* SubscriptionRef.make<ReadonlyMap<string, FolderEntry>>(new Map());
    const queue = yield* Queue.unbounded<string>();

    const listProjects = sql<LiveProject>`
      SELECT project_id AS "projectId", workspace_root AS "workspaceRoot"
      FROM projection_projects
      WHERE deleted_at IS NULL
    `.pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("project folder usage could not list projects", { cause }),
      ),
      Effect.orElseSucceed((): ReadonlyArray<LiveProject> => []),
    );

    // Opening the privacy database read-only forces the macOS check without
    // reading anything (see DesktopPermissions' probe).
    const fullDiskAccess = Effect.scoped(
      fileSystem.open(
        path.join(home, "Library", "Application Support", "com.apple.TCC", "TCC.db"),
        { flag: "r" },
      ),
    ).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

    const measure = (root: string) =>
      Effect.gen(function* () {
        const projectRoots = (yield* listProjects).map((project) => project.workspaceRoot);
        const skip =
          platform === "darwin"
            ? protectedFoldersToSkip({
                root,
                home,
                fullDiskAccess: yield* fullDiskAccess,
                projectRoots,
                path,
              })
            : [];
        const startedMs = yield* Clock.currentTimeMillis;
        const known = [...(yield* SubscriptionRef.get(state)).entries()].flatMap(
          ([folder, entry]) =>
            isInsideFolder(folder, root, path.sep) &&
            !entry.measuring &&
            entry.bytes !== null &&
            entry.error === null &&
            entry.measuredAtMs !== null &&
            startedMs - entry.measuredAtMs < FOLDER_USAGE_FRESH_MS
              ? [{ path: folder, bytes: entry.bytes, unreadable: entry.unreadableFolders }]
              : [],
        );
        const result = yield* walkFolder({
          root,
          skip,
          known,
          measure: platform === "win32" ? "apparent" : "allocated",
        }).pipe(
          Effect.map(
            (walked): FolderEntry => ({
              bytes: walked.bytes,
              measuredAtMs: startedMs,
              measuring: false,
              skippedFolders: skip.map((folder) => path.relative(root, folder)),
              unreadableFolders: walked.unreadable,
              error: null,
            }),
          ),
          Effect.catch((failure) =>
            Effect.succeed<FolderEntry>({
              ...UNMEASURED,
              measuredAtMs: startedMs,
              error:
                failure.reason === "missing"
                  ? "This folder doesn't exist."
                  : failure.reason === "timeout"
                    ? "This folder took too long to measure."
                    : "This folder couldn't be measured.",
            }),
          ),
        );
        yield* SubscriptionRef.update(state, (entries) => new Map(entries).set(root, result));
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("project folder measurement failed", { root, cause }).pipe(
            Effect.andThen(
              SubscriptionRef.update(state, (entries) =>
                new Map(entries).set(root, {
                  ...(entries.get(root) ?? UNMEASURED),
                  measuring: false,
                  error: "This folder couldn't be measured.",
                }),
              ),
            ),
          ),
        ),
      );

    // One walk at a time: a home folder can hold millions of files.
    yield* Effect.forkScoped(Effect.forever(Queue.take(queue).pipe(Effect.flatMap(measure))));

    const ensure = (roots: ReadonlyArray<string>, force: boolean) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const queued = yield* SubscriptionRef.modify(
          state,
          (entries): readonly [ReadonlyArray<string>, ReadonlyMap<string, FolderEntry>] => {
            const next = new Map(entries);
            const toQueue: string[] = [];
            // Deepest first, so a folder holding others counts their fresh
            // totals instead of walking them again.
            for (const root of [...new Set(roots)].toSorted((a, b) => b.length - a.length)) {
              const entry = next.get(root);
              if (entry?.measuring) continue;
              const fresh =
                entry?.measuredAtMs !== null &&
                entry?.measuredAtMs !== undefined &&
                nowMs - entry.measuredAtMs < FOLDER_USAGE_FRESH_MS;
              if (fresh && !force) continue;
              next.set(root, { ...(entry ?? UNMEASURED), measuring: true });
              toQueue.push(root);
            }
            return [toQueue, toQueue.length === 0 ? entries : next];
          },
        );
        if (queued.length > 0) yield* Queue.offerAll(queue, queued);
      });

    const stream: Stream.Stream<OrchestrationProjectFolders> = Stream.unwrap(
      Effect.gen(function* () {
        yield* ensure(
          (yield* listProjects).map((project) => project.workspaceRoot),
          false,
        );
        return SubscriptionRef.changes(state).pipe(
          Stream.mapEffect((entries) =>
            listProjects.pipe(
              Effect.map((projects) => ({
                folders: projects.map((project) =>
                  toUsage(project, entries.get(project.workspaceRoot)),
                ),
              })),
            ),
          ),
        );
      }),
    );

    const refresh = (projectIds: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const wanted = new Set(projectIds);
        const projects = yield* listProjects;
        yield* ensure(
          projects
            .filter((project) => wanted.has(project.projectId))
            .map((project) => project.workspaceRoot),
          true,
        );
      });

    return ProjectFolderUsage.of({ stream, refresh });
  }),
);
