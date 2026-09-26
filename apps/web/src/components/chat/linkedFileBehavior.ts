import { isWorkspaceMediaPreviewPath } from "@t3tools/shared/filePreview";

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

export type LinkedFilePrimaryAction =
  | "image"
  | "browser"
  | "reveal"
  | "preview"
  | "editor"
  /** Hand the file to whatever application the OS has registered for it. */
  | "default-app";

export function resolveLinkedFilePrimaryAction(input: {
  readonly filePath: string;
  readonly workspaceRelativePath: string | null;
  readonly hasImageAction: boolean;
  readonly hasBrowserAction: boolean;
  readonly canRevealOnThisDevice: boolean;
  readonly canOpenInDefaultApp?: boolean;
}): LinkedFilePrimaryAction {
  if (input.hasImageAction) return "image";
  if (input.workspaceRelativePath === null) {
    return input.canRevealOnThisDevice ? "reveal" : "editor";
  }
  // Stays ahead of the media check: on desktop a PDF has an integrated-browser
  // action and that remains the better reader. The runtime offers it only where
  // it works, so a phone falls through to the panel below.
  if (input.hasBrowserAction) return "browser";
  // Video, audio, and PDF render in the panel now, so they are no longer
  // "binary" in the sense that matters here. This has to precede the reveal
  // table, which still lists mp4/mov/webm (and mp3/wav) from when nothing
  // could display them - and which sent a phone, where revealing is
  // impossible, down an editor branch that quietly did nothing. That was the
  // reported dead click.
  if (isWorkspaceMediaPreviewPath(input.filePath)) return "preview";
  if (shouldRevealLinkedFileByDefault(input.filePath)) {
    // Opening beats locating: the user asked for the file, not for its folder.
    if (input.canOpenInDefaultApp === true) return "default-app";
    if (input.canRevealOnThisDevice) return "reveal";
    // Neither is possible - a phone, or a path in another environment. The
    // panel cannot render it either, but it CAN name the file and say why,
    // which is the difference between a dead click and an answer.
    return "preview";
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

/**
 * What to do when this computer's filesystem could not produce the file.
 *
 * `revealFile` and `openPath` both answer for the LOCAL machine, and both
 * report plain failure when the path is not on it. A Solla workspace often is
 * not: a remote environment, WSL, or a worktree all put the file somewhere this
 * desktop cannot see. Telling the user "the file no longer exists on this
 * computer" was therefore wrong as often as it was right, and it ended the
 * click in a toast - which is what the owner reported as "sometimes it says
 * the file is not found".
 *
 * The panel reads through the environment that actually owns the file, so it
 * is the better next move whenever the thread gives us one.
 */
export function resolveLocalFileFallback(input: {
  readonly hasThreadRef: boolean;
  readonly workspaceRelativePath: string | null;
}): "preview" | "report" {
  return input.hasThreadRef && input.workspaceRelativePath !== null ? "preview" : "report";
}
