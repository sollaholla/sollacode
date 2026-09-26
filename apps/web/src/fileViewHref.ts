import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { fileViewPath } from "@t3tools/shared/fileView";

/**
 * The absolute viewer URL a chat file chip carries as its `href`.
 *
 * The chip's click is handled in-app, so this only matters to the browser
 * paths the handler never sees: Safari's long-press preview, "Open in New
 * Tab", a copied link. Those follow the `href` literally, and a raw
 * filesystem path resolved against the page origin was answering "Not Found"
 * from the SPA catch-all. Built against the environment's own HTTP base so a
 * phone connected over Tailscale gets a tailnet URL.
 */
export function fileViewHref(httpBaseUrl: string | null, absolutePath: string): string | null {
  if (httpBaseUrl === null) return null;
  const relative = fileViewPath(absolutePath);
  return relative === null ? null : resolveAssetUrl(httpBaseUrl, relative);
}
