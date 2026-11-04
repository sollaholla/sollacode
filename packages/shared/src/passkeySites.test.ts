import { describe, expect, it } from "vite-plus/test";

import {
  isPasskeySiteRefused,
  passkeySiteForHost,
  passkeySiteForUrl,
  passkeySiteFromInput,
} from "./passkeySites.ts";

describe("passkeySiteForHost", () => {
  it("reads a site from any of its hosts", () => {
    expect(passkeySiteForHost("example.com")).toBe("example.com");
    expect(passkeySiteForHost("login.app.Example.com")).toBe("example.com");
    expect(passkeySiteForHost("login.example.co.uk")).toBe("example.co.uk");
    expect(passkeySiteForHost("example.co.uk")).toBe("example.co.uk");
  });

  it("keeps local addresses whole", () => {
    expect(passkeySiteForHost("localhost")).toBe("localhost");
    expect(passkeySiteForHost("app.localhost")).toBe("app.localhost");
    expect(passkeySiteForHost("127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("passkeySiteForUrl", () => {
  it("allows only pages that can use a passkey", () => {
    expect(passkeySiteForUrl("https://app.example.com/login")).toBe("example.com");
    expect(passkeySiteForUrl("http://localhost:5173/")).toBe("localhost");
    expect(passkeySiteForUrl("http://app.example.com/")).toBeNull();
    expect(passkeySiteForUrl("about:blank")).toBeNull();
    expect(passkeySiteForUrl("not a url")).toBeNull();
  });
});

describe("passkeySiteFromInput", () => {
  it("takes a bare domain or a whole address", () => {
    expect(passkeySiteFromInput(" app.example.com ")).toBe("example.com");
    expect(passkeySiteFromInput("https://example.com/settings")).toBe("example.com");
    expect(passkeySiteFromInput("")).toBeNull();
  });
});

describe("isPasskeySiteRefused", () => {
  it("refuses Google, whose sign-in rejects the debugger this needs", () => {
    expect(isPasskeySiteRefused("google.com")).toBe(true);
    expect(isPasskeySiteRefused(passkeySiteForHost("accounts.google.com"))).toBe(true);
    expect(isPasskeySiteRefused("notgoogle.com")).toBe(false);
  });
});
