import { describe, expect, it } from "vite-plus/test";

import { downloadDomain, resolveDownloadApproval } from "./downloadApproval.ts";

describe("downloadDomain", () => {
  it("attributes a download to its host", () => {
    expect(downloadDomain("https://grok.com/files/a.mp4")).toBe("grok.com");
  });

  it("lower-cases so a remembered answer is not case-sensitive", () => {
    expect(downloadDomain("https://Grok.COM/a.bin")).toBe("grok.com");
  });

  it("returns nothing attributable for a URL it cannot parse", () => {
    expect(downloadDomain("not a url")).toBe("");
    expect(downloadDomain("")).toBe("");
  });
});

describe("resolveDownloadApproval", () => {
  const none = { allowedDomains: new Set<string>(), oneTimeGrant: null };

  it("asks the first time a domain wants to write a file", () => {
    expect(resolveDownloadApproval({ domain: "grok.com", ...none })).toBe("ask");
  });

  it("remembers a domain the user allowed", () => {
    expect(
      resolveDownloadApproval({
        domain: "grok.com",
        allowedDomains: new Set(["grok.com"]),
        oneTimeGrant: null,
      }),
    ).toBe("allowed");
  });

  it("honours a one-time grant for that domain only", () => {
    expect(
      resolveDownloadApproval({
        domain: "grok.com",
        allowedDomains: new Set(),
        oneTimeGrant: "grok.com",
      }),
    ).toBe("allowed");
    expect(
      resolveDownloadApproval({
        domain: "evil.test",
        allowedDomains: new Set(),
        oneTimeGrant: "grok.com",
      }),
    ).toBe("ask");
  });

  it("always asks when the download cannot be attributed to a domain", () => {
    // An unattributable download is the kind that must not ride in on a
    // remembered answer.
    expect(
      resolveDownloadApproval({ domain: "", allowedDomains: new Set([""]), oneTimeGrant: "" }),
    ).toBe("ask");
  });
});
