export const WORK_LOG_IMAGE_SIZE = 44;
export const WORK_LOG_IMAGE_GAP = 6;
export const WORK_LOG_IMAGE_ROW_HEIGHT = 52;
const MORE_TILE_WIDTH = 76;
const MAX_TILES = 6;

export type WorkLogImage = {
  readonly id: string;
  readonly name: string;
  readonly revision: string;
} & (
  | {
      readonly kind: "file";
      readonly path: string;
      readonly sourceActivityId: string;
      readonly inlineSrc?: string;
    }
  | { readonly kind: "attachment"; readonly attachmentId: string }
  /** An image only the tool result holds, such as a browser snapshot: no file to fetch. */
  | { readonly kind: "stored"; readonly src: string }
);

/** How each kind of work-log image is identified, so a card can name the image it shows. */
export const workLogImageId = {
  file: (sourceActivityId: string, path: string) => `file:${sourceActivityId}:${path}`,
  attachment: (attachmentId: string) => `attachment:${attachmentId}`,
  stored: (entryId: string) => `stored:${entryId}`,
};

/** Only images already recognized by the work log participate in its visual index. */
export function collectWorkLogImages(
  entries: readonly {
    readonly id: string;
    readonly readImagePath?: string;
    readonly readImageSourceActivityId?: string;
    readonly readImageInlineSrc?: string;
    readonly snapshotImageSrc?: string;
    readonly snapshotAttachmentId?: string;
    readonly tokenOptimizer?: {
      readonly attachments: readonly { readonly id: string; readonly name: string }[];
    };
  }[],
): WorkLogImage[] {
  const images = new Map<string, WorkLogImage>();
  for (const entry of entries) {
    if (entry.readImagePath) {
      const sourceActivityId = entry.readImageSourceActivityId ?? entry.id;
      const id = workLogImageId.file(sourceActivityId, entry.readImagePath);
      images.set(id, {
        kind: "file",
        id,
        revision: entry.id,
        path: entry.readImagePath,
        sourceActivityId,
        name: entry.readImagePath.replaceAll("\\", "/").split("/").at(-1) || "Image",
        ...(entry.readImageInlineSrc ? { inlineSrc: entry.readImageInlineSrc } : {}),
      });
    }
    if (entry.snapshotAttachmentId) {
      const id = workLogImageId.attachment(entry.snapshotAttachmentId);
      images.set(id, {
        kind: "attachment",
        id,
        revision: entry.id,
        attachmentId: entry.snapshotAttachmentId,
        name: "Browser snapshot",
      });
    } else if (entry.snapshotImageSrc) {
      const id = workLogImageId.stored(entry.id);
      images.set(id, {
        kind: "stored",
        id,
        revision: entry.id,
        name: "Browser snapshot",
        src: entry.snapshotImageSrc,
      });
    }
    for (const attachment of entry.tokenOptimizer?.attachments ?? []) {
      const id = workLogImageId.attachment(attachment.id);
      images.set(id, {
        kind: "attachment",
        id,
        revision: entry.id,
        attachmentId: attachment.id,
        name: attachment.name,
      });
    }
  }
  return [...images.values()];
}

/** Reserves room for the overflow tile before choosing thumbnails; never wraps. */
export function workLogImageLayout(count: number, width: number) {
  const available = Math.max(0, Number.isFinite(width) ? width : 0);
  const capacity = Math.min(
    MAX_TILES,
    Math.floor((available + WORK_LOG_IMAGE_GAP) / (WORK_LOG_IMAGE_SIZE + WORK_LOG_IMAGE_GAP)),
  );
  if (count <= capacity) return { visible: count, remaining: 0 };
  const visible = Math.min(
    MAX_TILES - 1,
    Math.max(
      0,
      Math.floor((available - MORE_TILE_WIDTH) / (WORK_LOG_IMAGE_SIZE + WORK_LOG_IMAGE_GAP)),
    ),
  );
  return { visible, remaining: Math.max(0, count - visible) };
}
