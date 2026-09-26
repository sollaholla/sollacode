import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createTouchActionMenu,
  TOUCH_HOLD_ITEMS,
  TOUCH_MENU_DWELL_MS,
  TOUCH_MENU_HOLD_MS,
  TOUCH_MENU_ITEMS,
} from "../remoteControl/touchActionMenu";
import {
  createRemoteBrowserTouchGestures,
  createRemoteKeyboardQueue,
  REMOTE_HOLD_MAX_MS,
  remoteContextMenuItems,
  remoteSearchUrl,
  type RemoteBrowserTouchGesture,
  type RemoteKeyboardEntry,
} from "./remoteBrowserInput";

const origin = { x: 200, y: 300 };
const center = { x: 180, y: 320 };

function harness() {
  const gestures: RemoteBrowserTouchGesture[] = [];
  const adapter = createRemoteBrowserTouchGestures({
    gesture: (gesture) => gestures.push(gesture),
  });
  const scroll = vi.fn();
  const menu = createTouchActionMenu({
    menu: adapter.menu,
    pointer: adapter.pointer,
    scroll,
    panScrolls: true,
  });
  const choose = (items: typeof TOUCH_MENU_ITEMS | typeof TOUCH_HOLD_ITEMS, action: string) => {
    const item = items.find((candidate) => candidate.action === action)!;
    menu.move({ x: center.x + item.x, y: center.y + item.y });
    vi.advanceTimersByTime(TOUCH_MENU_DWELL_MS);
  };
  const openMenu = () => {
    menu.start(origin, center);
    vi.advanceTimersByTime(TOUCH_MENU_HOLD_MS);
  };
  return { gestures, adapter, menu, scroll, choose, openMenu };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("remote browser touch gestures", () => {
  it("sends a quick tap as one click", () => {
    const h = harness();
    h.menu.start(origin, center);
    h.menu.end();
    expect(h.gestures).toEqual([{ kind: "click", at: origin }]);
  });

  it("scrolls a pan instead of clicking", () => {
    const h = harness();
    h.menu.start(origin, center);
    h.menu.move({ x: 200, y: 250 });
    h.menu.end();
    expect(h.gestures).toEqual([]);
    expect(h.scroll).toHaveBeenCalledWith(origin, { x: 0, y: 50 });
  });

  it("opens the page menu from Right-click without a click", () => {
    const h = harness();
    h.openMenu();
    h.choose(TOUCH_MENU_ITEMS, "right-click");
    h.menu.end();
    expect(h.gestures).toEqual([{ kind: "contextMenu", at: origin }]);
  });

  it("sends a Drag whole when the finger lifts", () => {
    const h = harness();
    h.openMenu();
    h.choose(TOUCH_MENU_ITEMS, "drag");
    h.menu.move({ x: 260, y: 200 });
    h.menu.end();
    expect(h.gestures).toHaveLength(1);
    expect(h.gestures[0]).toMatchObject({ kind: "drag", from: origin });
    expect(h.gestures[0]).not.toHaveProperty("holdMs");
  });

  it("sends a right hold with how long it was held, capped", () => {
    const h = harness();
    h.openMenu();
    h.choose(TOUCH_MENU_ITEMS, "hold");
    h.choose(TOUCH_HOLD_ITEMS, "right-hold");
    vi.advanceTimersByTime(1_200);
    h.menu.end();
    expect(h.gestures).toEqual([
      { kind: "drag", from: origin, to: origin, button: "right", holdMs: 1_200 },
    ]);

    h.openMenu();
    h.choose(TOUCH_MENU_ITEMS, "hold");
    h.choose(TOUCH_HOLD_ITEMS, "left-hold");
    vi.advanceTimersByTime(60_000);
    h.menu.end();
    expect(h.gestures[1]).toMatchObject({ button: "left", holdMs: REMOTE_HOLD_MAX_MS });
  });

  it("drops an abandoned press when a pinch takes over", () => {
    const h = harness();
    h.openMenu();
    h.choose(TOUCH_MENU_ITEMS, "drag");
    h.adapter.abandon();
    h.menu.cancel();
    h.menu.start(origin, center);
    h.menu.end();
    expect(h.gestures).toEqual([{ kind: "click", at: origin }]);
  });
});

describe("remote keyboard queue", () => {
  it("keeps keys in order and merges text typed during a send", async () => {
    const sent: RemoteKeyboardEntry[] = [];
    const releases: Array<() => void> = [];
    const queue = createRemoteKeyboardQueue((entry) => {
      sent.push(entry);
      return new Promise<void>((resolve) => releases.push(resolve));
    });
    queue.push({ kind: "text", text: "h" });
    queue.push({ kind: "text", text: "e" });
    queue.push({ kind: "text", text: "y" });
    queue.push({ kind: "key", key: "Enter" });
    queue.push({ kind: "text", text: "!" });
    expect(sent).toEqual([{ kind: "text", text: "h" }]);
    for (let index = 0; index < 3; index += 1) {
      releases[index]!();
      await vi.waitFor(() => expect(sent).toHaveLength(index + 2));
    }
    expect(sent).toEqual([
      { kind: "text", text: "h" },
      { kind: "text", text: "ey" },
      { kind: "key", key: "Enter" },
      { kind: "text", text: "!" },
    ]);
  });

  it("splits text past the type limit and forgets unsent entries on clear", async () => {
    const sent: RemoteKeyboardEntry[] = [];
    let release = () => {};
    const queue = createRemoteKeyboardQueue((entry) => {
      sent.push(entry);
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    queue.push({ kind: "text", text: "x".repeat(5_000) });
    expect(sent[0]).toEqual({ kind: "text", text: "x".repeat(4_096) });
    queue.clear();
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toHaveLength(1);
  });
});

describe("remote page menu items", () => {
  const blank = {
    pageUrl: "https://example.com/",
    linkUrl: "",
    linkText: "",
    srcUrl: "",
    mediaType: "none",
    isEditable: false,
    selectionText: "",
    canUndo: false,
    canRedo: false,
    canSelectAll: false,
    canGoBack: true,
    canGoForward: false,
  };
  const ids = (target: typeof blank, canOpenInNewTab = true) =>
    remoteContextMenuItems(target, { canOpenInNewTab }).map((group) =>
      group.map((item) => item.id),
    );

  it("offers page navigation only when nothing is targeted", () => {
    expect(ids(blank)).toEqual([["back", "reload", "copy-page"]]);
  });

  it("never offers to open a script link, only to copy it", () => {
    expect(ids({ ...blank, linkUrl: "javascript:alert(1)" })).toEqual([["copy-link"]]);
    expect(ids({ ...blank, linkUrl: "https://a.test/" }, false)).toEqual([
      ["open-link-here", "copy-link"],
    ]);
  });

  it("gives an editable field its edit items from the page's own flags", () => {
    expect(
      ids({ ...blank, isEditable: true, selectionText: "hi", canUndo: true, canSelectAll: true }),
    ).toEqual([["undo"], ["cut", "copy", "paste", "select-all"], ["search"]]);
  });

  it("lists an image's items and copies a plain selection", () => {
    expect(
      ids({ ...blank, srcUrl: "https://a.test/x.png", mediaType: "image", selectionText: "t" }),
    ).toEqual([["open-media-host", "copy-media"], ["copy"], ["search"]]);
    expect(remoteSearchUrl("  a b ")).toBe("https://www.google.com/search?q=a%20b");
  });
});
