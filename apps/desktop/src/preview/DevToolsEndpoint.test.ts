import { describe, expect, it } from "vite-plus/test";

import {
  devToolsActivePortCandidates,
  parseDevToolsActivePort,
  recordDevToolsUserDataDirectory,
} from "./DevToolsEndpoint.ts";

describe("parseDevToolsActivePort", () => {
  it("reads the bound port and the browser target path", () => {
    expect(parseDevToolsActivePort("52134\n/devtools/browser/abc-123\n")).toEqual({
      port: 52134,
      browserTargetPath: "/devtools/browser/abc-123",
    });
  });

  it("accepts a file that carries only a port", () => {
    expect(parseDevToolsActivePort("52134")).toEqual({ port: 52134, browserTargetPath: null });
  });

  it("refuses anything that does not name a bound port", () => {
    for (const contents of ["0\n/devtools/browser/x", "", "not-a-port", "-1", "70000"]) {
      expect(parseDevToolsActivePort(contents)).toBeNull();
    }
  });
});

describe("devToolsActivePortCandidates", () => {
  it("looks only in the current directory when nothing was recorded", () => {
    expect(devToolsActivePortCandidates("/data/current")).toEqual(["/data/current"]);
  });

  it("prefers the directory Chromium started with once they diverge", () => {
    // Observed on a real run: Chromium wrote the file to the launch directory
    // while the app reported a relocated one, and DevTools looked unavailable.
    recordDevToolsUserDataDirectory("/data/launch");
    expect(devToolsActivePortCandidates("/data/current")).toEqual([
      "/data/launch",
      "/data/current",
    ]);
  });

  it("does not look in the same directory twice", () => {
    recordDevToolsUserDataDirectory("/data/same");
    expect(devToolsActivePortCandidates("/data/same")).toEqual(["/data/same"]);
  });
});
