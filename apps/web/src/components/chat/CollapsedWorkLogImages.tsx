import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ImageIcon } from "lucide-react";
import { EventId, type AssetResource, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { assetThumbnailUrl } from "@t3tools/client-runtime/state/assets";
import { resolveReadImagePreview } from "@t3tools/client-runtime/state/read-image-preview";
import {
  workLogImageLayout,
  type WorkLogImage,
} from "@t3tools/client-runtime/state/work-log-images";
import { useAssetUrlState, withAssetRevision } from "../../assets/assetUrls";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

type ImageContext = {
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  /** Opens the image by its id among the conversation's images; `fallback` shows it alone. */
  onImageOpen: (imageId: string, fallback: ExpandedImagePreview) => void;
};

type TileContext = ImageContext & {
  /** An image that is gone or can't be decoded leaves the row instead of showing a blank tile. */
  onUnavailable: (imageId: string) => void;
};

function useReportUnavailable(
  unavailable: boolean,
  imageId: string,
  onUnavailable: (imageId: string) => void,
) {
  useEffect(() => {
    if (unavailable) onUnavailable(imageId);
  }, [imageId, onUnavailable, unavailable]);
}

/** A read file outside a thread can't be fetched: nothing to show. */
function UnreachableTile({ image, onUnavailable }: TileContext & { image: WorkLogImage }) {
  useReportUnavailable(true, image.id, onUnavailable);
  return null;
}

function ImageTile(props: TileContext & { image: WorkLogImage; gallery?: boolean }) {
  const { image } = props;
  if (image.kind === "stored") return <StoredImageTile {...props} image={image} />;
  if (image.kind === "file" && !props.threadId) return <UnreachableTile {...props} />;
  const resource: AssetResource =
    image.kind === "attachment"
      ? { _tag: "attachment", attachmentId: image.attachmentId }
      : {
          _tag: "workspace-file",
          threadId: props.threadId!,
          path: image.path,
          sourceActivityId: EventId.make(image.sourceActivityId),
        };
  return <ResolvedImageTile {...props} resource={resource} />;
}

function ResolvedImageTile({
  image,
  gallery = false,
  resource,
  ...ctx
}: TileContext & { image: WorkLogImage; gallery?: boolean; resource: AssetResource }) {
  const asset = useAssetUrlState(ctx.environmentId, resource);
  const [failedSrcs, setFailedSrcs] = useState<ReadonlySet<string>>(() => new Set());
  const originalUrl =
    asset._tag === "Success" ? withAssetRevision(asset.url, image.revision) : null;
  // A small copy: the whole image is fetched only when it is opened.
  const thumbnailUrl = originalUrl === null ? null : assetThumbnailUrl(originalUrl);
  const preview = resolveReadImagePreview({
    assetFailed: asset._tag === "Failure" || (image.kind === "file" && ctx.threadId === null),
    assetUrl: thumbnailUrl,
    storedSrc: image.kind === "file" ? (image.inlineSrc ?? null) : null,
    failedSrcs,
  });
  const unavailable = preview._tag === "Unavailable";
  useReportUnavailable(unavailable, image.id, ctx.onUnavailable);
  if (unavailable) return null;
  const src = preview._tag === "Image" ? preview.src : null;
  return (
    <ImageTileFrame
      image={image}
      gallery={gallery}
      src={src}
      openSrc={src === thumbnailUrl ? originalUrl : src}
      onFailed={(failed) => setFailedSrcs((previous) => new Set(previous).add(failed))}
      onImageOpen={ctx.onImageOpen}
    />
  );
}

/** The tool result is the only copy, so there is nothing to fetch or fall back to. */
function StoredImageTile({
  image,
  gallery = false,
  ...ctx
}: TileContext & { image: Extract<WorkLogImage, { kind: "stored" }>; gallery?: boolean }) {
  const [failed, setFailed] = useState(false);
  useReportUnavailable(failed, image.id, ctx.onUnavailable);
  if (failed) return null;
  return (
    <ImageTileFrame
      image={image}
      gallery={gallery}
      src={image.src}
      openSrc={image.src}
      onFailed={() => setFailed(true)}
      onImageOpen={ctx.onImageOpen}
    />
  );
}

function ImageTileFrame({
  image,
  gallery,
  src,
  openSrc,
  onFailed,
  onImageOpen,
}: {
  image: WorkLogImage;
  gallery: boolean;
  /** What the tile draws: a thumbnail, or the stored copy. */
  src: string | null;
  /** What opening it shows on its own: the whole image. */
  openSrc: string | null;
  onFailed: (src: string) => void;
  onImageOpen: ImageContext["onImageOpen"];
}) {
  return (
    <button
      type="button"
      className={`min-w-0 overflow-hidden rounded-md border border-[var(--line)] bg-surface-tile text-muted-foreground hover:border-ring/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default ${gallery ? "w-full text-left" : "size-11 shrink-0"}`}
      title={image.kind === "file" ? image.path : image.name}
      aria-label={`Open image: ${image.name}`}
      disabled={!src}
      onClick={() => {
        const opened = openSrc ?? src;
        if (opened)
          onImageOpen(image.id, { images: [{ src: opened, name: image.name }], index: 0 });
      }}
    >
      <span className={`flex items-center justify-center ${gallery ? "h-28 w-full" : "size-full"}`}>
        {src ? (
          <img
            src={src}
            alt={image.name}
            loading="lazy"
            decoding="async"
            className="block size-full object-contain"
            onError={() => onFailed(src)}
          />
        ) : (
          <ImageIcon className="size-4 opacity-40" aria-hidden />
        )}
      </span>
      {gallery ? (
        <span className="block truncate border-t border-[var(--line)] px-2 py-1.5 text-xs">
          {image.name}
        </span>
      ) : null}
    </button>
  );
}

function ImageGallery({ images, ...ctx }: TileContext & { images: readonly WorkLogImage[] }) {
  const [limit, setLimit] = useState(24);
  const scroller = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const hasMore = limit < images.length;
  useEffect(() => {
    if (!hasMore || !more.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setLimit((value) => value + 24);
      },
      { root: scroller.current, rootMargin: "120px" },
    );
    observer.observe(more.current);
    return () => observer.disconnect();
  }, [hasMore, limit]);
  return (
    <div
      ref={scroller}
      className="min-h-0 overflow-y-auto overscroll-contain px-5 pb-5"
      style={{ scrollbarGutter: "stable" }}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {images.slice(0, limit).map((image) => (
          <ImageTile key={image.id} image={image} gallery {...ctx} />
        ))}
      </div>
      {hasMore ? (
        <button
          ref={more}
          type="button"
          className="mt-4 w-full rounded-md border border-border py-2 text-sm text-muted-foreground hover:bg-surface-hover"
          onClick={() => setLimit((value) => value + 24)}
        >
          Load more images
        </button>
      ) : null}
    </div>
  );
}

