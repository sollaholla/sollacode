import { FILE_VIEW_ROUTE_PREFIX, fileViewPath } from "@t3tools/shared/fileView";

/**
 * What the plain-HTTP file viewer answers with; see `@t3tools/shared/fileView`
 * for the URL shape and `fileViewRouteLayer` in `http.ts` for the route.
 *
 * Everything here is pure so it can be tested without a filesystem: the route
 * gathers the directory entries and the sniffed bytes, this module decides how
 * they are presented.
 */

export interface FileViewDirectoryEntry {
  readonly name: string;
  readonly kind: "directory" | "file" | "other";
  /** Bytes for a file; null for anything else or when stat failed. */
  readonly size: number | null;
}

/**
 * Source and config extensions the MIME table either does not know or knows
 * as something else entirely (`.ts` is MPEG transport stream to it). The
 * viewer's job is to show these as text.
 */
const TEXT_EXTENSIONS = new Set([
  "bash",
  "c",
  "cc",
  "cfg",
  "cjs",
  "clj",
  "conf",
  "cpp",
  "cs",
  "css",
  "csv",
  "cts",
  "dart",
  "diff",
  "el",
  "env",
  "erl",
  "ex",
  "exs",
  "fish",
  "go",
  "gradle",
  "graphql",
  "h",
  "hpp",
  "hs",
  "htm",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "json5",
  "jsonc",
  "jsonl",
  "jsx",
  "kt",
  "kts",
  "less",
  "lock",
  "log",
  "lua",
  "m",
  "makefile",
  "markdown",
  "md",
  "mdx",
  "mjs",
  "mk",
  "mts",
  "ndjson",
  "nix",
  "patch",
  "php",
  "pl",
  "plist",
  "proto",
  "ps1",
  "py",
  "pyi",
  "r",
  "rb",
  "rs",
  "sass",
  "scala",
  "scss",
  "sh",
  "sql",
  "svelte",
  "svg",
  "swift",
  "tex",
  "text",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zig",
  "zsh",
]);

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/javascript",
  "application/x-javascript",
  "application/xml",
  "application/x-sh",
  "application/x-shellscript",
  "application/toml",
  "application/x-yaml",
  "application/yaml",
  "image/svg+xml",
]);

export const FILE_VIEW_TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";

/**
 * The content type the viewer serves a file with.
 *
 * Text is always served as `text/plain`: the viewer sits on the app's own
 * origin behind the session cookie, so a workspace HTML or SVG file must
 * never render as a document here. Media keeps its type so the browser can
 * play or paginate it inline; anything else is offered as a download.
 * `looksBinary` is the caller's NUL-byte sniff of the file's head, which is
 * what decides extension-less and unknown files.
 */
export function fileViewContentType(input: {
  readonly fileName: string;
  readonly mimeType: string | null;
  readonly looksBinary: boolean;
}): string {
  const lowerName = input.fileName.toLowerCase();
  const dotIndex = lowerName.lastIndexOf(".");
  const extension = dotIndex >= 0 ? lowerName.slice(dotIndex + 1) : lowerName;
  if (TEXT_EXTENSIONS.has(extension) || lowerName.startsWith(".")) {
    return FILE_VIEW_TEXT_CONTENT_TYPE;
  }
  const mime = input.mimeType?.split(";")[0]?.trim().toLowerCase() ?? null;
  if (mime !== null && (mime.startsWith("text/") || TEXT_MIME_TYPES.has(mime))) {
    return FILE_VIEW_TEXT_CONTENT_TYPE;
  }
  if (
    mime !== null &&
    (mime.startsWith("image/") ||
      mime.startsWith("video/") ||
      mime.startsWith("audio/") ||
      mime === "application/pdf")
  ) {
    return mime;
  }
  if (!input.looksBinary) return FILE_VIEW_TEXT_CONTENT_TYPE;
  return "application/octet-stream";
}

