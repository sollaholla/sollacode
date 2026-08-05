import { describe, expect, it } from "vite-plus/test";

import indexHtml from "../index.html?raw";

describe("static boot shell recovery", () => {
  it("retries a stuck boot once with a cache-busting URL", () => {
    expect(indexHtml).toContain("const BOOT_TIMEOUT_MS = 8000;");
    expect(indexHtml).toContain('const RETRY_QUERY_KEY = "solla_boot_retry";');
    expect(indexHtml).toContain('window.sessionStorage.setItem(RETRY_STORAGE_KEY, "attempted")');
    expect(indexHtml).toContain("window.location.replace(url.toString())");
  });

  it("stops retrying and offers an explicit retry if boot remains stuck", () => {
    expect(indexHtml).toContain("if (alreadyRetried)");
    expect(indexHtml).toContain('status.textContent = "Solla Code did not finish loading.";');
    expect(indexHtml).toContain('retry.textContent = "Retry";');
    expect(indexHtml).toContain('retry.addEventListener("click", retryWithFreshShell)');
  });

  it("clears the retry marker after the app replaces the static shell", () => {
    expect(indexHtml).toContain('const appBooted = () => !document.getElementById("boot-shell")');
    expect(indexHtml).toContain("observer.disconnect()");
    expect(indexHtml).toContain("removeRetryMarker()");
  });
});
