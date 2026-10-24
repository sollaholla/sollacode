import { WORK_LOG_IMAGE_ROW_HEIGHT } from "@t3tools/client-runtime/state/work-log-images";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadFeedActivity } from "../../lib/threadActivity";
import { collapsedWorkLogHeight, shownWorkLogImages } from "./workLogLayout";

function activity(fields: Partial<ThreadFeedActivity> & { readonly id: string }) {
  return {
    createdAt: "2026-10-11T00:00:00Z",
    turnId: null,
    summary: "Tool",
    detail: null,
    canExpand: false,
    getFullDetail: () => null,
    getCopyText: () => "",
    icon: "eye",
    toolLike: true,
    status: "success",
    ...fields,
  } satisfies ThreadFeedActivity;
}

describe("work log layout", () => {
  const read = activity({ id: "read", readImagePath: "/tmp/shot.png" });
  const plain = activity({ id: "plain" });

  it("reserves the thumbnail row only while the row has an image to show", () => {
    const withImage = collapsedWorkLogHeight([read, plain], 16);
    const withoutImage = collapsedWorkLogHeight(
      [read, plain],
      16,
      new Set(["file:read:/tmp/shot.png"]),
    );
    // Reported 2026-10-11: blank tiles read as broken images. A gone image
    // leaves, and its row's height goes with it, so the feed leaves no gap.
    expect(withImage - withoutImage).toBe(WORK_LOG_IMAGE_ROW_HEIGHT);
    expect(withoutImage).toBe(collapsedWorkLogHeight([plain, plain], 16));
  });

  it("shows a row's images less the ones found unable to load", () => {
    expect(shownWorkLogImages(read, new Set()).map((image) => image.id)).toEqual([
      "file:read:/tmp/shot.png",
    ]);
    expect(shownWorkLogImages(read, new Set(["file:read:/tmp/shot.png"]))).toEqual([]);
  });
});
