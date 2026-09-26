import { describe, expect, it } from "vite-plus/test";

import {
  resolveLinkedFileAbsolutePath,
  resolveLinkedFilePrimaryAction,
  resolveLocalFileFallback,
  shouldRevealLinkedFileByDefault,
} from "./linkedFileBehavior";

describe("shouldRevealLinkedFileByDefault", () => {
  it.each([
    "/build/MedXRNativePrototype.apk",
    "/Applications/Solla Code.app",
    "release/client.dmg",
    "artifacts/client.zip",
    "C:\\build\\client.exe:12",
  ])("routes non-text artifact %s to the file explorer", (filePath) => {
    expect(shouldRevealLinkedFileByDefault(filePath)).toBe(true);
  });

  it.each([
    "/repo/src/App.tsx",
    "/repo/README.md",
    "/repo/package.json:14",
    "/repo/scripts/build",
    "/repo/image.png",
    "/repo/report.pdf",
  ])("keeps previewable file %s on its existing open path", (filePath) => {
    expect(shouldRevealLinkedFileByDefault(filePath)).toBe(false);
  });

  it.each([
    "/movies/clip.mp4",
    "/movies/clip.mov?download=1",
    "C:\\media\\clip.webm:12",
    "/audio/master.wav",
    "/documents/brief.docx",
  ])("routes non-text media/document %s away from the text preview", (filePath) => {
    expect(shouldRevealLinkedFileByDefault(filePath)).toBe(true);
  });
});

describe("resolveLinkedFilePrimaryAction", () => {
  const base = {
    filePath: "/movies/clip.mp4",
    workspaceRelativePath: "media/clip.mp4",
    hasImageAction: false,
    hasBrowserAction: false,
    canRevealOnThisDevice: true,
  };

  // Was "reveal" until the panel learned to play video. Revealing a file the
  // app can now show in place is strictly less useful, so this expectation
  // changed with the capability rather than with the rule.
  it("plays local video in the panel now that the panel can render it", () => {
    expect(resolveLinkedFilePrimaryAction(base)).toBe("preview");
  });

  it("never sends a remote media path to the local file explorer", () => {
    // Still the point of this test: not "reveal". A phone has no file explorer
    // and no editor, and the old "editor" answer is what made the click dead.
    expect(resolveLinkedFilePrimaryAction({ ...base, canRevealOnThisDevice: false })).toBe(
      "preview",
    );
  });

  it("reveals any same-machine path outside the current workspace", () => {
    expect(
      resolveLinkedFilePrimaryAction({
        ...base,
        filePath: "/Downloads/reference.txt",
        workspaceRelativePath: null,
      }),
    ).toBe("reveal");
  });

  it("does not offer outside-workspace HTML or PDF to the authenticated browser preview", () => {
    expect(
      resolveLinkedFilePrimaryAction({
        ...base,
        filePath: "/Downloads/report.pdf",
        workspaceRelativePath: null,
        hasBrowserAction: true,
      }),
    ).toBe("reveal");
    expect(
      resolveLinkedFilePrimaryAction({
        ...base,
        filePath: "/Downloads/report.html",
        workspaceRelativePath: null,
        hasBrowserAction: true,
        canRevealOnThisDevice: false,
      }),
    ).toBe("editor");
  });

  it("keeps image and integrated-browser actions ahead of reveal", () => {
    expect(resolveLinkedFilePrimaryAction({ ...base, hasImageAction: true })).toBe("image");
    expect(resolveLinkedFilePrimaryAction({ ...base, hasBrowserAction: true })).toBe("browser");
  });
});

describe("resolveLocalFileFallback", () => {
  // The reported "sometimes it says the file is not found": reveal and openPath
  // speak for THIS machine, but the workspace may be on a remote host, in WSL,
  // or in a worktree, where the file is present. Reaching for the panel turns a
  // wrong denial into the file the user asked for.
  it("prefers the environment-backed panel over reporting a local miss", () => {
    expect(
      resolveLocalFileFallback({ hasThreadRef: true, workspaceRelativePath: "src/app.ts" }),
    ).toBe("preview");
  });

  it("reports only when there is genuinely nowhere else to look", () => {
    // No workspace-relative path: the file is outside the workspace, so the
    // panel cannot read it either and saying so is the honest answer.
    expect(resolveLocalFileFallback({ hasThreadRef: true, workspaceRelativePath: null })).toBe(
      "report",
    );
    expect(
      resolveLocalFileFallback({ hasThreadRef: false, workspaceRelativePath: "src/app.ts" }),
    ).toBe("report");
  });
});

