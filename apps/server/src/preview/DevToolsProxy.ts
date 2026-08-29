/**
 * Loopback is the whole security model here, so nothing in this module ever
 * builds a URL pointing anywhere else. The endpoint a guest's host reports is
 * on that host's own loopback interface, and this server runs on that same
 * machine — the broker hands preview work to the host that owns the
 * environment, which is where the server is.
 */
const DEVTOOLS_HOST = "127.0.0.1";

/**
 * Chromium target ids are hex-ish opaque strings. Constraining them is not
 * cosmetic: the id is interpolated into a URL path, so anything able to carry
 * a slash or a query could aim the proxy at a different endpoint entirely.
 */
const TARGET_ID = /^[A-Za-z0-9]{8,256}$/;

export function isDevToolsTargetId(targetId: string): boolean {
  return TARGET_ID.test(targetId);
}

/**
 * The CDP socket for exactly one target.
 *
 * Callers never name a target themselves — the host vouches for the one that
 * is this guest — and a malformed id yields no URL at all rather than a URL
 * somewhere unintended.
 */
export function devToolsCdpUrl(endpoint: {
  readonly port: number;
  readonly targetId: string;
}): string | null {
  if (!Number.isInteger(endpoint.port) || endpoint.port <= 0 || endpoint.port > 65_535) return null;
  if (!isDevToolsTargetId(endpoint.targetId)) return null;
  return `ws://${DEVTOOLS_HOST}:${endpoint.port}/devtools/page/${endpoint.targetId}`;
}

/**
 * A frontend asset, and only a frontend asset.
 *
 * The same endpoint serves `/json`, which lists every target the browser has
 * open — including the app's own windows. Proxying that would hand out the
 * target ids this module exists to withhold, so only `/devtools/**` is
 * reachable, and never through a traversal.
 */
export function devToolsAssetUrl(port: number, assetPath: string): string | null {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  const normalized = assetPath.startsWith("/") ? assetPath : `/${assetPath}`;
  const [pathOnly] = normalized.split("?");
  if (pathOnly === undefined) return null;
  if (!pathOnly.startsWith("/devtools/")) return null;
  // `..` in any form, and the encoded spellings a normalizing proxy would
  // otherwise resolve after this check.
  if (pathOnly.includes("..") || /%2e/i.test(pathOnly)) return null;
  if (pathOnly.includes("//")) return null;
  return `http://${DEVTOOLS_HOST}:${port}${normalized}`;
}
