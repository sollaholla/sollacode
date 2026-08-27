import { useFocusEffect, type StaticScreenProps } from "@react-navigation/native";
import {
  EnvironmentId,
  ThreadId,
  type PreviewRemoteSnapshotResult,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { previewEnvironment } from "../../state/preview";
import { closeRemoteBrowserTab, openRemoteBrowserTab } from "./threadBrowserRouteActions";

const LIVE_FRAME_INTERVAL_MS = 2_500;

type ThreadBrowserRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

function snapshotTitle(snapshot: PreviewSessionSnapshot): string {
  return snapshot.navStatus._tag === "Idle"
    ? "New tab"
    : snapshot.navStatus.title.trim() || "New tab";
}

function snapshotUrl(snapshot: PreviewSessionSnapshot): string {
  return snapshot.navStatus._tag === "Idle" ? "about:blank" : snapshot.navStatus.url;
}

function commandError(cause: Cause.Cause<unknown>, fallback: string): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

/**
 * Read-only near-live view of the desktop host's real collaborative browser.
 * The frame comes through the existing environment WebSocket, so remote/Tailscale
 * connections retain the desktop's cookies and authenticated page state.
 */
export function ThreadBrowserRouteScreen({ route }: ThreadBrowserRouteProps) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const threadId = ThreadId.make(route.params.threadId);
  const listAtom = useMemo(
    () => previewEnvironment.list({ environmentId, input: { threadId } }),
    [environmentId, threadId],
  );
  const previews = useEnvironmentQuery(listAtom);
  const sessions = previews.data?.sessions ?? [];
  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
  const [frame, setFrame] = useState<PreviewRemoteSnapshotResult | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const selectedTabIdRef = useRef<string | null>(null);
  const captureRemoteSnapshot = useAtomCommand(previewEnvironment.remoteSnapshot, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const closePreview = useAtomCommand(previewEnvironment.close, { reportFailure: false });
  const selectedSession =
    sessions.find((session) => session.tabId === selectedTabId) ?? sessions[0] ?? null;

  useEffect(() => {
    const next = sessions.some((session) => session.tabId === selectedTabId)
      ? selectedTabId
      : (sessions[0]?.tabId ?? null);
    selectedTabIdRef.current = next;
    setSelectedTabId(next);
    setFrame((current) => (current?.tabId === next ? current : null));
  }, [selectedTabId, sessions]);

  const capture = useCallback(async () => {
    const tabId = selectedTabIdRef.current;
    if (tabId === null) return;
    const result = await captureRemoteSnapshot({
      environmentId,
      input: { threadId, tabId },
    });
    if (selectedTabIdRef.current !== tabId) return;
    if (result._tag === "Failure") {
      setFrameError(
        commandError(result.cause, "The desktop browser host did not return a rendered frame."),
      );
      return;
    }
    setFrame(result.value);
    setFrameError(null);
  }, [captureRemoteSnapshot, environmentId, threadId]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const tick = async () => {
        await capture();
        if (active) timer = setTimeout(() => void tick(), LIVE_FRAME_INTERVAL_MS);
      };
      void tick();
      return () => {
        active = false;
        if (timer !== null) clearTimeout(timer);
      };
    }, [capture]),
  );

  const addTab = async () => {
    if (mutating) return;
    setMutating(true);
    await openRemoteBrowserTab({
      environmentId,
      threadId,
      open: openPreview,
      onOpened: (tabId) => {
        selectedTabIdRef.current = tabId;
        setSelectedTabId(tabId);
      },
      onFailure: (cause) =>
        setFrameError(commandError(cause, "A browser tab could not be opened.")),
      refresh: previews.refresh,
    });
    setMutating(false);
  };

  const closeTab = async () => {
    const tabId = selectedTabIdRef.current;
    if (tabId === null || mutating) return;
    setMutating(true);
    await closeRemoteBrowserTab({
      environmentId,
      threadId,
      tabId,
      close: closePreview,
      onClosed: () => setFrame(null),
      onFailure: (cause) =>
        setFrameError(commandError(cause, "The browser tab could not be closed.")),
      refresh: previews.refresh,
    });
    setMutating(false);
  };

  if (previews.isPending && previews.data === null) {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-screen px-6">
        <ActivityIndicator />
        <Text className="text-sm text-foreground-muted">Loading host browser tabs…</Text>
      </View>
    );
  }

  if (previews.error !== null && previews.data === null) {
    return (
      <View className="flex-1 items-center justify-center bg-screen px-6">
        <EmptyState title="Browser unavailable" detail={previews.error} />
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="min-w-0 gap-4 px-4 py-5"
    >
      <View className="min-w-0 flex-row items-center gap-2">
        <View className="min-w-0 flex-1">
          <Text className="text-xl font-t3-bold text-foreground">Host browser</Text>
          <Text className="text-sm text-foreground-muted">
            Live frames from the desktop tab over this connection
          </Text>
        </View>
        <Pressable
          accessibilityLabel="Open browser tab"
          accessibilityRole="button"
          className="min-h-11 items-center justify-center rounded-xl border border-border bg-sheet px-4 disabled:opacity-50"
          disabled={mutating}
          onPress={() => void addTab()}
        >
          <Text className="font-t3-bold text-foreground">New tab</Text>
        </Pressable>
      </View>

      {sessions.length === 0 ? (
        <View className="min-h-72 items-center justify-center rounded-2xl border border-border bg-sheet px-6">
          <EmptyState
            title="No browser tabs"
            detail="Open a tab here or from the connected desktop host."
          />
        </View>
      ) : (
        <>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-2"
          >
            {sessions.map((session) => {
              const selected = session.tabId === selectedTabId;
              return (
                <Pressable
                  key={session.tabId}
                  accessibilityRole="tab"
                  accessibilityState={{ selected }}
                  className={`min-h-11 max-w-64 justify-center rounded-xl border px-4 ${
                    selected ? "border-primary bg-primary/10" : "border-border bg-sheet"
                  }`}
                  onPress={() => {
                    selectedTabIdRef.current = session.tabId;
                    setSelectedTabId(session.tabId);
                    setFrame(null);
                    setFrameError(null);
                  }}
                >
                  <Text className="font-t3-bold text-foreground" numberOfLines={1}>
                    {snapshotTitle(session)}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          <View className="min-w-0 overflow-hidden rounded-2xl border border-border bg-black">
            {frame ? (
              <Image
                accessibilityLabel={`Rendered browser tab ${frame.title || frame.url}`}
                resizeMode="contain"
                source={{
                  uri: `data:${frame.screenshot.mimeType};base64,${frame.screenshot.data}`,
                }}
                style={{
                  width: "100%",
                  aspectRatio: frame.screenshot.width / frame.screenshot.height,
                }}
              />
            ) : (
              <View className="min-h-72 items-center justify-center gap-3 px-6">
                <ActivityIndicator color="#ffffff" />
                <Text className="text-center text-sm text-white/70">
                  Waiting for the desktop browser host…
                </Text>
              </View>
            )}
          </View>

          <View className="min-w-0 gap-1 rounded-2xl border border-border bg-sheet p-4">
            <Text className="font-t3-bold text-foreground" numberOfLines={1}>
              {frame?.title || (selectedSession ? snapshotTitle(selectedSession) : "New tab")}
            </Text>
            <Text className="text-sm text-foreground-muted" numberOfLines={2} selectable>
              {frame?.url || (selectedSession ? snapshotUrl(selectedSession) : "about:blank")}
            </Text>
            <View className="mt-2 min-w-0 flex-row flex-wrap gap-2">
              <Pressable
                accessibilityRole="button"
                className="min-h-11 items-center justify-center rounded-xl bg-primary px-4"
                onPress={() => void capture()}
              >
                <Text className="font-t3-bold text-primary-foreground">Refresh frame</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                className="min-h-11 items-center justify-center rounded-xl border border-border px-4 disabled:opacity-50"
                disabled={mutating}
                onPress={() => void closeTab()}
              >
                <Text className="font-t3-bold text-foreground">Close tab</Text>
              </Pressable>
            </View>
          </View>
        </>
      )}
      {frameError ? (
        <View className="rounded-2xl border border-red-500/25 bg-red-500/8 p-4">
          <Text className="text-sm text-red-700 dark:text-red-300">{frameError}</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}
