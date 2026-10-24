import { EventId, type AssetResource, type ThreadId } from "@t3tools/contracts";

import type { WorkLogImage } from "./workLogImages.ts";

/** Where a viewer gets an image the conversation shows: bytes in hand, or an asset to fetch. */
export type ThreadImageSource =
  | { readonly kind: "src"; readonly src: string }
  | {
      readonly kind: "asset";
      readonly resource: AssetResource;
      /** Changes when the same path is read again, so a client can fetch the new bytes. */
      readonly revision: string;
      /** The copy a read tool returned, shown when the asset can't be fetched. */
      readonly fallbackSrc?: string;
    };

/** One image in a conversation's gallery, which a viewer pages through oldest first. */
export interface ThreadImage {
  readonly id: string;
  readonly name: string;
  readonly source: ThreadImageSource;
}

/** How a gallery names an image someone attached to a message. */
export function messageImageId(attachmentId: string): string {
  return `message-attachment:${attachmentId}`;
}

/**
 * A work-log image as the gallery shows it. A read file needs its thread to be
 * fetched, so without one only the copy the tool returned can stand in.
 */
export function workLogThreadImage(
  image: WorkLogImage,
  threadId: ThreadId | null,
): ThreadImage | null {
  const { id, name } = image;
  if (image.kind === "stored") return { id, name, source: { kind: "src", src: image.src } };
  if (image.kind === "attachment") {
    return {
      id,
      name,
      source: {
        kind: "asset",
        resource: { _tag: "attachment", attachmentId: image.attachmentId },
        revision: image.revision,
      },
    };
  }
  if (threadId === null) {
    return image.inlineSrc ? { id, name, source: { kind: "src", src: image.inlineSrc } } : null;
  }
  return {
    id,
    name,
    source: {
      kind: "asset",
      resource: {
        _tag: "workspace-file",
        threadId,
        path: image.path,
        sourceActivityId: EventId.make(image.sourceActivityId),
      },
      revision: image.revision,
      ...(image.inlineSrc ? { fallbackSrc: image.inlineSrc } : {}),
    },
  };
}

/** Collects a conversation's images in the order given, keeping the first of each id. */
export function collectThreadImages(images: Iterable<ThreadImage | null>): ThreadImage[] {
  const byId = new Map<string, ThreadImage>();
  for (const image of images) {
    if (image !== null && !byId.has(image.id)) byId.set(image.id, image);
  }
  return [...byId.values()];
}
