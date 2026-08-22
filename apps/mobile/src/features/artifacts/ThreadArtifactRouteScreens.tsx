import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  EnvironmentId,
  ThreadArtifactId,
  ThreadId,
  type AssetResource,
  type ThreadArtifactSummary,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, View } from "react-native";
import { WebView } from "react-native-webview";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { useAssetUrl } from "../../state/assets";
import { useEnvironmentQuery } from "../../state/query";
import { threadArtifactEnvironment } from "../../state/threadArtifacts";
import { useAtomCommand } from "../../state/use-atom-command";
import { isAllowedArtifactNavigation } from "./artifactNavigation";

type ThreadArtifactListRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

function ArtifactIcon(props: {
  readonly environmentId: EnvironmentId;
  readonly summary: ThreadArtifactSummary;
}) {
  const uri = useAssetUrl(props.environmentId, props.summary.iconResource);
  return uri ? (
    <Image accessibilityIgnoresInvertColors source={{ uri }} className="size-10 rounded-xl" />
  ) : (
    <View className="size-10 items-center justify-center rounded-xl bg-primary/10">
      <Text className="text-lg font-t3-bold text-primary">A</Text>
    </View>
  );
}

function useArtifactList(environmentId: EnvironmentId, threadId: ThreadId) {
  const atom = useMemo(
    () =>
      threadArtifactEnvironment.list({
        environmentId,
        input: { threadId, includeArchived: true },
      }),
    [environmentId, threadId],
  );
  const result = useAtomValue(atom);
  return { result, data: Option.getOrNull(AsyncResult.value(result)) };
}

export function ThreadArtifactsRouteScreen({ route }: ThreadArtifactListRouteProps) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const threadId = ThreadId.make(route.params.threadId);
  const { result, data } = useArtifactList(environmentId, threadId);
  const artifacts = data?.artifacts ?? [];

  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="min-w-0 gap-3 px-4 py-5"
    >
      <Text className="text-sm text-foreground-muted">
        Portable previews published by this thread. They stay on the connected host.
      </Text>
      {result._tag === "Failure" ? (
        <EmptyState title="Artifacts unavailable" detail="Reconnect to this host and try again." />
      ) : data === null ? (
        <View className="min-h-32 items-center justify-center gap-3">
          <ActivityIndicator />
          <Text className="text-sm text-foreground-muted">Loading artifacts…</Text>
        </View>
      ) : artifacts.length === 0 ? (
        <EmptyState
          title="No artifacts yet"
          detail="Ask the agent to publish an artifact, then it will appear here on every connected device."
        />
      ) : (
        artifacts.map((summary) => (
          <Pressable
            key={summary.artifact.artifactId}
            accessibilityLabel={`Open ${summary.artifact.title}`}
            accessibilityRole="button"
            className="min-h-14 min-w-0 flex-row items-center gap-3 rounded-2xl border border-border bg-sheet px-3 py-3 active:bg-subtle"
            onPress={() =>
              navigation.navigate("ThreadArtifact", {
                environmentId: String(environmentId),
                threadId: String(threadId),
                artifactId: String(summary.artifact.artifactId),
              })
            }
          >
            <ArtifactIcon environmentId={environmentId} summary={summary} />
            <View className="min-w-0 flex-1">
              <Text className="text-base font-t3-bold text-foreground" numberOfLines={1}>
                {summary.artifact.title}
              </Text>
              <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                {summary.artifact.archivedAt ? "Archived" : summary.artifact.kind} · revision{" "}
                {summary.artifact.currentRevision}
              </Text>
            </View>
          </Pressable>
        ))
      )}
    </ScrollView>
  );
}

type ThreadArtifactRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly artifactId: string;
}>;

function ArtifactWebSurface(props: { readonly title: string; readonly uri: string | null }) {
  const [error, setError] = useState<string | null>(null);

  if (props.uri === null) {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-card px-6">
        <ActivityIndicator />
        <Text className="text-center text-sm text-foreground-muted">Preparing preview…</Text>
      </View>
    );
  }
  const entryUri = props.uri;
  const entryOrigin = new URL(entryUri).origin;

  return (
    <View className="min-h-0 flex-1 bg-card">
      {error ? (
        <View className="border-b border-border bg-sheet px-4 py-2">
          <Text className="text-xs font-t3-bold text-foreground">Preview failed</Text>
          <Text className="text-xs text-foreground-muted">{error}</Text>
        </View>
      ) : null}
      <WebView
        source={{ uri: entryUri }}
        accessibilityLabel={`${props.title} artifact preview`}
        originWhitelist={[`${entryOrigin}/*`, "about:blank"]}
        javaScriptCanOpenWindowsAutomatically={false}
        setSupportMultipleWindows={false}
        allowsBackForwardNavigationGestures={false}
        allowsFullscreenVideo={false}
        onShouldStartLoadWithRequest={(request) => {
          if (isAllowedArtifactNavigation(request.url, entryUri)) return true;
          setError("This artifact tried to leave its signed host surface. Navigation was blocked.");
          return false;
        }}
        onLoadStart={() => setError(null)}
        onError={(event) =>
          setError(event.nativeEvent.description || "The artifact could not be rendered.")
        }
        renderLoading={() => (
          <View className="absolute inset-0 items-center justify-center bg-card">
            <ActivityIndicator />
          </View>
        )}
        startInLoadingState
        style={{ flex: 1, backgroundColor: "transparent" }}
      />
    </View>
  );
}

