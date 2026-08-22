import { describe, expect, it } from "vite-plus/test";

import {
  insertTerminalBeside,
  layoutLeafIds,
  listDropPlacementForPoint,
  moveTerminalInLayout,
  paneDropZoneForPoint,
  layoutsEqual,
  normalizeGroupLayout,
  removeTerminalFromLayout,
  setLayoutSizesAtPath,
  splitLayoutAtTerminal,
  swapLayoutTerminals,
} from "./terminalPaneLayout";
import type { TerminalPaneLayout } from "./types";

const leaf = (terminalId: string): TerminalPaneLayout => ({ kind: "terminal", terminalId });

describe("splitLayoutAtTerminal", () => {
  it("splits only the anchor pane, not the whole group", () => {
    // [t1 | t2] horizontally; splitting t2 vertically nests inside t2's cell.
    const layout = splitLayoutAtTerminal(
      splitLayoutAtTerminal(undefined, "t1", "t2", "horizontal"),
      "t2",
      "t3",
      "vertical",
    );
    expect(layout).toEqual({
      kind: "split",
      direction: "horizontal",
      children: [
        leaf("t1"),
        { kind: "split", direction: "vertical", children: [leaf("t2"), leaf("t3")] },
      ],
    });
  });

  it("appends after the anchor when the parent already runs that direction", () => {
    const layout = splitLayoutAtTerminal(
      splitLayoutAtTerminal(undefined, "t1", "t2", "horizontal"),
      "t1",
      "t3",
      "horizontal",
    );
    expect(layout).toEqual({
      kind: "split",
      direction: "horizontal",
      children: [leaf("t1"), leaf("t3"), leaf("t2")],
    });
  });

  it("appends at the root when the anchor is missing", () => {
    const layout = splitLayoutAtTerminal(
      splitLayoutAtTerminal(undefined, "t1", "t2", "horizontal"),
      "missing",
      "t3",
      "vertical",
    );
    expect(layoutLeafIds(layout)).toEqual(["t1", "t2", "t3"]);
  });
});

describe("normalizeGroupLayout", () => {
  it("returns undefined for single-terminal groups", () => {
    expect(normalizeGroupLayout(undefined, ["t1"])).toBeUndefined();
    expect(
      normalizeGroupLayout(
        { kind: "split", direction: "vertical", children: [leaf("t1"), leaf("gone")] },
        ["t1"],
      ),
    ).toBeUndefined();
  });

  it("builds a flat split from legacy direction and sizes", () => {
    expect(
      normalizeGroupLayout(undefined, ["t1", "t2"], {
        splitDirection: "vertical",
        paneSizes: [3, 1],
      }),
    ).toEqual({
      kind: "split",
      direction: "vertical",
      children: [leaf("t1"), leaf("t2")],
      sizes: [0.75, 0.25],
    });
  });

  it("collapses splits left with one child and appends missing members", () => {
    const layout = normalizeGroupLayout(
      {
        kind: "split",
        direction: "horizontal",
        children: [
          leaf("t1"),
          { kind: "split", direction: "vertical", children: [leaf("t2"), leaf("closed")] },
        ],
      },
      ["t1", "t2", "t4"],
    );
    expect(layout).toEqual({
      kind: "split",
      direction: "horizontal",
      children: [leaf("t1"), leaf("t2"), leaf("t4")],
    });
  });

  it("keeps nested structure intact when members match", () => {
    const nested: TerminalPaneLayout = {
      kind: "split",
      direction: "horizontal",
      children: [
        leaf("t1"),
        { kind: "split", direction: "vertical", children: [leaf("t2"), leaf("t3")] },
      ],
    };
    expect(normalizeGroupLayout(nested, ["t1", "t2", "t3"])).toEqual(nested);
  });
});

describe("swapLayoutTerminals", () => {
  it("swaps leaves across nesting levels", () => {
    const layout: TerminalPaneLayout = {
      kind: "split",
      direction: "horizontal",
      children: [
        leaf("t1"),
        { kind: "split", direction: "vertical", children: [leaf("t2"), leaf("t3")] },
      ],
    };
    expect(layoutLeafIds(swapLayoutTerminals(layout, "t1", "t3"))).toEqual(["t3", "t2", "t1"]);
  });
});

