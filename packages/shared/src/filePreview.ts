export const WORKSPACE_BROWSER_PREVIEW_EXTENSIONS = [".htm", ".html", ".pdf"] as const;

export const WORKSPACE_IMAGE_PREVIEW_EXTENSIONS = [
  ".avif",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
] as const;

/**
 * Video containers a browser `<video>` element can actually decode.
 *
 * Deliberately not "every video format": playback is the browser's codec
 * support, not ours, and listing `.mkv` or `.avi` here would only trade a
 * useful "open in your player" for a black rectangle that never plays. The
 * formats below are the ones Chromium and WebKit decode natively.
 *
 * `.mov` is the judgement call. QuickTime is a container, so an H.264/AAC
 * `.mov` - what a Mac screen recording and an iPhone camera both produce -
 * plays everywhere, while a ProRes one cannot. It is included because the
 * common case dominates on the platforms this app runs on, and the element's
 * own error event catches the rest: anything that fails to decode falls back
 * to opening in the system player, so a wrong guess costs one click, never a
 * dead end.
 */
export const WORKSPACE_VIDEO_PREVIEW_EXTENSIONS = [
  ".m4v",
  ".mov",
  ".mp4",
  ".ogv",
  ".webm",
] as const;

export const WORKSPACE_AUDIO_PREVIEW_EXTENSIONS = [
  ".wav",
  ".mp3",
  ".m4a",
  ".aac",
  ".ogg",
  ".flac",
] as const;
const AUDIO_MIME_TYPES: Readonly<Record<string, string>> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
};
export function isWorkspaceAudioPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_AUDIO_PREVIEW_EXTENSIONS);
}
export function workspaceAudioMimeType(path: string): string | null {
  const normalized = normalizedPreviewPath(path);
  return (
    Object.entries(AUDIO_MIME_TYPES).find(([extension]) => normalized.endsWith(extension))?.[1] ??
    null
  );
}

export const WORKSPACE_PDF_PREVIEW_EXTENSIONS = [".pdf"] as const;

/** MIME type for a previewable video, so the `<source>` hint matches the file. */
const VIDEO_MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".ogv": "video/ogg",
  ".webm": "video/webm",
};

function normalizedPreviewPath(path: string): string {
  return path.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
}

function hasPreviewExtension(path: string, extensions: ReadonlyArray<string>): boolean {
  const pathWithoutQuery = normalizedPreviewPath(path);
  return extensions.some((extension) => pathWithoutQuery.endsWith(extension));
}

export function isWorkspaceBrowserPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_BROWSER_PREVIEW_EXTENSIONS);
}

export function isWorkspaceImagePreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_IMAGE_PREVIEW_EXTENSIONS);
}

export function isWorkspaceVideoPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_VIDEO_PREVIEW_EXTENSIONS);
}

export function isWorkspacePdfPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_PDF_PREVIEW_EXTENSIONS);
}

export function workspaceVideoMimeType(path: string): string | null {
  const pathWithoutQuery = normalizedPreviewPath(path);
  for (const [extension, mimeType] of Object.entries(VIDEO_MIME_TYPE_BY_EXTENSION)) {
    if (pathWithoutQuery.endsWith(extension)) return mimeType;
  }
  return null;
}

export function isWorkspacePreviewEntryPath(path: string): boolean {
  return isWorkspaceBrowserPreviewPath(path) || isWorkspaceImagePreviewPath(path);
}

/**
 * Whether the file panel can render this itself, rather than falling back to
 * the system's default application.
 *
 * The panel's own text view handles everything else it can decode as text, so
 * this covers only the media types with a dedicated element behind them.
 */
export function isWorkspaceMediaPreviewPath(path: string): boolean {
  return (
    isWorkspaceImagePreviewPath(path) ||
    isWorkspaceVideoPreviewPath(path) ||
    isWorkspaceAudioPreviewPath(path) ||
    isWorkspacePdfPreviewPath(path)
  );
}