export function ThreadArtifactRouteScreen({ route }: ThreadArtifactRouteProps) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const threadId = ThreadId.make(route.params.threadId);
  const artifactId = ThreadArtifactId.make(route.params.artifactId);
  const { result: listResult, data: list } = useArtifactList(environmentId, threadId);
  const summary = list?.artifacts.find((entry) => entry.artifact.artifactId === artifactId) ?? null;
  const detailAtom = useMemo(
    () =>
      threadArtifactEnvironment.detail({
        environmentId,
        input: { threadId, artifactId },
      }),
    [artifactId, environmentId, threadId],
  );
  const detail = useEnvironmentQuery(detailAtom);
  // Prefer the live summary so a new publish can raise the update banner even
  // while the bounded revision-detail query remains cached.
  const artifact = summary?.artifact ?? detail.data?.artifact ?? null;
  const [revisionSelection, setRevisionSelection] = useState<{
    readonly artifactId: string;
    readonly revision: number;
  } | null>(null);
  const [mutating, setMutating] = useState(false);
  const displayedRevision =
    revisionSelection?.artifactId === artifactId ? revisionSelection.revision : null;
  const pinnedRevision = displayedRevision ?? artifact?.currentRevision ?? null;
  useEffect(() => {
    if (artifact === null || displayedRevision !== null) return;
    setRevisionSelection({ artifactId, revision: artifact.currentRevision });
  }, [artifact, artifactId, displayedRevision]);
  const revision =
    detail.data?.revisions.find((entry) => entry.revision === pinnedRevision) ??
    (summary?.revision.revision === pinnedRevision ? summary.revision : null);
  const resource = useMemo<AssetResource | null>(() => {
    if (pinnedRevision === null) return null;
    if (summary?.entryResource.revision === pinnedRevision) return summary.entryResource;
    if (detail.data?.entryResource.revision === pinnedRevision) return detail.data.entryResource;
    if (!revision) return null;
    return {
      _tag: "artifact-revision",
      threadId,
      artifactId,
      revision: pinnedRevision,
      path: revision.entryPath,
    };
  }, [artifactId, detail.data, pinnedRevision, revision, summary, threadId]);
  const uri = useAssetUrl(environmentId, resource);
  const archive = useAtomCommand(threadArtifactEnvironment.archive, { reportFailure: false });
  const restore = useAtomCommand(threadArtifactEnvironment.restore, { reportFailure: false });
  const updateAvailable =
    pinnedRevision !== null && artifact !== null && artifact.currentRevision > pinnedRevision;

  const toggleArchived = async () => {
    if (!artifact || mutating) return;
    setMutating(true);
    const command = artifact.archivedAt === null ? archive : restore;
    const outcome = await command({ environmentId, input: { threadId, artifactId } });
    setMutating(false);
    if (outcome._tag === "Failure") {
      Alert.alert(
        artifact.archivedAt === null ? "Could not archive artifact" : "Could not restore artifact",
        "Reconnect to the host and try again.",
      );
    } else {
      detail.refresh();
    }
  };

  if (listResult._tag === "Failure" || detail.error) {
    return (
      <View className="flex-1 items-center justify-center bg-screen px-6">
        <EmptyState title="Artifact unavailable" detail="Reconnect to this host and try again." />
      </View>
    );
  }

  return (
    <View className="min-h-0 min-w-0 flex-1 bg-screen">
      {updateAvailable && artifact ? (
        <View className="min-w-0 flex-row flex-wrap items-center gap-2 border-b border-border bg-sheet px-3 py-2">
          <Text className="min-w-0 flex-1 text-sm text-foreground">
            Revision {artifact.currentRevision} is ready. Viewing revision {pinnedRevision}.
          </Text>
          <Pressable
            accessibilityRole="button"
            className="min-h-11 justify-center rounded-xl border border-border px-3"
            onPress={() => setRevisionSelection({ artifactId, revision: artifact.currentRevision })}
          >
            <Text className="font-t3-bold text-foreground">Use latest</Text>
          </Pressable>
        </View>
      ) : null}
      <View className="min-w-0 flex-row flex-wrap items-center gap-2 border-b border-border bg-sheet px-3 py-2">
        <View className="min-w-0 flex-1">
          <Text className="font-t3-bold text-foreground" numberOfLines={1}>
            {artifact?.title ?? "Artifact"}
          </Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {artifact?.kind ?? "artifact"}
            {pinnedRevision ? ` · revision ${pinnedRevision}` : ""}
          </Text>
        </View>
        {artifact ? (
          <Pressable
            accessibilityRole="button"
            disabled={mutating}
            className="min-h-11 justify-center rounded-xl border border-border px-3"
            onPress={() => void toggleArchived()}
          >
            <Text className="font-t3-bold text-foreground">
              {mutating ? "Saving…" : artifact.archivedAt ? "Restore" : "Archive"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <ArtifactWebSurface title={artifact?.title ?? "Artifact"} uri={uri} />
    </View>
  );
}
