import { memo, useCallback, useEffect, useState } from "react";
import { ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

interface ExpandedImageDialogProps {
  preview: ExpandedImagePreview;
  onClose: () => void;
  fullScreenMobile?: boolean;
}

const MOBILE_IMAGE_VIEWER_HISTORY_KEY = "__t3MobileImageViewer";

function currentMobileImageViewerHistoryEntry(): unknown {
  const state: unknown = window.history.state;
  if (typeof state !== "object" || state === null) return null;
  return Reflect.get(state, MOBILE_IMAGE_VIEWER_HISTORY_KEY);
}

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  onClose,
  fullScreenMobile = false,
}: ExpandedImageDialogProps) {
  const [imageOffset, setImageOffset] = useState(0);
  const [mobileHistoryEntryId] = useState(
    () => `image-preview-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const index = (preview.index + imageOffset + preview.images.length) % preview.images.length;

  const navigateImage = useCallback((direction: -1 | 1) => {
    setImageOffset((current) => current + direction);
  }, []);

  useEffect(() => {
    if (!fullScreenMobile) return;

    if (currentMobileImageViewerHistoryEntry() !== mobileHistoryEntryId) {
      const state: unknown = window.history.state;
      const previousState = typeof state === "object" && state !== null ? state : {};
      window.history.pushState(
        { ...previousState, [MOBILE_IMAGE_VIEWER_HISTORY_KEY]: mobileHistoryEntryId },
        "",
        window.location.href,
      );
    }

    const handlePopState = () => {
      onClose();
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [fullScreenMobile, mobileHistoryEntryId, onClose]);

  const dismiss = useCallback(() => {
    if (fullScreenMobile && currentMobileImageViewerHistoryEntry() === mobileHistoryEntryId) {
      window.history.back();
      return;
    }
    onClose();
  }, [fullScreenMobile, mobileHistoryEntryId, onClose]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        return;
      }
      if (preview.images.length <= 1) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateImage(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dismiss, navigateImage, preview.images.length]);

  const item = preview.images[index];
  if (!item) return null;

  if (fullScreenMobile) {
    return (
      <div
        className="fixed inset-0 z-[9000] flex h-[100dvh] w-screen flex-col overflow-hidden bg-black text-white pt-safe pb-safe pl-safe pr-safe [-webkit-app-region:no-drag]"
        data-mobile-fullscreen-image-viewer
        role="dialog"
        aria-modal="true"
        aria-label="Expanded image preview"
      >
        <header className="relative z-20 flex shrink-0 items-center justify-between px-2 py-2">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-11 text-white/90 hover:bg-white/10 hover:text-white"
            onClick={dismiss}
            aria-label="Back from image preview"
          >
            <ArrowLeftIcon className="size-5" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-11 text-white/90 hover:bg-white/10 hover:text-white"
            onClick={dismiss}
            aria-label="Close image preview"
          >
            <XIcon className="size-5" />
          </Button>
        </header>

        <div className="relative flex min-h-0 flex-1 items-center justify-center px-2">
          {preview.images.length > 1 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="absolute left-2 top-1/2 z-20 size-11 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white"
              aria-label="Previous image"
              onClick={() => navigateImage(-1)}
            >
              <ChevronLeftIcon className="size-5" />
            </Button>
          )}
          <img
            src={item.src}
            alt={item.name}
            className="max-h-full max-w-full select-none object-contain"
            draggable={false}
          />
          {preview.images.length > 1 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="absolute right-2 top-1/2 z-20 size-11 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white"
              aria-label="Next image"
              onClick={() => navigateImage(1)}
            >
              <ChevronRightIcon className="size-5" />
            </Button>
          )}
        </div>

        <p className="shrink-0 truncate px-4 py-3 text-center text-xs text-white/70">
          {item.name}
          {preview.images.length > 1 ? ` (${index + 1}/${preview.images.length})` : ""}
        </p>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded image preview"
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label="Close image preview"
        onClick={dismiss}
      />
      {preview.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
          aria-label="Previous image"
          onClick={() => navigateImage(-1)}
        >
          <ChevronLeftIcon className="size-5" />
        </Button>
      )}
      <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="absolute right-2 top-2"
          onClick={dismiss}
          aria-label="Close image preview"
        >
          <XIcon />
        </Button>
        <img
          src={item.src}
          alt={item.name}
          className="max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-border/70 bg-background object-contain shadow-2xl"
          draggable={false}
        />
        <p className="mt-2 max-w-[92vw] truncate text-center text-xs text-muted-foreground/80">
          {item.name}
          {preview.images.length > 1 ? ` (${index + 1}/${preview.images.length})` : ""}
        </p>
      </div>
      {preview.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
          aria-label="Next image"
          onClick={() => navigateImage(1)}
        >
          <ChevronRightIcon className="size-5" />
        </Button>
      )}
    </div>
  );
});
