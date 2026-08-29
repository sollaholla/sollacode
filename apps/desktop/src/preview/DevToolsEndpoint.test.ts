import { describe, expect, it } from "vite-plus/test";

import { parseDevToolsActivePort } from "./DevToolsEndpoint.ts";

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
