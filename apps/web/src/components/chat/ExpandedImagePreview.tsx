import { createContext, type ReactNode, useContext, useMemo } from "react";

export interface ExpandedImageItem {
  src: string;
  name: string;
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
