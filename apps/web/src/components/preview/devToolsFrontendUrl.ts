/**
 * Where the viewer loads Chromium's DevTools frontend from, and how it tells
 * that frontend to reach the guest.
 *
 * Both halves go through this server: the frontend is proxied from the browser
 * that owns the guest so its version matches the protocol it speaks, and the
 * CDP socket is proxied so the guest's endpoint never leaves its own loopback.
 * The frontend takes its socket as `ws=host/path` with no scheme, which is why
 * this strips one off rather than passing a whole URL through.
 */
import { DEVTOOLS_ROUTE_PREFIX } from "@t3tools/shared/preview";

/**
 * Whether the session cookie will reach this server from this page.
 *
 * Neither a framed document nor a WebSocket can carry an Authorization header,
 * so the cookie is the only credential either half of DevTools has. The cookie
 * is host-scoped and set without a Domain, which is a narrower rule than same
 * origin in one direction and wider in another: the port is irrelevant, but a
 * different host — or an http target framed by an https page, which the browser
 * blocks as mixed content — gets nothing.
 */
function carriesSessionCookie(base: URL, pageOrigin: string | null): boolean {
  if (pageOrigin === null) return false;
  let page: URL;
  try {
    page = new URL(pageOrigin);
  } catch {
    return false;
  }
  return base.hostname === page.hostname && base.protocol === page.protocol;
}

export function devToolsFrontendUrl(input: {
  readonly httpBaseUrl: string;
  readonly threadId: string;
  readonly tabId: string;
  readonly pageOrigin: string | null;
}): string | null {
  let base: URL;
  try {
    base = new URL(input.httpBaseUrl);
  } catch {
    return null;
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") return null;

  // Somewhere the cookie cannot follow would load an iframe that 401s, so
  // report no DevTools rather than showing one that cannot connect.
  if (!carriesSessionCookie(base, input.pageOrigin)) return null;

  // The guest rides in the path, not the query: Chromium's frontend references
  // its own assets relatively, so a query string is gone by the second request
  // while a path prefix is inherited by every one of them.
  const root = `${base.pathname.replace(/\/$/, "")}${DEVTOOLS_ROUTE_PREFIX}/${encodeURIComponent(input.threadId)}/${encodeURIComponent(input.tabId)}`;

  const frontend = new URL(`${base.origin}${root}/inspector.html`);
  // `host` carries the port; the frontend derives ws:// or wss:// from how it
  // was itself served, which is why the scheme is deliberately absent here.
  frontend.searchParams.set("ws", `${base.host}${root}/cdp`);
  return frontend.toString();
}
