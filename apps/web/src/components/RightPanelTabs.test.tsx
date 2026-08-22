import { renderToStaticMarkup } from "react-dom/server";
import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { reorderSurfaces, type RightPanelSurface } from "~/rightPanelStore";

import {
  isPointerOverTabStrip,
  rightPanelNewSurfaceKinds,
  resolveHorizontalTabWheelDelta,
  resolveRightPanelSurfaceTitle,
  rightPanelTabContextMenuItems,
  RightPanelEmptyState,
  routeCapturedHorizontalTabWheel,
  routeHorizontalTabWheel,
  shouldShowArtifactShelf,
  shouldShowSideChatProviderIcon,
} from "./RightPanelTabs";

describe("right-panel artifact access", () => {
  const artifactSurface: RightPanelSurface = {
    id: "artifact:artifact-1",
    kind: "artifact",
    resourceId: "artifact-1",
    revision: 2,
    title: "Feature tour",
  };
  const terminalSurface: RightPanelSurface = {
    id: "terminal:term-1",
    kind: "terminal",
    resourceId: "term-1",
    terminalIds: ["term-1"],
    activeTerminalId: "term-1",
  };

  it("hides the artifact shelf only while an artifact tab is active", () => {
    const surfaces = [terminalSurface, artifactSurface];

    expect(shouldShowArtifactShelf(surfaces, artifactSurface.id)).toBe(false);
    expect(shouldShowArtifactShelf(surfaces, terminalSurface.id)).toBe(true);
    expect(shouldShowArtifactShelf([terminalSurface], null)).toBe(true);
  });

  it("adds an Artifacts picker to the new-surface menu when choices are available", () => {
    expect(rightPanelNewSurfaceKinds(true)).toEqual([
      "browser",
      "terminal",
      "files",
      "artifact",
      "diff",
      "side-chat",
    ]);
    expect(rightPanelNewSurfaceKinds(false)).not.toContain("artifact");
  });
});

describe("right-panel tab naming", () => {
  const terminalSurface: RightPanelSurface = {
    id: "terminal:term-1",
    kind: "terminal",
    resourceId: "term-1",
    terminalIds: ["term-1"],
    activeTerminalId: "term-1",
  };

  it("offers Rename from the tab context menu and Reset name for an override", () => {
    expect(rightPanelTabContextMenuItems(terminalSurface, 0, 2).map((item) => item.id)).toEqual([
      "rename",
      "close",
      "close-others",
      "close-to-right",
      "close-all",
    ]);
    expect(
      rightPanelTabContextMenuItems({ ...terminalSurface, customTitle: "Build logs" }, 0, 2).map(
        (item) => item.id,
      ),
    ).toEqual(["rename", "reset-name", "close", "close-others", "close-to-right", "close-all"]);
  });

  it("offers Copy chat ID only for a side chat, whose id is otherwise unreachable", () => {
    const sideChat: RightPanelSurface = {
      id: "side-chat:thread-7",
      kind: "side-chat",
      resourceId: "thread-7",
      title: "Research",
    };
    expect(rightPanelTabContextMenuItems(sideChat, 0, 2).map((item) => item.id)).toEqual([
      "copy-chat-id",
      "rename",
      "close",
      "close-others",
      "close-to-right",
      "close-all",
    ]);
    expect(rightPanelTabContextMenuItems(terminalSurface, 0, 2)).not.toContainEqual(
      expect.objectContaining({ id: "copy-chat-id" }),
    );
  });

  it("keeps a custom name ahead of a changing live terminal label", () => {
    const liveLabels = new Map([["term-1", "codex"]]);
    expect(resolveRightPanelSurfaceTitle(terminalSurface, {}, liveLabels)).toBe("codex");
    expect(
      resolveRightPanelSurfaceTitle(
        { ...terminalSurface, customTitle: "Deployment" },
        {},
        liveLabels,
      ),
    ).toBe("Deployment");
  });
});

