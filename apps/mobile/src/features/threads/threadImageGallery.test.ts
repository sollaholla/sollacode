import { messageImageId } from "@t3tools/client-runtime/state/thread-images";
import { ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadFeedActivity, ThreadFeedEntry } from "../../lib/threadActivity";
import {
  collectThreadFeedImages,
  pressedThreadImage,
  threadImageGallery,
} from "./threadImageGallery";

const at = "2026-10-11T00:00:00Z";
const threadId = ThreadId.make("thread");

function activity(fields: Partial<ThreadFeedActivity> & { readonly id: string }) {
  return {
    createdAt: at,
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

const feed: ThreadFeedEntry[] = [
  {
    type: "message",
    id: "ask",
    createdAt: at,
    message: {
      id: "ask" as never,
      role: "user",
      text: "Match this",
      turnId: TurnId.make("turn"),
      createdAt: at,
      updatedAt: at,
      streaming: false,
      attachments: [
        { type: "image", id: "mock", name: "mock.png", mimeType: "image/png", sizeBytes: 10 },
      ],
    },
  },
  {
    type: "activity-group",
    id: "group",
    createdAt: at,
    turnId: null,
    activities: [
      activity({ id: "read", readImagePath: "/repo/shot.png" }),
      activity({ id: "snap", snapshotAttachmentId: "page" }),
    ],
  },
];

describe("thread feed image gallery", () => {
  it("lists attachments and work-log images oldest first", () => {
    const images = collectThreadFeedImages(feed, threadId);
    expect(images.map((image) => image.id)).toEqual([
      messageImageId("mock"),
      "file:read:/repo/shot.png",
      "attachment:page",
    ]);
    expect(images[0]?.source).toEqual({
      kind: "asset",
      resource: { _tag: "attachment", attachmentId: "mock" },
      revision: "mock",
    });
  });

  it("opens on the tapped image with what its thumbnail loaded", () => {
    const images = collectThreadFeedImages(feed, threadId);
    const pressed = pressedThreadImage("file:read:/repo/shot.png", "shot.png", "https://host/shot");
    const gallery = threadImageGallery(images, pressed);
    expect(gallery.index).toBe(1);
    expect(gallery.images).toHaveLength(3);
    expect(gallery.images[1]).toBe(pressed);
    expect(gallery.images[2]).toBe(images[2]);
  });

  it("leaves out images found unable to load", () => {
    const images = collectThreadFeedImages(feed, threadId);
    const pressed = pressedThreadImage("attachment:page", "Browser snapshot", "https://host/p");
    const gallery = threadImageGallery(images, pressed, new Set(["file:read:/repo/shot.png"]));
    expect(gallery.images.map((image) => image.id)).toEqual([
      messageImageId("mock"),
      "attachment:page",
    ]);
    expect(gallery.index).toBe(1);
  });

  it("opens an image the conversation doesn't list on its own", () => {
    const pressed = pressedThreadImage("elsewhere", "x.png", "https://host/x");
    expect(threadImageGallery([], pressed)).toEqual({ images: [pressed], index: 0 });
  });
});
