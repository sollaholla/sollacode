import { describe, expect, it } from "vite-plus/test";
import { collectWorkLogImages, workLogImageLayout } from "./workLogImages.ts";

describe("work log image index", () => {
  it("preserves separate reads of the same path and ignores incidental filenames", () => {
    const images = collectWorkLogImages([
      {
        id: "a",
        readImagePath: "/tmp/scene.png",
        readImageSourceActivityId: "first",
        readImageInlineSrc: "data:image/png;base64,AAAA",
      },
      { id: "b", readImagePath: "/tmp/scene.png", readImageSourceActivityId: "second" },
      { id: "ordinary-output" },
      { id: "pages", tokenOptimizer: { attachments: [{ id: "page-1", name: "Page 1.png" }] } },
    ]);
    expect(images).toHaveLength(3);
    expect(images[0]).toMatchObject({
      name: "scene.png",
      sourceActivityId: "first",
      inlineSrc: "data:image/png;base64,AAAA",
    });
    expect(images[1]).toMatchObject({ sourceActivityId: "second" });
    expect(images[2]).toMatchObject({ kind: "attachment", attachmentId: "page-1" });
  });

  it("shows the page a browser snapshot captured, from the bytes the tool kept", () => {
    expect(
      collectWorkLogImages([
        { id: "snapshot-row", snapshotImageSrc: "data:image/jpeg;base64,/9j/" },
        { id: "click-row" },
      ]),
    ).toEqual([
      {
        kind: "stored",
        id: "stored:snapshot-row",
        revision: "snapshot-row",
        name: "Browser snapshot",
        src: "data:image/jpeg;base64,/9j/",
      },
    ]);
  });

  it("fetches a snapshot the server stored as an attachment", () => {
    expect(
      collectWorkLogImages([{ id: "snapshot-row", snapshotAttachmentId: "thread-1-abc" }]),
    ).toEqual([
      {
        kind: "attachment",
        id: "attachment:thread-1-abc",
        revision: "snapshot-row",
        attachmentId: "thread-1-abc",
        name: "Browser snapshot",
      },
    ]);
  });

  it("deduplicates repeated receipts without losing the newest revision", () => {
    const image = { readImagePath: "screenshots\\scene.png", readImageSourceActivityId: "receipt" };
    expect(
      collectWorkLogImages([
        { ...image, id: "a" },
        { ...image, id: "b" },
      ]),
    ).toMatchObject([{ revision: "b", name: "scene.png" }]);
    expect(
      collectWorkLogImages([
        { ...image, id: "a" },
        { ...image, id: "b" },
      ]),
    ).toHaveLength(1);
  });
});

describe("single row image layout", () => {
  it.each([
    [0, 0, 0, 0],
    [1, 44, 1, 0],
    [6, 294, 6, 0],
    [7, 294, 4, 3],
    [100, 326, 5, 95],
    [100, 2000, 5, 95],
    [10, 126, 1, 9],
    [10, 75, 0, 10],
    [10, 0, 0, 10],
  ])("fits %i images within %ipx", (count, width, visible, remaining) => {
    expect(workLogImageLayout(count, width)).toEqual({ visible, remaining });
  });

  it("never exceeds six tiles or the available width", () => {
    for (let width = 76; width <= 1000; width++) {
      for (let count = 1; count <= 20; count++) {
        const { visible, remaining } = workLogImageLayout(count, width);
        const tiles = visible + Number(remaining > 0);
        expect(tiles).toBeLessThanOrEqual(6);
        expect(
          visible * 44 + (remaining ? 76 : 0) + Math.max(0, tiles - 1) * 6,
        ).toBeLessThanOrEqual(width);
        expect(visible + remaining).toBe(count);
      }
    }
  });
});
