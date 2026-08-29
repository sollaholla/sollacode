import { describe, expect, it } from "vite-plus/test";

import { devToolsFrontendUrl } from "./devToolsFrontendUrl";

const base = {
  threadId: "thread-1",
  tabId: "tab-1",
  pageOrigin: "http://192.168.1.5:3773",
} as const;

describe("devToolsFrontendUrl", () => {
  it("loads the frontend from this server and points it back through it", () => {
    const url = devToolsFrontendUrl({ ...base, httpBaseUrl: "http://192.168.1.5:3773" });
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.origin).toBe("http://192.168.1.5:3773");
    // The guest is named in the path so the frontend's relative asset requests
    // inherit it, and by thread and tab rather than by a target the caller
    // picked.
    expect(parsed.pathname).toBe("/preview/devtools/thread-1/tab-1/inspector.html");
    // The frontend wants host/path with no scheme.
    expect(parsed.searchParams.get("ws")).toBe(
      "192.168.1.5:3773/preview/devtools/thread-1/tab-1/cdp",
    );
  });

  it("escapes a guest whose identifiers would otherwise reshape the path", () => {
    const url = devToolsFrontendUrl({
      ...base,
      httpBaseUrl: "http://192.168.1.5:3773",
      threadId: "../../json",
      tabId: "a/b",
    });
    const parsed = new URL(url!);
    expect(parsed.pathname).toBe("/preview/devtools/..%2F..%2Fjson/a%2Fb/inspector.html");
  });

  it("refuses a base that is not somewhere this server can be", () => {
    for (const httpBaseUrl of ["", "not a url", "ftp://example.com", "javascript:alert(1)"]) {
      expect(devToolsFrontendUrl({ ...base, httpBaseUrl })).toBeNull();
    }
  });

  it("follows the cookie to another port on the same host", () => {
    // Desktop dev bakes the backend at a different port than the page it
    // serves, and the session cookie ignores ports.
    const url = devToolsFrontendUrl({
      ...base,
      httpBaseUrl: "http://127.0.0.1:13779",
      pageOrigin: "http://127.0.0.1:5739",
    });
    expect(url).not.toBeNull();
    expect(new URL(url!).origin).toBe("http://127.0.0.1:13779");
  });

  it("reports no DevTools where the cookie cannot follow", () => {
    for (const [httpBaseUrl, why] of [
      ["http://other.example", "another host"],
      // An https page framing http is blocked as mixed content long before
      // authentication matters.
      ["http://app.example", "a scheme downgrade"],
    ] as const) {
      expect(
        devToolsFrontendUrl({ ...base, httpBaseUrl, pageOrigin: "https://app.example" }),
        why,
      ).toBeNull();
    }
    expect(
      devToolsFrontendUrl({ ...base, httpBaseUrl: "http://app.example", pageOrigin: null }),
    ).toBeNull();
  });
});
