import { useEffect, useState } from "react";
import { FlatList, Image, Modal, Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { EventId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { assetThumbnailUrl } from "@t3tools/client-runtime/state/assets";
import { resolveReadImagePreview } from "@t3tools/client-runtime/state/read-image-preview";
import type { ThreadImage } from "@t3tools/client-runtime/state/thread-images";
import {
  workLogImageLayout,
  WORK_LOG_IMAGE_ROW_HEIGHT,
  type WorkLogImage,
} from "@t3tools/client-runtime/state/work-log-images";
import { useAssetUrlState } from "../../state/assets";
import { AppText as Text } from "../../components/AppText";
import { ThreadImageViewer } from "./ThreadImageViewer";
import {
  pressedThreadImage,
  type ThreadImageGallery,
  type ThreadImageGalleryOpener,
} from "./threadImageGallery";

type ImageContext = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly imageGallery: ThreadImageGalleryOpener;
};

type TileContext = Omit<ImageContext, "imageGallery"> & {
  /** Opens the tapped image, shown with the URL its thumbnail loaded. */
  readonly onOpen: (pressed: ThreadImage) => void;
  /** An image that is gone or can't be decoded leaves the feed instead of showing a blank tile. */
  readonly onUnavailable: (imageId: string) => void;
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

function ImageTile(props: TileContext & { image: WorkLogImage; gallery?: boolean }) {
  const { image } = props;
  return image.kind === "stored" ? (
    <StoredImageTile {...props} image={image} />
  ) : (
    <AssetImageTile {...props} image={image} />
  );
}

function AssetImageTile({
  image,
  gallery = false,
  ...ctx
}: TileContext & {
  image: Exclude<WorkLogImage, { kind: "stored" }>;
  gallery?: boolean;
}) {
  const asset = useAssetUrlState(
    ctx.environmentId,
    image.kind === "attachment"
      ? { _tag: "attachment", attachmentId: image.attachmentId }
      : {
          _tag: "workspace-file",
          threadId: ctx.threadId,
          path: image.path,
          sourceActivityId: EventId.make(image.sourceActivityId),
        },
  );
  const [failedSrcs, setFailedSrcs] = useState<ReadonlySet<string>>(() => new Set());
  const originalUrl = asset._tag === "Success" ? asset.url : null;
  // A small copy: the whole image is fetched only when it is opened.
  const thumbnailUrl = originalUrl === null ? null : assetThumbnailUrl(originalUrl);
  const preview = resolveReadImagePreview({
    assetFailed: asset._tag === "Failure",
    assetUrl: thumbnailUrl,
    storedSrc: image.kind === "file" ? (image.inlineSrc ?? null) : null,
    failedSrcs,
  });
  const unavailable = preview._tag === "Unavailable";
  useReportUnavailable(unavailable, image.id, ctx.onUnavailable);
  if (unavailable) return null;
  const src = preview._tag === "Image" ? preview.src : null;
  const openSrc = src === thumbnailUrl ? originalUrl : src;
  return (
    <ImageTileFrame
      image={image}
      gallery={gallery}
      src={src}
      onFailed={(failed) => setFailedSrcs((previous) => new Set(previous).add(failed))}
      onPressImage={() => {
        if (openSrc) ctx.onOpen(pressedThreadImage(image.id, image.name, openSrc));
      }}
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
      onFailed={() => setFailed(true)}
      onPressImage={() => ctx.onOpen(pressedThreadImage(image.id, image.name, image.src))}
    />
  );
}

function ImageTileFrame({
  image,
  gallery,
  src,
  onFailed,
  onPressImage,
}: {
  image: WorkLogImage;
  gallery: boolean;
  /** What the tile draws: a thumbnail, or the stored copy. */
  src: string | null;
  onFailed: (src: string) => void;
  onPressImage: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open image: ${image.name}`}
      disabled={!src}
      onPress={onPressImage}
      className="overflow-hidden rounded-md border border-neutral-200 bg-neutral-100 dark:border-white/10 dark:bg-white/5"
      style={gallery ? { width: "31%", margin: 4 } : { width: 44, height: 44 }}
    >
      <View style={{ height: gallery ? 112 : 42, alignItems: "center", justifyContent: "center" }}>
        {src ? (
          <Image
            source={{ uri: src }}
            resizeMode="contain"
            style={{ width: "100%", height: "100%" }}
            onError={() => onFailed(src)}
          />
        ) : (
          <Text className="text-xs text-foreground-muted">…</Text>
        )}
      </View>
      {gallery ? (
        <Text numberOfLines={1} className="px-2 py-1.5 text-xs text-foreground-muted">
          {image.name}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function CollapsedWorkLogImages({
  images,
  imageGallery,
  ...ctx
}: ImageContext & { images: readonly WorkLogImage[] }) {
  const [width, setWidth] = useState(126);
  const [open, setOpen] = useState(false);
  // The sheet is its own modal, so an image opened from it is viewed inside it.
  const [sheetGallery, setSheetGallery] = useState<ThreadImageGallery | null>(null);
  const { visible, remaining } = workLogImageLayout(images.length, width);
  if (images.length === 0) return null;
  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <View
        style={{
          height: WORK_LOG_IMAGE_ROW_HEIGHT,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          overflow: "hidden",
        }}
      >
        {images.slice(0, visible).map((image) => (
          <ImageTile
            key={image.id}
            image={image}
            {...ctx}
            onOpen={(pressed) => imageGallery.open(imageGallery.galleryFor(pressed))}
            onUnavailable={imageGallery.markUnavailable}
          />
        ))}
        {remaining > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`View all ${images.length} images`}
            onPress={() => setOpen(true)}
            className="items-center justify-center rounded-md border border-neutral-200 bg-neutral-100 dark:border-white/10 dark:bg-white/5"
            style={{ width: 76, height: 44, flexShrink: 1 }}
          >
            <Text className="text-xs text-foreground-muted">+{remaining} more</Text>
          </Pressable>
        ) : null}
      </View>
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <SafeAreaView className="flex-1 bg-background">
          <View className="flex-row items-center justify-between px-5 pb-3 pt-4">
            <View>
              <Text className="font-t3-semibold text-lg text-foreground">Images viewed</Text>
              <Text className="text-xs text-foreground-muted">
                {images.length} images from this work log
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={() => setOpen(false)}
              className="min-h-11 justify-center px-3"
            >
              <Text className="text-sm text-foreground">Done</Text>
            </Pressable>
          </View>
          {open ? (
            <FlatList
              data={images}
              keyExtractor={(image) => image.id}
              numColumns={3}
              initialNumToRender={12}
              windowSize={5}
              contentContainerStyle={{ padding: 12 }}
              renderItem={({ item }) => (
                <ImageTile
                  image={item}
                  gallery
                  {...ctx}
                  onOpen={(pressed) => setSheetGallery(imageGallery.galleryFor(pressed))}
                  onUnavailable={imageGallery.markUnavailable}
                />
              )}
            />
          ) : null}
          <ThreadImageViewer
            environmentId={ctx.environmentId}
            gallery={sheetGallery}
            onClose={() => setSheetGallery(null)}
            onUnavailable={imageGallery.markUnavailable}
          />
        </SafeAreaView>
      </Modal>
    </View>
  );
}
