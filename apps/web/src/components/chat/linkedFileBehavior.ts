const REVEAL_IN_FILE_EXPLORER_EXTENSIONS = new Set([
  "a",
  "aab",
  "apk",
  "app",
  "bin",
  "class",
  "deb",
  "dll",
  "dmg",
  "dylib",
  "exe",
  "gz",
  "ipa",
  "iso",
  "jar",
  "lib",
  "msi",
  "o",
  "obj",
  "pkg",
  "pyc",
  "rar",
  "rpm",
  "so",
  "tar",
  "tgz",
  "war",
  "wasm",
  "xz",
  "zip",
  "7z",
]);

/**
 * Binary programs, packages, and archives cannot be represented by the text
 * file panel. On desktop, clicking one should locate the artifact instead of
 * opening a guaranteed-to-fail text preview.
 */
export function shouldRevealLinkedFileByDefault(filePath: string): boolean {
  const pathWithoutPosition = filePath
    .split(/[?#]/, 1)[0]
    ?.replace(/:\d+(?::\d+)?$/, "")
    .replace(/[\\/]+$/, "");
  const basename = pathWithoutPosition?.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  const extensionIndex = basename.lastIndexOf(".");
  if (extensionIndex < 0 || extensionIndex === basename.length - 1) return false;
  return REVEAL_IN_FILE_EXPLORER_EXTENSIONS.has(basename.slice(extensionIndex + 1));
}
