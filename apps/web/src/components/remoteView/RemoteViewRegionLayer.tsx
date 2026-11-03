import { containedFrameRect, type FrameSize } from "@t3tools/shared/remoteFrameGestures";
import { useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from "react";

/**
 * Holds the canvas a magnified viewer's sharp crop is painted on.
 *
 * It takes the picture's zoom transform, and its inner box covers exactly the
 * letterboxed picture, so the renderer can place a crop in percentages of the
 * whole and it lines up with what is underneath at any zoom or pane size.
 */
export function RemoteViewRegionLayer(props: {
  readonly canvasRef: Ref<HTMLCanvasElement>;
  /** The whole picture's size, for the letterboxing. */
  readonly frame: FrameSize | null;
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
  const rect = box && props.frame ? containedFrameRect(box, props.frame) : null;
  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0" style={props.style}>
      <div
        className="absolute"
        style={
          rect
            ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
            : { display: "none" }
        }
      >
        <canvas ref={props.canvasRef} aria-hidden className="absolute hidden" />
      </div>
    </div>
  );
}
