import { describe, expect, it } from "vite-plus/test";

import { devToolsFrontendUrl, devToolsTicketFromSocketUrl } from "./devToolsFrontendUrl";

const base = {
  threadId: "thread-1",
  tabId: "tab-1",
  ticket: "ticket-abc",
} as const;

describe("devToolsFrontendUrl", () => {
  it("loads the frontend from this server and points it back through it", () => {
    const url = devToolsFrontendUrl({ ...base, httpBaseUrl: "http://192.168.1.5:3773" });
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.origin).toBe("http://192.168.1.5:3773");
    expect(parsed.pathname).toBe("/preview/devtools/inspector.html");
    // The frontend wants host/path with no scheme, and the guest is named by
    // thread and tab rather than by a target the caller picked.
    expect(parsed.searchParams.get("ws")).toBe(
      "192.168.1.5:3773/preview/devtools/cdp?threadId=thread-1&tabId=tab-1&wsTicket=ticket-abc",
    );
    expect(parsed.searchParams.get("wsTicket")).toBe("ticket-abc");
  });

  it("refuses a base that is not somewhere this server can be", () => {
    for (const httpBaseUrl of ["", "not a url", "ftp://example.com", "javascript:alert(1)"]) {
      expect(devToolsFrontendUrl({ ...base, httpBaseUrl })).toBeNull();
    }
  });
});

describe("devToolsTicketFromSocketUrl", () => {
  it("reuses the ticket the RPC socket already carries", () => {
    expect(devToolsTicketFromSocketUrl("wss://env.example/ws?wsTicket=abc123")).toBe("abc123");
  });

  it("reports no ticket rather than an empty one", () => {
    for (const socketUrl of ["wss://env.example/ws", "wss://env.example/ws?wsTicket=", "nope"]) {
      expect(devToolsTicketFromSocketUrl(socketUrl)).toBeNull();
    }
  });
});
