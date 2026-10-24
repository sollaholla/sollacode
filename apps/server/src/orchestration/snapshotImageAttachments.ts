// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { isPreviewSnapshotToolCall } from "@t3tools/shared/filePreview";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import { inferImageExtension } from "../imageMime.ts";

/**
 * Browser snapshots keep their page image as an attachment file.
 *
 * A `preview_snapshot` result carries a JPEG of the page. Left in the activity
 * it was cut by the payload caps: Codex keeps results under `data.item.result`,
 * whose strings are stored at 16 KB and sent to clients at 2 KB, so the
 * timeline drew the top of the page over grey (2026-10-10: 7,830 of 8,268 Codex
 * snapshots). Claude's uncapped `data.result` had the opposite problem, riding
 * whole in every thread snapshot. Written once to the attachments directory,
 * the block keeps only `{ type: "image", mimeType, attachmentId }`: the row
 * stays small everywhere and a client fetches the picture only when it shows
 * it. It expires with the attachment retention setting, like every
 * attachment.
 */

export interface SnapshotImageFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;

class SnapshotImageStoreError extends Schema.TaggedErrorClass<SnapshotImageStoreError>()(
  "SnapshotImageStoreError",
  { cause: Schema.Defect() },
) {}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Named by the bytes' hash, so the started, updated and completed rows of one
 * call, and an unchanged page snapshotted twice, share a file.
 */
function attachmentIdFor(threadSegment: string, bytes: Uint8Array): string {
  const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  return `${threadSegment}-${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * The snapshot's payload with each inline image swapped for a reference, and
 * the files to write; null when there is nothing to move.
 */
export function externalizeSnapshotImages(input: {
  readonly payload: unknown;
  readonly summary: string;
  readonly threadId: string;
}): { readonly payload: unknown; readonly files: ReadonlyArray<SnapshotImageFile> } | null {
  if (!isPreviewSnapshotToolCall(input.payload, input.summary)) return null;
  const threadSegment = toSafeThreadAttachmentSegment(input.threadId);
  const payload = asRecord(input.payload);
  const data = asRecord(payload?.data);
  if (!threadSegment || !payload || !data) return null;

  const files: Array<SnapshotImageFile> = [];
  const moveImages = (result: unknown): unknown => {
    const record = asRecord(result);
    if (!record || !Array.isArray(record.content)) return result;
    let changed = false;
    const content = record.content.map((block) => {
      const image = asRecord(block);
      if (image?.type !== "image") return block;
      // MCP and ACP: { data, mimeType }. Anthropic: { source: { data, media_type } }.
      const source = asRecord(image.source) ?? image;
      const mimeType = [source.mimeType, source.media_type].find(
        (value): value is string => typeof value === "string",
      );
      const base64 = typeof source.data === "string" ? source.data.replace(/\s+/gu, "") : "";
      if (!mimeType || base64.length === 0 || !BASE64_PATTERN.test(base64)) return block;
      const bytes = new Uint8Array(Buffer.from(base64, "base64"));
      const attachmentId = attachmentIdFor(threadSegment, bytes);
      files.push({
        relativePath: `${attachmentId}${inferImageExtension({ mimeType })}`,
        bytes,
      });
      changed = true;
      return { type: "image", mimeType, attachmentId };
    });
    return changed ? { ...record, content } : result;
  };

  const result = moveImages(data.result);
  const item = asRecord(data.item);
  const itemResult = item ? moveImages(item.result) : undefined;
  if (files.length === 0) return null;
  return {
    payload: {
      ...payload,
      data: {
        ...data,
        ...(result !== data.result ? { result } : {}),
        ...(item && itemResult !== item.result ? { item: { ...item, result: itemResult } } : {}),
      },
    },
    files,
  };
}

/**
 * Writes a snapshot activity's images to the attachments directory and
 * returns the activity referencing them. Any failure leaves the activity as
 * it was: a cut picture is no worse than before, and the row must still land.
 */
export const storeSnapshotImages = Effect.fn("storeSnapshotImages")(function* <
  A extends { readonly payload: unknown; readonly summary: string },
>(input: { readonly activity: A; readonly threadId: string; readonly attachmentsDir: string }) {
  const externalized = externalizeSnapshotImages({
    payload: input.activity.payload,
    summary: input.activity.summary,
    threadId: input.threadId,
  });
  if (externalized === null) return input.activity;
  const nowSeconds = (yield* Clock.currentTimeMillis) / 1000;
  return yield* Effect.tryPromise({
    try: async () => {
      await NodeFSP.mkdir(input.attachmentsDir, { recursive: true });
      for (const file of externalized.files) {
        const path = NodePath.join(input.attachmentsDir, file.relativePath);
        try {
          await NodeFSP.writeFile(path, file.bytes, { flag: "wx" });
        } catch (cause) {
          if ((cause as { readonly code?: unknown }).code !== "EEXIST") throw cause;
          // The same picture again: restart its retention clock instead.
          await NodeFSP.utimes(path, nowSeconds, nowSeconds);
        }
      }
      return { ...input.activity, payload: externalized.payload };
    },
    catch: (cause) => new SnapshotImageStoreError({ cause }),
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("snapshot image could not be stored as an attachment", {
        threadId: input.threadId,
        cause: String(cause),
      }).pipe(Effect.as(input.activity)),
    ),
  );
});
