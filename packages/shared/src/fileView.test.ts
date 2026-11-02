import { describe, expect, it } from "vite-plus/test";

import { decodeFileViewPath, fileViewPath } from "./fileView.ts";

describe("fileViewPath", () => {
  it("encodes a POSIX path segment by segment", () => {
    expect(fileViewPath("/Users/me/My Docs/notes #1.md")).toBe(
      "/api/view/Users/me/My%20Docs/notes%20%231.md",
    );
  });

  it("keeps a Windows drive path and normalises its separators", () => {
    expect(fileViewPath("C:\\Users\\me\\a b.txt")).toBe("/api/view/C%3A/Users/me/a%20b.txt");
  });

  it("refuses relative, UNC, and traversing paths", () => {
    expect(fileViewPath("src/index.ts")).toBeNull();
    expect(fileViewPath("./index.ts")).toBeNull();
    expect(fileViewPath("\\\\server\\share\\x")).toBeNull();
    expect(fileViewPath("/Users/me/../etc/passwd")).toBeNull();
  });
});

describe("decodeFileViewPath", () => {
  it("round-trips what fileViewPath produced", () => {
    for (const path of ["/Users/me/My Docs/notes #1.md", "/tmp", "/a/%2F/b"]) {
      expect(decodeFileViewPath(fileViewPath(path)!)).toBe(path);
    }
    expect(decodeFileViewPath(fileViewPath("C:\\Users\\me\\a b.txt")!)).toBe("C:/Users/me/a b.txt");
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
