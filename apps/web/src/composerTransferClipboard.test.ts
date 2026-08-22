import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearInMemoryComposerTransfersForTest,
  composerTransferHtml,
  discardComposerTransfer,
  hasPersistedComposerTransfer,
  hasTransferableComposerContent,
  persistComposerTransfer,
  planComposerPaste,
  readClipboardImageFiles,
  readComposerTransferFromClipboard,
  resolveComposerTransferFromClipboard,
  setComposerTransferPersistenceForTest,
  stageComposerTransfer,
  writeComposerTransferToClipboard,
} from "./composerTransferClipboard";
import type {
  ComposerTransferPersistence,
  PersistedComposerTransfer,
} from "./composerTransferPersistence";

function clipboardData(values: Record<string, string>): Pick<DataTransfer, "getData"> {
  return {
    getData: (type) => values[type] ?? "",
  };
}

function createMetadataStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function clonePersistedTransfer(transfer: PersistedComposerTransfer): PersistedComposerTransfer {
  return {
    ...transfer,
    files: transfer.files.map((file) => ({
      ...file,
      blob: new Blob([file.blob], { type: file.mimeType }),
    })),
  };
}

function createTransferPersistence(): {
  readonly persistence: ComposerTransferPersistence;
  readonly values: Map<string, PersistedComposerTransfer>;
} {
  const values = new Map<string, PersistedComposerTransfer>();
  return {
    values,
    persistence: {
      write: (transfer) => {
        values.set(transfer.token, clonePersistedTransfer(transfer));
        return Promise.resolve();
      },
      read: (token) => Promise.resolve(values.get(token) ?? null),
      remove: (token) => {
        values.delete(token);
        return Promise.resolve();
      },
    },
  };
}

