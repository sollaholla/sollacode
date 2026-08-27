import { describe, expect, it } from "vite-plus/test";

import {
  downloadDomain,
  resolveDownloadApproval,
  resolveDownloadApprovalEffects,
} from "./downloadApproval.ts";

describe("downloadDomain", () => {
  it("attributes a download to its host", () => {
    expect(downloadDomain("https://grok.com/files/a.mp4")).toBe("grok.com");
  });

  it("lower-cases so a remembered answer is not case-sensitive", () => {
    expect(downloadDomain("https://Grok.COM/a.bin")).toBe("grok.com");
  });

  it("unwraps the blob URL most sites actually download through", () => {
    // `new URL("blob:https://grok.com/x").hostname` is empty, so without this
    // every generated-in-the-page download is unattributable and "Allow for
    // this domain" is permanently greyed out.
    expect(downloadDomain("blob:https://grok.com/6f1e-42")).toBe("grok.com");
  });

  it("falls back to the page for a genuinely hostless download", () => {
    expect(downloadDomain("data:text/plain;base64,AAA", "https://grok.com/chat")).toBe("grok.com");
    expect(downloadDomain("blob:null/6f1e-42", "https://grok.com/chat")).toBe("grok.com");
  });

  it("prefers the download's own host over the page it was started from", () => {
    expect(downloadDomain("https://cdn.grok.com/a.mp4", "https://grok.com/chat")).toBe(
      "cdn.grok.com",
    );
  });

  it("returns nothing attributable for a URL it cannot parse", () => {
    expect(downloadDomain("not a url")).toBe("");
    expect(downloadDomain("")).toBe("");
    expect(downloadDomain("data:text/plain;base64,AAA", "also not a url")).toBe("");
  });
});

describe("resolveDownloadApproval", () => {
  it("asks the first time a domain wants to write a file", () => {
    expect(resolveDownloadApproval({ domain: "grok.com", allowedDomains: new Set() })).toBe("ask");
  });

  it("remembers a domain the user allowed", () => {
    expect(
      resolveDownloadApproval({ domain: "grok.com", allowedDomains: new Set(["grok.com"]) }),
    ).toBe("allowed");
  });

  it("does not let one allowed domain speak for another", () => {
    expect(
      resolveDownloadApproval({ domain: "evil.test", allowedDomains: new Set(["grok.com"]) }),
    ).toBe("ask");
  });

  it("always asks when the download cannot be attributed to a domain", () => {
    // An unattributable download is the kind that must not ride in on a
    // remembered answer, even one that literally matches.
    expect(resolveDownloadApproval({ domain: "", allowedDomains: new Set([""]) })).toBe("ask");
  });
});

describe("resolveDownloadApprovalEffects", () => {
  it("keeps the file and the domain when the site is allowed", () => {
    expect(resolveDownloadApprovalEffects("allow-domain")).toEqual({
      keepFile: true,
      rememberDomain: true,
    });
  });

  it("spends an allow-once on the file alone", () => {
    expect(resolveDownloadApprovalEffects("allow-once")).toEqual({
      keepFile: true,
      rememberDomain: false,
    });
  });

  it("keeps nothing on a denial", () => {
    expect(resolveDownloadApprovalEffects("deny")).toEqual({
      keepFile: false,
      rememberDomain: false,
    });
  });
});
