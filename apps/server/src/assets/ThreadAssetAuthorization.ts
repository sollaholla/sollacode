import type { OrchestrationMessage, OrchestrationThreadActivity } from "@t3tools/contracts";
import { isWorkspaceImagePreviewPath, readImageToolOutputPath } from "@t3tools/shared/filePreview";
import {
  normalizeEmbeddedWindowsAbsolutePath,
  normalizeProjectPathForComparison,
} from "@t3tools/shared/path";

// `savedPath` is where Codex writes an image it GENERATED (item.type
// "imageGeneration"), as opposed to `path` for one it merely viewed. Both
// arrive as itemType `image_view`, so leaving it out meant a generated image
// rendered as a bare "Image view" row with nothing to look at, while a viewed
// one rendered fine.
const READ_PATH_KEYS = [
  "path",
  "filePath",
  "file_path",
  "absolutePath",
  "absolute_path",
  "savedPath",
  "saved_path",
] as const;
const READ_NESTED_KEYS = ["input", "rawInput", "arguments", "item", "data", "files"] as const;
const DISALLOWED_READ_ITEM_TYPES = new Set([
  "command_execution",
  "collab_agent_tool_call",
  "web_search",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function addPathCandidates(candidates: Set<string>, value: unknown, depth = 0): void {
  if (depth > 4) return;
  if (Array.isArray(value)) {
    for (const entry of value) {
      addPathCandidates(candidates, entry, depth + 1);
    }
    return;
  }

  const record = asRecord(value);
  if (!record) return;
  for (const key of READ_PATH_KEYS) {
    const candidate = asTrimmedString(record[key]);
    if (candidate && isWorkspaceImagePreviewPath(candidate)) {
      candidates.add(candidate);
    }
  }
  for (const key of READ_NESTED_KEYS) {
    if (key in record) {
      addPathCandidates(candidates, record[key], depth + 1);
    }
  }
}

function normalizeComparablePath(value: string): string {
  return normalizeProjectPathForComparison(normalizeEmbeddedWindowsAbsolutePath(value));
}

function readInvocationPath(detail: string | null): string | null {
  if (!detail) return null;
  const match = /^\s*Read\s*:\s*(\{[\s\S]*\})\s*$/iu.exec(detail);
  if (!match?.[1]) return null;
  try {
    const input = asRecord(JSON.parse(match[1]) as unknown);
    for (const key of READ_PATH_KEYS) {
      const candidate = asTrimmedString(input?.[key]);
      if (candidate && isWorkspaceImagePreviewPath(candidate)) {
        return candidate;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function imagePathFromReadText(value: string | null): string | null {
  if (!value) return null;
  for (const line of value.split(/\r?\n/u)) {
    const candidate = line
      .trim()
      .replace(/^(?:image\s+view|view\s+image|read\s+image|read\s+file)\s*:?\s*/iu, "")
      .replace(/^["'`]|["'`]$/gu, "")
      .trim();
    if (candidate && isWorkspaceImagePreviewPath(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isReadImageActivity(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown>,
): boolean {
  const itemType = asTrimmedString(payload.itemType)?.toLowerCase() ?? "";
  if (DISALLOWED_READ_ITEM_TYPES.has(itemType)) return false;

  const data = asRecord(payload.data);
  const kind = asTrimmedString(data?.kind)?.toLowerCase();
  const title = asTrimmedString(payload.title);
  const detail = asTrimmedString(payload.detail);
  const normalizedTitle = (title ?? activity.summary).toLowerCase();
  return (
    payload.requestKind === "file-read" ||
    itemType === "image_view" ||
    kind === "read" ||
    kind === "view" ||
    normalizedTitle === "read" ||
    normalizedTitle.includes("read file") ||
    normalizedTitle.includes("view image") ||
    normalizedTitle.includes("image view") ||
    readImageToolOutputPath(payload) !== null ||
    readInvocationPath(detail) !== null ||
    imagePathFromReadText(title) !== null ||
    imagePathFromReadText(detail) !== null
  );
}

/**
 * External image previews are permitted only when the exact path came from the
 * exact read/image activity named by the client. This keeps the workspace-file
 * endpoint root-confined for every other caller while supporting providers
 * that represent image reads as dynamic tool calls.
 */
export function activityAuthorizesExternalImagePath(
  activity: OrchestrationThreadActivity,
  requestedPath: string,
): boolean {
  if (!activity.kind.startsWith("tool.") || !isWorkspaceImagePreviewPath(requestedPath)) {
    return false;
  }

  const payload = asRecord(activity.payload);
  if (!payload || !isReadImageActivity(activity, payload)) return false;

  const candidates = new Set<string>();
  addPathCandidates(candidates, payload);
  const outputImagePath = readImageToolOutputPath(payload);
  if (outputImagePath) candidates.add(outputImagePath);
  const titleImagePath = imagePathFromReadText(asTrimmedString(payload.title));
  if (titleImagePath) {
    candidates.add(titleImagePath);
  }
  const detail = asTrimmedString(payload.detail);
  const detailImagePath = imagePathFromReadText(detail);
  if (detailImagePath) {
    candidates.add(detailImagePath);
  }
  const invocationPath = readInvocationPath(detail);
  if (invocationPath) {
    candidates.add(invocationPath);
  }

  const requested = normalizeComparablePath(requestedPath);
  return [...candidates].some((candidate) => normalizeComparablePath(candidate) === requested);
}

function safeDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeMarkdownImageDestination(value: string): string | null {
  const unwrapped = value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
  const withoutPosition = unwrapped.split(/[?#]/u, 1)[0]?.trim() ?? "";
  if (withoutPosition.length === 0) return null;
  if (withoutPosition.toLowerCase().startsWith("file:")) {
    try {
      const parsed = new URL(withoutPosition);
      if (parsed.protocol.toLowerCase() !== "file:") return null;
      const decoded = safeDecodeUriComponent(parsed.pathname);
      return /^\/[A-Za-z]:[\\/]/u.test(decoded) ? decoded.slice(1) : decoded;
    } catch {
      return null;
    }
  }
  return safeDecodeUriComponent(withoutPosition);
}

/** Links and inline code that hold a path, decoded the way clients read them. */
function markdownPathReferences(markdown: string): ReadonlyArray<string> {
  const destinations: string[] = [];
  // One level of balanced parentheses is part of a CommonMark destination, which
  // is how a name like `Screenshot(3).png` is written.
  const linkPattern =
    /!?\[[^\]]*\]\(\s*(<[^>\r\n]+>|(?:[^\s()]|\([^\s()]*\))+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/gu;
  for (const match of markdown.matchAll(linkPattern)) {
    const destination = match[1] ? normalizeMarkdownImageDestination(match[1]) : null;
    if (destination) destinations.push(destination);
  }
  const inlineCodePattern = /(?<!`)`([^`\r\n]+)`(?!`)/gu;
  for (const match of markdown.matchAll(inlineCodePattern)) {
    const destination = match[1] ? normalizeMarkdownImageDestination(match[1].trim()) : null;
    if (destination) destinations.push(destination);
  }
  return destinations;
}

const LINE_SUFFIX_PATTERN = /:\d+(?::\d+)?$/u;
const WINDOWS_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\)/u;
// What may sit next to a path without being part of it. A name that merely starts
// the same way (`a.png.bak`) or a longer path ending the same way is another file.
const PATH_CHARACTER_PATTERN = /[\p{L}\p{N}_\-/\\~%+@]/u;

function textNamesExactPath(text: string, path: string): boolean {
  for (let at = text.indexOf(path); at >= 0; at = text.indexOf(path, at + 1)) {
    const before = text.slice(Math.max(0, at - 1), at);
    if (before === "." || (before !== "" && PATH_CHARACTER_PATTERN.test(before))) continue;
    const after = text.slice(at + path.length, at + path.length + 2);
    const continues = after.startsWith(".") ? after.slice(1) : after.slice(0, 1);
    if (continues !== "" && PATH_CHARACTER_PATTERN.test(continues.slice(0, 1))) continue;
    return true;
  }
  return false;
}

/** Whether the text names this absolute path as written: linked, in code, or plain. */
function messageTextNamesPath(
  text: string,
  requestedPath: string,
  homeDirectory: string | undefined,
): boolean {
  const requested = normalizeComparablePath(requestedPath);
  const expandHome = (candidate: string) =>
    homeDirectory !== undefined && /^~[\\/]/u.test(candidate)
      ? `${homeDirectory}/${candidate.slice(2)}`
      : candidate;
  const named = markdownPathReferences(text).some((reference) => {
    const candidate = expandHome(reference);
    return (
      normalizeComparablePath(candidate) === requested ||
      normalizeComparablePath(candidate.replace(LINE_SUFFIX_PATTERN, "")) === requested
    );
  });
  if (named) return true;

  const embedded = normalizeEmbeddedWindowsAbsolutePath(requestedPath);
  // Windows paths compare without regard to case or slash direction.
  const comparable = WINDOWS_PATH_PATTERN.test(embedded)
    ? (value: string) => value.replaceAll("\\", "/").toLowerCase()
    : (value: string) => value;
  const haystack = comparable(text.replaceAll("file://", ""));
  const absolute = comparable(embedded);
  if (textNamesExactPath(haystack, absolute)) return true;
  if (homeDirectory === undefined) return false;
  const home = comparable(homeDirectory).replace(/\/+$/u, "");
  return (
    absolute.startsWith(`${home}/`) &&
    textNamesExactPath(haystack, `~/${absolute.slice(home.length + 1)}`)
  );
}

/**
 * Remote clients may preview an absolute image path an assistant message names,
 * whether it links it, puts it in inline code, or writes it in plain text.
 * Authorization is scoped to the exact message and exact path so arbitrary files
 * adjacent to it remain inaccessible. `~/` means the home directory of the host
 * this runs on, which is the path clients resolve it to.
 */
export function messageAuthorizesExternalImagePath(
  message: OrchestrationMessage,
  requestedPath: string,
  homeDirectory?: string,
): boolean {
  return (
    isWorkspaceImagePreviewPath(requestedPath) &&
    messageAuthorizesExternalFilePath(message, requestedPath, homeDirectory)
  );
}

/**
 * The same rule for any file, behind the `thread-file` link. A person's own
 * message does not count: naming a path there must not be a way to read it.
 */
export function messageAuthorizesExternalFilePath(
  message: Pick<OrchestrationMessage, "role" | "text">,
  requestedPath: string,
  homeDirectory?: string,
): boolean {
  return (
    message.role === "assistant" && messageTextNamesPath(message.text, requestedPath, homeDirectory)
  );
}

/** A leading `~/` on a host path, as a message would write it and a client may send it. */
export function expandHostHomePath(path: string, homeDirectory: string): string {
  return /^~[\\/]/u.test(path) ? `${homeDirectory}/${path.slice(2)}` : path;
}

/**
 * Substrings that narrow a thread's messages before the exact check runs: the file
 * name as written and as a link encodes it. Lower-case because the search ignores
 * case, which Windows paths need.
 */
export function threadFileMentionTerms(path: string): ReadonlyArray<string> {
  const name = path.split(/[\\/]/u).at(-1) ?? path;
  return [...new Set([name, encodeURIComponent(name)].map((term) => term.toLowerCase()))];
}