describe("composer transfer clipboard", () => {
  afterEach(() => {
    clearInMemoryComposerTransfersForTest();
    setComposerTransferPersistenceForTest({ persistence: null, metadataStorage: null });
    vi.unstubAllGlobals();
  });

  it.each([
    { prompt: "", attachmentCount: 0, expected: false },
    { prompt: "Move this prompt", attachmentCount: 0, expected: true },
    { prompt: "", attachmentCount: 1, expected: true },
    { prompt: "Move this prompt", attachmentCount: 2, expected: true },
  ])("detects transferable text and attachments", ({ prompt, attachmentCount, expected }) => {
    expect(hasTransferableComposerContent(prompt, attachmentCount)).toBe(expected);
  });

  it("round-trips all staged files through the HTML clipboard marker", async () => {
    const first = new File(["first"], "first.png", { type: "image/png", lastModified: 10 });
    const second = new File(["second"], "second.webp", {
      type: "image/webp",
      lastModified: 20,
    });
    const staged = stageComposerTransfer("hello\nworld", [first, second]);
    const resolved = readComposerTransferFromClipboard(
      clipboardData({ "text/html": composerTransferHtml(staged) }),
    );

    expect(resolved?.prompt).toBe("hello\nworld");
    expect(resolved?.files.map((file) => [file.name, file.type, file.lastModified])).toEqual([
      ["first.png", "image/png", 10],
      ["second.webp", "image/webp", 20],
    ]);
    expect(resolved?.files[0]).not.toBe(first);
    expect(await resolved?.files[0]?.text()).toBe("first");

    discardComposerTransfer(staged.token);
    expect(
      readComposerTransferFromClipboard(
        clipboardData({ "text/html": composerTransferHtml(staged) }),
      ),
    ).toBeNull();
  });

  it("escapes prompt markup without hiding the transfer marker", () => {
    const staged = stageComposerTransfer(`<script>"cut"</script>`, []);
    const html = composerTransferHtml(staged);

    expect(html).toContain(`data-solla-composer-transfer="${staged.token}"`);
    expect(html).toContain("&lt;script&gt;&quot;cut&quot;&lt;/script&gt;");
    expect(html).not.toContain("<script>");

    discardComposerTransfer(staged.token);
  });

  it("ignores arbitrary image clipboard content without a staged transfer token", () => {
    expect(
      readComposerTransferFromClipboard(
        clipboardData({
          "text/plain": "draft",
          "text/html": '<img src="data:image/png;base64,AAAA">',
        }),
      ),
    ).toBeNull();
  });

  it("restores attachments when the OS keeps only the plain-text clipboard representation", async () => {
    const image = new File(["image"], "reference.png", {
      type: "image/png",
      lastModified: 30,
    });
    const staged = stageComposerTransfer("move this with the image", [image]);

    const resolved = readComposerTransferFromClipboard(
      clipboardData({ "text/plain": "move this with the image" }),
    );

    expect(resolved?.prompt).toBe("move this with the image");
    expect(resolved?.files.map((file) => file.name)).toEqual(["reference.png"]);
    expect(await resolved?.files[0]?.text()).toBe("image");
    discardComposerTransfer(staged.token);
  });

  it("restores attachment-only drafts from a stripped clipboard representation", () => {
    const image = new File(["image"], "attachment-only.png", { type: "image/png" });
    const staged = stageComposerTransfer("", [image]);

    const resolved = readComposerTransferFromClipboard(clipboardData({ "text/plain": "" }));

    expect(resolved?.prompt).toBe("");
    expect(resolved?.files.map((file) => file.name)).toEqual(["attachment-only.png"]);
    discardComposerTransfer(staged.token);
  });

  it("does not restore staged attachments when the pasted plain text differs", () => {
    const staged = stageComposerTransfer("original draft", [
      new File(["image"], "original.png", { type: "image/png" }),
    ]);

    expect(
      readComposerTransferFromClipboard(clipboardData({ "text/plain": "different text" })),
    ).toBeNull();
    discardComposerTransfer(staged.token);
  });

  it("restores every image after the renderer-local transfer map is lost", async () => {
    const metadataStorage = createMetadataStorage();
    const { persistence } = createTransferPersistence();
    setComposerTransferPersistenceForTest({ persistence, metadataStorage });
    const first = new File(["first bytes"], "first.png", {
      type: "image/png",
      lastModified: 10,
    });
    const second = new File(["second bytes"], "second.webp", {
      type: "image/webp",
      lastModified: 20,
    });
    const staged = stageComposerTransfer("survive a renderer reload", [first, second]);

    await expect(persistComposerTransfer(staged)).resolves.toBe(true);
    clearInMemoryComposerTransfersForTest();

    const strippedClipboard = clipboardData({ "text/plain": "survive a renderer reload" });
    expect(readComposerTransferFromClipboard(strippedClipboard)).toBeNull();
    expect(hasPersistedComposerTransfer(strippedClipboard)).toBe(true);
    const restored = await resolveComposerTransferFromClipboard(strippedClipboard);

    expect(restored?.prompt).toBe("survive a renderer reload");
    expect(restored?.files.map((file) => [file.name, file.type, file.lastModified])).toEqual([
      ["first.png", "image/png", 10],
      ["second.webp", "image/webp", 20],
    ]);
    expect(await restored?.files[0]?.text()).toBe("first bytes");
    expect(await restored?.files[1]?.text()).toBe("second bytes");
    discardComposerTransfer(staged.token);
  });

  it("restores an attachment-only cut after a renderer reload", async () => {
    const metadataStorage = createMetadataStorage();
    const { persistence } = createTransferPersistence();
    setComposerTransferPersistenceForTest({ persistence, metadataStorage });
    const staged = stageComposerTransfer("", [
      new File(["image"], "attachment-only.png", { type: "image/png" }),
    ]);

    await expect(persistComposerTransfer(staged)).resolves.toBe(true);
    clearInMemoryComposerTransfersForTest();
    const emptyClipboard = clipboardData({ "text/plain": "" });

    expect(hasPersistedComposerTransfer(emptyClipboard)).toBe(true);
    await expect(resolveComposerTransferFromClipboard(emptyClipboard)).resolves.toMatchObject({
      prompt: "",
      files: [{ name: "attachment-only.png" }],
    });
    discardComposerTransfer(staged.token);
  });

  it("uses the durable token after reload when HTML survives", async () => {
    const metadataStorage = createMetadataStorage();
    const { persistence } = createTransferPersistence();
    setComposerTransferPersistenceForTest({ persistence, metadataStorage });
    const staged = stageComposerTransfer("marked", [
      new File(["image"], "marked.png", { type: "image/png" }),
    ]);

    await expect(persistComposerTransfer(staged)).resolves.toBe(true);
    clearInMemoryComposerTransfersForTest();
    const markedClipboard = clipboardData({
      "text/plain": "a platform may alter this representation",
      "text/html": composerTransferHtml(staged),
    });

    const restored = await resolveComposerTransferFromClipboard(markedClipboard);
    expect(restored?.prompt).toBe("marked");
    expect(restored?.files.map((file) => file.name)).toEqual(["marked.png"]);
    discardComposerTransfer(staged.token);
  });

  it("normalizes line endings and Unicode before matching a stripped clipboard", async () => {
    const metadataStorage = createMetadataStorage();
    const { persistence } = createTransferPersistence();
    setComposerTransferPersistenceForTest({ persistence, metadataStorage });
    const staged = stageComposerTransfer("Cafe\u0301\nsecond line", [
      new File(["image"], "normalized.png", { type: "image/png" }),
    ]);

    await expect(persistComposerTransfer(staged)).resolves.toBe(true);
    clearInMemoryComposerTransfersForTest();
    const normalizedClipboard = clipboardData({ "text/plain": "Caf\u00e9\r\nsecond line" });

    expect(hasPersistedComposerTransfer(normalizedClipboard)).toBe(true);
    expect(
      (await resolveComposerTransferFromClipboard(normalizedClipboard))?.files.map(
        (file) => file.name,
      ),
    ).toEqual(["normalized.png"]);
    discardComposerTransfer(staged.token);
  });

  it("refuses to clear on the strength of an attachment stage that did not persist", async () => {
    const metadataStorage = createMetadataStorage();
    const removed: string[] = [];
    setComposerTransferPersistenceForTest({
      metadataStorage,
      persistence: {
        write: () => Promise.reject(new Error("disk full")),
        read: () => Promise.resolve(null),
        remove: (token) => {
          removed.push(token);
          return Promise.resolve();
        },
      },
    });
    const staged = stageComposerTransfer("keep the source", [
      new File(["image"], "safe.png", { type: "image/png" }),
    ]);

    await expect(persistComposerTransfer(staged)).resolves.toBe(false);
    clearInMemoryComposerTransfersForTest();
    expect(hasPersistedComposerTransfer(clipboardData({ "text/plain": "keep the source" }))).toBe(
      false,
    );
    expect(removed).toEqual([]);
  });

  it("removes persisted bytes if the small lookup record cannot be written", async () => {
    const { persistence, values } = createTransferPersistence();
    const metadataStorage = createMetadataStorage();
    metadataStorage.setItem = () => {
      throw new Error("quota rejected");
    };
    setComposerTransferPersistenceForTest({ persistence, metadataStorage });
    const staged = stageComposerTransfer("keep this too", [
      new File(["image"], "safe.png", { type: "image/png" }),
    ]);

    await expect(persistComposerTransfer(staged)).resolves.toBe(false);
    expect(values.has(staged.token)).toBe(false);
  });

  it("writes plain text, HTML marker, and the internal token in the button gesture", async () => {
    const values: Record<string, string> = {};
    let copyListener: ((event: ClipboardEvent) => void) | null = null;
    vi.stubGlobal("document", {
      addEventListener: (type: string, listener: (event: ClipboardEvent) => void) => {
        if (type === "copy") copyListener = listener;
      },
      removeEventListener: vi.fn(),
      execCommand: (command: string) => {
        expect(command).toBe("copy");
        copyListener?.({
          preventDefault: vi.fn(),
          clipboardData: {
            setData: (type: string, value: string) => {
              values[type] = value;
            },
          },
        } as unknown as ClipboardEvent);
        return true;
      },
    });
    const staged = stageComposerTransfer("move me", []);

    await expect(writeComposerTransferToClipboard(staged)).resolves.toBe(true);
    expect(values["text/plain"]).toBe("move me");
    expect(values["text/html"]).toContain(`data-solla-composer-transfer="${staged.token}"`);
    expect(values["application/x-solla-composer-transfer"]).toBe(staged.token);

    discardComposerTransfer(staged.token);
  });
});

