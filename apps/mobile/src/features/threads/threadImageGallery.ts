import {
  collectThreadImages,
  messageImageId,
  workLogThreadImage,
  type ThreadImage,
} from "@t3tools/client-runtime/state/thread-images";
import { collectWorkLogImages } from "@t3tools/client-runtime/state/work-log-images";
import type { ThreadId } from "@t3tools/contracts";

import type { ThreadFeedEntry } from "../../lib/threadActivity";

/** The images a viewer pages through, and the one it shows first. */
export interface ThreadImageGallery {
  readonly images: readonly ThreadImage[];
  readonly index: number;
}

/** Opens the conversation's images from any image in it, and keeps out the ones that can't load. */
export interface ThreadImageGalleryOpener {
  /** The gallery opened on `image`, or `image` alone when the conversation doesn't list it. */
  readonly galleryFor: (image: ThreadImage) => ThreadImageGallery;
  /** Shows a gallery in the conversation's viewer. */
  readonly open: (gallery: ThreadImageGallery) => void;
  /**
   * Images found to be gone or undecodable. The feed stops showing them,
   * sizes its rows without them, and leaves them out of the gallery.
   */
  readonly unavailable: ReadonlySet<string>;
  readonly markUnavailable: (imageId: string) => void;
}

/** An image someone attached to a message, fetched by its attachment id. */
export function messageThreadImage(attachment: {
  readonly id: string;
  readonly name: string;
}): ThreadImage {
  return {
    id: messageImageId(attachment.id),
    name: attachment.name,
    source: {
      kind: "asset",
      resource: { _tag: "attachment", attachmentId: attachment.id },
      revision: attachment.id,
    },
  };
}

/** The image a press opened, shown with the URL its thumbnail already loaded. */
export function pressedThreadImage(id: string, name: string, src: string): ThreadImage {
  return { id, name, source: { kind: "src", src } };
}

/**
 * Every image the conversation shows, oldest first: what people attached and
 * what the agent looked at, each once.
 */
export function collectThreadFeedImages(
  feed: ReadonlyArray<ThreadFeedEntry>,
  threadId: ThreadId,
): ThreadImage[] {
  return collectThreadImages(
    feed.flatMap((entry): Array<ThreadImage | null> => {
      switch (entry.type) {
        case "message":
          return (entry.message.attachments ?? []).flatMap((attachment) =>
            attachment.type === "image" ? [messageThreadImage(attachment)] : [],
          );
        case "activity-group":
          return collectWorkLogImages(entry.activities).map((image) =>
            workLogThreadImage(image, threadId),
          );
        default:
          return [];
      }
    }),
  );
}

/**
 * The gallery opened on `pressed`, which stands in for its own entry so the
 * viewer starts on exactly what was tapped.
 */
export function threadImageGallery(
  images: readonly ThreadImage[],
  pressed: ThreadImage,
  unavailable: ReadonlySet<string> = new Set(),
): ThreadImageGallery {
  const shown = images.filter((image) => image.id === pressed.id || !unavailable.has(image.id));
  const index = shown.findIndex((image) => image.id === pressed.id);
  if (index < 0) return { images: [pressed], index: 0 };
  return { images: shown.map((image, at) => (at === index ? pressed : image)), index };
}
