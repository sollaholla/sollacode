import type { OrchestrationMessage, OrchestrationThreadActivity } from "@t3tools/contracts";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import {
  normalizeEmbeddedWindowsAbsolutePath,
  normalizeProjectPathForComparison,
} from "@t3tools/shared/path";

const READ_PATH_KEYS = ["path", "filePath", "file_path", "absolutePath", "absolute_path"] as const;
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

function assistantImageReferences(markdown: string): ReadonlyArray<string> {
  const destinations: string[] = [];
  const linkPattern = /!?\[[^\]]*\]\(\s*(<[^>\r\n]+>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/gu;
  for (const match of markdown.matchAll(linkPattern)) {
    const destination = match[1] ? normalizeMarkdownImageDestination(match[1]) : null;
    if (destination && isWorkspaceImagePreviewPath(destination)) {
      destinations.push(destination);
    }
  }
  const inlineCodePattern = /(?<!`)`([^`\r\n]+)`(?!`)/gu;
  for (const match of markdown.matchAll(inlineCodePattern)) {
    const destination = match[1] ? normalizeMarkdownImageDestination(match[1].trim()) : null;
    if (destination && isWorkspaceImagePreviewPath(destination)) {
      destinations.push(destination);
    }
  }
  return destinations;
}

/**
 * Remote clients may preview an absolute image path linked by an assistant
 * message. Authorization is scoped to the exact message and exact linked or
 * inline-code destination so arbitrary files adjacent to it remain inaccessible.
 */
export function messageAuthorizesExternalImagePath(
  message: OrchestrationMessage,
  requestedPath: string,
): boolean {
  if (message.role !== "assistant" || !isWorkspaceImagePreviewPath(requestedPath)) {
    return false;
  }
  const requested = normalizeComparablePath(requestedPath);
  return assistantImageReferences(message.text).some(
    (candidate) => normalizeComparablePath(candidate) === requested,
  );
}
