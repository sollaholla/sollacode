import { RegistryContext } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import {
  REMOTE_FRAME_STREAM_GRACE_MS,
  remoteFrameRequestSize,
} from "@t3tools/client-runtime/preview/remote-frame-feed";
import {
  PreviewTabId,
  type EnvironmentId,
  type ThreadId,
  type PreviewRemoteSnapshotResult,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useContext, useRef, useState } from "react";
import { AppState, useWindowDimensions } from "react-native";

import { useEnvironmentServerConfig } from "../../state/entities";
import { previewEnvironment } from "../../state/preview";

/** Native Image consumes pushed keyframes; old hosts retain snapshot polling. */
export function useRemoteBrowserStream(options: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tabId: string | null;
  readonly onFrame: (
    update: (held: PreviewRemoteSnapshotResult | null) => PreviewRemoteSnapshotResult | null,
  ) => void;
  /** A complete stream picture recovered the preview from snapshot fallback. */
  readonly onPicture: () => void;
}) {
  const { environmentId, threadId, tabId } = options;
  const registry = useContext(RegistryContext);
  const supported =
    useEnvironmentServerConfig(environmentId)?.environment.capabilities.remotePreviewFrames ===
    true;
  const dimensions = useWindowDimensions();
  const { maxWidth, maxHeight } = remoteFrameRequestSize({
    boxWidth: Math.max(1, dimensions.width - 32),
    boxHeight: dimensions.height,
    devicePixelRatio: dimensions.scale,
  });
  const onFrame = useRef(options.onFrame);
  onFrame.current = options.onFrame;
  const onPicture = useRef(options.onPicture);
  onPicture.current = options.onPicture;
  const [pollNeeded, setPollNeeded] = useState(true);
  const pollNeededRef = useRef(true);
  const setPolling = useCallback((value: boolean) => {
    pollNeededRef.current = value;
    setPollNeeded(value);
  }, []);
  useFocusEffect(
    useCallback(() => {
      if (!supported || tabId === null) {
        setPolling(true);
        return;
      }
      let stop: (() => void) | undefined;
      const start = () => {
        stop?.();
        let received = false;
        let active = true;
        let state: import("@t3tools/contracts").PreviewRemoteFramePageState | null = null;
        let lastBatch: unknown = null;
        setPolling(false);
        const grace = setTimeout(() => {
          if (!received) setPolling(true);
        }, REMOTE_FRAME_STREAM_GRACE_MS);
        const atom = previewEnvironment.remoteFrames({
          environmentId,
          input: { threadId, tabId: PreviewTabId.make(tabId), maxWidth, maxHeight, patches: false },
        });
        const unsubscribe = registry.subscribe(
          atom,
          (result) => {
            if (!active) return;
            if (AsyncResult.isFailure(result)) {
              setPolling(true);
              return;
            }
            if (!AsyncResult.isSuccess(result) || result.value === lastBatch) return;
            lastBatch = result.value;
            for (const event of result.value) {
              if (event.type === "unavailable") setPolling(true);
              if (event.type === "state") {
                state = event.state;
                const nextState = state;
                onFrame.current((held) =>
                  held === null
                    ? held
                    : {
                        ...held,
                        ...nextState,
                        pendingDownloadApprovals: nextState.pendingDownloadApprovals,
                        agentPointer: nextState.agentPointer,
                      },
                );
              }
              if (event.type === "keyframe") {
                received = true;
                clearTimeout(grace);
                setPolling(false);
                const nextState = state;
                onFrame.current((held) => ({
                  tabId: PreviewTabId.make(tabId),
                  url: nextState?.url ?? held?.url ?? "",
                  title: nextState?.title ?? held?.title ?? "",
                  loading: nextState?.loading ?? false,
                  capturedAt: new Date().toISOString(),
                  pendingDownloadApprovals: nextState?.pendingDownloadApprovals,
                  agentPointer: nextState?.agentPointer,
                  screenshot: {
                    mimeType: "image/jpeg",
                    data: event.data,
                    width: event.width,
                    height: event.height,
                  },
                }));
                onPicture.current();
              }
            }
          },
          { immediate: true },
        );
        stop = () => {
          active = false;
          clearTimeout(grace);
          unsubscribe();
        };
      };
      if (AppState.currentState === "active") start();
      const subscription = AppState.addEventListener("change", (next) => {
        if (next === "active") start();
        else {
          stop?.();
          stop = undefined;
          onFrame.current(() => null);
        }
      });
      return () => {
        stop?.();
        subscription.remove();
      };
    }, [environmentId, maxHeight, maxWidth, registry, supported, tabId, threadId, setPolling]),
  );
  return { pollNeeded, pollNeededRef, onDecodeError: () => setPolling(true) };
}
