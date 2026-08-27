import { describe, expect, it } from "vite-plus/test";

import { resolveDownloadFileName, resolveUniqueDownloadPath } from "./downloadPaths.ts";

const join = (directory: string, fileName: string) => `${directory}/${fileName}`;

describe("resolveDownloadFileName", () => {
  it("keeps an ordinary name as it is", () => {
    expect(resolveDownloadFileName("moose-render.mp4")).toBe("moose-render.mp4");
  });

  it("refuses to let a remote name escape the downloads directory", () => {
    // The name comes from Content-Disposition, so it is attacker-controlled.
    expect(resolveDownloadFileName("../../.ssh/authorized_keys")).toBe("authorized_keys");
    expect(resolveDownloadFileName("C:\\Windows\\System32\\evil.dll")).toBe("evil.dll");
  });

  it("strips characters a filesystem will not take", () => {
    expect(resolveDownloadFileName('re<po>rt:"|?*.pdf')).toBe("re_po_rt_____.pdf");
  });

  it("never produces a hidden or empty name", () => {
    expect(resolveDownloadFileName("...")).toBe("download");
    expect(resolveDownloadFileName("   ")).toBe("download");
    expect(resolveDownloadFileName(".bashrc")).toBe("bashrc");
  });

  it("bounds the length for filesystems that cap it", () => {
    expect(resolveDownloadFileName("x".repeat(500)).length).toBe(180);
  });
});

describe("resolveUniqueDownloadPath", () => {
  it("uses the plain name when nothing is in the way", () => {
    expect(
      resolveUniqueDownloadPath({
        directory: "/d",
        fileName: "a.png",
        join,
        exists: () => false,
      }),
    ).toBe("/d/a.png");
  });

  it("numbers around an existing file rather than overwriting it", () => {
    // Nothing prompts here, so an overwrite would destroy work silently.
    const taken = new Set(["/d/a.png", "/d/a (1).png"]);
    expect(
      resolveUniqueDownloadPath({
        directory: "/d",
        fileName: "a.png",
        join,
        exists: (path) => taken.has(path),
      }),
    ).toBe("/d/a (2).png");
  });

  it("numbers before the extension, not after it", () => {
    expect(
      resolveUniqueDownloadPath({
        directory: "/d",
        fileName: "archive.tar.gz",
        join,
        exists: (path) => path === "/d/archive.tar.gz",
      }),
    ).toBe("/d/archive.tar (1).gz");
  });

  it("treats an extensionless name as a whole name", () => {
    expect(
      resolveUniqueDownloadPath({
        directory: "/d",
        fileName: "LICENSE",
        join,
        exists: (path) => path === "/d/LICENSE",
      }),
    ).toBe("/d/LICENSE (1)");
  });

  it("gives up rather than spinning when everything reports as taken", () => {
    expect(
      resolveUniqueDownloadPath({ directory: "/d", fileName: "a.png", join, exists: () => true }),
    ).toBe("/d/a.png");
  });
});