describe("RightPanelEmptyState", () => {
  it("offers Side Chat as the fifth right-panel surface", () => {
    const markup = renderToStaticMarkup(
      <RightPanelEmptyState
        onAddBrowser={vi.fn()}
        onAddTerminal={vi.fn()}
        onAddFiles={vi.fn()}
        onAddDiff={vi.fn()}
        onAddSideChat={vi.fn()}
        browserAvailable
        diffAvailable
        filesAvailable
        sideChatAvailable
      />,
    );

    expect(markup.match(/<button/g)).toHaveLength(5);
    expect(markup).toContain("Side Chat");
    expect(markup).toContain("Fork an isolated, disposable sub-agent.");
  });
});

describe("right-panel tab-strip wheel routing", () => {
  it("uses native horizontal trackpad movement even when a child control owns the pointer", () => {
    expect(
      resolveHorizontalTabWheelDelta({
        deltaX: 42,
        deltaY: 3,
        deltaMode: 0,
        viewportWidth: 500,
      }),
    ).toBe(42);
  });

  it("translates a mouse wheel into horizontal tab movement", () => {
    expect(
      resolveHorizontalTabWheelDelta({
        deltaX: 0,
        deltaY: -3,
        deltaMode: 1,
        viewportWidth: 500,
      }),
    ).toBe(-48);
  });

  it("scales page-mode wheel movement to the visible strip width", () => {
    expect(
      resolveHorizontalTabWheelDelta({
        deltaX: 0,
        deltaY: 1,
        deltaMode: 2,
        viewportWidth: 640,
      }),
    ).toBe(640);
  });

  it("uses the dominant axis instead of tiny trackpad cross-axis noise", () => {
    expect(
      resolveHorizontalTabWheelDelta({
        deltaX: 0.25,
        deltaY: 18,
        deltaMode: 0,
        viewportWidth: 500,
      }),
    ).toBe(18);
  });

  it("routes the gesture even when a nested close control is the event target", () => {
    const viewport = { clientWidth: 400, scrollWidth: 1_000, scrollLeft: 100 };
    const event = {
      deltaX: 0,
      deltaY: 24,
      deltaMode: 0,
      target: { tagName: "BUTTON", ariaLabel: "Close Side Chat" },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };

    expect(routeHorizontalTabWheel(viewport, event)).toBe(true);
    expect(viewport.scrollLeft).toBe(124);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  });

  it("claims a close-button gesture from window capture before document scroll locks", () => {
    const viewport = { clientWidth: 400, scrollWidth: 1_000, scrollLeft: 100 };
    const closeButton = { tagName: "BUTTON", ariaLabel: "Close Side Chat" };
    const event = {
      deltaX: 32,
      deltaY: 0,
      deltaMode: 0,
      clientX: 120,
      clientY: 20,
      composedPath: () => [closeButton, { role: "tab" }, viewport, { role: "document" }],
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };

    expect(routeCapturedHorizontalTabWheel(viewport, event)).toBe(true);
    expect(viewport.scrollLeft).toBe(132);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  });

  it("ignores window-captured wheel gestures from outside the tab strip", () => {
    const viewport = { clientWidth: 400, scrollWidth: 1_000, scrollLeft: 100 };
    const event = {
      deltaX: 32,
      deltaY: 0,
      deltaMode: 0,
      clientX: 900,
      clientY: 600,
      composedPath: () => [{ role: "conversation" }, { role: "document" }],
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };

    expect(routeCapturedHorizontalTabWheel(viewport, event)).toBe(false);
    expect(viewport.scrollLeft).toBe(100);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  const STRIP_BOX = { left: 0, top: 0, right: 400, bottom: 44 };

  it("keeps scrolling when a hovered child retargets the gesture off the viewport", () => {
    const viewport = { clientWidth: 400, scrollWidth: 1_000, scrollLeft: 100 };
    const event = {
      deltaX: 32,
      deltaY: 0,
      deltaMode: 0,
      clientX: 180,
      clientY: 20,
      // A label span, close glyph, or overlay can leave the viewport out of the
      // composed path entirely; the pointer is still over the strip.
      composedPath: () => [{ tagName: "SPAN" }, { role: "document" }],
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };

    expect(routeCapturedHorizontalTabWheel(viewport, event, () => STRIP_BOX)).toBe(true);
    expect(viewport.scrollLeft).toBe(132);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("still declines a retargeted gesture whose pointer is outside the strip", () => {
    const viewport = { clientWidth: 400, scrollWidth: 1_000, scrollLeft: 100 };
    const event = {
      deltaX: 32,
      deltaY: 0,
      deltaMode: 0,
      clientX: 180,
      clientY: 500,
      composedPath: () => [{ tagName: "SPAN" }, { role: "document" }],
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };

    expect(routeCapturedHorizontalTabWheel(viewport, event, () => STRIP_BOX)).toBe(false);
    expect(viewport.scrollLeft).toBe(100);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("reads the strip box only when the composed path misses", () => {
    const viewport = { clientWidth: 400, scrollWidth: 1_000, scrollLeft: 100 };
    const readBox = vi.fn(() => STRIP_BOX);
    const event = {
      deltaX: 32,
      deltaY: 0,
      deltaMode: 0,
      clientX: 180,
      clientY: 20,
      composedPath: () => [viewport],
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };

    expect(routeCapturedHorizontalTabWheel(viewport, event, readBox)).toBe(true);
    expect(readBox).not.toHaveBeenCalled();
  });

  it("treats the strip box edges as inside", () => {
    expect(isPointerOverTabStrip(STRIP_BOX, { clientX: 0, clientY: 0 })).toBe(true);
    expect(isPointerOverTabStrip(STRIP_BOX, { clientX: 400, clientY: 44 })).toBe(true);
    expect(isPointerOverTabStrip(STRIP_BOX, { clientX: 401, clientY: 44 })).toBe(false);
    expect(isPointerOverTabStrip(STRIP_BOX, { clientX: 400, clientY: 45 })).toBe(false);
  });

  it("leaves the wheel available to an ancestor when the strip cannot move farther", () => {
    const viewport = { clientWidth: 400, scrollWidth: 1_000, scrollLeft: 600 };
    const event = {
      deltaX: 0,
      deltaY: 24,
      deltaMode: 0,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };

    expect(routeHorizontalTabWheel(viewport, event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  });
});

describe("right-panel tab reordering", () => {
  const surfaces = [
    { id: "diff", kind: "diff" },
    { id: "files", kind: "files" },
    { id: "plan", kind: "plan" },
  ] as const;

  it("moves a tab forward into the slot it was dropped on", () => {
    expect(reorderSurfaces(surfaces, "diff", "plan").map((surface) => surface.id)).toEqual([
      "files",
      "plan",
      "diff",
    ]);
  });

  it("moves a tab backward into the slot it was dropped on", () => {
    expect(reorderSurfaces(surfaces, "plan", "diff").map((surface) => surface.id)).toEqual([
      "plan",
      "diff",
      "files",
    ]);
  });

  it("returns the same array for a no-op drop so the store skips a write", () => {
    expect(reorderSurfaces(surfaces, "files", "files")).toBe(surfaces);
    expect(reorderSurfaces(surfaces, "files", "missing")).toBe(surfaces);
    expect(reorderSurfaces(surfaces, "missing", "files")).toBe(surfaces);
  });
});

describe("side-chat tab icon", () => {
  const provider = {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
  };

  it("replaces the generic chat icon only after the first side-chat message", () => {
    expect(
      shouldShowSideChatProviderIcon({ hasConversation: false, isWorking: false, provider }),
    ).toBe(false);
    expect(
      shouldShowSideChatProviderIcon({ hasConversation: true, isWorking: false, provider }),
    ).toBe(true);
  });

  it("keeps the generic icon when provider identity has not arrived yet", () => {
    expect(
      shouldShowSideChatProviderIcon({ hasConversation: true, isWorking: true, provider: null }),
    ).toBe(false);
  });
});
