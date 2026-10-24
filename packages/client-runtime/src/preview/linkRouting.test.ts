import { describe, expect, it, vi } from "vite-plus/test";
import {
  openThreadUrl,
  resolveThreadArtifactLink,
  shouldOpenUrlInHostPreview,
} from "./linkRouting.ts";

describe("artifact link routing", () => {
  const route =
    "/c7aa9515-0f3f-4f89-ac5e-5c845c26263d/26d1fe19-752c-4a81-a866-4f7349a7daca?artifact=7fd8fde5-bbf7-475a-ab87-9949009abcb5";
  const known = ["c7aa9515-0f3f-4f89-ac5e-5c845c26263d", "another-host"];
  it.each([
    "",
    "https://solomans-macbook-pro.tail0b929e.ts.net",
    "http://localhost:3773",
    "http://192.168.1.2:3773",
  ])("resolves the registered environment through %s without depending on its origin", (origin) => {
    expect(resolveThreadArtifactLink(origin + route, known)).toEqual({
      environmentId: known[0],
      threadId: "26d1fe19-752c-4a81-a866-4f7349a7daca",
      artifactId: "7fd8fde5-bbf7-475a-ab87-9949009abcb5",
    });
  });
  it("decodes each route component and handles another registered environment", () => {
    expect(
      resolveThreadArtifactLink("/another-host/thread%2F1?artifact=artifact%20one", known),
    ).toEqual({
      environmentId: "another-host",
      threadId: "thread/1",
      artifactId: "artifact one",
    });
  });
  it.each([
    "/unknown/thread?artifact=a",
    "/another-host/thread",
    "/another-host/thread?artifact=",
    "/another-host/thread?artifact=a&artifact=b",
    "/another-host/thread/extra?artifact=a",
    "/another-host/%ZZ?artifact=a",
    "/another-host/thread?artifact=%00",
    "/another-host/thread?artifact=%20a",
    "/another-host/thread?artifact=" + "a".repeat(129),
    "#artifact=a",
    "https://example.com/?artifact=a",
    "https://example.com/docs/page?artifact=a",
    "file:///another-host/thread?artifact=a",
    "javascript:alert(1)",
    "https://user:password@example.com/another-host/thread?artifact=a",
  ])("leaves unrelated or malformed links alone: %s", (url) => {
    expect(resolveThreadArtifactLink(url, known)).toBeNull();
  });
});

describe("remote host link routing", () => {
  it.each([
    "http://localhost:5173/path?token=example#section",
    "http://app.localhost/",
    "http://127.1:3000/",
    "http://0.0.0.0:8080/",
    "http://10.0.0.5/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.10:8080/",
    "http://169.254.1.2/",
    "http://macbook.local/",
    "http://server/",
    "http://router.home.arpa/",
    "http://[::1]:3000/",
    "http://[fd12::1]/",
    "http://[fe80::1]/",
    "http://100.64.0.1/",
    "https://host.tail123.ts.net/",
  ])("opens %s on the host only for remote clients", (url) => {
    expect(shouldOpenUrlInHostPreview(url, true)).toBe(true);
    expect(shouldOpenUrlInHostPreview(url, false)).toBe(false);
  });
  it.each([
    "https://example.com/",
    "http://172.32.0.1/",
    "https://localhost.example.com/",
    "http://8.8.8.8/",
    "https://[2606:4700:4700::1111]/",
    "mailto:me@example.com",
    "file:///tmp/file.html",
    "#section",
    "javascript:alert(1)",
    "not a url",
  ])("leaves %s to its existing handler", (url) => {
    expect(shouldOpenUrlInHostPreview(url, true)).toBe(false);
  });
  it("preserves the complete LAN URL and never falls back to the device when preview fails", async () => {
    const url = "http://192.168.1.10:3000/page?token=example#part";
    const cause = new Error("Host unavailable");
    const openInPreview = vi.fn().mockRejectedValue(cause);
    const openExternally = vi.fn();
    await expect(
      openThreadUrl({ url, isRemoteClient: true, openInPreview, openExternally }),
    ).rejects.toBe(cause);
    expect(openInPreview).toHaveBeenCalledExactlyOnceWith(url);
    expect(openExternally).not.toHaveBeenCalled();
  });
  it.each([
    { url: "https://example.com/", isRemoteClient: true },
    { url: "http://localhost:3000/", isRemoteClient: false },
  ])("preserves ordinary browser behavior for $url (remote=$isRemoteClient)", async (input) => {
    const openInPreview = vi.fn();
    const openExternally = vi.fn();
    await openThreadUrl({ ...input, openInPreview, openExternally });
    expect(openExternally).toHaveBeenCalledExactlyOnceWith(input.url);
    expect(openInPreview).not.toHaveBeenCalled();
  });
});