describe("resolveLinkedFileAbsolutePath", () => {
  it("resolves a relative tool path against the workspace before desktop reveal", () => {
    expect(resolveLinkedFileAbsolutePath("captures/frame.png", "/repo/project")).toBe(
      "/repo/project/captures/frame.png",
    );
  });

  it("preserves absolute paths and rejects unscoped relative paths", () => {
    expect(resolveLinkedFileAbsolutePath("/tmp/frame.png", "/repo/project")).toBe("/tmp/frame.png");
    expect(resolveLinkedFileAbsolutePath("captures/frame.png", undefined)).toBeNull();
  });

  /**
   * The reported defect: "clicking the link does absolutely nothing".
   *
   * mp4/mov/webm sit in the reveal table from when nothing could display them.
   * On a phone `canRevealOnThisDevice` is false, so the resolver fell through
   * to "editor" - and on a phone there is no editor to open, so the click ended
   * in silence. Media now has a panel that renders it, so it routes there.
   */
  it("sends video to the panel instead of a reveal a phone cannot perform", () => {
    for (const filePath of ["clip.mp4", "demo.mov", "loop.webm", "doc.pdf"]) {
      expect(
        resolveLinkedFilePrimaryAction({
          filePath,
          workspaceRelativePath: filePath,
          hasImageAction: false,
          hasBrowserAction: false,
          canRevealOnThisDevice: false,
        }),
      ).toBe("preview");
      // Same answer on desktop: the panel can draw it, so revealing its folder
      // is strictly less useful than showing it.
      expect(
        resolveLinkedFilePrimaryAction({
          filePath,
          workspaceRelativePath: filePath,
          hasImageAction: false,
          hasBrowserAction: false,
          canRevealOnThisDevice: true,
        }),
      ).toBe("preview");
    }
  });

  it("sends audio to the panel instead of a reveal a phone cannot perform", () => {
    for (const filePath of ["song.mp3", "note.wav", "take.m4a", "loop.ogg"]) {
      expect(
        resolveLinkedFilePrimaryAction({
          filePath,
          workspaceRelativePath: filePath,
          hasImageAction: false,
          hasBrowserAction: false,
          canRevealOnThisDevice: false,
        }),
      ).toBe("preview");
      // Same answer on desktop: the panel can play it, so revealing its folder
      // is strictly less useful than showing it.
      expect(
        resolveLinkedFilePrimaryAction({
          filePath,
          workspaceRelativePath: filePath,
          hasImageAction: false,
          hasBrowserAction: false,
          canRevealOnThisDevice: true,
        }),
      ).toBe("preview");
    }
  });

  it("opens a genuinely unrenderable file in its own application", () => {
    expect(
      resolveLinkedFilePrimaryAction({
        filePath: "report.docx",
        workspaceRelativePath: "report.docx",
        hasImageAction: false,
        hasBrowserAction: false,
        canRevealOnThisDevice: true,
        canOpenInDefaultApp: true,
      }),
    ).toBe("default-app");
    // Without the bridge, locating it is still better than nothing.
    expect(
      resolveLinkedFilePrimaryAction({
        filePath: "report.docx",
        workspaceRelativePath: "report.docx",
        hasImageAction: false,
        hasBrowserAction: false,
        canRevealOnThisDevice: true,
        canOpenInDefaultApp: false,
      }),
    ).toBe("reveal");
  });

  it("never leaves a click with nowhere to go", () => {
    // A phone: cannot reveal, cannot launch an app, cannot render a .docx.
    // The panel at least names the file and says why, which beats silence.
    expect(
      resolveLinkedFilePrimaryAction({
        filePath: "report.docx",
        workspaceRelativePath: "report.docx",
        hasImageAction: false,
        hasBrowserAction: false,
        canRevealOnThisDevice: false,
        canOpenInDefaultApp: false,
      }),
    ).toBe("preview");
  });
});
