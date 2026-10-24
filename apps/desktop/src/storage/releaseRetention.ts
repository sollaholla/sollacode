// @effect-diagnostics nodeBuiltinImport:off - Detached installer filesystem work.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const MIN_AGE_MS = 24 * 60 * 60 * 1_000;
const KEEP_RELEASES = 5;
const RELEASE_NAME = /^Solla-Code-(\d+)\.(\d+)\.(\d+)-(arm64|x64)\.(zip|dmg|exe|AppImage)$/;

export interface ReleaseFile {
  readonly name: string;
  readonly bytes: number;
  readonly modifiedAtMs: number;
}

/** Keep five releases per architecture/format, plus the artifact just installed. */
export function planReleaseCleanup(
  files: ReadonlyArray<ReleaseFile>,
  installedName: string,
  nowMs: number,
) {
  const groups = new Map<string, Array<ReleaseFile & { version: number[] }>>();
  for (const file of files) {
    const match = RELEASE_NAME.exec(file.name);
    if (!match) continue;
    const group = `${match[4]}.${match[5]}`;
    const entries = groups.get(group) ?? [];
    entries.push({ ...file, version: [Number(match[1]), Number(match[2]), Number(match[3])] });
    groups.set(group, entries);
  }
  return [...groups.values()].flatMap((entries) =>
    entries
      .toSorted(
        (a, b) =>
          b.version[0]! - a.version[0]! ||
          b.version[1]! - a.version[1]! ||
          b.version[2]! - a.version[2]!,
      )
      .slice(KEEP_RELEASES)
      .filter((entry) => entry.name !== installedName && entry.modifiedAtMs <= nowMs - MIN_AGE_MS),
  );
}

export async function cleanupReleaseArtifacts(input: {
  readonly artifactPath: string;
  readonly nowMs: number;
  readonly isEnabled: () => Promise<boolean>;
  /** A fresh process/open-file inventory. Unknown inventory must throw, never return empty. */
  readonly openPaths: () => Promise<ReadonlySet<string>>;
}) {
  const removed: Array<{ path: string; bytes: number }> = [];
  if (!RELEASE_NAME.test(NodePath.basename(input.artifactPath)) || !(await input.isEnabled()))
    return removed;
  const directory = await NodeFSP.realpath(NodePath.dirname(input.artifactPath));
  const files: Array<ReleaseFile> = [];
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !RELEASE_NAME.test(entry.name)) continue;
    const info = await NodeFSP.lstat(NodePath.join(directory, entry.name));
    files.push({ name: entry.name, bytes: info.size, modifiedAtMs: info.mtimeMs });
  }
  for (const candidate of planReleaseCleanup(
    files,
    NodePath.basename(input.artifactPath),
    input.nowMs,
  )) {
    if (!(await input.isEnabled())) break;
    const open = await input.openPaths();
    const path = NodePath.join(directory, candidate.name);
    const matchingOpenPaths = [...open].filter(
      (entry) =>
        NodePath.basename(entry) === candidate.name ||
        NodePath.basename(entry) === `${candidate.name}.blockmap`,
    );
    const canonicalOpenPaths = await Promise.all(
      matchingOpenPaths.map((entry) => NodeFSP.realpath(entry).catch(() => entry)),
    );
    if (canonicalOpenPaths.includes(path) || canonicalOpenPaths.includes(`${path}.blockmap`))
      continue;
    const info = await NodeFSP.lstat(path);
    if (!info.isFile() || info.size !== candidate.bytes || info.mtimeMs !== candidate.modifiedAtMs)
      continue;
    await NodeFSP.unlink(path);
    removed.push({ path, bytes: info.size });
    const blockmap = await NodeFSP.lstat(`${path}.blockmap`).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (blockmap?.isFile() && blockmap.mtimeMs <= input.nowMs - MIN_AGE_MS) {
      await NodeFSP.unlink(`${path}.blockmap`);
      removed.push({ path: `${path}.blockmap`, bytes: blockmap.size });
    }
  }
  return removed;
}
