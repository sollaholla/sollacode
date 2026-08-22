/**
 * Pure operations on a terminal group's split tree.
 *
 * A group's layout is a binary-ish tree: leaves are terminals, split nodes
 * divide their cell among children along one direction. Splitting the focused
 * pane nests a new split in place of its leaf (or appends to its parent when
 * the direction already matches), so a split never reorients sibling panes.
 */
import type { TerminalPaneLayout } from "./types";

/** Smallest share a split child can be dragged to; mirrors the store's floor. */
export const MIN_PANE_FRACTION = 0.1;

/**
 * Validates flex fractions against a child count. Sizes are positional (slot
 * N keeps its share when terminals swap); any mismatch falls back to equal
 * shares by returning null.
 */
export function normalizedPaneSizes(
  paneSizes: number[] | undefined,
  paneCount: number,
): number[] | null {
  if (!paneSizes || paneSizes.length !== paneCount || paneCount < 2) {
    return null;
  }
  if (!paneSizes.every((size) => Number.isFinite(size) && size > 0)) {
    return null;
  }
  const total = paneSizes.reduce((sum, size) => sum + size, 0);
  if (total <= 0) {
    return null;
  }
  const scaled = paneSizes.map((size) => size / total);
  if (scaled.some((size) => size < MIN_PANE_FRACTION / 2)) {
    return null;
  }
  return scaled;
}

export function layoutLeafIds(layout: TerminalPaneLayout): string[] {
  if (layout.kind === "terminal") {
    return [layout.terminalId];
  }
  return layout.children.flatMap(layoutLeafIds);
}

export function copyLayout(layout: TerminalPaneLayout): TerminalPaneLayout {
  if (layout.kind === "terminal") {
    return { kind: "terminal", terminalId: layout.terminalId };
  }
  return {
    kind: "split",
    direction: layout.direction,
    children: layout.children.map(copyLayout),
    ...(layout.sizes ? { sizes: [...layout.sizes] } : {}),
  };
}

export function layoutsEqual(
  left: TerminalPaneLayout | undefined,
  right: TerminalPaneLayout | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "terminal" || right.kind === "terminal") {
    return (
      left.kind === "terminal" && right.kind === "terminal" && left.terminalId === right.terminalId
    );
  }
  if (left.direction !== right.direction) {
    return false;
  }
  if (left.children.length !== right.children.length) {
    return false;
  }
  const leftSizes = left.sizes ?? null;
  const rightSizes = right.sizes ?? null;
  if ((leftSizes === null) !== (rightSizes === null)) {
    return false;
  }
  if (leftSizes && rightSizes) {
    if (leftSizes.length !== rightSizes.length) {
      return false;
    }
    for (let index = 0; index < leftSizes.length; index += 1) {
      if (leftSizes[index] !== rightSizes[index]) {
        return false;
      }
    }
  }
  return left.children.every((child, index) => layoutsEqual(child, right.children[index]));
}

/**
 * Drops leaves outside `validIds` (and duplicate leaves), collapses empty and
 * single-child splits, and re-validates sizes. Returns undefined when nothing
 * survives.
 */
function pruneLayout(
  layout: TerminalPaneLayout,
  validIds: ReadonlySet<string>,
  seen: Set<string>,
): TerminalPaneLayout | undefined {
  if (layout.kind === "terminal") {
    if (!validIds.has(layout.terminalId) || seen.has(layout.terminalId)) {
      return undefined;
    }
    seen.add(layout.terminalId);
    return { kind: "terminal", terminalId: layout.terminalId };
  }
  const children = layout.children
    .map((child) => pruneLayout(child, validIds, seen))
    .filter((child): child is TerminalPaneLayout => child !== undefined);
  if (children.length === 0) {
    return undefined;
  }
  if (children.length === 1) {
    return children[0];
  }
  const sizes =
    children.length === layout.children.length
      ? normalizedPaneSizes(layout.sizes, children.length)
      : null;
  return {
    kind: "split",
    direction: layout.direction,
    children,
    ...(sizes ? { sizes } : {}),
  };
}

