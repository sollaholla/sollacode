// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { persistThreadExportJson } from "./threadExportAction";

const originalDesktopBridge = window.desktopBridge;

afterEach(() => {
  if (originalDesktopBridge) {
    window.desktopBridge = originalDesktopBridge;
  } else {
    delete window.desktopBridge;
  }
});

describe("persistThreadExportJson", () => {
  it("saves the export and reveals it in Finder on desktop", async () => {
    const saveThreadExportJson = vi.fn(async () => "/tmp/thread.json");
    const revealFile = vi.fn(async () => true);
    window.desktopBridge = {
      saveThreadExportJson,
      revealFile,
    } as unknown as NonNullable<typeof window.desktopBridge>;

    await expect(
      persistThreadExportJson({ filename: "thread.json", contents: "{}" }),
    ).resolves.toBe("/tmp/thread.json");
    expect(saveThreadExportJson).toHaveBeenCalledWith({
      filename: "thread.json",
      contents: "{}",
    });
    expect(revealFile).toHaveBeenCalledWith("/tmp/thread.json");
  });

  it("reports when Finder cannot reveal a successfully saved export", async () => {
    window.desktopBridge = {
      saveThreadExportJson: vi.fn(async () => "/tmp/thread.json"),
      revealFile: vi.fn(async () => false),
    } as unknown as NonNullable<typeof window.desktopBridge>;

    await expect(
      persistThreadExportJson({ filename: "thread.json", contents: "{}" }),
    ).rejects.toThrow("The export was saved, but Finder could not reveal /tmp/thread.json.");
  });
});
