import { describe, expect, it } from "vite-plus/test";

import { decodeFileViewPath, fileViewPath } from "./fileView.ts";

describe("fileViewPath", () => {
  it("encodes a POSIX path segment by segment", () => {
    expect(fileViewPath("/Users/sol/My Docs/notes #1.md")).toBe(
      "/api/view/Users/sol/My%20Docs/notes%20%231.md",
    );
  });

  it("keeps a Windows drive path and normalises its separators", () => {
    expect(fileViewPath("C:\\Users\\sol\\a b.txt")).toBe("/api/view/C%3A/Users/sol/a%20b.txt");
  });

  it("refuses relative, UNC, and traversing paths", () => {
    expect(fileViewPath("src/index.ts")).toBeNull();
    expect(fileViewPath("./index.ts")).toBeNull();
    expect(fileViewPath("\\\\server\\share\\x")).toBeNull();
    expect(fileViewPath("/Users/sol/../etc/passwd")).toBeNull();
  });
});

describe("decodeFileViewPath", () => {
  it("round-trips what fileViewPath produced", () => {
    for (const path of ["/Users/sol/My Docs/notes #1.md", "/tmp", "/a/%2F/b"]) {
      expect(decodeFileViewPath(fileViewPath(path)!)).toBe(path);
    }
    expect(decodeFileViewPath(fileViewPath("C:\\Users\\sol\\a b.txt")!)).toBe(
      "C:/Users/sol/a b.txt",
    );
  });

  it("names the drive root for a bare Windows drive", () => {
    expect(decodeFileViewPath("/api/view/C%3A")).toBe("C:/");
  });

  it("rejects everything the viewer must not resolve", () => {
    expect(decodeFileViewPath("/api/assets/x")).toBeNull();
    expect(decodeFileViewPath("/api/view/")).toBeNull();
    expect(decodeFileViewPath("/api/view/Users/..%2Fetc/passwd")).toBeNull();
    expect(decodeFileViewPath("/api/view/Users/%2e%2e/etc")).toBeNull();
    expect(decodeFileViewPath("/api/view/Users/%00")).toBeNull();
    expect(decodeFileViewPath("/api/view/Users/%E0%A4%A")).toBeNull();
    expect(decodeFileViewPath("/api/view/Users/a%5Cb")).toBeNull();
  });
});