describe("writeComposerTransferToClipboard image bytes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the desktop atomic clipboard bridge for image cuts", async () => {
    const writeComposerClipboard = vi.fn(() => Promise.resolve(true));
    vi.stubGlobal("window", { desktopBridge: { writeComposerClipboard } });
    const png = new File([new Uint8Array([4, 5, 6])], "shot.png", { type: "image/png" });
    const staged = stageComposerTransfer("move this", [png]);

    await expect(writeComposerTransferToClipboard(staged, [png])).resolves.toBe(true);
    expect(writeComposerClipboard).toHaveBeenCalledTimes(1);
    expect(writeComposerClipboard).toHaveBeenCalledWith({
      text: "move this",
      html: composerTransferHtml(staged),
      imagePng: new Uint8Array([4, 5, 6]),
    });
    discardComposerTransfer(staged.token);
  });

  it("keeps an image draft intact when the native clipboard loses a representation", async () => {
    vi.stubGlobal("window", {
      desktopBridge: { writeComposerClipboard: () => Promise.resolve(false) },
    });
    const png = new File([new Uint8Array([7])], "shot.png", { type: "image/png" });
    const staged = stageComposerTransfer("keep this", [png]);
    await expect(writeComposerTransferToClipboard(staged, [png])).resolves.toBe(false);
    discardComposerTransfer(staged.token);
  });

  it("writes real PNG bytes alongside the text so a stripped clipboard still carries the image", async () => {
    // The bug this covers: cut put only text/html on the clipboard, so pasting
    // into another thread produced text and silently lost every attachment.
    const written: Array<Record<string, Blob>> = [];
    const originalClipboard = globalThis.navigator?.clipboard;
    const originalItem = globalThis.ClipboardItem;
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: {
        write: (items: Array<{ readonly parts: Record<string, Blob> }>) => {
          for (const item of items) written.push(item.parts);
          return Promise.resolve();
        },
      },
    });
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = class {
      readonly parts: Record<string, Blob>;
      constructor(parts: Record<string, Blob>) {
        this.parts = parts;
      }
    };

    try {
      const png = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
      const staged = stageComposerTransfer("look at this", [png]);
      const ok = await writeComposerTransferToClipboard(staged, [png]);

      expect(ok).toBe(true);
      expect(written).toHaveLength(1);
      expect(Object.keys(written[0] ?? {}).toSorted()).toEqual([
        "image/png",
        "text/html",
        "text/plain",
      ]);
      discardComposerTransfer(staged.token);
    } finally {
      if (originalClipboard === undefined) {
        Reflect.deleteProperty(globalThis.navigator, "clipboard");
      } else {
        Object.defineProperty(globalThis.navigator, "clipboard", {
          configurable: true,
          value: originalClipboard,
        });
      }
      (globalThis as { ClipboardItem?: unknown }).ClipboardItem = originalItem;
    }
  });

  it("leaves text-only drafts on the synchronous copy path", async () => {
    // No image means no reason to reach for the async API, which some remote
    // clients reject outright.
    const staged = stageComposerTransfer("just words", []);
    const result = await writeComposerTransferToClipboard(staged, []);
    expect(typeof result).toBe("boolean");
    discardComposerTransfer(staged.token);
  });
});

