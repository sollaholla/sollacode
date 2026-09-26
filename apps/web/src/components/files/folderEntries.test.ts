import { describe, expect, it } from "vite-plus/test";

import { directChildEntries, entryName, parentFolderPath } from "./folderEntries";

describe("directChildEntries", () => {
  it("narrows the flat listing to one level, folders first", () => {
    const entries = [
      { path: "src/b.ts", kind: "file" as const },
      { path: "src/a.ts", kind: "file" as const },
      { path: "src/lib/deep/x.ts", kind: "file" as const },
      { path: "src/util", kind: "directory" as const },
      { path: "README.md", kind: "file" as const },
      { path: "srcx/z.ts", kind: "file" as const },
    ];
    expect(directChildEntries(entries, "src")).toEqual([
      { path: "src/lib", kind: "directory" },
      { path: "src/util", kind: "directory" },
      { path: "src/a.ts", kind: "file" },
      { path: "src/b.ts", kind: "file" },
    ]);
    expect(directChildEntries(entries, "").map((entry) => entry.path)).toEqual([
      "src",
      "srcx",
      "README.md",
    ]);
  });
});

describe("entryName / parentFolderPath", () => {
  it("splits a relative path", () => {
    expect(entryName("src/lib/x.ts")).toBe("x.ts");
    expect(entryName("src/")).toBe("src");
    expect(parentFolderPath("src/lib")).toBe("src");
    expect(parentFolderPath("src")).toBe("");
    expect(parentFolderPath("")).toBeNull();
  });
});
