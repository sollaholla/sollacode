// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  isAgentsProjectId,
  isOrchestratorProjectId,
  type ProjectFolderRemovalCheck,
  type ProjectRemoveWithFolderResult,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import { ProcessRunner } from "../processRunner.ts";

/**
 * Moving a project's folder to the Trash when the person removes the project.
 *
 * Nothing here deletes files itself. The system's own Trash takes the folder,
 * so it can be put back, and when that fails the folder simply stays where it
 * is. The refusals exist because a project can be rooted anywhere, including a
 * home folder: anything that holds more than this one project's work is
 * refused here on the server, whatever a client asks for.
 */

const TRASH_TIMEOUT = Duration.minutes(10);

/** Folders straight inside a home folder that hold a person's whole life, not a project. */
const STANDARD_HOME_FOLDERS = [
  "applications",
  "appdata",
  "contacts",
  "desktop",
  "documents",
  "downloads",
  "favorites",
  "icloud drive",
  "library",
  "links",
  "movies",
  "music",
  "onedrive",
  "pictures",
  "public",
  "saved games",
  "searches",
  "videos",
];

/** App and system data inside a home folder; nothing under these is a project to bin. */
const HOME_SYSTEM_FOLDERS = ["library", "appdata"];

const POSIX_SYSTEM_FOLDERS = [
  "/Applications",
  "/Library",
  "/System",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/opt",
  "/private/etc",
  "/private/var",
  "/proc",
  "/sbin",
  "/sys",
  "/usr",
  "/var",
];

const POSIX_MOUNT_PARENTS = ["/Volumes", "/mnt", "/media"];

const WINDOWS_SYSTEM_FOLDERS = ["windows", "program files", "program files (x86)", "programdata"];

export const trashNameFor = (platform: NodeJS.Platform) =>
  platform === "win32" ? "Recycle Bin" : "Trash";

export interface FolderRemovalContext {
  /** The folder itself, with links resolved. */
  readonly folder: string;
  readonly homeDir: string;
  /** Where Solla Code keeps its data: neither inside this folder, nor around it. */
  readonly dataDir: string;
  /** What Solla Code runs from. May be anywhere, even a home folder, so only "not inside". */
  readonly runningFrom: ReadonlyArray<string>;
  /** Every other project on this computer, with links resolved. */
  readonly otherProjects: ReadonlyArray<{
    readonly title: string;
    readonly workspaceRoot: string;
  }>;
  readonly platform: NodeJS.Platform;
}

/** Why this folder must not go to the Trash, or null when it may. */
export function folderRemovalRefusal(context: FolderRemovalContext): string | null {
  const { dataDir, homeDir, otherProjects, platform, runningFrom } = context;
  const path = platform === "win32" ? NodePath.win32 : NodePath.posix;
  // Both default to case-insensitive, so a differently cased path can't slip past.
  const fold = (value: string) =>
    platform === "linux" ? path.resolve(value) : path.resolve(value).toLowerCase();
  const folder = fold(context.folder);
  const home = fold(homeDir);
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

  if (path.dirname(folder) === folder) return "This is a whole drive.";
  if (contains(folder, home)) return "This is your home folder, or a folder that contains it.";

  if (contains(home, folder)) {
    const first = path.relative(home, folder).split(path.sep)[0]?.toLowerCase() ?? "";
    const direct = path.dirname(folder) === home;
    if (HOME_SYSTEM_FOLDERS.includes(first)) return "This folder holds app and system data.";
    if (direct && (STANDARD_HOME_FOLDERS.includes(first) || first.startsWith("."))) {
      return "This is one of your standard folders, not just this project.";
    }
  } else if (platform === "win32") {
    const first = folder.split(path.sep)[1] ?? "";
    if (WINDOWS_SYSTEM_FOLDERS.includes(first) || first === "users") {
      return "This is a system folder.";
    }
  } else {
    if (path.dirname(folder) === path.parse(folder).root) return "This is a system folder.";
    if (POSIX_SYSTEM_FOLDERS.some((system) => contains(fold(system), folder))) {
      return "This is a system folder.";
    }
    if (POSIX_MOUNT_PARENTS.some((parent) => path.dirname(folder) === fold(parent))) {
      return "This is a whole drive.";
    }
  }

  const data = fold(dataDir);
  if (
    contains(folder, data) ||
    contains(data, folder) ||
    runningFrom.some((own) => contains(folder, fold(own)))
  ) {
    return "This folder holds Solla Code itself or its data.";
  }
  for (const other of otherProjects) {
    const root = fold(other.workspaceRoot);
    if (contains(folder, root) || contains(root, folder)) {
      return `The project “${other.title}” uses this folder too.`;
    }
  }
  return null;
}