/**
 * Fixed geometry keeps image loads from changing the timeline's height. An
 * image that turns out to be gone or undecodable drops out of the row, and a
 * row left with none goes with it.
 */
export const CollapsedWorkLogImages = memo(function CollapsedWorkLogImages({
  images: allImages,
  ...imageContext
}: ImageContext & { images: readonly WorkLogImage[] }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(126);
  const [open, setOpen] = useState(false);
  // Images found to be gone or undecodable, which this row stops showing.
  const [unavailable, setUnavailable] = useState<ReadonlySet<string>>(() => new Set());
  const onUnavailable = useCallback(
    (imageId: string) =>
      setUnavailable((previous) =>
        previous.has(imageId) ? previous : new Set(previous).add(imageId),
      ),
    [],
  );
  const ctx: TileContext = { ...imageContext, onUnavailable };
  const images = useMemo(
    () => allImages.filter((image) => !unavailable.has(image.id)),
    [allImages, unavailable],
  );
  const hasImages = images.length > 0;
  const { visible, remaining } = workLogImageLayout(images.length, width);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasImages]);
  if (images.length === 0) return null;
  return (
    <div
      ref={container}
      data-work-log-images
      className="min-w-0 w-full"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div
        className="flex h-[52px] items-center gap-1.5 overflow-hidden"
        aria-label={`${images.length} ${images.length === 1 ? "image" : "images"} viewed`}
      >
        {images.slice(0, visible).map((image) => (
          <ImageTile key={image.id} image={image} {...ctx} />
        ))}
        {remaining > 0 ? (
          <button
            type="button"
            className="h-11 w-[76px] min-w-0 shrink rounded-md border border-[var(--line)] bg-surface-tile px-1 text-[11px] font-medium tabular-nums text-muted-foreground hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            aria-label={`View all ${images.length} images`}
            onClick={() => setOpen(true)}
          >
            +{remaining} more
          </button>
        ) : null}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="flex max-h-[min(80dvh,640px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
          bottomStickOnMobile={false}
        >
          <DialogHeader className="shrink-0 p-5 pr-12">
            <DialogTitle>Images viewed</DialogTitle>
            <DialogDescription>
              {images.length} images from this work log. Select an image to open it.
            </DialogDescription>
          </DialogHeader>
          {open ? (
            <ImageGallery
              images={images}
              {...ctx}
              onImageOpen={(imageId, fallback) => {
                setOpen(false);
                ctx.onImageOpen(imageId, fallback);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
});
