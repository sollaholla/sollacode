import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Image, Pressable, View } from "react-native";
import ImageViewing from "react-native-image-viewing";
import { AsyncResult } from "effect/unstable/reactivity";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { workspaceFileImageAtom } from "./workspace-file-image-cache";

/** Opens the full-screen view elsewhere, such as the conversation's image gallery. */
type OpenFullScreen = ((uri: string) => void) | undefined;
/** Hands an image that can't be shown back to its owner, which shows nothing instead. */
type OnUnavailable = ((uri: string) => void) | undefined;

function useReportUnavailable(failed: boolean, uri: string, onUnavailable: OnUnavailable) {
  useEffect(() => {
    if (failed) onUnavailable?.(uri);
  }, [failed, onUnavailable, uri]);
}

function ResolvedWorkspaceFileImagePreview(props: {
  readonly accessibilityLabel: string;
  readonly uri: string;
  readonly onOpenFullScreen?: OpenFullScreen;
  readonly onUnavailable?: OnUnavailable;
}) {
  const [loadError, setLoadError] = useState<string | null>(null);
  useReportUnavailable(loadError !== null, props.uri, props.onUnavailable);
  const [fullScreenVisible, setFullScreenVisible] = useState(false);
  const imageSource = useMemo(
    () => ({ uri: props.uri, cache: "force-cache" as const }),
    [props.uri],
  );
  const fullScreenImages = useMemo(() => [imageSource], [imageSource]);

  return (
    <View className="relative flex-1 bg-subtle">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open full-screen preview of ${props.accessibilityLabel}`}
        disabled={loadError !== null}
        className="flex-1 p-4 active:bg-subtle-strong"
        onPress={() =>
          props.onOpenFullScreen ? props.onOpenFullScreen(props.uri) : setFullScreenVisible(true)
        }
      >
        <Image
          accessible={false}
          source={imageSource}
          className="h-full w-full"
          resizeMode="contain"
          onLoadStart={() => setLoadError(null)}
          onError={(event) => {
            setLoadError(event.nativeEvent.error || "The image could not be rendered.");
          }}
        />
      </Pressable>

      {loadError !== null && !props.onUnavailable ? (
        <View className="absolute inset-0 items-center justify-center bg-card px-6">
          <EmptyState title="Image unavailable" detail={loadError} />
        </View>
      ) : null}

      <ImageViewing
        images={fullScreenImages}
        imageIndex={0}
        visible={fullScreenVisible}
        onRequestClose={() => setFullScreenVisible(false)}
        swipeToCloseEnabled
        doubleTapToZoomEnabled
      />
    </View>
  );
}

function CachedWorkspaceFileImagePreview(props: {
  readonly accessibilityLabel: string;
  readonly uri: string;
  readonly onOpenFullScreen?: OpenFullScreen;
  readonly onUnavailable?: OnUnavailable;
}) {
  const imageAtom = useMemo(() => workspaceFileImageAtom(props.uri), [props.uri]);
  const imageResult = useAtomValue(imageAtom);
  const failed = AsyncResult.isFailure(imageResult);
  useReportUnavailable(failed, props.uri, props.onUnavailable);

  if (failed && props.onUnavailable) return null;
  if (failed) {
    return (
      <View className="flex-1 items-center justify-center bg-card px-6">
        <EmptyState
          title="Image unavailable"
          detail="The image could not be loaded into the local cache."
        />
      </View>
    );
  }

  if (!AsyncResult.isSuccess(imageResult)) {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-card px-6">
        <ActivityIndicator />
        <Text className="text-center text-sm text-foreground-muted">Loading image...</Text>
      </View>
    );
  }

  return (
    <ResolvedWorkspaceFileImagePreview
      accessibilityLabel={props.accessibilityLabel}
      uri={imageResult.value}
      onOpenFullScreen={props.onOpenFullScreen}
      onUnavailable={props.onUnavailable ? () => props.onUnavailable?.(props.uri) : undefined}
    />
  );
}

export function WorkspaceFileImagePreview(props: {
  readonly accessibilityLabel: string;
  readonly uri: string | null;
  readonly onOpenFullScreen?: OpenFullScreen;
  /** When given, an image that can't be shown renders nothing and is reported here. */
  readonly onUnavailable?: OnUnavailable;
}) {
  if (props.uri === null) {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-card px-6">
        <ActivityIndicator />
        <Text className="text-center text-sm text-foreground-muted">
          Preparing image preview...
        </Text>
      </View>
    );
  }

  return (
    <CachedWorkspaceFileImagePreview
      accessibilityLabel={props.accessibilityLabel}
      uri={props.uri}
      onOpenFullScreen={props.onOpenFullScreen}
      onUnavailable={props.onUnavailable}
    />
  );
}
