import type { ProjectEntry } from "@t3tools/contracts";

/**
 * The direct children of one workspace folder, from the flat project listing.
 *
 * The listing is the same index the file explorer draws from, so it already
 * honours ignore rules; this only narrows it to one level. Folders sort
 * first, then names in natural order, which is what a listing page looks
 * like everywhere else.
 */
export function directChildEntries(
  entries: ReadonlyArray<ProjectEntry>,
  folderRelativePath: string,
): ProjectEntry[] {
  const prefix = folderRelativePath.replace(/\/+$/, "");
  const children = new Map<string, ProjectEntry>();
  for (const entry of entries) {
    const path = entry.path.replace(/\/+$/, "");
    if (prefix.length > 0 && !path.startsWith(`${prefix}/`)) continue;
    const rest = prefix.length > 0 ? path.slice(prefix.length + 1) : path;
    if (rest.length === 0) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      children.set(path, entry);
      continue;
    }
    // A deeper entry implies its ancestor folder even when the index did not
    // list the folder itself.
    const childPath =
      prefix.length > 0 ? `${prefix}/${rest.slice(0, slash)}` : rest.slice(0, slash);
    if (!children.has(childPath)) {
      children.set(childPath, { path: childPath, kind: "directory" });
    }
  }
  const rank = (entry: ProjectEntry) => (entry.kind === "directory" ? 0 : 1);
  return [...children.values()].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      entryName(a.path).localeCompare(entryName(b.path), undefined, { numeric: true }),
  );
}

export function entryName(relativePath: string): string {
  const trimmed = relativePath.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

export function parentFolderPath(relativePath: string): string | null {
  const trimmed = relativePath.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  if (slash === -1) return trimmed.length > 0 ? "" : null;
  return trimmed.slice(0, slash);
}