/** Recovers the explicit image-read receipt emitted by Muse, including saved historical rows. */
export function readImageToolOutputPath(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (
    record.itemType !== "dynamic_tool_call" &&
    record.itemType !== "mcp_tool_call" &&
    record.itemType !== "image_view"
  )
    return null;
  const data =
    record.data !== null && typeof record.data === "object" && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : null;
  const detail = typeof record.detail === "string" ? record.detail.trim() : "";
  // Deep Code stores the full path in params; older started receipts only
  // retain the display detail. Neither includes the ReadImage label in the path.
  const deepCodePath =
    data?.toolName === "ReadImage" && typeof data.params === "string"
      ? data.params.trim()
      : /^ReadImage:\s*([^\r\n]+)$/u.exec(detail)?.[1]?.trim();
  const match =
    /^Read image file `([^`\r\n]+)` as model-visible image output\.\r?\nmedia_type: image\/(?:png|jpeg|gif|webp|avif|x-icon|vnd\.microsoft\.icon)\r?\nsource_bytes: \d+\s*$/u.exec(
      detail,
    );
  const path = deepCodePath ?? match?.[1];
  if (!path || !/\.(?:avif|gif|ico|jpe?g|png|webp)$/iu.test(path)) return null;
  // Browser URLs and file URLs are not workspace paths. Windows drive paths are.
  if (/^[a-z][a-z\d+.-]*:/iu.test(path) && !/^[a-z]:[\\/]/iu.test(path)) return null;
  return path;
}

/**
 * Raster types accepted from a tool result's inline image data.
 *
 * SVG is deliberately absent: the inline copy is rendered from a `data:` URL
 * we did not author, and an `<img>`-embedded SVG is the one raster-shaped
 * format that can carry markup.
 */
const INLINE_TOOL_IMAGE_MEDIA_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/**
 * A base64 payload longer than this is left alone. A read image is ~200 KB of
 * base64; the cap only excludes the pathological row that would otherwise put
 * megabytes of string into a DOM attribute.
 */
const INLINE_TOOL_IMAGE_MAX_BASE64_CHARS = 8_000_000;

const BASE64_PATTERN = /^[A-Za-z0-9+/\s]+={0,2}$/u;

function inlineImageFromContentBlock(block: Record<string, unknown>): string | null {
  const source =
    block.source !== null && typeof block.source === "object" && !Array.isArray(block.source)
      ? (block.source as Record<string, unknown>)
      : block;
  const mediaType = [source.media_type, source.mediaType, source.mimeType, source.mime_type].find(
    (value): value is string => typeof value === "string",
  );
  const data = typeof source.data === "string" ? source.data : null;
  if (!mediaType || data === null) return null;
  const normalizedMediaType = mediaType.trim().toLowerCase();
  if (!INLINE_TOOL_IMAGE_MEDIA_TYPES.has(normalizedMediaType)) return null;
  const normalizedData = data.trim();
  if (normalizedData.length === 0 || normalizedData.length > INLINE_TOOL_IMAGE_MAX_BASE64_CHARS) {
    return null;
  }
  if (!BASE64_PATTERN.test(normalizedData)) return null;
  return `data:${normalizedMediaType};base64,${normalizedData.replace(/\s+/gu, "")}`;
}

/**
 * The image a read tool actually returned, as a `data:` URL, or null.
 *
 * Providers hand the model the image bytes inline — Anthropic as
 * `{type: "image", source: {type: "base64", media_type, data}}`, MCP and ACP
 * as `{type: "image", mimeType, data}` — and the activity keeps that copy. It
 * is the only surviving record once the file behind the path is rewritten or
 * deleted, which is routine for tools that shoot into a scratch directory, so
 * the timeline falls back to it rather than showing an empty frame for an
 * image the agent plainly saw.
 */
export function inlineToolImageDataUrl(payload: unknown): string | null {
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number): string | null => {
    if (depth > 6 || value === null || typeof value !== "object") return null;
    if (seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = walk(entry, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const record = value as Record<string, unknown>;
    if (record.type === "image" || record.type === "image_url") {
      const found = inlineImageFromContentBlock(record);
      if (found) return found;
    }
    for (const entry of Object.values(record)) {
      const found = walk(entry, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(payload, 0);
}
