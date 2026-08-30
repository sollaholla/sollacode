import { describe, expect, it, vi } from "vite-plus/test";

import {
  isEmbeddedOAuthRejected,
  openPreviewUrlInSystemBrowser,
  resolveEmbeddedOAuthHandoffUrl,
} from "./embeddedOAuth";

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

describe("resolveEmbeddedOAuthHandoffUrl", () => {
  it("opens the final destination instead of either stale sign-in wrapper", () => {
    const continueUrl =
      "https://www.youtube.com/signin?action_handle_signin=true&next=https%3A%2F%2Fstudio.youtube.com%2F";
    const rejectedUrl = new URL("https://accounts.google.com/v3/signin/rejected");
    rejectedUrl.searchParams.set("continue", continueUrl);

    expect(resolveEmbeddedOAuthHandoffUrl(rejectedUrl.toString())).toBe(
      "https://studio.youtube.com/",
    );
  });

  it("fails closed when no safe HTTPS continuation is available", () => {
    expect(
      resolveEmbeddedOAuthHandoffUrl("https://accounts.google.com/v3/signin/rejected"),
    ).toBeNull();
    expect(
      resolveEmbeddedOAuthHandoffUrl(
        "https://accounts.google.com/v3/signin/rejected?continue=javascript%3Aalert(1)",
      ),
    ).toBeNull();
    expect(
      resolveEmbeddedOAuthHandoffUrl(
        "https://accounts.google.com/v3/signin/rejected?continue=https%3A%2F%2Fevil.example%2Fphish",
      ),
    ).toBeNull();
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