/**
 * Produces the canonical layout for a group: the persisted tree when present
 * (pruned against the member ids, with missing members appended at the root),
 * otherwise a flat split from the legacy direction/size fields. Undefined for
 * empty and single-terminal groups.
 */
export function normalizeGroupLayout(
  layout: TerminalPaneLayout | undefined,
  terminalIds: readonly string[],
  legacy?: {
    readonly splitDirection?: "horizontal" | "vertical";
    readonly paneSizes?: number[];
  },
): TerminalPaneLayout | undefined {
  if (terminalIds.length < 2) {
    return undefined;
  }
  const validIds = new Set(terminalIds);
  const pruned = layout ? pruneLayout(layout, validIds, new Set()) : undefined;
  const covered = new Set(pruned ? layoutLeafIds(pruned) : []);
  const missing = terminalIds.filter((terminalId) => !covered.has(terminalId));
  if (!pruned) {
    const sizes = normalizedPaneSizes(legacy?.paneSizes, missing.length);
    return {
      kind: "split",
      direction: legacy?.splitDirection === "vertical" ? "vertical" : "horizontal",
      children: missing.map((terminalId) => ({ kind: "terminal", terminalId })),
      ...(sizes ? { sizes } : {}),
    };
  }
  if (missing.length === 0) {
    return pruned;
  }
  const missingLeaves = missing.map(
    (terminalId): TerminalPaneLayout => ({ kind: "terminal", terminalId }),
  );
  if (pruned.kind === "split") {
    return {
      kind: "split",
      direction: pruned.direction,
      children: [...pruned.children, ...missingLeaves],
    };
  }
  return {
    kind: "split",
    direction: "horizontal",
    children: [pruned, ...missingLeaves],
  };
}

/**
 * Splits the anchor pane: when its parent split already runs in `direction`
 * the new terminal slots in right after it, otherwise the anchor's leaf is
 * replaced by a nested split of [anchor, new]. Only the anchor's cell changes.
 */
export function splitLayoutAtTerminal(
  layout: TerminalPaneLayout | undefined,
  anchorTerminalId: string,
  newTerminalId: string,
  direction: "horizontal" | "vertical",
): TerminalPaneLayout {
  const newLeaf: TerminalPaneLayout = { kind: "terminal", terminalId: newTerminalId };
  if (!layout) {
    return {
      kind: "split",
      direction,
      children: [{ kind: "terminal", terminalId: anchorTerminalId }, newLeaf],
    };
  }

  const insert = (node: TerminalPaneLayout): TerminalPaneLayout | null => {
    if (node.kind === "terminal") {
      if (node.terminalId !== anchorTerminalId) {
        return null;
      }
      return { kind: "split", direction, children: [copyLayout(node), newLeaf] };
    }
    const anchorChildIndex = node.children.findIndex(
      (child) => child.kind === "terminal" && child.terminalId === anchorTerminalId,
    );
    if (anchorChildIndex >= 0 && node.direction === direction) {
      const children = node.children.map(copyLayout);
      children.splice(anchorChildIndex + 1, 0, newLeaf);
      return { kind: "split", direction: node.direction, children };
    }
    for (let index = 0; index < node.children.length; index += 1) {
      const replaced = insert(node.children[index]!);
      if (replaced) {
        const children = node.children.map(copyLayout);
        children[index] = replaced;
        const sizes = normalizedPaneSizes(node.sizes, children.length);
        return {
          kind: "split",
          direction: node.direction,
          children,
          ...(sizes ? { sizes } : {}),
        };
      }
    }
    return null;
  };

  const next = insert(layout);
  if (next) {
    return next;
  }
  // Anchor not found: append at the root rather than losing the terminal.
  if (layout.kind === "split") {
    return {
      kind: "split",
      direction: layout.direction,
      children: [...layout.children.map(copyLayout), newLeaf],
    };
  }
  return { kind: "split", direction, children: [copyLayout(layout), newLeaf] };
}

