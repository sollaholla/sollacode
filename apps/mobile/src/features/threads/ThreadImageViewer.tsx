import type { ThreadImage } from "@t3tools/client-runtime/state/thread-images";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Image, type ImageURISource, View } from "react-native";
import ImageViewing from "react-native-image-viewing";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { useAssetUrlState } from "../../state/assets";
import type { ThreadImageGallery } from "./threadImageGallery";

/** A transparent pixel for an image that can't load, so the viewer stops spinning on it. */
const BLANK_IMAGE: ImageURISource = {
  uri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
};
/** No uri yet: the viewer spins until the image's URL arrives. */
const PENDING_IMAGE: ImageURISource = {};
/** How many images either side of the shown one to fetch ahead, so a swipe lands on a loaded one. */
const FETCH_AHEAD = 1;

/** Where an asset image loads from, or null once it is known not to load. */
type Settled = ReadonlyMap<string, string | null>;

/** Reports where an asset image loads from, or null when it can't be loaded. */
function AssetImageProbe(props: {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly resource: AssetResource;
  readonly onSettled: (id: string, url: string | null) => void;
}) {
  const state = useAssetUrlState(props.environmentId, props.resource);
  const { id, onSettled } = props;
  const url = state._tag === "Success" ? state.url : null;
  const failed = state._tag === "Failure";
  useEffect(() => {
    if (failed) {
      onSettled(id, null);
      return;
    }
    if (url === null) return;
    let current = true;
    // Reading the size proves the file is still there and decodes, and warms
    // the image cache before the swipe arrives.
    Image.getSize(url).then(
      () => {
        if (current) onSettled(id, url);
      },
      () => {
        if (current) onSettled(id, null);
      },
    );
    return () => {
      current = false;
    };
  }, [failed, id, onSettled, url]);
  return null;
}

/** The uri a gallery image shows, or null while it is still being fetched. */
function imageUri(image: ThreadImage, settled: Settled): string | null | "unavailable" {
  if (image.source.kind === "src") return image.source.src;
  const url = settled.get(image.id);
  if (url === undefined) return null;
  return url ?? image.source.fallbackSrc ?? "unavailable";
}

type ViewerProps = {
  readonly environmentId: EnvironmentId;
  /** Told about an image found to be gone or undecodable, so the feed stops showing it. */
  readonly onUnavailable?: ((imageId: string) => void) | undefined;
  readonly onClose: () => void;
};

function OpenThreadImageViewer(props: ViewerProps & { readonly gallery: ThreadImageGallery }) {
  const { index } = props.gallery;
  const insets = useSafeAreaInsets();
  const [shown, setShown] = useState(index);
  const [settled, setSettled] = useState<Settled>(() => new Map());
  // Images ahead found unable to load leave the pager before the swipe gets
  // there. One already passed keeps its place: removing it would shift the
  // page on screen, so it says it is gone instead.
  const [dropped, setDropped] = useState<ReadonlySet<string>>(() => new Set());
  const images = useMemo(
    () => props.gallery.images.filter((image) => !dropped.has(image.id)),
    [dropped, props.gallery.images],
  );
  const latest = useRef({ images, shown });
  useLayoutEffect(() => {
    latest.current = { images, shown };
  }, [images, shown]);
  // One source object per uri, so an image whose uri hasn't changed isn't
  // measured and drawn again whenever another one arrives.
  const sourceCache = useRef(new Map<string, ImageURISource>());

  const { onUnavailable } = props;
  const onSettled = useCallback(
    (id: string, url: string | null) => {
      setSettled((previous) =>
        previous.has(id) && previous.get(id) === url ? previous : new Map(previous).set(id, url),
      );
      if (url !== null) return;
      const at = latest.current.images.findIndex((image) => image.id === id);
      const image = latest.current.images[at];
      // The copy the tool kept stands in for a file that is gone.
      if (image?.source.kind === "asset" && image.source.fallbackSrc) return;
      onUnavailable?.(id);
      if (at > latest.current.shown) setDropped((previous) => new Set(previous).add(id));
    },
    [onUnavailable],
  );

  const sources = useMemo(
    () =>
      images.map((image) => {
        const uri = imageUri(image, settled);
        if (uri === null) return PENDING_IMAGE;
        if (uri === "unavailable") return BLANK_IMAGE;
        const cached = sourceCache.current.get(uri);
        if (cached) return cached;
        const source = { uri };
        sourceCache.current.set(uri, source);
        return source;
      }),
    [images, settled],
  );

  const keyExtractor = useCallback(
    (_source: unknown, at: number) => images[at]?.id ?? String(at),
    [images],
  );

  const Footer = useCallback(
    ({ imageIndex }: { imageIndex: number }) => {
      const image = images[imageIndex];
      if (!image) return null;
      const unavailable = imageUri(image, settled) === "unavailable";
      return (
        <View
          className="items-center bg-black/50 px-6 pt-3"
          style={{ paddingBottom: insets.bottom + 12 }}
        >
          {unavailable ? (
            <Text className="pb-1 text-center text-sm text-white">
              This image is no longer available.
            </Text>
          ) : null}
          <Text numberOfLines={1} className="text-center text-xs text-white/70">
            {image.name}
            {images.length > 1 ? ` (${imageIndex + 1}/${images.length})` : ""}
          </Text>
        </View>
      );
    },
    [images, insets.bottom, settled],
  );

  const nearby = images.filter(
    (image, at) =>
      Math.abs(at - shown) <= FETCH_AHEAD &&
      image.source.kind === "asset" &&
      !settled.has(image.id),
  );

  return (
    <>
      {nearby.map((image) =>
        image.source.kind === "asset" ? (
          <AssetImageProbe
            key={image.id}
            id={image.id}
            environmentId={props.environmentId}
            resource={image.source.resource}
            onSettled={onSettled}
          />
        ) : null,
      )}
      <ImageViewing
        images={sources}
        keyExtractor={keyExtractor}
        imageIndex={index}
        visible
        onRequestClose={props.onClose}
        onImageIndexChange={setShown}
        FooterComponent={Footer}
        swipeToCloseEnabled
        doubleTapToZoomEnabled
      />
    </>
  );
}

/**
 * The full-screen viewer for a conversation's images: swipe sideways for the
 * next or previous one. Images are fetched as they come up, a neighbour
 * ahead, so a gallery of hundreds costs only what is looked at.
 */
export function ThreadImageViewer(
  props: ViewerProps & { readonly gallery: ThreadImageGallery | null },
) {
  if (props.gallery === null) return null;
  return (
    <OpenThreadImageViewer
      environmentId={props.environmentId}
      gallery={props.gallery}
      onClose={props.onClose}
      onUnavailable={props.onUnavailable}
    />
  );
}
