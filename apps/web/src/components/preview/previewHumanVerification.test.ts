import type { PreviewAutomationSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  clearPreviewHumanVerification,
  detectPreviewHumanVerification,
  getPreviewHumanVerification,
  inspectPreviewHumanVerification,
  parsePreviewHumanVerificationProbe,
  setPreviewHumanVerification,
} from "./previewHumanVerification";

const snapshot = (
  overrides: Partial<PreviewAutomationSnapshot> = {},
): PreviewAutomationSnapshot => ({
  url: "https://example.com/",
  title: "Example",
  loading: false,
  visibleText: "Welcome",
  interactiveElements: [],
  accessibilityTree: null,
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
  screenshot: {
    mimeType: "image/jpeg",
    data: "",
    width: 1280,
    height: 800,
  },
  ...overrides,
});

describe("preview human verification", () => {
  it("recognizes Cloudflare 600* failures without inventing a sub-code meaning", () => {
    const result = detectPreviewHumanVerification({
      snapshot: snapshot({
        title: "Verification failed",
        visibleText: "Cloudflare Turnstile error 600010. Please try again.",
      }),
      now: "2026-08-26T12:00:00.000Z",
    });

    expect(result).toMatchObject({
      kind: "bot-detection",
      code: "600010",
      detectedAt: "2026-08-26T12:00:00.000Z",
      retryCount: 0,
      diagnostic: {
        embeddedBrowser: true,
        automationAvailable: true,
        cdpAttached: true,
        challengesCloudflareReachable: null,
      },
    });
  });

  it("recognizes Cloudflare 300* challenge-family failures", () => {
    const result = detectPreviewHumanVerification({
      probe: {
        url: "https://example.com/",
        title: "Security verification",
        visibleText: "Cloudflare challenge failed with code 300030",
        browserUserAgent: null,
        hasTurnstile: true,
        hasFullPageChallenge: false,
      },
    });

    expect(result).toMatchObject({
      kind: "embedded-turnstile",
      code: "300030",
      retryCount: 0,
      retryAvailable: false,
    });
  });

  it("recognizes cf-mitigated challenge responses", () => {
    const result = detectPreviewHumanVerification({
      snapshot: snapshot({
        networkEntries: [
          {
            url: "https://example.com/",
            method: "GET",
            status: 200,
            failed: false,
            cfMitigated: true,
            timestamp: "2026-08-26T12:00:00.000Z",
          },
        ],
      }),
    });

    expect(result?.kind).toBe("full-page-challenge");
    expect(result?.diagnostic.cfMitigated).toBe(true);
    expect(result?.diagnostic.responseStatusCode).toBe(200);
    expect(result?.diagnostic.challengesCloudflareReachable).toBe(true);
  });

  it("recognizes a staged Turnstile widget and captures only visible diagnostics", () => {
    const result = detectPreviewHumanVerification({
      probe: {
        url: "https://suno.com/create",
        title: "Suno",
        visibleText: "Verify you are human — Cloudflare Ray ID: abcdef123456",
        browserUserAgent: "Mozilla/5.0 Chrome/140.0.0.0",
        hasTurnstile: true,
        hasFullPageChallenge: false,
      },
    });

    expect(result).toMatchObject({
      kind: "embedded-turnstile",
      code: null,
      diagnostic: {
        browserProduct: "Chrome",
        browserVersion: "140.0.0.0",
        browserUserAgent: "Mozilla/5.0 Chrome/140.0.0.0",
        rayId: "abcdef123456",
        cfMitigated: null,
      },
    });
  });

  it("does not classify ordinary mentions of verification as a challenge", () => {
    expect(
      detectPreviewHumanVerification({
        snapshot: snapshot({ visibleText: "Read our guide to user verification." }),
      }),
    ).toBeNull();
  });

  it("does not treat an unrelated six-digit number as a Cloudflare error", () => {
    expect(
      detectPreviewHumanVerification({
        snapshot: snapshot({ visibleText: "Order 600010 is ready for pickup." }),
      }),
    ).toBeNull();
  });

  it("keeps the original detection time while a tab remains blocked", () => {
    const tabId = "runtime-tab";
    clearPreviewHumanVerification(tabId);
    const first = detectPreviewHumanVerification({
      snapshot: snapshot({ visibleText: "Cloudflare Turnstile 600010" }),
      now: "2026-08-26T12:00:00.000Z",
    })!;
    const second = detectPreviewHumanVerification({
      snapshot: snapshot({ visibleText: "Cloudflare Turnstile 600010" }),
      now: "2026-08-26T12:05:00.000Z",
    })!;

    setPreviewHumanVerification(tabId, first);
    setPreviewHumanVerification(tabId, second);
    expect(getPreviewHumanVerification(tabId)?.detectedAt).toBe("2026-08-26T12:00:00.000Z");
    clearPreviewHumanVerification(tabId);
  });

  it("keeps automation gated until an explicit read-only re-check clears it", async () => {
    const tabId = "runtime-tab-recheck";
    clearPreviewHumanVerification(tabId);
    const challengeProbe = {
      url: "https://suno.com/create",
      title: "Verification failed",
      visibleText: "Cloudflare Turnstile 600010",
      browserUserAgent: "Mozilla/5.0 Chrome/140.0.0.0",
      hasTurnstile: true,
      hasFullPageChallenge: false,
    };
    let evaluations = 0;

    await inspectPreviewHumanVerification({
      runtimeTabId: tabId,
      evaluate: async () => {
        evaluations += 1;
        return challengeProbe;
      },
    });
    await inspectPreviewHumanVerification({
      runtimeTabId: tabId,
      evaluate: async () => {
        evaluations += 1;
        return { ...challengeProbe, visibleText: "Ready", hasTurnstile: false };
      },
    });
    expect(evaluations).toBe(1);
    expect(getPreviewHumanVerification(tabId)).not.toBeNull();

    const result = await inspectPreviewHumanVerification({
      runtimeTabId: tabId,
      force: true,
      evaluate: async () => ({
        ...challengeProbe,
        title: "Create",
        visibleText: "Ready",
        hasTurnstile: false,
      }),
    });
    expect(result).toBeNull();
    expect(getPreviewHumanVerification(tabId)).toBeNull();
  });

  it("rejects malformed DOM probe payloads", () => {
    expect(parsePreviewHumanVerificationProbe({ url: "https://example.com" })).toBeNull();
  });
});
