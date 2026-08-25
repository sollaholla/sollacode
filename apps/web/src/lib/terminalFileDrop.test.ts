import { describe, expect, it } from "vite-plus/test";

import { COMPOSER_MENTION_DRAG_TYPE } from "../components/chat/composerMentionDrag";
import {
  buildTerminalDropInput,
  canResolveOsFilePaths,
  classifyTerminalFileDrop,
  collectTerminalDropInput,
  COMPOSER_MENTION_DRAG_MIME,
  fileUrlToPath,
  pathFromComposerFileLink,
  pathsFromUriList,
  quoteTerminalPath,
  resolveOsFilePath,
  TERMINAL_GROUP_DRAG_MIME,
  TERMINAL_PANE_DRAG_MIME,
  terminalFileDropPreviewsEqual,
} from "./terminalFileDrop";

describe("canResolveOsFilePaths", () => {
  it("requires the actual desktop path resolver, not merely a bridge object", () => {
    expect(canResolveOsFilePaths(undefined)).toBe(false);
    expect(canResolveOsFilePaths({})).toBe(false);
    expect(canResolveOsFilePaths({ getPathForFile: () => "/tmp/clip.mp4" })).toBe(true);
  });
});

describe("classifyTerminalFileDrop", () => {
  it("ignores pane and group rearranges", () => {
    expect(classifyTerminalFileDrop([TERMINAL_PANE_DRAG_MIME]).kind).toBe("ignore");
    expect(classifyTerminalFileDrop([TERMINAL_GROUP_DRAG_MIME, "Files"]).kind).toBe("ignore");
  });

  it("accepts OS files when paths can be resolved", () => {
    expect(classifyTerminalFileDrop(["Files"], { canResolveOsFilePaths: true })).toMatchObject({
      kind: "accept",
      title: "Drop to insert path",
    });
  });

  it("rejects OS files when paths cannot be resolved", () => {
    expect(classifyTerminalFileDrop(["Files"], { canResolveOsFilePaths: false })).toMatchObject({
      kind: "reject",
      title: "Can't drop files here",
    });
  });

  it("accepts file URIs, workspace mentions, and plain text", () => {
    expect(classifyTerminalFileDrop(["text/uri-list"]).kind).toBe("accept");
    expect(classifyTerminalFileDrop([COMPOSER_MENTION_DRAG_MIME]).kind).toBe("accept");
    expect(classifyTerminalFileDrop(["text/plain"]).kind).toBe("accept");
    expect(COMPOSER_MENTION_DRAG_MIME).toBe(COMPOSER_MENTION_DRAG_TYPE);
  });

  it("rejects unknown payloads", () => {
    expect(classifyTerminalFileDrop(["text/html"]).kind).toBe("reject");
    expect(classifyTerminalFileDrop([]).kind).toBe("reject");
  });
});

describe("quoteTerminalPath", () => {
  it("leaves simple paths unquoted and quotes spaces and quotes", () => {
    expect(quoteTerminalPath("/tmp/photo.png")).toBe("/tmp/photo.png");
    expect(quoteTerminalPath("C:/repo/src/main.ts")).toBe("C:/repo/src/main.ts");
    expect(quoteTerminalPath("/tmp/my file.png")).toBe("'/tmp/my file.png'");
    expect(quoteTerminalPath("/tmp/it's.png")).toBe("'/tmp/it'\\''s.png'");
  });
});

describe("fileUrlToPath", () => {
  it("converts unix and windows file URLs", () => {
    expect(fileUrlToPath("file:///Users/ada/photo.png")).toBe("/Users/ada/photo.png");
    expect(fileUrlToPath("file:///C:/Users/ada/photo.png")).toBe("C:/Users/ada/photo.png");
    expect(fileUrlToPath("https://example.com/photo.png")).toBeNull();
  });
});

