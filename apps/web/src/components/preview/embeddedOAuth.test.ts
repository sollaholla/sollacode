import { describe, expect, it, vi } from "vite-plus/test";

import { isEmbeddedOAuthRejected, openPreviewUrlInSystemBrowser } from "./embeddedOAuth";

describe("isEmbeddedOAuthRejected", () => {
  it("recognizes Google's embedded-browser rejection page", () => {
    expect(
      isEmbeddedOAuthRejected(
        "https://accounts.google.com/v3/signin/rejected?flowEntry=ServiceLogin&service=youtube",
      ),
    ).toBe(true);
    expect(isEmbeddedOAuthRejected("https://accounts.google.com/v3/signin/identifier")).toBe(false);
    expect(isEmbeddedOAuthRejected("https://example.com/signin/rejected")).toBe(false);
  });
});

describe("openPreviewUrlInSystemBrowser", () => {
  it("uses the desktop shell when it is available", () => {
    const openNative = vi.fn(async () => true);
    const openWeb = vi.fn();

    openPreviewUrlInSystemBrowser({ url: "https://example.com/", openNative, openWeb });

    expect(openNative).toHaveBeenCalledWith("https://example.com/");
    expect(openWeb).not.toHaveBeenCalled();
  });

  it("opens a new browser tab for remote and mobile viewers", () => {
    const openWeb = vi.fn();

    openPreviewUrlInSystemBrowser({ url: "https://example.com/", openWeb });

    expect(openWeb).toHaveBeenCalledWith("https://example.com/");
  });
});