describe("setLayoutSizesAtPath", () => {
  it("sets sizes on the addressed split node only", () => {
    const layout: TerminalPaneLayout = {
      kind: "split",
      direction: "horizontal",
      children: [
        leaf("t1"),
        { kind: "split", direction: "vertical", children: [leaf("t2"), leaf("t3")] },
      ],
    };
    const next = setLayoutSizesAtPath(layout, [1], [1, 3]);
    expect(next).toEqual({
      kind: "split",
      direction: "horizontal",
      children: [
        leaf("t1"),
        {
          kind: "split",
          direction: "vertical",
          children: [leaf("t2"), leaf("t3")],
          sizes: [0.25, 0.75],
        },
      ],
    });
    expect(setLayoutSizesAtPath(layout, [0], [1, 1])).toBeNull();
    expect(setLayoutSizesAtPath(layout, [5], [1, 1])).toBeNull();
  });
});

describe("layoutsEqual", () => {
  it("compares structure, direction, and sizes", () => {
    const base: TerminalPaneLayout = {
      kind: "split",
      direction: "horizontal",
      children: [leaf("t1"), leaf("t2")],
    };
    expect(layoutsEqual(base, { ...base, children: [leaf("t1"), leaf("t2")] })).toBe(true);
    expect(layoutsEqual(base, { ...base, direction: "vertical" })).toBe(false);
    expect(layoutsEqual(base, { ...base, sizes: [0.5, 0.5] })).toBe(false);
    expect(layoutsEqual(undefined, undefined)).toBe(true);
    expect(layoutsEqual(base, undefined)).toBe(false);
  });
});

describe("moveTerminalInLayout", () => {
  const nested: TerminalPaneLayout = {
    kind: "split",
    direction: "horizontal",
    children: [
      leaf("t1"),
      { kind: "split", direction: "vertical", children: [leaf("t2"), leaf("t3")] },
    ],
  };

  it("swaps on a center drop", () => {
    const moved = moveTerminalInLayout(nested, "t1", "t3", "center");
    expect(moved && layoutLeafIds(moved)).toEqual(["t3", "t2", "t1"]);
  });

  it("splits the target pane on an edge drop, collapsing the vacated split", () => {
    const moved = moveTerminalInLayout(nested, "t3", "t1", "left");
    expect(moved).toEqual({
      kind: "split",
      direction: "horizontal",
      children: [
        { kind: "split", direction: "horizontal", children: [leaf("t3"), leaf("t1")] },
        leaf("t2"),
      ],
    });
  });

  it("places the dragged pane below on a bottom drop", () => {
    const moved = moveTerminalInLayout(nested, "t2", "t1", "bottom");
    expect(moved).toEqual({
      kind: "split",
      direction: "horizontal",
      children: [
        { kind: "split", direction: "vertical", children: [leaf("t1"), leaf("t2")] },
        leaf("t3"),
      ],
    });
  });

  it("returns null for self-drops and unknown panes", () => {
    expect(moveTerminalInLayout(nested, "t1", "t1", "left")).toBeNull();
    expect(moveTerminalInLayout(nested, "missing", "t1", "left")).toBeNull();
  });
});

describe("paneDropZoneForPoint", () => {
  it("maps pane-relative coordinates to zones", () => {
    const bounds = { width: 400, height: 200 };
    expect(paneDropZoneForPoint({ ...bounds, x: 10, y: 100 })).toBe("left");
    expect(paneDropZoneForPoint({ ...bounds, x: 390, y: 100 })).toBe("right");
    expect(paneDropZoneForPoint({ ...bounds, x: 200, y: 10 })).toBe("top");
    expect(paneDropZoneForPoint({ ...bounds, x: 200, y: 195 })).toBe("bottom");
    expect(paneDropZoneForPoint({ ...bounds, x: 200, y: 100 })).toBe("center");
  });
});

describe("listDropPlacementForPoint", () => {
  it("splits a row into before and after", () => {
    expect(listDropPlacementForPoint(2, 20)).toBe("before");
    expect(listDropPlacementForPoint(18, 20)).toBe("after");
  });
});

describe("insertTerminalBeside", () => {
  it("inserts as a sibling of a leaf in a matching split", () => {
    const layout = splitLayoutAtTerminal(undefined, "t1", "t2", "horizontal");
    expect(insertTerminalBeside(layout, "t1", "t3", "before")).toEqual({
      kind: "split",
      direction: "horizontal",
      children: [leaf("t3"), leaf("t1"), leaf("t2")],
    });
    expect(layoutLeafIds(insertTerminalBeside(layout, "t2", "t3", "after"))).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
  });

  it("builds a two-pane split when the group had a single terminal", () => {
    expect(insertTerminalBeside(undefined, "t1", "t2", "after")).toEqual({
      kind: "split",
      direction: "horizontal",
      children: [leaf("t1"), leaf("t2")],
    });
  });

  it("drops a leaf from the tree", () => {
    const layout = splitLayoutAtTerminal(undefined, "t1", "t2", "horizontal");
    expect(removeTerminalFromLayout(layout, "t2")).toEqual(leaf("t1"));
  });
});