describe("readClipboardImageFiles", () => {
  it("reads a native clipboard bitmap exposed only through DataTransfer.items", () => {
    const png = new File([new Uint8Array([1, 2])], "clipboard.png", { type: "image/png" });
    const files = readClipboardImageFiles({
      files: [] as unknown as FileList,
      items: [
        {
          type: "image/png",
          getAsFile: () => png,
        },
      ] as unknown as DataTransferItemList,
    });

    expect(files).toEqual([png]);
  });

  it("does not duplicate images represented in both clipboard collections", () => {
    const png = new File([new Uint8Array([1])], "clipboard.png", { type: "image/png" });
    const files = readClipboardImageFiles({
      files: [png] as unknown as FileList,
      items: [
        {
          type: "image/png",
          getAsFile: () => png,
        },
      ] as unknown as DataTransferItemList,
    });

    expect(files).toEqual([png]);
  });
});

describe("planComposerPaste", () => {
  const png = () => new File([new Uint8Array([1])], "a.png", { type: "image/png" });

  it("inserts both the text and the image when a cut lands as raw clipboard data", () => {
    // The regression: preventing the default paste to attach the image also
    // suppressed the browser's text insertion, delivering half the draft.
    const plan = planComposerPaste({
      transfer: null,
      clipboardText: "look at this",
      clipboardFiles: [png()],
    });
    expect(plan.handled).toBe(true);
    expect(plan.prompt).toBe("look at this");
    expect(plan.files).toHaveLength(1);
  });

  it("prefers the staged transfer and ignores duplicate clipboard bytes", () => {
    // Both routes describe the same cut; taking both would double the image.
    const plan = planComposerPaste({
      transfer: { prompt: "staged", files: [png(), png()] },
      clipboardText: "staged",
      clipboardFiles: [png()],
    });
    expect(plan.prompt).toBe("staged");
    expect(plan.files).toHaveLength(2);
  });

  it("leaves an ordinary text paste to the browser", () => {
    const plan = planComposerPaste({
      transfer: null,
      clipboardText: "just words",
      clipboardFiles: [],
    });
    expect(plan.handled).toBe(false);
    expect(plan.files).toHaveLength(0);
  });

  it("attaches an image that arrives with no text", () => {
    const plan = planComposerPaste({ transfer: null, clipboardText: "", clipboardFiles: [png()] });
    expect(plan.handled).toBe(true);
    expect(plan.prompt).toBeNull();
    expect(plan.files).toHaveLength(1);
  });

  it("ignores non-image files so document pastes fall through", () => {
    const pdf = new File([new Uint8Array([1])], "a.pdf", { type: "application/pdf" });
    expect(
      planComposerPaste({ transfer: null, clipboardText: "", clipboardFiles: [pdf] }).handled,
    ).toBe(false);
  });
});