/** The command that hands a folder to this system's Trash, or null when it has none. */
export function trashCommand(input: {
  readonly platform: NodeJS.Platform;
  readonly folder: string;
  /** macOS 15 and later ship `/usr/bin/trash`; older ones go through Finder. */
  readonly hasMacTrashTool: boolean;
}): { readonly command: string; readonly args: ReadonlyArray<string> } | null {
  const { folder, platform } = input;
  if (platform === "darwin") {
    return input.hasMacTrashTool
      ? { command: "/usr/bin/trash", args: [folder] }
      : {
          command: "/usr/bin/osascript",
          args: [
            "-e",
            "on run argv",
            "-e",
            'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)',
            "-e",
            "end run",
            folder,
          ],
        };
  }
  if (platform === "win32") {
    const literal = folder.replaceAll("'", "''");
    const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${literal}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
    };
  }
  if (platform === "linux") return { command: "gio", args: ["trash", folder] };
  return null;
}

export class ProjectFolderRemoval extends Context.Service<
  ProjectFolderRemoval,
  {
    /** Whether a project's folder may go to the Trash, and why not when it may not. */
    readonly check: (input: {
      readonly project: { readonly id: string; readonly workspaceRoot: string };
      readonly otherProjects: ReadonlyArray<{
        readonly title: string;
        readonly workspaceRoot: string;
      }>;
    }) => Effect.Effect<ProjectFolderRemovalCheck>;
    /**
     * Hands the folder to the Trash. The project is already gone by now, so
     * this reports rather than fails: a folder that stays put is safe, and the
     * person is told. There is deliberately no fallback to deleting it outright.
     */
    readonly moveToTrash: (folder: string) => Effect.Effect<ProjectRemoveWithFolderResult>;
  }
>()("t3/project/ProjectFolderRemoval") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const config = yield* ServerConfig.ServerConfig;
  const runner = yield* ProcessRunner;
  const trashName = trashNameFor(platform);
  const resolved = (value: string) =>
    fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => value));

  const check: ProjectFolderRemoval["Service"]["check"] = Effect.fn("ProjectFolderRemoval.check")(
    function* ({ otherProjects, project }) {
      const answer = (reason: string | null): ProjectFolderRemovalCheck => ({
        workspaceRoot: project.workspaceRoot,
        removable: reason === null,
        reason,
        trashName,
      });
      if (isAgentsProjectId(project.id) || isOrchestratorProjectId(project.id)) {
        return answer("This folder belongs to Solla Code.");
      }
      const info = yield* fileSystem.stat(project.workspaceRoot).pipe(Effect.option);
      if (Option.isNone(info)) return answer("The folder is already gone.");
      if (info.value.type !== "Directory") return answer("This isn't a folder.");
      const link = yield* fileSystem.readLink(project.workspaceRoot).pipe(Effect.option);
      if (Option.isSome(link)) return answer("This is a link to a folder, not the folder itself.");

      return answer(
        folderRemovalRefusal({
          folder: yield* resolved(project.workspaceRoot),
          homeDir: yield* resolved(NodeOS.homedir()),
          dataDir: yield* resolved(config.baseDir),
          runningFrom: [yield* resolved(config.cwd), yield* resolved(process.execPath)],
          otherProjects: yield* Effect.forEach(otherProjects, (other) =>
            resolved(other.workspaceRoot).pipe(
              Effect.map((workspaceRoot) => ({ title: other.title, workspaceRoot })),
            ),
          ),
          platform,
        }),
      );
    },
  );

  const moveToTrash: ProjectFolderRemoval["Service"]["moveToTrash"] = Effect.fn(
    "ProjectFolderRemoval.moveToTrash",
  )(function* (folder) {
    const kept = (detail: string): ProjectRemoveWithFolderResult => ({
      folder: "kept",
      detail,
      trashName,
    });
    const hasMacTrashTool = yield* fileSystem
      .exists("/usr/bin/trash")
      .pipe(Effect.orElseSucceed(() => false));
    const command = trashCommand({ platform, folder, hasMacTrashTool });
    if (command === null) return kept(`This computer has no ${trashName} to move it to.`);

    const run = yield* runner
      .run({
        ...command,
        timeout: TRASH_TIMEOUT,
        timeoutBehavior: "timedOutResult",
        outputMode: "truncate",
      })
      .pipe(Effect.result);
    const stillThere = yield* fileSystem.exists(folder).pipe(Effect.orElseSucceed(() => true));
    if (!stillThere) return { folder: "trashed", detail: null, trashName };
    if (run._tag === "Failure") return kept(run.failure.message);
    if (run.success.timedOut) return kept(`Moving it to the ${trashName} took too long.`);
    return kept(run.success.stderr.trim().slice(0, 300) || `The ${trashName} didn't take it.`);
  });

  return ProjectFolderRemoval.of({ check, moveToTrash });
});

export const layer = Layer.effect(ProjectFolderRemoval, make);
