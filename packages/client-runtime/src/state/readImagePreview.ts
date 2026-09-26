/**
 * What a read-image row should show right now.
 *
 * A read tool's file and the image it returned are two different things. Tools
 * that read into a scratch directory rewrite or delete the file between the
 * read and the moment anyone scrolls back, so the workspace asset can fail
 * while the bytes the tool handed the model are still in the activity. The row
 * is a record of that read, so the stored copy is a correct answer — but only
 * once the live file has actually failed, since the file is the one that stays
 * current.
 */
export interface ReadImagePreviewInput {
  /** The asset request for the workspace file failed outright. */
  readonly assetFailed: boolean;
  /** Resolved URL for the workspace file, or null while the request is in flight. */
  readonly assetUrl: string | null;
  /** The image the tool returned, as a `data:` URL, when the activity kept one. */
  readonly storedSrc: string | null;
  /** Sources whose `<img>` raised `error`; a decode failure is as final as a 404. */
  readonly failedSrcs: ReadonlySet<string>;
}

export type ReadImagePreviewState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Image"; readonly src: string; readonly stored: boolean }
  | { readonly _tag: "Unavailable" };

export function resolveReadImagePreview(input: ReadImagePreviewInput): ReadImagePreviewState {
  const liveUsable =
    !input.assetFailed && input.assetUrl !== null && !input.failedSrcs.has(input.assetUrl);
  if (liveUsable && input.assetUrl !== null) {
    return { _tag: "Image", src: input.assetUrl, stored: false };
  }
  const liveSettled =
    input.assetFailed || (input.assetUrl !== null && input.failedSrcs.has(input.assetUrl));
  if (!liveSettled) {
    return { _tag: "Loading" };
  }
  if (input.storedSrc !== null && !input.failedSrcs.has(input.storedSrc)) {
    return { _tag: "Image", src: input.storedSrc, stored: true };
  }
  return { _tag: "Unavailable" };
}
