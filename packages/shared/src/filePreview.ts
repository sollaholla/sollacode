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

function rasterFilePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim();
  if (
    ["\r", "\n", String.fromCharCode(0)].some((character) => path.includes(character)) ||
    !/\.(?:avif|gif|ico|jpe?g|png|webp)$/iu.test(path)
  )
    return null;
  // Browser URLs and file URLs are not workspace paths. Windows drive paths are.
  if (/^[a-z][a-z\d+.-]*:/iu.test(path) && !/^[a-z]:[\\/]/iu.test(path)) return null;
  return path;
}

/** Reads both provider image items and the compact file list sent to clients. */
function structuredImageViewPath(value: unknown, depth = 0): string | null {
  if (depth > 4 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 12)) {
      const path = structuredImageViewPath(entry, depth + 1);
      if (path) return path;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of [
    "path",
    "filePath",
    "file_path",
    "absolutePath",
    "absolute_path",
    "savedPath",
    "saved_path",
  ]) {
    const path = rasterFilePath(record[key]);
    if (path) return path;
  }
  for (const key of ["item", "input", "rawInput", "arguments", "files", "data"]) {
    const path = structuredImageViewPath(record[key], depth + 1);
    if (path) return path;
  }
  return null;
}

/** Recovers image-view paths and explicit image-read receipts, including saved historical rows. */
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
  if (record.itemType === "image_view") {
    const path = structuredImageViewPath(data);
    if (path) return path;
  }
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
  return rasterFilePath(
    deepCodePath ?? match?.[1] ?? (record.itemType === "image_view" ? detail : null),
  );
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
  const compactData = normalizedData.replace(/\s+/gu, "");
  if (!inlineImageIsComplete(normalizedMediaType, compactData)) return null;
  return `data:${normalizedMediaType};base64,${compactData}`;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** The last bytes of a base64 string, without decoding the rest of it. */
function base64TailBytes(base64: string, quads: number): number[] {
  const tail = base64.slice(-4 * quads);
  const bytes: number[] = [];
  for (let index = 0; index < tail.length; index += 4) {
    const values = Array.from(tail.slice(index, index + 4), (char) =>
      char === "=" ? 0 : BASE64_ALPHABET.indexOf(char),
    );
    const padding = tail.slice(index, index + 4).split("=").length - 1;
    const word =
      ((values[0] ?? 0) << 18) |
      ((values[1] ?? 0) << 12) |
      ((values[2] ?? 0) << 6) |
      (values[3] ?? 0);
    bytes.push((word >> 16) & 0xff, (word >> 8) & 0xff, word & 0xff);
    if (padding > 0) bytes.splice(bytes.length - padding, padding);
  }
  return bytes;
}

/**
 * Whether a JPEG or PNG still has its end marker. A copy cut short by a
 * payload cap decodes as the top of the picture over grey, which reads as a
 * broken page rather than a missing preview, so it does not count as an image.
 */
function inlineImageIsComplete(mediaType: string, base64: string): boolean {
  if (mediaType !== "image/jpeg" && mediaType !== "image/png") return true;
  if (base64.length % 4 !== 0) return false;
  const tail = base64TailBytes(base64, 3);
  if (mediaType === "image/jpeg") {
    return tail.at(-2) === 0xff && tail.at(-1) === 0xd9;
  }
  // IEND chunk type and its fixed CRC.
  return [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82].every(
    (byte, index) => tail[tail.length - 8 + index] === byte,
  );
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
  if (payload === null || typeof payload !== "object") return null;
  // Activities are immutable and every timeline update re-derives every row,
  // so remember each payload's answer instead of re-validating and copying
  // tens of kilobytes of base64 per image row on each pass.
  const cached = inlineToolImageCache.get(payload);
  if (cached !== undefined) return cached;
  const found = findInlineToolImage(payload);
  inlineToolImageCache.set(payload, found);
  return found;
}

const inlineToolImageCache = new WeakMap<object, string | null>();

function findInlineToolImage(payload: object): string | null {
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

/** `t3-code · preview_snapshot`, `mcp__t3-code__preview_snapshot`, `preview_snapshot`. */
const PREVIEW_SNAPSHOT_TOOL_NAME = /(?:^|[\s·:/_.-])preview_snapshot$/u;

/**
 * Whether a tool activity is a `preview_snapshot` call, however a provider
 * spells it: the activity summary, Claude's tool name, or a Codex MCP item.
 */
export function isPreviewSnapshotToolCall(payload: unknown, summary?: string): boolean {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  const data =
    record.data !== null && typeof record.data === "object" && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : null;
  const item =
    data?.item !== null && typeof data?.item === "object" && !Array.isArray(data?.item)
      ? (data.item as Record<string, unknown>)
      : null;
  return [summary, record.title, data?.toolName, item?.tool].some(
    (name) => typeof name === "string" && PREVIEW_SNAPSHOT_TOOL_NAME.test(name.trim()),
  );
}

export type PreviewSnapshotImage =
  | { readonly kind: "attachment"; readonly attachmentId: string }
  | { readonly kind: "inline"; readonly src: string };

function snapshotImageAttachmentId(payload: object): string | null {
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number): string | null => {
    if (depth > 6 || value === null || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    const record = value as Record<string, unknown>;
    if (
      !Array.isArray(value) &&
      record.type === "image" &&
      typeof record.attachmentId === "string"
    ) {
      return record.attachmentId;
    }
    for (const entry of entries) {
      const found = walk(entry, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(payload, 0);
}

/**
 * The page a `preview_snapshot` call captured, or null for any other tool.
 * A snapshot is the browser view the agent acted on, so its row shows the
 * picture the way a read-image row does. The server stores the picture as an
 * attachment and leaves its id in the result; rows saved before that carry
 * the bytes inline, and only a complete copy counts.
 */
export function previewSnapshotImage(
  payload: unknown,
  summary?: string,
): PreviewSnapshotImage | null {
  if (!isPreviewSnapshotToolCall(payload, summary)) return null;
  const attachmentId = snapshotImageAttachmentId(payload as object);
  if (attachmentId) return { kind: "attachment", attachmentId };
  const src = inlineToolImageDataUrl(payload);
  return src ? { kind: "inline", src } : null;
}
