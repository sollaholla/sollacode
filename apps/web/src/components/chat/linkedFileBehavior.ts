import { resolveMarkdownFileLinkTarget } from "../../markdown-links";
import { resolvePathLinkTarget } from "../../terminal-links";

const REVEAL_IN_FILE_EXPLORER_EXTENSIONS = new Set([
  "a",
  "aab",
  "aac",
  "aiff",
  "apk",
  "app",
  "avi",
  "bin",
  "class",
  "deb",
  "dll",
  "dmg",
  "doc",
  "docx",
  "dylib",
  "exe",
  "flac",
  "gz",
  "ipa",
  "iso",
  "jar",
  "lib",
  "m4a",
  "m4v",
  "mkv",
  "mov",
  "mp3",
  "mp4",
  "mpeg",
  "mpg",
  "msi",
  "o",
  "obj",
  "ogg",
  "opus",
  "pkg",
  "ppt",
  "pptx",
  "pyc",
  "rar",
  "rpm",
  "so",
  "tar",
  "tgz",
  "wav",
  "war",
  "wasm",
  "webm",
  "wma",
  "wmv",
  "xls",
  "xlsx",
  "xz",
  "zip",
  "7z",
]);

/**
 * Media, office documents, programs, packages, and archives cannot be
 * represented by the text file panel. On desktop, clicking one should locate
 * the file instead of opening a guaranteed-to-fail text preview.
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

export type LinkedFilePrimaryAction = "image" | "browser" | "reveal" | "preview" | "editor";

export function resolveLinkedFilePrimaryAction(input: {
  readonly filePath: string;
  readonly workspaceRelativePath: string | null;
  readonly hasImageAction: boolean;
  readonly hasBrowserAction: boolean;
  readonly canRevealOnThisDevice: boolean;
}): LinkedFilePrimaryAction {
  if (input.hasImageAction) return "image";
  if (input.workspaceRelativePath === null) {
    return input.canRevealOnThisDevice ? "reveal" : "editor";
  }
  if (input.hasBrowserAction) return "browser";
  if (shouldRevealLinkedFileByDefault(input.filePath)) {
    // Binary/media files must never enter the text preview. If the path belongs
    // to another environment, let that environment's editor integration own it
    // instead of asking this desktop's Finder/Explorer to reveal a foreign path.
    return input.canRevealOnThisDevice ? "reveal" : "editor";
  }
  return "preview";
}

export function resolveLinkedFileAbsolutePath(
  filePath: string,
  workspaceRoot: string | undefined,
): string | null {
  return workspaceRoot
    ? resolvePathLinkTarget(filePath, workspaceRoot)
    : resolveMarkdownFileLinkTarget(filePath);
}
