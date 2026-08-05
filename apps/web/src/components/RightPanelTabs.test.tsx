import { renderToStaticMarkup } from "react-dom/server";
import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  resolveHorizontalTabWheelDelta,
  RightPanelEmptyState,
  routeCapturedHorizontalTabWheel,
  routeHorizontalTabWheel,
  shouldShowSideChatProviderIcon,
} from "./RightPanelTabs";

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
