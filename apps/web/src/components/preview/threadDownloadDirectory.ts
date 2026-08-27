/**
 * Where a thread's browser downloads should land.
 *
 * An agent that fetches a file almost always wants to do something with it
 * next — convert it, upload it, commit it — and a file sitting in the app's
 * own artifacts folder is a file it has to go find first. Putting downloads
 * under the workspace the thread is actually working in means the very next
 * shell command can just use it.
 *
 * A `downloads` subfolder rather than the workspace root: the root is often a
 * git checkout, and dropping arbitrary fetched files straight into it turns
 * every download into untracked noise in the next `git status`.
 *
 * Returns `null` when the thread has no workspace, which is the signal to
 * leave the desktop's own fallback directory in place.
 */
export function resolveThreadDownloadDirectory(cwd: string | null | undefined): string | null {
  const trimmed = cwd?.trim() ?? "";
  if (trimmed.length === 0) return null;
  // The path belongs to the host the thread runs on, which may not be this
  // machine, so the separator is read from the path rather than assumed.
  const separator = /^[A-Za-z]:\\|^\\\\/u.test(trimmed) || trimmed.includes("\\") ? "\\" : "/";
  const withoutTrailing = trimmed.endsWith(separator)
    ? trimmed.slice(0, -separator.length)
    : trimmed;
  // A root path keeps its separator: "/" + "downloads", not "" + "downloads".
  const base = withoutTrailing.length > 0 ? withoutTrailing : separator;
  return base === separator ? `${separator}downloads` : `${base}${separator}downloads`;
}
