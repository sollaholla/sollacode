import { messageImageId } from "@t3tools/client-runtime/state/thread-images";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry, WorkLogEntry } from "../../session-logic";
import type { ChatImageAttachment } from "../../types";
import {
  collectTimelineImages,
  timelineImagePreview,
  type TimelineImageContext,
} from "./timelineImageGallery";

const at = "2026-10-11T00:00:00Z";
const context: TimelineImageContext = {
  environmentId: EnvironmentId.make("host"),
  threadId: ThreadId.make("thread"),
};

function image(id: string, previewUrl?: string): ChatImageAttachment {
  return {
    type: "image",
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 10,
    ...(previewUrl ? { previewUrl } : {}),
  };
}

function message(id: string, attachments: ChatImageAttachment[]): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: at,
    message: {
      id: id as never,
      role: "user",
      text: "",
      turnId: null,
      createdAt: at,
      updatedAt: at,
      streaming: false,
      attachments,
    },
  };
}

function work(entry: Partial<WorkLogEntry> & { readonly id: string }): TimelineEntry {
  return {
    id: entry.id,
    kind: "work",
    createdAt: at,
    entry: { createdAt: at, label: "Tool", tone: "tool", ...entry },
  };
}

const entries: TimelineEntry[] = [
  message("ask", [image("mock", "blob:mock"), image("unsent")]),
  work({
    id: "read",
    readImagePath: "/repo/shot.png",
    readImageInlineSrc: "data:image/png;base64,AA",
  }),
  // A tool row merged from the same activity names the same image again.
  work({ id: "read-update", readImagePath: "/repo/shot.png", readImageSourceActivityId: "read" }),
  work({ id: "snap", snapshotAttachmentId: "page" }),
  work({ id: "old-snap", snapshotImageSrc: "data:image/jpeg;base64,/9j/" }),
];

describe("timeline image gallery", () => {
  it("lists every image in the conversation once, oldest first", () => {
    expect(collectTimelineImages(entries, context.threadId).map((entry) => entry.id)).toEqual([
      messageImageId("mock"),
      "file:read:/repo/shot.png",
      "attachment:page",
      "stored:old-snap",
    ]);
  });

  it("opens on the chosen image with the rest either side", () => {
    const fallback = { images: [{ name: "alone", src: "blob:alone" }], index: 0 };
    const preview = timelineImagePreview(entries, context, "attachment:page", fallback);
    expect(preview).toEqual({
      index: 2,
      images: [
        { name: "mock.png", src: "blob:mock" },
        {
          name: "shot.png",
          asset: {
            environmentId: context.environmentId,
            resource: {
              _tag: "workspace-file",
              threadId: context.threadId,
              path: "/repo/shot.png",
              sourceActivityId: "read",
            },
            revision: "read",
            fallbackSrc: "data:image/png;base64,AA",
          },
        },
        {
          name: "Browser snapshot",
          asset: {
            environmentId: context.environmentId,
            resource: { _tag: "attachment", attachmentId: "page" },
            revision: "snap",
          },
        },
        { name: "Browser snapshot", src: "data:image/jpeg;base64,/9j/" },
      ],
    });
    expect(timelineImagePreview(entries, context, "attachment:gone", fallback)).toBe(fallback);
  });
});
