import { describe, expect, it } from "vite-plus/test";

import {
  fileViewContentDisposition,
  fileViewContentType,
  fileViewParentPath,
  renderFileViewDirectoryPage,
  sortFileViewEntries,
} from "./fileView.ts";

describe("fileViewContentType", () => {
  it("serves source files as plain text even when the MIME table disagrees", () => {
    expect(
      fileViewContentType({ fileName: "index.ts", mimeType: "video/mp2t", looksBinary: false }),
    ).toBe("text/plain; charset=utf-8");
    expect(
      fileViewContentType({ fileName: "page.html", mimeType: "text/html", looksBinary: false }),
    ).toBe("text/plain; charset=utf-8");
    expect(
      fileViewContentType({ fileName: "logo.svg", mimeType: "image/svg+xml", looksBinary: false }),
    ).toBe("text/plain; charset=utf-8");
    expect(fileViewContentType({ fileName: ".zshrc", mimeType: null, looksBinary: false })).toBe(
      "text/plain; charset=utf-8",
    );
  });

  it("keeps media types so the browser renders them inline", () => {
    expect(
      fileViewContentType({ fileName: "clip.mp4", mimeType: "video/mp4", looksBinary: true }),
    ).toBe("video/mp4");
    expect(
      fileViewContentType({ fileName: "a.pdf", mimeType: "application/pdf", looksBinary: true }),
    ).toBe("application/pdf");
    expect(
      fileViewContentType({ fileName: "shot.png", mimeType: "image/png", looksBinary: true }),
    ).toBe("image/png");
  });

  it("falls back on the NUL sniff for unknown names", () => {
    expect(fileViewContentType({ fileName: "Makefile", mimeType: null, looksBinary: false })).toBe(
      "text/plain; charset=utf-8",
    );
    expect(fileViewContentType({ fileName: "blob.bin", mimeType: null, looksBinary: true })).toBe(
      "application/octet-stream",
    );
  });
});

describe("fileViewContentDisposition", () => {
  it("offers an ASCII fallback and the UTF-8 name", () => {
    expect(fileViewContentDisposition('naïve "x".md')).toBe(
      `inline; filename="na_ve 'x'.md"; filename*=UTF-8''na%C3%AFve%20%22x%22.md`,
    );
  });
});

describe("fileViewParentPath", () => {
  it("walks up to the root and stops there", () => {
    expect(fileViewParentPath("/Users/sol/a")).toBe("/Users/sol");
    expect(fileViewParentPath("/Users")).toBe("/");
    expect(fileViewParentPath("/")).toBeNull();
    expect(fileViewParentPath("C:/Users")).toBe("C:/");
    expect(fileViewParentPath("C:/")).toBeNull();
  });
});

describe("renderFileViewDirectoryPage", () => {
  it("lists folders first, links every entry into the viewer, and escapes names", () => {
    const html = renderFileViewDirectoryPage({
      path: "/Users/sol/My Docs",
      entries: [
        { name: "zeta.txt", kind: "file", size: 2048 },
        { name: "<b>evil</b>", kind: "file", size: 3 },
        { name: "alpha", kind: "directory", size: null },
      ],
    });
    expect(html).toContain('<a href="/api/view/Users/sol">sol</a>');
    expect(html).toContain('<a href="/api/view/Users/sol"><span class="name">..</span>');
    const alpha = html.indexOf('href="/api/view/Users/sol/My%20Docs/alpha"');
    const zeta = html.indexOf('href="/api/view/Users/sol/My%20Docs/zeta.txt"');
    const evil = html.indexOf("&lt;b&gt;evil&lt;/b&gt;");
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(evil);
    expect(evil).toBeLessThan(zeta);
    expect(html).not.toContain("<b>evil</b>");
    expect(html).toContain('<span class="size">2.0 KB</span>');
  });

  it("says so when the folder is empty and offers no parent at the root", () => {
    const html = renderFileViewDirectoryPage({ path: "/", entries: [] });
    expect(html).toContain("This folder is empty.");
    expect(html).not.toContain('<span class="name">..</span>');
  });
});

describe("sortFileViewEntries", () => {
  it("orders folders before files and names numerically", () => {
    expect(
      sortFileViewEntries([
        { name: "file10.txt", kind: "file", size: 1 },
        { name: "file2.txt", kind: "file", size: 1 },
        { name: "b", kind: "directory", size: null },
      ]).map((entry) => entry.name),
    ).toEqual(["b", "file2.txt", "file10.txt"]);
  });
});
