import { describe, expect, it } from "vite-plus/test";

import { resolveThreadDownloadDirectory } from "./threadDownloadDirectory.ts";

describe("resolveThreadDownloadDirectory", () => {
  it("puts downloads under the workspace the thread is working in", () => {
    expect(resolveThreadDownloadDirectory("/Users/me/Desktop/PawstalgiaTunesUGC")).toBe(
      "/Users/me/Desktop/PawstalgiaTunesUGC/downloads",
    );
  });

  it("keeps a subfolder rather than dropping files into a git checkout root", () => {
    expect(resolveThreadDownloadDirectory("/repo")).toBe("/repo/downloads");
  });

  it("uses the separator the host path is written in", () => {
    // The workspace can live on a Windows host reached from this machine.
    expect(resolveThreadDownloadDirectory("C:\\Users\\me\\project")).toBe(
      "C:\\Users\\me\\project\\downloads",
    );
    expect(resolveThreadDownloadDirectory("\\\\share\\team")).toBe("\\\\share\\team\\downloads");
  });

  it("does not double the separator on a trailing slash", () => {
    expect(resolveThreadDownloadDirectory("/repo/")).toBe("/repo/downloads");
    expect(resolveThreadDownloadDirectory("C:\\project\\")).toBe("C:\\project\\downloads");
  });

  it("handles a root workspace without producing a doubled root", () => {
    expect(resolveThreadDownloadDirectory("/")).toBe("/downloads");
  });

  it("defers to the desktop fallback when there is no workspace", () => {
    expect(resolveThreadDownloadDirectory(null)).toBeNull();
    expect(resolveThreadDownloadDirectory(undefined)).toBeNull();
    expect(resolveThreadDownloadDirectory("   ")).toBeNull();
  });
});
