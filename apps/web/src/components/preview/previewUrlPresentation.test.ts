import { describe, expect, it } from "vite-plus/test";

import { formatPreviewUrl } from "./previewUrlPresentation";

describe("formatPreviewUrl", () => {
  it("formats signed asset URLs with the environment label and decoded filename", () => {
    expect(
      formatPreviewUrl({
        url: "http://127.0.0.1:3773/api/assets/token/architecture%20brief.pdf",
        environmentLabel: "Local environment",
        environmentHttpBaseUrl: "http://127.0.0.1:3773",
      }),
    ).toBe("Local environment · architecture brief.pdf");
  });

  it("does not alias assets from another origin", () => {
    expect(
      formatPreviewUrl({
        url: "https://example.com/api/assets/token/report.pdf",
        environmentLabel: "Local environment",
        environmentHttpBaseUrl: "http://127.0.0.1:3773",
      }),
    ).toBe("example.com");
  });

  it("formats regular preview URLs as their exact host", () => {
    expect(
      formatPreviewUrl({
        url: "http://127.0.0.1:5173/dashboard",
        environmentLabel: "Local environment",
        environmentHttpBaseUrl: "http://127.0.0.1:3773",
      }),
    ).toBe("127.0.0.1:5173");
  });

  it("names the site rather than the machine it is dialled through", () => {
    // A viewer on another machine reaches the dev server at the environment's
    // tailnet address; that address is how it got there, not what it is.
    expect(
      formatPreviewUrl({
        url: "http://100.65.180.100:5173/dashboard",
        environmentLabel: "Studio",
        environmentHttpBaseUrl: "http://100.65.180.100:3773",
      }),
    ).toBe("localhost:5173");
    expect(
      formatPreviewUrl({
        url: "http://192.168.1.25:8080/",
        environmentLabel: "Studio",
        environmentHttpBaseUrl: "http://192.168.1.25:3773",
      }),
    ).toBe("localhost:8080");
  });

  it("leaves a public host alone even when it is the environment's own", () => {
    // A relay-hosted environment shares its host with whatever it serves;
    // relabelling that as localhost would be a lie.
    expect(
      formatPreviewUrl({
        url: "https://relay.example.com:8443/app",
        environmentLabel: "Hosted",
        environmentHttpBaseUrl: "https://relay.example.com",
      }),
    ).toBe("relay.example.com:8443");
  });

  it("leaves the environment's own pages alone", () => {
    expect(
      formatPreviewUrl({
        url: "http://100.65.180.100:3773/settings",
        environmentLabel: "Studio",
        environmentHttpBaseUrl: "http://100.65.180.100:3773",
      }),
    ).toBe("100.65.180.100:3773");
  });

  it("does not compact non-http URLs", () => {
    expect(
      formatPreviewUrl({
        url: "file:///tmp/report.pdf",
        environmentLabel: "Local environment",
        environmentHttpBaseUrl: "http://127.0.0.1:3773",
      }),
    ).toBeNull();
  });
});
