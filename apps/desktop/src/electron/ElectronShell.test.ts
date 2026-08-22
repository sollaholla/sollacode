import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const {
  clipboardReadHtmlMock,
  clipboardReadImageMock,
  clipboardReadTextMock,
  clipboardWriteMock,
  createFromBufferMock,
  openExternalMock,
  writeTextMock,
} = vi.hoisted(() => ({
  clipboardReadHtmlMock: vi.fn(),
  clipboardReadImageMock: vi.fn(),
  clipboardReadTextMock: vi.fn(),
  clipboardWriteMock: vi.fn(),
  createFromBufferMock: vi.fn(),
  openExternalMock: vi.fn(),
  writeTextMock: vi.fn(),
}));

vi.mock("electron", () => ({
  shell: {
    openExternal: openExternalMock,
  },
  clipboard: {
    readHTML: clipboardReadHtmlMock,
    readImage: clipboardReadImageMock,
    readText: clipboardReadTextMock,
    write: clipboardWriteMock,
    writeText: writeTextMock,
  },
  nativeImage: {
    createFromBuffer: createFromBufferMock,
  },
}));

import * as ElectronShell from "./ElectronShell.ts";

describe("ElectronShell", () => {
  beforeEach(() => {
    clipboardReadHtmlMock.mockReset();
    clipboardReadImageMock.mockReset();
    clipboardReadTextMock.mockReset();
    clipboardWriteMock.mockReset();
    createFromBufferMock.mockReset();
    openExternalMock.mockReset();
    writeTextMock.mockReset();
  });

  it.effect("opens safe external URLs", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("https://example.com/path");

      assert.equal(result, true);
      assert.deepEqual(openExternalMock.mock.calls, [["https://example.com/path"]]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not open unsafe external URLs", () =>
    Effect.gen(function* () {
      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("file:///etc/passwd");

      assert.equal(result, false);
      assert.equal(openExternalMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("returns false when Electron rejects openExternal", () =>
    Effect.gen(function* () {
      openExternalMock.mockRejectedValue(new Error("open failed"));

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("https://example.com/path");

      assert.equal(result, false);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("writes and verifies text, HTML, and PNG in one native clipboard item", () =>
    Effect.gen(function* () {
      const writtenImage = { isEmpty: () => false };
      createFromBufferMock.mockReturnValue(writtenImage);
      clipboardReadTextMock.mockReturnValue("move this");
      clipboardReadHtmlMock.mockReturnValue(
        '<meta charset="utf-8"><div data-solla-composer-transfer="solla-token">move this</div>',
      );
      clipboardReadImageMock.mockReturnValue({ isEmpty: () => false });

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.writeComposerClipboard({
        text: "move this",
        html: '<div data-solla-composer-transfer="solla-token">move this</div>',
        imagePng: new Uint8Array([1, 2, 3]),
      });

      assert.isTrue(result);
      assert.deepEqual(clipboardWriteMock.mock.calls, [
        [
          {
            text: "move this",
            html: '<div data-solla-composer-transfer="solla-token">move this</div>',
            image: writtenImage,
          },
        ],
      ]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("rejects a partial native write so the composer is not cleared", () =>
    Effect.gen(function* () {
      createFromBufferMock.mockReturnValue({ isEmpty: () => false });
      clipboardReadTextMock.mockReturnValue("move this");
      clipboardReadHtmlMock.mockReturnValue("");
      clipboardReadImageMock.mockReturnValue({ isEmpty: () => false });

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.writeComposerClipboard({
        text: "move this",
        html: '<div data-solla-composer-transfer="solla-token">move this</div>',
        imagePng: new Uint8Array([1, 2, 3]),
      });

      assert.isFalse(result);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );
});
