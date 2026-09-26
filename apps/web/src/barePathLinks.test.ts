import { describe, expect, it } from "vite-plus/test";

import { findBareFilePaths, remarkBareFilePaths, uniqueBareFilePaths } from "./barePathLinks";

describe("findBareFilePaths", () => {
  it("finds an absolute path with a real extension in prose", () => {
    const text =
      "absolute paths: /Users/sol/Desktop/OpenWorldUnreal/reports/island/captures/owner_review_20260912/slope_to_town.png and done.";
    expect(findBareFilePaths(text)).toEqual([
      {
        start: 16,
        end:
          16 +
          "/Users/sol/Desktop/OpenWorldUnreal/reports/island/captures/owner_review_20260912/slope_to_town.png"
            .length,
        href: "/Users/sol/Desktop/OpenWorldUnreal/reports/island/captures/owner_review_20260912/slope_to_town.png",
        path: "/Users/sol/Desktop/OpenWorldUnreal/reports/island/captures/owner_review_20260912/slope_to_town.png",
      },
    ]);
  });

  it("keeps a line:column suffix on the href but not the path", () => {
    const [match] = findBareFilePaths("see /src/app/main.ts:12:4, then");
    expect(match?.href).toBe("/src/app/main.ts:12:4");
    expect(match?.path).toBe("/src/app/main.ts");
  });

  it("drops trailing punctuation and parenthesised wrappers", () => {
    expect(findBareFilePaths("(saved to /tmp/out.json).").map((m) => m.href)).toEqual([
      "/tmp/out.json",
    ]);
    expect(findBareFilePaths("files: /a/b.txt, /c/d.md; end").map((m) => m.href)).toEqual([
      "/a/b.txt",
      "/c/d.md",
    ]);
  });

  it("ignores URLs, version numbers, extensionless paths and deeper segments", () => {
    expect(findBareFilePaths("https://example.com/img/a.png")).toEqual([]);
    expect(findBareFilePaths("bumped to /v1.2 today")).toEqual([]);
    expect(findBareFilePaths("/etc/hosts and /usr/bin")).toEqual([]);
    expect(findBareFilePaths("in /dir.name/child")).toEqual([]);
    expect(findBareFilePaths("email me@host.com/x.png")).toEqual([]);
    expect(findBareFilePaths("~/notes/a.md")).toEqual([]);
  });

  it("finds Windows drive paths", () => {
    expect(findBareFilePaths("open C:\\Users\\sol\\report.pdf now").map((m) => m.href)).toEqual([
      "C:\\Users\\sol\\report.pdf",
    ]);
  });

  it("lists each distinct path once", () => {
    const matches = findBareFilePaths("/a/b.txt then /a/b.txt:3 and /c.md");
    expect(uniqueBareFilePaths(matches)).toEqual(["/a/b.txt", "/c.md"]);
  });
});

describe("remarkBareFilePaths", () => {
  it("links only verified paths and leaves code and links alone", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "Real /a/real.png, fake /a/fake.png." },
            { type: "inlineCode", value: "/a/real.png" },
            {
              type: "link",
              url: "/a/real.png",
              children: [{ type: "text", value: "/a/real.png" }],
            },
          ],
        },
        { type: "code", value: "/a/real.png" },
      ],
    };
    remarkBareFilePaths({ verified: new Set(["/a/real.png"]) })(tree);
    expect(tree.children[0]?.children).toEqual([
      { type: "text", value: "Real " },
      { type: "link", url: "/a/real.png", children: [{ type: "text", value: "/a/real.png" }] },
      { type: "text", value: ", fake /a/fake.png." },
      { type: "inlineCode", value: "/a/real.png" },
      { type: "link", url: "/a/real.png", children: [{ type: "text", value: "/a/real.png" }] },
    ]);
    expect(tree.children[1]).toEqual({ type: "code", value: "/a/real.png" });
  });

  it("is a no-op with nothing verified", () => {
    const tree = { type: "root", children: [{ type: "text", value: "/a/b.png" }] };
    remarkBareFilePaths({ verified: new Set() })(tree);
    expect(tree.children).toEqual([{ type: "text", value: "/a/b.png" }]);
  });
});
