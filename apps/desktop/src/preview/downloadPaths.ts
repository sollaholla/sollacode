/**
 * Turns a server-supplied download name into something safe to write.
 *
 * `DownloadItem.getFilename()` comes from the remote `Content-Disposition`, so
 * it is untrusted: it can carry path separators, traversal segments, or
 * characters a filesystem will not take. Everything but the final component is
 * discarded, so a hostile name lands beside the other downloads rather than
 * anywhere it chose.
 */
export function resolveDownloadFileName(rawName: string): string {
  const finalComponent = rawName.split(/[\\/]/u).pop() ?? "";
  // Built by scanning rather than by regex: a character class covering the
  // control range is exactly what `no-control-regex` exists to stop, and this
  // says the same thing more plainly.
  const ILLEGAL = '<>:"|?*';
  const cleaned = [...finalComponent]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f || ILLEGAL.includes(character) ? "_" : character;
    })
    .join("")
    // A leading dot would hide the file, and "." / ".." are not names at all.
    .replace(/^\.+/u, "")
    .trim();
  // Long enough for any real name, short enough for every filesystem's limit.
  const bounded = cleaned.slice(0, 180).trim();
  return bounded.length > 0 ? bounded : "download";
}

/**
 * Picks a name that does not overwrite an existing download.
 *
 * Downloads land without asking, so silently replacing a file the user or an
 * agent already has would destroy work with no prompt to catch it. Numbering
 * matches what a browser does: `report.pdf`, `report (1).pdf`, and so on.
 */
export function resolveUniqueDownloadPath(input: {
  readonly directory: string;
  readonly fileName: string;
  readonly join: (directory: string, fileName: string) => string;
  readonly exists: (path: string) => boolean;
}): string {
  const direct = input.join(input.directory, input.fileName);
  if (!input.exists(direct)) return direct;

  const dot = input.fileName.lastIndexOf(".");
  // A leading dot is part of the name, not an extension separator.
  const hasExtension = dot > 0;
  const stem = hasExtension ? input.fileName.slice(0, dot) : input.fileName;
  const extension = hasExtension ? input.fileName.slice(dot) : "";

  // Bounded so a directory that always reports "exists" cannot spin forever.
  for (let attempt = 1; attempt < 1_000; attempt += 1) {
    const candidate = input.join(input.directory, `${stem} (${attempt})${extension}`);
    if (!input.exists(candidate)) return candidate;
  }
  return direct;
}
