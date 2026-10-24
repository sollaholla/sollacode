import { resolveReadImagePreview } from "@t3tools/client-runtime/state/read-image-preview";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  LoaderCircleIcon,
  XIcon,
} from "lucide-react";

import { useAssetUrlState, withAssetRevision } from "../../assets/assetUrls";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  expandedImageItemKey,
  type ExpandedImageAsset,
  type ExpandedImageItem,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";
import { SwipeableImageArea } from "./SwipeableImageArea";
import { ZoomableImage } from "./ZoomableImage";

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

interface ImageViewProps {
  readonly className: string;
  readonly surfaceClassName: string;
}

/** Tells the viewer, once, that an image can't be shown, so it leaves the gallery. */
type ReportUnavailable = (itemKey: string) => void;

function useReportUnavailable(
  unavailable: boolean,
  itemKey: string,
  onUnavailable: ReportUnavailable,
) {
  useEffect(() => {
    if (unavailable) onUnavailable(itemKey);
  }, [itemKey, onUnavailable, unavailable]);
}

/** Where an asset image loads from: its file, else the copy a tool kept, else nowhere. */
function useAssetImageSource(asset: ExpandedImageAsset) {
  const state = useAssetUrlState(asset.environmentId, asset.resource);
  const [failedSrcs, setFailedSrcs] = useState<ReadonlySet<string>>(() => new Set());
  const preview = resolveReadImagePreview({
    assetFailed: state._tag === "Failure",
    assetUrl: state._tag === "Success" ? withAssetRevision(state.url, asset.revision) : null,
    storedSrc: asset.fallbackSrc ?? null,
    failedSrcs,
  });
  const fail = useCallback(
    (src: string) => setFailedSrcs((previous) => new Set(previous).add(src)),
    [],
  );
  return { preview, fail };
}

interface ItemProps {
  readonly item: ExpandedImageItem;
  readonly itemKey: string;
  readonly onUnavailable: ReportUnavailable;
}

/** The shown image: a ready URL, or an asset fetched now that it has come up. */
function ExpandedImageContent({
  item,
  itemKey,
  onUnavailable,
  ...view
}: ImageViewProps & ItemProps) {
  if ("src" in item) {
    return (
      <ZoomableImage
        src={item.src}
        alt={item.name}
        className={view.className}
        surfaceClassName={view.surfaceClassName}
        onError={() => onUnavailable(itemKey)}
      />
    );
  }
  return (
    <ExpandedAssetImage
      asset={item.asset}
      name={item.name}
      itemKey={itemKey}
      onUnavailable={onUnavailable}
      {...view}
    />
  );
}

function ExpandedAssetImage({
  asset,
  name,
  itemKey,
  onUnavailable,
  className,
  surfaceClassName,
}: ImageViewProps & Omit<ItemProps, "item"> & { asset: ExpandedImageAsset; name: string }) {
  const { preview, fail } = useAssetImageSource(asset);
  useReportUnavailable(preview._tag === "Unavailable", itemKey, onUnavailable);
  if (preview._tag === "Image") {
    const src = preview.src;
    return (
      <ZoomableImage
        key={src}
        src={src}
        alt={name}
        className={className}
        surfaceClassName={surfaceClassName}
        onError={() => fail(src)}
      />
    );
  }
  return (
    <div className={cn(surfaceClassName, "flex min-h-48 min-w-64 items-center justify-center")}>
      {preview._tag === "Loading" ? (
        <LoaderCircleIcon
          className="size-6 animate-spin text-muted-foreground"
          aria-label="Loading image"
        />
      ) : null}
    </div>
  );
}

/**
 * Starts fetching a neighbouring image, so swiping to it shows it at once, and
 * finds out ahead of the swipe when it can't be shown.
 */
function PreloadImage({ item, itemKey, onUnavailable }: ItemProps) {
  if ("src" in item) {
    return (
      <img
        src={item.src}
        alt=""
        aria-hidden
        className="hidden"
        onError={() => onUnavailable(itemKey)}
      />
    );
  }
  return <PreloadAssetImage asset={item.asset} itemKey={itemKey} onUnavailable={onUnavailable} />;
}

