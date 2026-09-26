/**
 * The plain-HTTP file viewer: `GET /api/view/<absolute path>`.
 *
 * Chat file chips carry this as their real `href`, so a browser that follows
 * the link on its own — Safari's long-press preview, "Open in New Tab", a
 * copied link pasted into another tab — reaches a page the server actually
 * serves, instead of the raw filesystem path 404ing against the SPA shell.
 * The route answers with the file's bytes, or a listing when the path is a
 * folder. Authentication is the browser session cookie the app already holds,
 * which is what makes the same link work over Tailscale.
 *
 * Both sides of the wire share this module so the encoding cannot drift:
 * the web builds hrefs with {@link fileViewPath}, the server reads them back
 * with {@link decodeFileViewPath}.
 */
export const FILE_VIEW_ROUTE_PREFIX = "/api/view";

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

/**
 * Host-relative viewer URL for one absolute path, or null when the path is
 * not absolute (a relative path has no meaning outside the thread's cwd, and
 * a UNC share is not something the viewer serves).
 */
export function fileViewPath(absolutePath: string): string | null {
  const normalized = absolutePath.replaceAll("\\", "/");
  const isWindowsDrive = WINDOWS_DRIVE_PATH_PATTERN.test(absolutePath);
  if (!isWindowsDrive && !normalized.startsWith("/")) return null;
  if (normalized.startsWith("//")) return null;
  if (normalized.includes("\0")) return null;
  const segments = (isWindowsDrive ? normalized : normalized.slice(1)).split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return `${FILE_VIEW_ROUTE_PREFIX}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

/**
 * The absolute path a viewer request names, or null when the request is not
 * for this route or names something the viewer must not resolve: a relative
 * path, a traversal segment, an embedded NUL, or undecodable escapes.
 */
export function decodeFileViewPath(pathname: string): string | null {
  const prefix = `${FILE_VIEW_ROUTE_PREFIX}/`;
  if (!pathname.startsWith(prefix)) return null;
  const encoded = pathname.slice(prefix.length);
  if (encoded.length === 0) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  const isWindowsDrive = /^[A-Za-z]:$/.test(segments[0] ?? "");
  if (isWindowsDrive) {
    return segments.length === 1 ? `${segments[0]}/` : segments.join("/");
  }
  return `/${decoded}`;
}
