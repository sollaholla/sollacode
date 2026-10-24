import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectThreadImages, workLogThreadImage } from "./threadImages.ts";
import { collectWorkLogImages } from "./workLogImages.ts";

const [read, snapshot, stored] = collectWorkLogImages([
  { id: "read", readImagePath: "/repo/shot.png", readImageInlineSrc: "data:image/png;base64,AA" },
  { id: "snap", snapshotAttachmentId: "page" },
  { id: "old-snap", snapshotImageSrc: "data:image/jpeg;base64,/9j/" },
]);
const threadId = ThreadId.make("thread");

describe("thread images", () => {
  it("fetches files and attachments, and shows stored pages as they are", () => {
    expect(workLogThreadImage(read!, threadId)).toEqual({
      id: "file:read:/repo/shot.png",
      name: "shot.png",
      source: {
        kind: "asset",
        resource: {
          _tag: "workspace-file",
          threadId,
          path: "/repo/shot.png",
          sourceActivityId: "read",
        },
        revision: "read",
        fallbackSrc: "data:image/png;base64,AA",
      },
    });
    expect(workLogThreadImage(snapshot!, threadId)?.source).toEqual({
      kind: "asset",
      resource: { _tag: "attachment", attachmentId: "page" },
      revision: "snap",
    });
    expect(workLogThreadImage(stored!, threadId)?.source).toEqual({
      kind: "src",
      src: "data:image/jpeg;base64,/9j/",
    });
  });

  it("shows a read file's stored copy outside a thread, and nothing without one", () => {
    expect(workLogThreadImage(read!, null)?.source).toEqual({
      kind: "src",
      src: "data:image/png;base64,AA",
    });
    const [bare] = collectWorkLogImages([{ id: "bare", readImagePath: "/repo/bare.png" }]);
    expect(workLogThreadImage(bare!, null)).toBeNull();
  });

  it("keeps the first of each image and drops the ones that can't be shown", () => {
    const first = workLogThreadImage(read!, threadId);
    const again = { ...first!, name: "renamed.png" };
    expect(collectThreadImages([first, null, again]).map((image) => image.name)).toEqual([
      "shot.png",
    ]);
  });
});
