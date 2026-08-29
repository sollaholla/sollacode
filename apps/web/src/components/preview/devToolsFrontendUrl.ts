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
/**
 * The ticket the RPC socket is already using.
 *
 * Reusing it avoids minting a second credential for the same session, and it
 * is the only kind an iframe or a WebSocket can carry at all.
 */
export function devToolsTicketFromSocketUrl(socketUrl: string): string | null {
  try {
    const ticket = new URL(socketUrl).searchParams.get("wsTicket");
    return ticket !== null && ticket.length > 0 ? ticket : null;
  } catch {
    return null;
  }
}

export function devToolsFrontendUrl(input: {
  readonly httpBaseUrl: string;
  readonly threadId: string;
  readonly tabId: string;
  readonly ticket: string;
}): string | null {
  let base: URL;
  try {
    base = new URL(input.httpBaseUrl);
  } catch {
    return null;
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") return null;

  const target = new URLSearchParams({
    threadId: input.threadId,
    tabId: input.tabId,
    wsTicket: input.ticket,
  });
  // `host` carries the port; the frontend derives ws:// or wss:// from how it
  // was itself served, which is why the scheme is deliberately absent here.
  const socket = `${base.host}${base.pathname.replace(/\/$/, "")}/preview/devtools/cdp?${target.toString()}`;

  const frontend = new URL(
    `${base.origin}${base.pathname.replace(/\/$/, "")}/preview/devtools/inspector.html`,
  );
  frontend.search = target.toString();
  frontend.searchParams.set("ws", socket);
  return frontend.toString();
}
