import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { createContext, type ReactNode, useContext, useMemo } from "react";

/** An image the viewer fetches when it comes up, so a gallery can list ones no tile has loaded. */
export interface ExpandedImageAsset {
  readonly environmentId: EnvironmentId;
  readonly resource: AssetResource;
  /** Changes when the same path is read again, so the browser fetches the new bytes. */
  readonly revision: string;
  /** Shown when the asset can't be fetched, such as the copy a read tool returned. */
  readonly fallbackSrc?: string | undefined;
}

export type ExpandedImageItem =
  | { readonly name: string; readonly src: string }
  | { readonly name: string; readonly asset: ExpandedImageAsset };

/** Identifies an item across renders, whether or not its URL is known yet. */
export function expandedImageItemKey(item: ExpandedImageItem): string {
  return "src" in item
    ? item.src
    : `${item.asset.environmentId}:${JSON.stringify(item.asset.resource)}:${item.asset.revision}`;
}

export interface ExpandedImagePreview {
  images: ExpandedImageItem[];
  index: number;
}

type ExpandedImagePreviewOpener = (preview: ExpandedImagePreview) => void;

interface ExpandedImagePreviewController {
  readonly fullScreenMobile: boolean;
  readonly open: ExpandedImagePreviewOpener;
}

const ExpandedImagePreviewContext = createContext<ExpandedImagePreviewController | null>(null);

export function ExpandedImagePreviewProvider({
  children,
  fullScreenMobile,
  onOpen,
}: {
  readonly children: ReactNode;
  readonly fullScreenMobile: boolean;
  readonly onOpen: ExpandedImagePreviewOpener;
}) {
  const value = useMemo(() => ({ fullScreenMobile, open: onOpen }), [fullScreenMobile, onOpen]);

  return (
    <ExpandedImagePreviewContext.Provider value={value}>
      {children}
    </ExpandedImagePreviewContext.Provider>
  );
}

/** A new key for each image opened, so the viewer starts fresh rather than where it was. */
export function expandedImagePreviewKey(preview: ExpandedImagePreview): string {
  const opened = preview.images[preview.index];
  return `${opened ? expandedImageItemKey(opened) : "image"}:${preview.index}`;
}

export function useExpandedImagePreviewController(): ExpandedImagePreviewController | null {
  return useContext(ExpandedImagePreviewContext);
}

export function buildExpandedImagePreview(
  images: ReadonlyArray<{ id: string; name: string; previewUrl?: string }>,
  selectedImageId: string,
): ExpandedImagePreview | null {
  const previewableImages = images.flatMap((image) =>
    image.previewUrl ? [{ id: image.id, src: image.previewUrl, name: image.name }] : [],
  );
  if (previewableImages.length === 0) {
    return null;
  }
  const selectedIndex = previewableImages.findIndex((image) => image.id === selectedImageId);
  if (selectedIndex < 0) {
    return null;
  }
  return {
    images: previewableImages.map((image) => ({
      src: image.src,
      name: image.name,
    })),
    index: selectedIndex,
  };
}
