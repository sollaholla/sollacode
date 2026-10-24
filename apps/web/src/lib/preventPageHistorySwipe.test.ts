// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { preventPageHistorySwipe } from "./preventPageHistorySwipe";
import { preventPagePinchZoom } from "./preventPagePinchZoom";

const point = (clientX: number, clientY = 100, identifier = 1) => ({
  clientX,
  clientY,
  identifier,
});

describe("iOS page history swipe guard", () => {
  let surface: HTMLButtonElement;
  let dispose = () => {};
  beforeEach(() => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("iPhone AppleWebKit Safari");
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
    vi.stubGlobal("visualViewport", null);
    surface = document.createElement("button");
    document.body.append(surface);
  });
  afterEach(() => {
    dispose();
    surface.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const touch = (type: string, touches: ReturnType<typeof point>[], cancelable = true) => {
    const event = new Event(type, { bubbles: true, cancelable });
    Object.defineProperty(event, "touches", { value: touches });
    surface.dispatchEvent(event);
    return event;
  };

  it.each([
    [0, 1],
    [20, 21],
    [370, 369],
    [390, 389],
  ])("cancels the first inward movement from either edge (%s to %s)", (from, to) => {
    dispose = preventPageHistorySwipe(document);
    expect(touch("touchstart", [point(from)]).defaultPrevented).toBe(false);
    expect(touch("touchmove", [point(to)]).defaultPrevented).toBe(true);
    // Reversing or moving vertically cannot hand an already-canceled swipe back to Safari.
    expect(touch("touchmove", [point(from, 130)]).defaultPrevented).toBe(true);
  });

  it.each([21, 200, 369])("leaves gestures originating inside the page alone (%s)", (x) => {
    dispose = preventPageHistorySwipe(document);
    touch("touchstart", [point(x)]);
    expect(touch("touchmove", [point(0)]).defaultPrevented).toBe(false);
    expect(touch("touchmove", [point(100)]).defaultPrevented).toBe(false);
  });

  it("does not cancel edge taps, focus events, or click activation", () => {
    dispose = preventPageHistorySwipe(document);
    const clicked = vi.fn();
    surface.addEventListener("click", clicked);
    expect(touch("touchstart", [point(10)]).defaultPrevented).toBe(false);
    expect(touch("touchmove", [point(10)]).defaultPrevented).toBe(false);
    expect(touch("touchend", []).defaultPrevented).toBe(false);
    surface.focus();
    surface.click();
    expect(document.activeElement).toBe(surface);
    expect(clicked).toHaveBeenCalledOnce();
  });

  it.each([
    [point(5, 110), point(70, 110)],
    [point(1), point(70)],
  ])("leaves initially vertical or outward movement alone for the whole gesture", (first, next) => {
    dispose = preventPageHistorySwipe(document);
    touch("touchstart", [point(5)]);
    expect(touch("touchmove", [first]).defaultPrevented).toBe(false);
    expect(touch("touchmove", [next]).defaultPrevented).toBe(false);
  });

  it("still delivers canceled movements to app surfaces and works when bubbling is stopped", () => {
    dispose = preventPageHistorySwipe(document);
    const received: boolean[] = [];
    surface.addEventListener("touchmove", (event) => {
      received.push(event.defaultPrevented);
      event.stopPropagation();
    });
    touch("touchstart", [point(5)]);
    touch("touchmove", [point(10)]);
    expect(received).toEqual([true]);
  });

  it.each(["touchend", "touchcancel", "blur"])("clears the gesture on %s", (type) => {
    dispose = preventPageHistorySwipe(document);
    touch("touchstart", [point(5)]);
    if (type === "blur") window.dispatchEvent(new Event(type));
    else touch(type, []);
    expect(touch("touchmove", [point(50)]).defaultPrevented).toBe(false);
  });

  it("does not reuse an edge touch after multitouch or an identifier change", () => {
    dispose = preventPageHistorySwipe(document);
    touch("touchstart", [point(5)]);
    touch("touchstart", [point(5), point(50, 100, 2)]);
    expect(touch("touchmove", [point(50)]).defaultPrevented).toBe(false);
    touch("touchstart", [point(5)]);
    expect(touch("touchmove", [point(50, 100, 2)]).defaultPrevented).toBe(false);
    expect(touch("touchmove", [point(50)]).defaultPrevented).toBe(false);
  });

  it("coexists with the pinch guard without canceling ordinary single-touch input", () => {
    const removePinch = preventPagePinchZoom(document);
    const removeSwipe = preventPageHistorySwipe(document);
    dispose = () => {
      removePinch();
      removeSwipe();
    };
    expect(touch("touchstart", [point(5)]).defaultPrevented).toBe(false);
    expect(touch("touchmove", [point(10)]).defaultPrevented).toBe(true);
    expect(touch("touchmove", [point(10), point(50, 100, 2)]).defaultPrevented).toBe(true);
    expect(touch("touchmove", [point(50)]).defaultPrevented).toBe(false);
  });

  it("uses the visible viewport and reads resized edges for each new gesture", () => {
    dispose = preventPageHistorySwipe(document);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(844);
    touch("touchstart", [point(830)]);
    expect(touch("touchmove", [point(820)]).defaultPrevented).toBe(true);
    vi.stubGlobal("visualViewport", {
      offsetLeft: 100,
      width: 300,
    });
    touch("touchstart", [point(105)]);
    expect(touch("touchmove", [point(110)]).defaultPrevented).toBe(true);
    touch("touchstart", [point(395)]);
    expect(touch("touchmove", [point(390)]).defaultPrevented).toBe(true);
  });

  it("supports iPad desktop user agents", () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Macintosh AppleWebKit Safari");
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
    vi.spyOn(window.navigator, "maxTouchPoints", "get").mockReturnValue(5);
    dispose = preventPageHistorySwipe(document);
    touch("touchstart", [point(5)]);
    expect(touch("touchmove", [point(10)]).defaultPrevented).toBe(true);
  });

  it.each(["Macintosh AppleWebKit Safari", "Android Chrome", "Windows Chrome"])(
    "does not install the workaround on %s",
    (userAgent) => {
      vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(userAgent);
      vi.spyOn(window.navigator, "maxTouchPoints", "get").mockReturnValue(0);
      dispose = preventPageHistorySwipe(document);
      touch("touchstart", [point(5)]);
      expect(touch("touchmove", [point(10)]).defaultPrevented).toBe(false);
    },
  );

  it("respects noncancelable events and removes its listeners on disposal", () => {
    dispose = preventPageHistorySwipe(document);
    touch("touchstart", [point(5)]);
    expect(touch("touchmove", [point(10)], false).defaultPrevented).toBe(false);
    dispose();
    touch("touchstart", [point(5)]);
    expect(touch("touchmove", [point(10)]).defaultPrevented).toBe(false);
  });
});