function PreloadAssetImage({
  asset,
  itemKey,
  onUnavailable,
}: Omit<ItemProps, "item"> & { asset: ExpandedImageAsset }) {
  const { preview, fail } = useAssetImageSource(asset);
  useReportUnavailable(preview._tag === "Unavailable", itemKey, onUnavailable);
  if (preview._tag !== "Image") return null;
  const src = preview.src;
  return <img src={src} alt="" aria-hidden className="hidden" onError={() => fail(src)} />;
}

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  onClose,
  fullScreenMobile = false,
}: ExpandedImageDialogProps) {
  // Which side the shown image came in from, so it slides in from there.
  const [enterFrom, setEnterFrom] = useState<-1 | 1 | null>(null);
  const [mobileHistoryEntryId] = useState(
    () => `image-preview-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  // Images found to be gone or undecodable leave the gallery rather than
  // showing an empty frame: the shown one, or a neighbour while preloading.
  const [unavailableKeys, setUnavailableKeys] = useState<ReadonlySet<string>>(() => new Set());
  const markUnavailable = useCallback(
    (itemKey: string) =>
      setUnavailableKeys((previous) =>
        previous.has(itemKey) ? previous : new Set(previous).add(itemKey),
      ),
    [],
  );
  const entries = useMemo(
    () => preview.images.map((item, at) => ({ item, key: `${at}:${expandedImageItemKey(item)}` })),
    [preview.images],
  );
  const visible = useMemo(
    () => entries.filter((entry) => !unavailableKeys.has(entry.key)),
    [entries, unavailableKeys],
  );
  // The shown image, and its place in case it leaves: the next one takes it.
  const [position, setPosition] = useState(() => ({
    key: entries[preview.index]?.key ?? "",
    at: preview.index,
  }));
  const count = visible.length;
  const found = visible.findIndex((entry) => entry.key === position.key);
  const index = found >= 0 ? found : Math.max(0, Math.min(position.at, count - 1));

  const navigateImage = useCallback(
    (direction: -1 | 1) => {
      if (count === 0) return;
      const next = (index + direction + count) % count;
      setPosition({ key: visible[next]?.key ?? "", at: next });
      setEnterFrom(direction);
    },
    [count, index, visible],
  );

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
      if (count <= 1) return;
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
  }, [count, dismiss, navigateImage]);

  // Nothing left that can be shown.
  useEffect(() => {
    if (count === 0) dismiss();
  }, [count, dismiss]);

  const shown = visible[index];
  if (!shown) return null;
  const { item, key: itemKey } = shown;
  const neighbours =
    count > 1 ? [visible[(index + 1) % count], visible[(index - 1 + count) % count]] : [];
  const preloads = (
    <>
      {neighbours.map((neighbour) =>
        neighbour && neighbour.key !== itemKey ? (
          <PreloadImage
            key={neighbour.key}
            item={neighbour.item}
            itemKey={neighbour.key}
            onUnavailable={markUnavailable}
          />
        ) : null,
      )}
    </>
  );

  if (fullScreenMobile) {
    return (
      <div
        className="fixed inset-0 z-[9000] flex h-[100dvh] w-screen flex-col overflow-hidden bg-black text-white pt-safe pb-safe pl-safe pr-safe [-webkit-app-region:no-drag]"
        data-mobile-fullscreen-image-viewer
        role="dialog"
        aria-modal="true"
        aria-label="Expanded image preview"
      >
        {/* One dismissal control only. The back arrow doubles as the phone's
            own back gesture, which this viewer already registers, so the extra
            X beside it just asked the same question twice. */}
        <header className="relative z-20 flex shrink-0 items-center px-2 py-2">
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
        </header>

        <div className="relative flex min-h-0 flex-1 items-center justify-center px-2">
          {count > 1 && (
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
          <SwipeableImageArea
            enabled={count > 1}
            onSwipe={navigateImage}
            slideKey={itemKey}
            enterFrom={enterFrom}
            className="absolute inset-0"
            contentClassName="absolute inset-0"
          >
            {/* Keyed per image, so moving to another image starts it unzoomed. */}
            <ExpandedImageContent
              key={itemKey}
              item={item}
              itemKey={itemKey}
              onUnavailable={markUnavailable}
              className="max-h-full max-w-full object-contain"
              surfaceClassName="absolute inset-0 flex items-center justify-center overflow-hidden px-2"
            />
          </SwipeableImageArea>
          {preloads}
          {count > 1 && (
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
          {count > 1 ? ` (${index + 1}/${count})` : ""}
        </p>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
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
      {count > 1 && (
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
          className="absolute right-2 top-2 z-10"
          onClick={dismiss}
          aria-label="Close image preview"
        >
          <XIcon />
        </Button>
        <SwipeableImageArea
          enabled={count > 1}
          onSwipe={navigateImage}
          slideKey={itemKey}
          enterFrom={enterFrom}
        >
          <ExpandedImageContent
            key={itemKey}
            item={item}
            itemKey={itemKey}
            onUnavailable={markUnavailable}
            className="block max-h-[86vh] max-w-[92vw] object-contain"
            surfaceClassName="overflow-hidden rounded-lg border border-border/70 bg-background shadow-2xl"
          />
        </SwipeableImageArea>
        {preloads}
        <p className="mt-2 max-w-[92vw] truncate text-center text-xs text-muted-foreground/80">
          {item.name}
          {count > 1 ? ` (${index + 1}/${count})` : ""}
        </p>
      </div>
      {count > 1 && (
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
