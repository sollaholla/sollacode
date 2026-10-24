import {
  collectThreadImages,
  messageImageId,
  workLogThreadImage,
  type ThreadImage,
} from "@t3tools/client-runtime/state/thread-images";
import { collectWorkLogImages } from "@t3tools/client-runtime/state/work-log-images";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { TimelineEntry } from "../../session-logic";
import type { ExpandedImageItem, ExpandedImagePreview } from "./ExpandedImagePreview";

export interface TimelineImageContext {
  readonly environmentId: EnvironmentId;
  /** Null outside a thread, where workspace files can't be fetched. */
  readonly threadId: ThreadId | null;
}

/** The viewer's item for a gallery image; an asset is fetched when it comes up. */
export function expandedImageItem(
  image: ThreadImage,
  environmentId: EnvironmentId,
): ExpandedImageItem {
  const { source } = image;
  if (source.kind === "src") return { name: image.name, src: source.src };
  return {
    name: image.name,
    asset: {
      environmentId,
      resource: source.resource,
      revision: source.revision,
      ...(source.fallbackSrc ? { fallbackSrc: source.fallbackSrc } : {}),
    },
  };
}

/**
 * Every image the conversation shows, oldest first: what people attached and
 * what the agent looked at, each once.
 */
export function collectTimelineImages(
  entries: ReadonlyArray<TimelineEntry>,
  threadId: ThreadId | null,
): ThreadImage[] {
  return collectThreadImages(
    entries.flatMap((entry): Array<ThreadImage | null> => {
      if (entry.kind === "work") {
        return collectWorkLogImages([entry.entry]).map((image) =>
          workLogThreadImage(image, threadId),
        );
      }
      if (entry.kind !== "message") return [];
      return (entry.message.attachments ?? []).flatMap((attachment) =>
        attachment.type === "image" && attachment.previewUrl
          ? [
              {
                id: messageImageId(attachment.id),
                name: attachment.name,
                source: { kind: "src" as const, src: attachment.previewUrl },
              },
            ]
          : [],
      );
    }),
  );
}

/**
 * The viewer opened on `imageId` with the conversation's other images either
 * side of it, or `fallback` when the image isn't among them.
 */
export function timelineImagePreview(
  entries: ReadonlyArray<TimelineEntry>,
  context: TimelineImageContext,
  imageId: string,
  fallback: ExpandedImagePreview,
): ExpandedImagePreview {
  const images = collectTimelineImages(entries, context.threadId);
  const index = images.findIndex((image) => image.id === imageId);
  if (index < 0) return fallback;
  return { images: images.map((image) => expandedImageItem(image, context.environmentId)), index };
}