/**
 * Where a dragged pane lands on a target pane: the center swaps the two
 * panes; an edge splits the target pane and places the dragged terminal on
 * that side.
 */
export type PaneDropZone = "center" | "left" | "right" | "top" | "bottom";

export function paneDropZoneForPoint(input: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): PaneDropZone {
  const { x, y, width, height } = input;
  if (width <= 0 || height <= 0) {
    return "center";
  }
  const edgeX = Math.min(width * 0.25, 96);
  const edgeY = Math.min(height * 0.25, 96);
  if (x < edgeX) return "left";
  if (x > width - edgeX) return "right";
  if (y < edgeY) return "top";
  if (y > height - edgeY) return "bottom";
  return "center";
}

export function removeTerminalFromLayout(
  layout: TerminalPaneLayout,
  terminalId: string,
): TerminalPaneLayout | undefined {
  const remaining = new Set(layoutLeafIds(layout).filter((leafId) => leafId !== terminalId));
  return pruneLayout(layout, remaining, new Set());
}

export type ListDropPlacement = "before" | "after";

/** Top half of a list row is "before"; bottom half is "after". */
export function listDropPlacementForPoint(y: number, height: number): ListDropPlacement {
  if (height <= 0) {
    return "after";
  }
  return y < height / 2 ? "before" : "after";
}

/**
 * Places `newTerminalId` next to `targetTerminalId` in the tree: as a sibling
 * when the target is a direct child of a split, otherwise as a nested split
 * of the target leaf. Undefined layout (a single remaining pane) becomes a
 * two-pane split.
 */
export function insertTerminalBeside(
  layout: TerminalPaneLayout | undefined,
  targetTerminalId: string,
  newTerminalId: string,
  placement: ListDropPlacement,
): TerminalPaneLayout {
  const newLeaf: TerminalPaneLayout = { kind: "terminal", terminalId: newTerminalId };
  const targetLeaf: TerminalPaneLayout = { kind: "terminal", terminalId: targetTerminalId };
  const pair = (): TerminalPaneLayout => ({
    kind: "split",
    direction: "horizontal",
    children: placement === "before" ? [newLeaf, targetLeaf] : [targetLeaf, newLeaf],
  });
  if (!layout) {
    return pair();
  }

  const insert = (node: TerminalPaneLayout): TerminalPaneLayout | null => {
    if (node.kind === "terminal") {
      return node.terminalId === targetTerminalId ? pair() : null;
    }
    const targetIndex = node.children.findIndex(
      (child) => child.kind === "terminal" && child.terminalId === targetTerminalId,
    );
    if (targetIndex >= 0) {
      const children = node.children.map(copyLayout);
      children.splice(placement === "before" ? targetIndex : targetIndex + 1, 0, newLeaf);
      return { kind: "split", direction: node.direction, children };
    }
    for (let index = 0; index < node.children.length; index += 1) {
      const replaced = insert(node.children[index]!);
      if (replaced) {
        const children = node.children.map(copyLayout);
        children[index] = replaced;
        const sizes = normalizedPaneSizes(node.sizes, children.length);
        return {
          kind: "split",
          direction: node.direction,
          children,
          ...(sizes ? { sizes } : {}),
        };
      }
    }
    return null;
  };

  const next = insert(layout);
  if (next) {
    return next;
  }
  if (layout.kind === "split") {
    return {
      kind: "split",
      direction: layout.direction,
      children:
        placement === "before"
          ? [newLeaf, ...layout.children.map(copyLayout)]
          : [...layout.children.map(copyLayout), newLeaf],
    };
  }
  return pair();
}

/**
 * Applies a drag-drop of one pane onto another: center swaps them; an edge
 * removes the dragged leaf and splits the target pane, placing the dragged
 * terminal on the dropped side. Returns null when nothing changes.
 */