describe("pathsFromUriList", () => {
  it("collects file URLs and skips comments", () => {
    expect(pathsFromUriList("# comment\nfile:///tmp/a.png\nfile:///tmp/b.png\n")).toEqual([
      "/tmp/a.png",
      "/tmp/b.png",
    ]);
  });
});

describe("pathFromComposerFileLink", () => {
  it("reads markdown destinations and @mentions", () => {
    expect(pathFromComposerFileLink("[package.json](src/package.json)")).toBe("src/package.json");
    expect(pathFromComposerFileLink("[My File.md](docs/My%20File.md)")).toBe("docs/My File.md");
    expect(pathFromComposerFileLink("@src/index.ts")).toBe("src/index.ts");
  });
});

describe("resolveOsFilePath", () => {
  it("prefers the desktop path helper, then File.path", () => {
    const file = new File(["x"], "photo.png", { type: "image/png" });
    expect(resolveOsFilePath(file)).toBeNull();
    expect(resolveOsFilePath(file, () => "/tmp/photo.png")).toBe("/tmp/photo.png");
    Object.defineProperty(file, "path", { value: "/legacy/photo.png" });
    expect(resolveOsFilePath(file)).toBe("/legacy/photo.png");
    expect(
      resolveOsFilePath(file, () => {
        throw new Error("old preload");
      }),
    ).toBe("/legacy/photo.png");
  });
});

describe("buildTerminalDropInput", () => {
  it("quotes paths and falls back to trimmed text", () => {
    expect(buildTerminalDropInput({ paths: ["/tmp/a.png", "/tmp/my file.png"] })).toBe(
      "/tmp/a.png '/tmp/my file.png' ",
    );
    expect(buildTerminalDropInput({ paths: [], text: "  hello  " })).toBe("hello");
    expect(buildTerminalDropInput({ paths: [], text: "   " })).toBeNull();
  });
});

describe("collectTerminalDropInput", () => {
  it("inserts resolved file paths and ignores internal pane drags", () => {
    const file = new File(["x"], "photo.png");
    expect(
      collectTerminalDropInput({
        types: ["Files"],
        files: [file],
        getData: () => "",
        resolveFilePath: () => "/tmp/photo.png",
        canResolveOsFilePaths: true,
      }),
    ).toBe("/tmp/photo.png ");
    expect(
      collectTerminalDropInput({
        types: [TERMINAL_PANE_DRAG_MIME, "Files"],
        files: [file],
        getData: () => "",
        resolveFilePath: () => "/tmp/photo.png",
        canResolveOsFilePaths: true,
      }),
    ).toBeNull();
  });

  it("prefers a workspace mention over OS files", () => {
    const file = new File(["x"], "photo.png");
    expect(
      collectTerminalDropInput({
        types: [COMPOSER_MENTION_DRAG_MIME, "Files"],
        files: [file],
        getData: (type) =>
          type === COMPOSER_MENTION_DRAG_MIME ? "[photo.png](assets/photo.png)" : "",
        resolveFilePath: () => "/tmp/photo.png",
        canResolveOsFilePaths: true,
      }),
    ).toBe("assets/photo.png ");
  });

  it("uses file URIs when File objects have no path", () => {
    expect(
      collectTerminalDropInput({
        types: ["Files", "text/uri-list"],
        files: [new File(["x"], "photo.png")],
        getData: (type) => (type === "text/uri-list" ? "file:///tmp/photo.png" : ""),
        canResolveOsFilePaths: false,
      }),
    ).toBe("/tmp/photo.png ");
  });
});

describe("terminalFileDropPreviewsEqual", () => {
  it("compares kind and copy", () => {
    const preview = classifyTerminalFileDrop(["text/plain"]);
    expect(terminalFileDropPreviewsEqual(preview, { ...preview })).toBe(true);
    expect(terminalFileDropPreviewsEqual(preview, classifyTerminalFileDrop(["text/html"]))).toBe(
      false,
    );
  });
});
