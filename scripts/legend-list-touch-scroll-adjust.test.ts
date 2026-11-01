// @effect-diagnostics globalDate:off globalTimers:off - Fake timers drive the distributed hook directly
// @effect-diagnostics nodeBuiltinImport:off - Exercises the distributed package runtime as a filesystem fixture.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const webRequire = NodeModule.createRequire(new URL("../apps/web/package.json", import.meta.url));
const packageDir =
  process.env.SOLLA_LEGEND_PATCH_DIR ??
  NodePath.dirname(webRequire.resolve("@legendapp/list/react"));
const cleanups: Array<() => void> = [];

// Run the distributed ScrollAdjust hook itself, with its native event targets
// and signal subscriptions. Layout is represented by the same adjustment signal
// used by LegendList's data, item-size, and header-size paths.
function mountScrollAdjust(file: "react.mjs" | "react.js", enabled = true) {
  const source = NodeFS.readFileSync(NodePath.join(packageDir, file), "utf8");
  const hookSource = source.slice(
    source.indexOf("function getScrollAdjustAxis("),
    source.indexOf("var SnapWrapper ="),
  );
  const windowTarget = new EventTarget();
  const scrollWrites = vi.fn();
  let reconcileNativeRequest = () => {};
  const writeOffset = (top: number, left: number) => {
    element.scrollTop = Math.max(0, Math.min(element.scrollHeight - element.clientHeight, top));
    element.scrollLeft = Math.max(0, Math.min(element.scrollWidth - element.clientWidth, left));
  };
  const element = Object.assign(new EventTarget(), {
    scrollTop: 1_000,
    scrollLeft: 0,
    scrollHeight: 5_000,
    clientHeight: 600,
    scrollWidth: 5_000,
    clientWidth: 600,
    ownerDocument: { defaultView: windowTarget },
    querySelector: () => null,
    scrollBy: vi.fn(({ top = 0, left = 0 }: { top?: number; left?: number }) => {
      scrollWrites();
      reconcileNativeRequest = () =>
        writeOffset(element.scrollTop + top, element.scrollLeft + left);
      reconcileNativeRequest();
    }),
    scrollTo: vi.fn(
      ({ top = element.scrollTop, left = element.scrollLeft }: { top?: number; left?: number }) => {
        scrollWrites();
        reconcileNativeRequest = () => writeOffset(top, left);
        reconcileNativeRequest();
      },
    ),
  });
  const state: {
    props: {
      horizontal: boolean;
      maintainVisibleContentPosition: { deferDuringTouch?: boolean };
    };
    refScroller: { current: { getScrollableNode: () => typeof element } };
    scroll: number;
    scrollPending: number;
    cancelDeferredScrollAdjust?: () => void;
    pendingScrollResolve?: () => void;
    didFinishInitialScroll?: boolean;
    initialScroll?: { viewPosition: number };
    initialScrollSession?: { kind: string } | undefined;
    scrollingTo?: { isInitialScroll: boolean } | undefined;
    preservedEndAnchorCorrection?: unknown;
    scrollLength?: number;
    lastNativeScroll?: number;
    lastNativeScrollTime?: number;
  } = {
    props: { horizontal: false, maintainVisibleContentPosition: { deferDuringTouch: enabled } },
    refScroller: { current: { getScrollableNode: () => element } },
    scroll: 1_000,
    scrollPending: 1_000,
  };
  const ctx = { state };
  const values = new Map<string, unknown>();
  const row = { id: "reading-row" };
  const layoutState = Object.assign(state, {
    props: { ...state.props, data: [row] },
    idCache: [row.id],
    positions: [1_200],
    columns: [1],
    columnSpans: [1],
    sizes: new Map([[row.id, 200]]),
  });
  values.set("containerItemData0", row);
  values.set("totalSize", 5_000);
  values.set("otherAxisSize", 400);
  values.set("readyToRender", true);
  const peek = (_ctx: unknown, key: string) => values.get(key);
  const set = (_ctx: unknown, key: string, value: unknown) => values.set(key, value);
  const syncSource = source.slice(
    source.indexOf("function syncMountedContainer("),
    source.indexOf("// src/core/prepareColumnStartState.ts"),
  );
  const syncRow = new Function(
    "peek$",
    "set$",
    "toPhysicalHorizontalItemPosition",
    "POSITION_OUT_OF_VIEW",
    `${syncSource}; return syncMountedContainer;`,
  )(peek, set, (_state: unknown, position: number) => position, -1e6);
  // Use the real slot style as well as its logical position. Pending touch
  // compensation must update rows even without a new range calculation.
  const positionSource = source.slice(
    source.indexOf("var PositionViewState ="),
    source.indexOf("var PositionViewSticky ="),
  );
  const renderPosition = new Function(
    "typedMemo",
    "useArr$",
    "isArray",
    "POSITION_OUT_OF_VIEW",
    "baseCss",
    "React3",
    "React3__namespace",
    `${positionSource};return PositionViewState;`,
  )(
    (component: unknown) => component,
    (keys: string[]) => keys.map((key) => values.get(key)),
    Array.isArray,
    -1e6,
    {},
    { createElement: (_tag: unknown, props: unknown) => ({ props }) },
    { createElement: (_tag: unknown, props: unknown) => ({ props }) },
  );
  const bottomSource = source.slice(
    source.indexOf("function checkAtBottom("),
    source.indexOf("// src/utils/hasActiveMVCPAnchorLock.ts"),
  );
  const checkBottom = new Function(
    "getContentSize",
    "getContentInsetEnd",
    "set$",
    "peek$",
    "EDGE_POSITION_EPSILON",
    "hasActiveInitialScroll",
    `${bottomSource};return checkAtBottom;`,
  )(
    () => Number(values.get("totalSize")),
    () => 0,
    set,
    peek,
    1,
    () => true,
  );
  const containerSource = source.slice(
    source.indexOf("var ContainersInner ="),
    source.indexOf("var Containers ="),
  );
  const renderContainer = new Function(
    "typedMemo",
    "useRef",
    "useStateContext",
    "isHorizontalRTL",
    "useArr$",
    "useDOMOrder",
    "React3",
    "React3__namespace",
    `${containerSource};return ContainersInner;`,
  )(
    (component: unknown) => component,
    () => ({ current: null }),
    () => ctx,
    () => false,
    (keys: string[]) => keys.map((key) => values.get(key)),
    () => {},
    {
      useRef: () => ({ current: null }),
      createElement: (_tag: unknown, props: unknown) => ({ props }),
    },
    {
      useRef: () => ({ current: null }),
      createElement: (_tag: unknown, props: unknown) => ({ props }),
    },
  );
  let trackRenderedExtent = false;
  const reconcileLayout = () => {
    syncRow(ctx, 0, 0, { scrollAdjustPending: Number(values.get("scrollAdjustPending")) || 0 });
    if (trackRenderedExtent) {
      element.scrollHeight = renderedExtent();
      element.scrollTop = Math.min(element.scrollTop, element.scrollHeight - element.clientHeight);
    }
  };
  const renderedExtent = () =>
    renderContainer({ horizontal: false, numColumns: 1 }).props.style.height as number;
  reconcileLayout();
  const listeners = new Map<string, () => void>();
  const effects: Array<() => (() => void) | undefined> = [];
  const react = {
    useRef: <T>(current: T) => ({ current }),
    useCallback: <T>(callback: T) => callback,
    useEffect: (effect: () => (() => void) | undefined) => effects.push(effect),
  };
  const updateScroll = vi.fn((_ctx: unknown, offset: number) => {
    state.scroll = offset;
  });
  const clearInitialSource = source.slice(
    source.indexOf("function clearPreservedInitialScrollTargetTimeout("),
    source.indexOf("function finishInitialScroll("),
  );
  const clearInitialTarget = new Function(
    "setInitialScrollSession",
    `${clearInitialSource};return clearPreservedInitialScrollTarget;`,
  )((current: typeof state) => {
    current.initialScrollSession = undefined;
  });
  const hook = new Function(
    "React3",
    "React3__namespace",
    "useStateContext",
    "peek$",
    "useValueListener$",
    "updateScroll",
    "LEGEND_LIST_CONTENT_CONTAINER_CLASS",
    "set$",
    "calculateItemsInView",
    "flushSync",
    "ReactDOM",
    "clearPreservedInitialScrollTarget",
    `${hookSource}\nreturn ScrollAdjust;`,
  )(
    react,
    react,
    () => ctx,
    (_ctx: unknown, key: string) => values.get(key),
    (key: string, callback: () => void) => listeners.set(key, callback),
    updateScroll,
    "legend-list-content-container",
    set,
    reconcileLayout,
    (commit: () => void) => commit(),
    { flushSync: (commit: () => void) => commit() },
    clearInitialTarget,
  );
  hook();
  const dispose = effects.map((effect) => effect()).filter((effect) => effect !== undefined);
  cleanups.push(() => dispose.forEach((cleanup) => cleanup()));

  const adjust = (delta: number) => {
    state.scroll += delta;
    values.set("scrollAdjust", (Number(values.get("scrollAdjust")) || 0) + delta);
    listeners.get("scrollAdjust")?.();
  };
  const preservedSource = source.slice(
    source.indexOf("function getPreservedEndAnchorOffsetDiff("),
    source.indexOf("function clearFinishedBootstrapInitialScrollTargetIfMovedAway("),
  );
  const schedulePreservedEnd = new Function(
    "isOffsetInitialScrollSession",
    "resolveInitialScrollOffset",
    "getObservedBootstrapInitialScrollOffset",
    "DEFAULT_BOOTSTRAP_REVEAL_EPSILON",
    "requestAdjust",
    `${preservedSource};return schedulePreservedEndAnchorCorrection;`,
  )(
    () => false,
    () => element.scrollHeight - (state.scrollLength ?? element.clientHeight),
    () => element.scrollTop,
    1,
    (_ctx: unknown, delta: number) => adjust(delta),
  );
  return {
    element,
    scrollWrites,
    reconcileNativeRequest: () => reconcileNativeRequest(),
    retargetPreservedEnd: () => schedulePreservedEnd(ctx),
    queuePreservedEnd: (finished = true, active = false) => {
      state.didFinishInitialScroll = finished;
      state.initialScroll = { viewPosition: 1 };
      state.initialScrollSession = { kind: "bootstrap" };
      state.scrollingTo = active ? { isInitialScroll: true } : undefined;
      state.lastNativeScroll = element.scrollTop;
      state.lastNativeScrollTime = Date.now();
      state.scrollLength = element.clientHeight - 60;
      schedulePreservedEnd(ctx);
    },
    input: (type: string, fields: Record<string, unknown> = {}) =>
      element.dispatchEvent(Object.assign(new Event(type), fields)),
    rowViewportTop: () =>
      renderPosition({ id: 0, horizontal: false }).props.style.top +
      (Number(values.get("headerSize")) || 0) -
      element.scrollTop,
    cancel: () => state.cancelDeferredScrollAdjust?.(),
    resizeHeader: (delta: number) => {
      values.set("headerSize", (Number(values.get("headerSize")) || 0) + delta);
      adjust(delta);
    },
    isAtEnd: () => {
      Object.assign(state, { queuedInitialLayout: true, scrollLength: element.clientHeight });
      checkBottom(ctx);
      return values.get("isAtEnd");
    },
    renderedExtent,
    remeasureAbove: (delta: number) => {
      trackRenderedExtent = true;
      layoutState.positions[0]! += delta;
      values.set("totalSize", Number(values.get("totalSize")) + delta);
      adjust(delta);
      reconcileLayout();
    },
    state,
    updateScroll,
    touchStart: () => element.dispatchEvent(new Event("touchstart")),
    touchEnd: () => windowTarget.dispatchEvent(new Event("touchend")),
    scrollEnd: () => element.dispatchEvent(new Event("scrollend")),
    scrollTo: (offset: number) => {
      element.scrollTop = state.scroll = offset;
      state.lastNativeScroll = offset;
      state.lastNativeScrollTime = Date.now();
      element.dispatchEvent(new Event("scroll"));
    },
    adjust,
    dispose: () => dispose.forEach((cleanup) => cleanup()),
    explicitScrollToEnd: () => {
      const imperativeSource = source.slice(
        source.indexOf("function createImperativeHandle("),
        source.indexOf("// src/utils/getAlwaysRenderIndices.ts"),
      );
      const schedule = vi.fn();
      const handle = new Function(
        "ctx",
        "schedule",
        `${imperativeSource}\nreturn createImperativeHandle(ctx, schedule);`,
      )(ctx, schedule);
      void handle.scrollToEnd({ animated: false });
      state.pendingScrollResolve?.();
      return schedule;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) =>
    setTimeout(() => callback(performance.now()), 16),
  );
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each(["react.mjs", "react.js"] as const)("LegendList %s touch adjustments", (file) => {
  it.each([300, -250])(
    "keeps the reading row and native range stable while geometry changes by %i",
    (delta) => {
      const view = mountScrollAdjust(file);
      const initialTop = view.rowViewportTop();
      const initialExtent = view.renderedExtent();
      view.touchStart();
      view.remeasureAbove(delta);
      expect(view.rowViewportTop()).toBe(initialTop);
      expect(view.renderedExtent()).toBe(initialExtent);
      expect(view.scrollWrites).not.toHaveBeenCalled();
      view.touchEnd();
      view.scrollTo(700);
      expect(view.rowViewportTop()).toBe(initialTop + 300);
      view.scrollEnd();
      expect(view.rowViewportTop()).toBe(initialTop + 300);
      expect(view.renderedExtent()).toBe(initialExtent + delta);
      expect(view.element.scrollTop).toBe(700 + delta);
    },
  );

  it.each([300, -250])(
    "rebases a correction of %i at the end without an intermediate range clamp",
    (delta) => {
      const view = mountScrollAdjust(file);
      view.scrollTo(4_400);
      const initialTop = view.rowViewportTop();
      view.touchStart();
      view.remeasureAbove(delta);
      expect(view.element.scrollHeight).toBe(5_000);
      expect(view.element.scrollTop).toBe(4_400);
      expect(view.rowViewportTop()).toBe(initialTop);
      view.touchEnd();
      view.scrollEnd();
      expect(view.element.scrollTop).toBe(4_400 + delta);
      expect(view.element.scrollHeight).toBe(5_000 + delta);
      expect(view.rowViewportTop()).toBe(initialTop);
      if (delta < 0) expect(view.scrollWrites).not.toHaveBeenCalled();
    },
  );

  it("keeps the reading row stable when WebKit reconciles a settled native request", () => {
    const view = mountScrollAdjust(file);
    const top = view.rowViewportTop();
    view.touchStart();
    view.remeasureAbove(188);
    view.touchEnd();
    view.scrollEnd();
    expect(view.rowViewportTop()).toBe(top);
    expect(view.scrollWrites).toHaveBeenCalledOnce();
    // Safari 26.5 applied the same relative delta again on its asynchronous
    // native commit, without another JS write. Reapplying a destination is safe.
    view.reconcileNativeRequest();
    expect(view.rowViewportTop()).toBe(top);
    expect(view.element.scrollTop).toBe(1_188);
    expect(view.scrollWrites).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "preserves the other axis when settling (horizontal: %s)",
    (horizontal) => {
      const view = mountScrollAdjust(file);
      view.state.props.horizontal = horizontal;
      view.element.scrollTop = horizontal ? 37 : 1_000;
      view.element.scrollLeft = horizontal ? 1_000 : 37;
      view.touchStart();
      view.adjust(50);
      expect(view.scrollWrites).not.toHaveBeenCalled();
      view.touchEnd();
      view.scrollEnd();
      expect(view.element.scrollTop).toBe(horizontal ? 37 : 1_050);
      expect(view.element.scrollLeft).toBe(horizontal ? 1_050 : 37);
      expect(view.element.scrollTo).toHaveBeenCalledExactlyOnceWith({
        behavior: "auto",
        [horizontal ? "left" : "top"]: 1_050,
      });
    },
  );

  it("compensates a header resize without waiting for another scroll or row calculation", () => {
    const view = mountScrollAdjust(file);
    const top = view.rowViewportTop();
    view.touchStart();
    view.resizeHeader(80);
    expect(view.rowViewportTop()).toBe(top);
    expect(view.scrollWrites).not.toHaveBeenCalled();
    view.touchEnd();
    view.scrollEnd();
    expect(view.rowViewportTop()).toBe(top);
  });

  it.each(["cancel", "disable"] as const)(
    "removes row and extent compensation together on %s without scrolling",
    (reason) => {
      const view = mountScrollAdjust(file);
      const top = view.rowViewportTop();
      view.touchStart();
      view.remeasureAbove(100);
      expect(view.rowViewportTop()).toBe(top);
      if (reason === "cancel") view.cancel();
      else {
        view.state.props.maintainVisibleContentPosition = {};
        view.touchEnd();
        view.scrollEnd();
      }
      expect(view.rowViewportTop()).toBe(top + 100);
      expect(view.renderedExtent()).toBe(5_100);
      expect(view.scrollWrites).not.toHaveBeenCalled();
    },
  );

  it("reports the rendered end while a negative correction is still pending", () => {
    const view = mountScrollAdjust(file);
    view.scrollTo(4_300);
    view.touchStart();
    view.remeasureAbove(-100);
    expect(view.renderedExtent()).toBe(5_000);
    expect(view.isAtEnd()).toBe(false);
    view.scrollTo(4_400);
    expect(view.isAtEnd()).toBe(true);
  });

  it.each(["touchstart", "pointerdown", "wheel", "keydown"])(
    "cancels a queued finished-bootstrap correction on %s before it can reclaim the viewport",
    (type) => {
      const view = mountScrollAdjust(file);
      view.queuePreservedEnd();
      view.input(type, { deltaY: -30, key: "ArrowUp" });
      view.scrollTo(700);
      // Safari's toolbar changes viewport height after the user's first input.
      view.state.scrollLength = 500;
      expect(view.retargetPreservedEnd()).toBe(false);
      vi.advanceTimersByTime(32);
      view.touchEnd();
      vi.advanceTimersByTime(200);
      expect(view.state.initialScroll).toBeUndefined();
      expect(view.state.preservedEndAnchorCorrection).toBeUndefined();
      expect(view.element.scrollTop).toBe(700);
      expect(view.scrollWrites).not.toHaveBeenCalled();
    },
  );

  it.each([
    [false, false],
    [true, true],
  ])("preserves unfinished or active initial scrolling (%s, %s)", (finished, active) => {
    const view = mountScrollAdjust(file);
    view.queuePreservedEnd(finished, active);
    view.touchStart();
    expect(view.state.initialScroll).toBeDefined();
  });

  it("does not cancel bootstrap on an unrelated modifier key", () => {
    const view = mountScrollAdjust(file);
    view.queuePreservedEnd();
    view.input("keydown", { key: "Shift" });
    expect(view.state.initialScroll).toBeDefined();
    view.dispose();
  });

  it("retains each delta once and applies it relative to the final native position", () => {
    const view = mountScrollAdjust(file);
    view.touchStart();
    view.adjust(30);
    view.adjust(20);
    expect(view.scrollWrites).not.toHaveBeenCalled();
    expect(view.state.scroll).toBe(1_000);
    view.touchEnd();
    view.scrollTo(650);
    view.adjust(-10);
    expect(view.scrollWrites).not.toHaveBeenCalled();

    view.scrollEnd();
    expect(view.element.scrollTop).toBe(690);
    expect(view.element.scrollTo).toHaveBeenCalledExactlyOnceWith({
      behavior: "auto",
      top: 690,
    });
    expect(view.updateScroll).toHaveBeenLastCalledWith(expect.anything(), 690, true, {
      markHasScrolled: false,
    });
    vi.advanceTimersByTime(1_000);
    expect(view.scrollWrites).toHaveBeenCalledTimes(1);
  });

  it("waits for released contact and quiet momentum when scrollend is unavailable", () => {
    const view = mountScrollAdjust(file);
    view.touchStart();
    view.adjust(50);
    view.scrollEnd();
    vi.advanceTimersByTime(1_000);
    expect(view.scrollWrites).not.toHaveBeenCalled();
    view.touchEnd();
    vi.advanceTimersByTime(140);
    view.scrollTo(700);
    vi.advanceTimersByTime(140);
    view.scrollTo(600);
    vi.advanceTimersByTime(149);
    expect(view.scrollWrites).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(view.element.scrollTop).toBe(650);
    expect(view.scrollWrites).toHaveBeenCalledTimes(1);
  });

  it("discards obsolete pending corrections when an explicit scroll supersedes them", () => {
    const view = mountScrollAdjust(file);
    view.touchStart();
    view.adjust(90);
    view.touchEnd();
    expect(view.explicitScrollToEnd()).toHaveBeenCalledOnce();
    view.scrollTo(4_400);
    view.scrollEnd();
    vi.advanceTimersByTime(1_000);
    expect(view.scrollWrites).not.toHaveBeenCalled();
    expect(view.element.scrollTop).toBe(4_400);
  });

  it("drops the old reading anchor when the caller resumes following the end", () => {
    const view = mountScrollAdjust(file);
    view.touchStart();
    view.adjust(60);
    view.touchEnd();
    view.state.props.maintainVisibleContentPosition = {};
    view.scrollTo(4_400);
    view.scrollEnd();
    expect(view.scrollWrites).not.toHaveBeenCalled();
  });

  it("keeps immediate corrections for callers that did not opt in", () => {
    const view = mountScrollAdjust(file, false);
    view.touchStart();
    view.adjust(50);
    expect(view.element.scrollTop).toBe(1_050);
    expect(view.scrollWrites).toHaveBeenCalledOnce();
    expect(view.element.scrollBy).toHaveBeenCalledExactlyOnceWith({
      behavior: "auto",
      left: 0,
      top: 50,
    });
    expect(view.element.scrollTo).not.toHaveBeenCalled();
  });

  it("defers when following the end enables MVCP after touchstart", () => {
    const view = mountScrollAdjust(file, false);
    view.touchStart();
    // Touchmove releases follow mode after the native touchstart listener ran.
    view.state.props.maintainVisibleContentPosition.deferDuringTouch = true;
    view.adjust(50);
    expect(view.scrollWrites).not.toHaveBeenCalled();
    view.touchEnd();
    view.scrollTo(700);
    view.scrollEnd();
    expect(view.element.scrollTop).toBe(750);
    expect(view.scrollWrites).toHaveBeenCalledOnce();
  });

  it("keeps observing contact through a disabled correction", () => {
    const view = mountScrollAdjust(file, false);
    view.touchStart();
    view.adjust(20);
    view.scrollWrites.mockClear();
    view.state.props.maintainVisibleContentPosition.deferDuringTouch = true;
    view.adjust(30);
    expect(view.scrollWrites).not.toHaveBeenCalled();
    view.touchEnd();
    view.scrollEnd();
    expect(view.element.scrollTop).toBe(1_050);
    expect(view.scrollWrites).toHaveBeenCalledOnce();
  });

  it.each(["before", "after"] as const)(
    "credits an extent clamp that happens %s the adjustment signal",
    (when) => {
      const view = mountScrollAdjust(file);
      view.element.scrollHeight = 1_600;
      view.touchStart();
      if (when === "before") {
        view.element.scrollHeight = 1_500;
        view.scrollTo(900);
      }
      view.adjust(-100);
      if (when === "after") {
        view.element.scrollHeight = 1_500;
        view.scrollTo(900);
      }
      view.touchEnd();
      view.scrollEnd();
      expect(view.element.scrollTop).toBe(900);
      expect(view.scrollWrites).not.toHaveBeenCalled();
    },
  );

  it("credits only the portion forced by the new extent", () => {
    const view = mountScrollAdjust(file);
    view.element.scrollHeight = 1_600;
    view.touchStart();
    view.adjust(-150);
    view.element.scrollHeight = 1_500;
    view.scrollTo(900);
    view.touchEnd();
    view.scrollEnd();
    expect(view.element.scrollTop).toBe(850);
    expect(view.element.scrollTo).toHaveBeenCalledExactlyOnceWith({
      behavior: "auto",
      top: 850,
    });
  });

  it("preserves upward motion below a shrinking end instead of treating it as a clamp", () => {
    const view = mountScrollAdjust(file);
    view.element.scrollHeight = 1_600;
    view.touchStart();
    view.adjust(-100);
    view.element.scrollHeight = 1_500;
    view.scrollTo(800);
    view.touchEnd();
    view.scrollEnd();
    expect(view.element.scrollTop).toBe(700);
    expect(view.scrollWrites).toHaveBeenCalledOnce();
  });

  it("does not apply pending corrections or retain input handlers after unmount", () => {
    const view = mountScrollAdjust(file);
    view.touchStart();
    view.adjust(80);
    view.touchEnd();
    view.dispose();
    view.scrollEnd();
    vi.advanceTimersByTime(1_000);
    expect(view.scrollWrites).not.toHaveBeenCalled();
    expect(view.state.cancelDeferredScrollAdjust).toBeUndefined();
  });
});
