import { describe, expect, it } from "vite-plus/test";

import {
  DOWNLOAD_ALLOWLIST_VERSION,
  downloadDomain,
  parseDownloadAllowlist,
  registrableDomain,
  resolveDownloadApproval,
  resolveDownloadApprovalEffects,
  serializeDownloadAllowlist,
} from "./downloadApproval.ts";

describe("downloadDomain", () => {
  it("attributes a download to its own site when no page speaks for it", () => {
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

  it("attributes a CDN download to the site that started it, not the CDN", () => {
    // The reported bug: allowing the file's own host answered for that host
    // alone, so the next file — from another CDN node, or another subdomain —
    // asked all over again.
    expect(downloadDomain("https://cdn1.suno.ai/track.mp3", "https://suno.com/song/1")).toBe(
      "suno.com",
    );
    expect(downloadDomain("https://audiopipe.suno.ai/x.mp3", "https://studio.suno.com/a")).toBe(
      "suno.com",
    );
  });

  it("collapses a site's own subdomains onto one answer", () => {
    expect(downloadDomain("https://cdn.grok.com/a.mp4", "https://grok.com/chat")).toBe("grok.com");
    expect(downloadDomain("https://cdn1.grok.com/a.mp4")).toBe("grok.com");
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

describe("registrableDomain", () => {
  it("collapses subdomains onto the site that owns them", () => {
    expect(registrableDomain("cdn1.suno.ai")).toBe("suno.ai");
    expect(registrableDomain("a.b.c.example.com")).toBe("example.com");
    expect(registrableDomain("example.com")).toBe("example.com");
  });

  it("keeps a multi-tenant suffix's tenants apart", () => {
    // One answer must never speak for every tailnet, or every GitHub page.
    expect(registrableDomain("mac.tail1234.ts.net")).toBe("tail1234.ts.net");
    expect(registrableDomain("someone.github.io")).toBe("someone.github.io");
    expect(registrableDomain("shop.example.co.uk")).toBe("example.co.uk");
  });

  it("leaves addresses and single labels whole", () => {
    expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
    expect(registrableDomain("[::1]")).toBe("[::1]");
    expect(registrableDomain("localhost")).toBe("localhost");
    expect(registrableDomain("")).toBe("");
  });

  it("normalises case and a trailing root dot", () => {
    expect(registrableDomain("CDN1.Suno.AI.")).toBe("suno.ai");
  });
});

describe("download allowlist file", () => {
  it("round-trips the remembered sites", () => {
    const raw = serializeDownloadAllowlist(["grok.com", "suno.com"]);
    expect(parseDownloadAllowlist(raw)).toEqual(["grok.com", "suno.com"]);
  });

  it("writes a stable, sorted, versioned document", () => {
    expect(JSON.parse(serializeDownloadAllowlist(["suno.com", "grok.com", "grok.com"]))).toEqual({
      version: DOWNLOAD_ALLOWLIST_VERSION,
      domains: ["grok.com", "suno.com"],
    });
  });

  it("normalises stored entries onto their site", () => {
    // A hand-edited or older file may hold a bare host; it still has to line
    // up with the domain a download is attributed to.
    const raw = JSON.stringify({ version: 1, domains: ["CDN1.Suno.AI.", "", 42, null] });
    expect(parseDownloadAllowlist(raw)).toEqual(["suno.ai"]);
  });

  it("treats anything it cannot read as no answers at all", () => {
    // Failing toward "ask" is the only safe direction for a file that gates
    // writes into the workspace.
    expect(parseDownloadAllowlist("")).toEqual([]);
    expect(parseDownloadAllowlist("not json")).toEqual([]);
    expect(parseDownloadAllowlist("null")).toEqual([]);
    expect(parseDownloadAllowlist('["grok.com"]')).toEqual([]);
    expect(parseDownloadAllowlist(JSON.stringify({ domains: ["grok.com"] }))).toEqual([]);
    expect(parseDownloadAllowlist(JSON.stringify({ version: 2, domains: ["grok.com"] }))).toEqual(
      [],
    );
    expect(parseDownloadAllowlist(JSON.stringify({ version: 1, domains: "grok.com" }))).toEqual([]);
  });
});
