"use client";

import {
  PreviewTabId,
  type EnvironmentId,
  type PreviewRemoteSnapshotResult,
  type ThreadId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

/**
 * Matches the cadence the mobile browser view has shipped with. Every frame
 * costs the host a full automation snapshot — a DOM and accessibility read it
 * then throws away — so this deliberately does not poll faster than the
 * existing consumer until that capture has a frame-only path.
 */
const REMOTE_FRAME_INTERVAL_MS = 2_500;

/**
 * The guest for this tab is a real browser on another machine. Rather than open
 * a second one here — same URL, different cookies, invisible to the agent —
 * show frames captured from the real one.
 */
export function PreviewRemoteSurface(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly visible: boolean;
  readonly className?: string;
}) {
  const { environmentId, threadId, tabId, visible, className } = props;
  const [frame, setFrame] = useState<PreviewRemoteSnapshotResult | null>(null);
  const [stale, setStale] = useState(false);
  const captureRemoteSnapshot = useAtomCommand(previewEnvironment.remoteSnapshot, {
    reportFailure: false,
  });
  // Frames are only meaningful for the tab they were captured from, and the
  // panel can switch tabs while a request is in flight.
  const tabIdRef = useRef(tabId);
  tabIdRef.current = tabId;

  useEffect(() => {
    setFrame((current) => (current?.tabId === tabId ? current : null));
    setStale(false);
  }, [tabId]);

  const capture = useCallback(async () => {
    const requested = tabIdRef.current;
    const result = await captureRemoteSnapshot({
      environmentId,
      input: { threadId, tabId: PreviewTabId.make(requested) },
    });
    if (tabIdRef.current !== requested) return;
    if (result._tag === "Failure") {
      // A dropped frame is usually a page mid-navigation, not a dead host.
      // Keep the last good one on screen and mark it rather than going blank.
      setStale(true);
      return;
    }
    setFrame(result.value);
    setStale(false);
  }, [captureRemoteSnapshot, environmentId, threadId]);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      await capture();
      if (active) timer = setTimeout(() => void tick(), REMOTE_FRAME_INTERVAL_MS);
    };
    void tick();
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [capture, visible]);

  return (
    <div className={cn("flex items-center justify-center overflow-hidden bg-muted/30", className)}>
      {frame ? (
        <img
          src={`data:${frame.screenshot.mimeType};base64,${frame.screenshot.data}`}
          alt={frame.title === "" ? frame.url : frame.title}
          className={cn("h-full w-full object-contain transition-opacity", stale && "opacity-60")}
          draggable={false}
        />
      ) : (
        <p className="px-6 text-center text-sm text-muted-foreground">
          Waiting for a frame from the machine running this environment…
        </p>
      )}
    </div>
  );
}
