import {
  RemoteClickFeedback,
  type RemoteClickMarker,
} from "@t3tools/client-runtime/preview/click-feedback";
import { containedFrameRect, type FrameSize } from "@t3tools/shared/remoteFrameGestures";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";

export function useRemoteClickFeedback(scope: string) {
  const [feedback] = useState(() => new RemoteClickFeedback());
  const markers = useSyncExternalStore(
    feedback.subscribe,
    feedback.getSnapshot,
    feedback.getSnapshot,
  );
  useEffect(() => {
    feedback.reset();
    return () => feedback.reset();
  }, [feedback, scope]);
  return { feedback, markers };
}

/** Shares the picture's contain rectangle and zoom transform, including letterboxing. */
export function RemoteClickMarkers({
  markers,
  frame,
  style,
}: {
  readonly markers: readonly RemoteClickMarker[];
  readonly frame: FrameSize;
  readonly style?: CSSProperties | undefined;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<FrameSize | null>(null);
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const measure = () => setBox({ width: layer.offsetWidth, height: layer.offsetHeight });
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(layer);
    return () => observer?.disconnect();
  }, []);
  const rect = box && containedFrameRect(box, frame);
  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0 z-20" style={style}>
      {rect &&
        markers.map((marker) => (
          <span
            key={marker.id}
            role="status"
            aria-label={
              marker.state === "failed"
                ? "Click was not acknowledged"
                : "Click awaiting host acknowledgement"
            }
            data-remote-click={marker.state}
            className="remote-click-marker"
            style={{
              left: rect.left + marker.x * rect.width,
              top: rect.top + marker.y * rect.height,
            }}
          >
            <span className="remote-click-marker-pulse" />
            <span className="remote-click-marker-dot" />
          </span>
        ))}
    </div>
  );
}