export function moveTerminalInLayout(
  layout: TerminalPaneLayout,
  draggedTerminalId: string,
  targetTerminalId: string,
  zone: PaneDropZone,
): TerminalPaneLayout | null {
  if (draggedTerminalId === targetTerminalId) {
    return null;
  }
  const leafIds = layoutLeafIds(layout);
  if (!leafIds.includes(draggedTerminalId) || !leafIds.includes(targetTerminalId)) {
    return null;
  }
  if (zone === "center") {
    return swapLayoutTerminals(layout, draggedTerminalId, targetTerminalId);
  }
  const direction: "horizontal" | "vertical" =
    zone === "left" || zone === "right" ? "horizontal" : "vertical";
  const draggedFirst = zone === "left" || zone === "top";
  const withoutDragged = removeTerminalFromLayout(layout, draggedTerminalId);
  const draggedLeaf: TerminalPaneLayout = { kind: "terminal", terminalId: draggedTerminalId };
  const targetLeaf: TerminalPaneLayout = { kind: "terminal", terminalId: targetTerminalId };
  const replacement: TerminalPaneLayout = {
    kind: "split",
    direction,
    children: draggedFirst ? [draggedLeaf, targetLeaf] : [targetLeaf, draggedLeaf],
  };
  if (!withoutDragged) {
    return replacement;
  }

  const replaceTarget = (node: TerminalPaneLayout): TerminalPaneLayout | null => {
    if (node.kind === "terminal") {
      return node.terminalId === targetTerminalId ? replacement : null;
    }
    for (let index = 0; index < node.children.length; index += 1) {
      const replaced = replaceTarget(node.children[index]!);
      if (replaced) {
        const children = node.children.map(copyLayout);
        children[index] = replaced;
        const sizes = normalizedPaneSizes(node.sizes, children.length);
        return {
          kind: "split",
          direction: node.direction,
          children,
          ...(sizes ? { sizes } : {}),
        };
      }
    }
    return null;
  };

  return replaceTarget(withoutDragged);
}

export function swapLayoutTerminals(
  layout: TerminalPaneLayout,
  firstTerminalId: string,
  secondTerminalId: string,
): TerminalPaneLayout {
  if (layout.kind === "terminal") {
    if (layout.terminalId === firstTerminalId) {
      return { kind: "terminal", terminalId: secondTerminalId };
    }
    if (layout.terminalId === secondTerminalId) {
      return { kind: "terminal", terminalId: firstTerminalId };
    }
    return layout;
  }
  return {
    ...layout,
    children: layout.children.map((child) =>
      swapLayoutTerminals(child, firstTerminalId, secondTerminalId),
    ),
    ...(layout.sizes ? { sizes: [...layout.sizes] } : {}),
  };
}

/**
 * Applies dragged fractions to the split node addressed by `path` (child
 * indices from the root). Returns null when the path misses or the sizes are
 * invalid for that node.
 */
export function setLayoutSizesAtPath(
  layout: TerminalPaneLayout,
  path: readonly number[],
  sizes: number[],
): TerminalPaneLayout | null {
  if (path.length === 0) {
    if (layout.kind !== "split") {
      return null;
    }
    const normalized = normalizedPaneSizes(sizes, layout.children.length);
    if (!normalized) {
      return null;
    }
    return { ...layout, children: layout.children.map(copyLayout), sizes: normalized };
  }
  if (layout.kind !== "split") {
    return null;
  }
  const [head, ...rest] = path;
  const child = head === undefined ? undefined : layout.children[head];
  if (child === undefined) {
    return null;
  }
  const nextChild = setLayoutSizesAtPath(child, rest, sizes);
  if (!nextChild) {
    return null;
  }
  const children = layout.children.map(copyLayout);
  children[head!] = nextChild;
  return { ...layout, children };
}
