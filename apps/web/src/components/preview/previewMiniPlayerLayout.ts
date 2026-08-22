import type { PreviewMiniPlayerPosition, PreviewMiniPlayerSize } from "~/previewMiniPlayerStore";

export const PREVIEW_MINI_PLAYER_EDGE_GAP = 12;
export const PREVIEW_MINI_PLAYER_DEFAULT_SIZE = { width: 320, height: 200 } as const;
export const PREVIEW_MINI_PLAYER_MIN_SIZE = { width: 240, height: 150 } as const;

export function clampPreviewMiniPlayerSize(
  size: PreviewMiniPlayerSize,
  container: PreviewMiniPlayerSize,
  bottomInset = 0,
): PreviewMiniPlayerSize {
  const availableWidth = Math.max(1, container.width - PREVIEW_MINI_PLAYER_EDGE_GAP * 2);
  const availableHeight = Math.max(
    1,
    container.height - Math.max(0, bottomInset) - PREVIEW_MINI_PLAYER_EDGE_GAP * 2,
  );
  return {
    width: Math.round(
      Math.min(Math.max(PREVIEW_MINI_PLAYER_MIN_SIZE.width, size.width), availableWidth),
    ),
    height: Math.round(
      Math.min(Math.max(PREVIEW_MINI_PLAYER_MIN_SIZE.height, size.height), availableHeight),
    ),
  };
}

export function clampPreviewMiniPlayerPosition(
  position: PreviewMiniPlayerPosition,
  container: PreviewMiniPlayerSize,
  player: PreviewMiniPlayerSize,
  bottomInset = 0,
): PreviewMiniPlayerPosition {
  const reservedBottomSpace = Math.max(0, bottomInset);
  const maxX = Math.max(
    PREVIEW_MINI_PLAYER_EDGE_GAP,
    container.width - player.width - PREVIEW_MINI_PLAYER_EDGE_GAP,
  );
  const maxY = Math.max(
    PREVIEW_MINI_PLAYER_EDGE_GAP,
    container.height - reservedBottomSpace - player.height - PREVIEW_MINI_PLAYER_EDGE_GAP,
  );
  return {
    x: Math.min(Math.max(position.x, PREVIEW_MINI_PLAYER_EDGE_GAP), maxX),
    y: Math.min(Math.max(position.y, PREVIEW_MINI_PLAYER_EDGE_GAP), maxY),
  };
}

export type PreviewMiniPlayerResizeCorner = "left" | "right";

/**
 * Resolve the position and size for a bottom-corner resize drag.
 *
 * Bottom-right is the simple case: the top-left stays put and the box grows
 * with the pointer. Bottom-left drags the *left* edge, so width grows as the
 * pointer moves left and the right edge is the anchor that must not move —
 * which is why this returns a position as well as a size.
 */
export function resolvePreviewMiniPlayerResize(input: {
  readonly corner: PreviewMiniPlayerResizeCorner;
  readonly origin: {
    readonly position: PreviewMiniPlayerPosition;
    readonly size: PreviewMiniPlayerSize;
  };
  readonly delta: { readonly x: number; readonly y: number };
  readonly container: PreviewMiniPlayerSize;
  readonly bottomInset?: number;
}): { readonly position: PreviewMiniPlayerPosition; readonly size: PreviewMiniPlayerSize } {
  const { bottomInset = 0, container, corner, delta, origin } = input;
  const rightEdge = origin.position.x + origin.size.width;
  const desiredWidth =
    corner === "left" ? origin.size.width - delta.x : origin.size.width + delta.x;
  // Cap a left drag at the container's left gap. Without this the width keeps
  // growing past the edge and the position clamp slides the anchored right edge
  // rightwards, so the box appears to walk across the screen instead of stopping.
  const maxWidth =
    corner === "left"
      ? Math.max(PREVIEW_MINI_PLAYER_MIN_SIZE.width, rightEdge - PREVIEW_MINI_PLAYER_EDGE_GAP)
      : Number.POSITIVE_INFINITY;
  const size = clampPreviewMiniPlayerSize(
    { width: Math.min(desiredWidth, maxWidth), height: origin.size.height + delta.y },
    container,
    bottomInset,
  );
  const position = clampPreviewMiniPlayerPosition(
    { x: corner === "left" ? rightEdge - size.width : origin.position.x, y: origin.position.y },
    container,
    size,
    bottomInset,
  );
  return { position, size };
}