/** `Content-Disposition: inline` with the name usable by every browser. */
export function fileViewContentDisposition(fileName: string): string {
  const ascii = fileName.replaceAll(/[^\x20-\x7e]/g, "_").replaceAll('"', "'");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * Headers shared by every viewer response. The sandbox keeps a served file
 * from ever running as same-origin content even if a content type slipped;
 * no-store because the file on disk may change under the link.
 */
export const FILE_VIEW_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export const FILE_VIEW_PAGE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value).toString()} ${units[unit]}`;
}

function splitAbsolutePath(path: string): { readonly root: string; readonly segments: string[] } {
  const normalized = path.replaceAll("\\", "/");
  const driveMatch = /^([A-Za-z]:)\/?/.exec(normalized);
  if (driveMatch) {
    const rest = normalized.slice(driveMatch[0].length);
    return { root: `${driveMatch[1]}/`, segments: rest.split("/").filter((s) => s.length > 0) };
  }
  return { root: "/", segments: normalized.split("/").filter((s) => s.length > 0) };
}

function joinPath(root: string, segments: ReadonlyArray<string>): string {
  return `${root}${segments.join("/")}`;
}

/** Parent folder of an absolute path, or null at a filesystem root. */
export function fileViewParentPath(path: string): string | null {
  const { root, segments } = splitAbsolutePath(path);
  if (segments.length === 0) return null;
  return joinPath(root, segments.slice(0, -1));
}

export function sortFileViewEntries(
  entries: ReadonlyArray<FileViewDirectoryEntry>,
): FileViewDirectoryEntry[] {
  const rank = (entry: FileViewDirectoryEntry) => (entry.kind === "directory" ? 0 : 1);
  return [...entries].sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
}

const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 20px 16px 40px; font: 14px/1.5 -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif; background: #fff; color: #1a1a1a; }
  @media (prefers-color-scheme: dark) { body { background: #0e0e10; color: #e8e8ea; } }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 14px; word-break: break-all; }
  h1 a { color: inherit; text-decoration: none; }
  h1 a:hover { text-decoration: underline; }
  h1 .sep { opacity: .45; padding: 0 3px; }
  ul { list-style: none; margin: 0; padding: 0; border-top: 1px solid rgba(128,128,128,.25); }
  li { border-bottom: 1px solid rgba(128,128,128,.25); }
  li a { display: flex; align-items: baseline; gap: 12px; padding: 9px 4px; color: inherit; text-decoration: none; }
  li a:hover { background: rgba(128,128,128,.12); }
  .name { flex: 1; min-width: 0; word-break: break-all; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13px; }
  .dir .name::after { content: "/"; opacity: .55; }
  .size { flex: none; font-variant-numeric: tabular-nums; opacity: .6; font-size: 12px; }
  .empty { padding: 24px 4px; opacity: .6; }
  .note { margin-top: 14px; font-size: 12px; opacity: .6; }
`;

/**
 * The folder page. Every entry links back into the viewer, the heading is a
 * breadcrumb that does the same for each ancestor, so a phone can walk the
 * tree from a single chat link.
 */
export function renderFileViewDirectoryPage(input: {
  readonly path: string;
  readonly entries: ReadonlyArray<FileViewDirectoryEntry>;
}): string {
  const { root, segments } = splitAbsolutePath(input.path);
  const crumbs: string[] = [];
  const rootHref = fileViewPath(root);
  crumbs.push(
    rootHref ? `<a href="${escapeHtml(rootHref)}">${escapeHtml(root)}</a>` : escapeHtml(root),
  );
  segments.forEach((segment, index) => {
    const href = fileViewPath(joinPath(root, segments.slice(0, index + 1)));
    const label = escapeHtml(segment);
    crumbs.push(href ? `<a href="${escapeHtml(href)}">${label}</a>` : label);
  });
  const heading = crumbs
    .join('<span class="sep">/</span>')
    .replace(`${escapeHtml(root)}</a><span class="sep">/</span>`, `${escapeHtml(root)}</a>`);

  const rows: string[] = [];
  const parent = fileViewParentPath(input.path);
  if (parent !== null) {
    const parentHref = fileViewPath(parent);
    if (parentHref) {
      rows.push(
        `<li class="dir"><a href="${escapeHtml(parentHref)}"><span class="name">..</span></a></li>`,
      );
    }
  }
  for (const entry of sortFileViewEntries(input.entries)) {
    const href = fileViewPath(joinPath(root, [...segments, entry.name]));
    if (!href) continue;
    const size = entry.kind === "file" && entry.size !== null ? formatSize(entry.size) : "";
    rows.push(
      `<li class="${entry.kind === "directory" ? "dir" : "file"}"><a href="${escapeHtml(href)}"><span class="name">${escapeHtml(entry.name)}</span><span class="size">${escapeHtml(size)}</span></a></li>`,
    );
  }
  const body =
    rows.length > 0 ? `<ul>${rows.join("")}</ul>` : `<p class="empty">This folder is empty.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(input.path)}</title><style>${PAGE_STYLE}</style></head><body><h1>${heading}</h1>${body}<p class="note">Served by Solla Code from ${escapeHtml(input.path)}.</p></body></html>`;
}

/** The page a signed-out browser gets instead of the file. */
export function renderFileViewSignInPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in to Solla Code</title><style>${PAGE_STYLE}</style></head><body><h1>Sign in to Solla Code first</h1><p>This link shows a file from the Solla Code workspace. Open Solla Code in this browser, sign in, and then open the link again.</p><p class="note">Route: ${escapeHtml(FILE_VIEW_ROUTE_PREFIX)}</p></body></html>`;
}
