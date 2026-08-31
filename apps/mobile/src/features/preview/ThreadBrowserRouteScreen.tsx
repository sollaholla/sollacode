import { useFocusEffect, type StaticScreenProps } from "@react-navigation/native";
import {
  EnvironmentId,
  ThreadId,
  type PreviewRemoteInputAction,
  type PreviewRemoteSnapshotResult,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  PanResponder,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { previewEnvironment } from "../../state/preview";
import { closeRemoteBrowserTab, openRemoteBrowserTab } from "./threadBrowserRouteActions";
import {
  FRAME_TAP_SLOP_PX,
  resolveFrameGesture,
  type FrameGestureSample,
  type FrameSize,
} from "./remoteFrameGestures";

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
 * Near-live view and touch control of the desktop host's real collaborative
 * browser. Frames come through the existing environment WebSocket, so
 * remote/Tailscale connections retain the desktop's cookies and authenticated
 * page state. Touches are forwarded as frame fractions through the same
 * automation operations agents use; the desktop keeps rendering its own guest.
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
  const sendRemoteInput = useAtomCommand(previewEnvironment.remoteInput, {
    reportFailure: false,
  });
  const selectedSession =
    sessions.find((session) => session.tabId === selectedTabId) ?? sessions[0] ?? null;
  const frameLayoutRef = useRef<FrameSize | null>(null);
  const gestureRef = useRef<Omit<FrameGestureSample, "end"> | null>(null);
  const [frameInteracting, setFrameInteracting] = useState(false);
  const [keyboardText, setKeyboardText] = useState("");

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

  const dispatchInput = useCallback(
    async (action: PreviewRemoteInputAction) => {
      const tabId = selectedTabIdRef.current;
      if (tabId === null) return;
      const result = await sendRemoteInput({
        environmentId,
        input: { threadId, tabId, action },
      });
      if (result._tag === "Failure") {
        setFrameError(commandError(result.cause, "The desktop browser did not accept the input."));
        return;
      }
      setFrameError(null);
      // Show the gesture's effect right away instead of waiting for the poll.
      await capture();
    },
    [capture, environmentId, sendRemoteInput, threadId],
  );
  const dispatchInputRef = useRef(dispatchInput);
  dispatchInputRef.current = dispatchInput;

  const framePanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // The surrounding screen scrolls; once a touch begins on the frame it
        // belongs to the page under it and must not be stolen mid-gesture.
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (event) => {
          gestureRef.current = {
            startedAt: Date.now(),
            start: { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY },
            maxDistancePx: 0,
            firstMovedAt: null,
          };
          setFrameInteracting(true);
        },
        onPanResponderMove: (_event, gestureState) => {
          const gesture = gestureRef.current;
          if (gesture === null) return;
          const distance = Math.hypot(gestureState.dx, gestureState.dy);
          gestureRef.current = {
            ...gesture,
            maxDistancePx: Math.max(gesture.maxDistancePx, distance),
            // The drag-hold clock starts when the finger truly leaves the tap
            // slop; grant-time jitter must not count as movement.
            firstMovedAt:
              gesture.firstMovedAt === null && distance > FRAME_TAP_SLOP_PX
                ? Date.now()
                : gesture.firstMovedAt,
          };
        },
        onPanResponderRelease: (_event, gestureState) => {
          const gesture = gestureRef.current;
          gestureRef.current = null;
          setFrameInteracting(false);
          const layout = frameLayoutRef.current;
          if (gesture === null || layout === null) return;
          const action = resolveFrameGesture(layout, {
            ...gesture,
            end: {
              x: gesture.start.x + gestureState.dx,
              y: gesture.start.y + gestureState.dy,
            },
          });
          if (action !== null) void dispatchInputRef.current(action);
        },
        onPanResponderTerminate: () => {
          gestureRef.current = null;
          setFrameInteracting(false);
        },
      }),
    [],
  );

  const sendKeyboardText = async () => {
    const text = keyboardText;
    if (text.length === 0) return;
    setKeyboardText("");
    await dispatchInput({ kind: "type", text });
  };

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
      scrollEnabled={!frameInteracting}
    >
      <View className="min-w-0 flex-row items-center gap-2">
        <View className="min-w-0 flex-1">
          <Text className="text-xl font-t3-bold text-foreground">Host browser</Text>
          <Text className="text-sm text-foreground-muted">
            Live frames from the desktop tab — your touches are forwarded
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
              <View
                accessibilityLabel={`Rendered browser tab ${frame.title || frame.url}. Touches are sent to the desktop tab.`}
                pointerEvents="box-only"
                onLayout={(event) => {
                  frameLayoutRef.current = {
                    width: event.nativeEvent.layout.width,
                    height: event.nativeEvent.layout.height,
                  };
                }}
                {...framePanResponder.panHandlers}
              >
                <Image
                  resizeMode="contain"
                  source={{
                    uri: `data:${frame.screenshot.mimeType};base64,${frame.screenshot.data}`,
                  }}
                  style={{
                    width: "100%",
                    aspectRatio: frame.screenshot.width / frame.screenshot.height,
                  }}
                />
              </View>
            ) : (
              <View className="min-h-72 items-center justify-center gap-3 px-6">
                <ActivityIndicator color="#ffffff" />
                <Text className="text-center text-sm text-white/70">
                  Waiting for the desktop browser host…
                </Text>
              </View>
            )}
          </View>

          {frame ? (
            <View className="min-w-0 gap-2 rounded-2xl border border-border bg-sheet p-3">
              <Text className="text-xs text-foreground-muted">
                Tap, scroll, and hold-to-drag on the frame are sent to the desktop tab. Tap a field
                first, then type here.
              </Text>
              <View className="min-w-0 flex-row items-center gap-2">
                <TextInput
                  accessibilityLabel="Text to type into the desktop tab"
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="min-h-11 min-w-0 flex-1 rounded-xl border border-border bg-screen px-3 py-2 text-sm text-foreground"
                  placeholder="Type into the page"
                  value={keyboardText}
                  onChangeText={setKeyboardText}
                  onSubmitEditing={() => void sendKeyboardText()}
                />
                <Pressable
                  accessibilityLabel="Send text to the desktop tab"
                  accessibilityRole="button"
                  className="min-h-11 items-center justify-center rounded-xl bg-primary px-4 disabled:opacity-50"
                  disabled={keyboardText.length === 0}
                  onPress={() => void sendKeyboardText()}
                >
                  <Text className="font-t3-bold text-primary-foreground">Type</Text>
                </Pressable>
              </View>
              <View className="min-w-0 flex-row flex-wrap gap-2">
                <Pressable
                  accessibilityLabel="Press Enter in the desktop tab"
                  accessibilityRole="button"
                  className="min-h-11 items-center justify-center rounded-xl border border-border px-4"
                  onPress={() => void dispatchInput({ kind: "press", key: "Enter" })}
                >
                  <Text className="font-t3-bold text-foreground">Enter</Text>
                </Pressable>
                <Pressable
                  accessibilityLabel="Press Backspace in the desktop tab"
                  accessibilityRole="button"
                  className="min-h-11 items-center justify-center rounded-xl border border-border px-4"
                  onPress={() => void dispatchInput({ kind: "press", key: "Backspace" })}
                >
                  <Text className="font-t3-bold text-foreground">⌫</Text>
                </Pressable>
                <Pressable
                  accessibilityLabel="Press Tab in the desktop tab"
                  accessibilityRole="button"
                  className="min-h-11 items-center justify-center rounded-xl border border-border px-4"
                  onPress={() => void dispatchInput({ kind: "press", key: "Tab" })}
                >
                  <Text className="font-t3-bold text-foreground">Tab</Text>
                </Pressable>
                <Pressable
                  accessibilityLabel="Press Escape in the desktop tab"
                  accessibilityRole="button"
                  className="min-h-11 items-center justify-center rounded-xl border border-border px-4"
                  onPress={() => void dispatchInput({ kind: "press", key: "Escape" })}
                >
                  <Text className="font-t3-bold text-foreground">Esc</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

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
