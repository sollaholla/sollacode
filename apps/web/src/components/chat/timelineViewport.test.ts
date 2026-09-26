// @vitest-environment happy-dom

import { describe, expect, it } from "vite-plus/test";
import {
  captureTimelineDisclosure,
  followTimelineEnd,
  restoreTimelineDisclosure,
} from "./timelineViewport";

function setup() {
  const scroller = document.createElement("div");
  scroller.innerHTML =
    '<div data-timeline-row-id="work-toggle:read"><button aria-expanded="false"><span>Show tools</span></button></div>';
  const button = scroller.querySelector("button")!;
  let contentTop = 1_300;
  scroller.scrollTop = 1_000;
  scroller.getBoundingClientRect = () => ({ top: 50 }) as DOMRect;
  const measureButton = () => ({ top: 50 + contentTop - scroller.scrollTop }) as DOMRect;
  button.getBoundingClientRect = measureButton;
  return {
    scroller,
    button,
    measureButton,
    setContentTop: (top: number) => {
      contentTop = top;
    },
  };
}

describe("timeline measured viewport", () => {
  it("keeps the clicked control in place when tools are inserted above it and then measured", () => {
    const { scroller, button, setContentTop } = setup();
    const anchor = captureTimelineDisclosure(scroller, button.firstChild);
    expect(anchor).not.toBeNull();
    // Capturing the nested label claims the disclosure, not an arbitrary row.
    // Use an element child as a pointer event target.
    const captured = captureTimelineDisclosure(scroller, button.querySelector("span"))!;
    setContentTop(2_300);
    restoreTimelineDisclosure(scroller, captured);
    expect(scroller.scrollTop).toBe(2_000);
    expect(button.getBoundingClientRect().top).toBe(350);
    setContentTop(1_850);
    restoreTimelineDisclosure(scroller, captured);
    expect(scroller.scrollTop).toBe(1_550);
    expect(button.getBoundingClientRect().top).toBe(350);
  });

  it("restores the same disclosure after the virtualizer remounts its row", () => {
    const { scroller, button, measureButton, setContentTop } = setup();
    const anchor = captureTimelineDisclosure(scroller, button)!;
    const replacement = scroller.firstElementChild!.cloneNode(true) as HTMLElement;
    scroller.replaceChildren(replacement);
    replacement.querySelector("button")!.getBoundingClientRect = measureButton;
    setContentTop(700);
    restoreTimelineDisclosure(scroller, anchor);
    expect(scroller.scrollTop).toBe(400);
  });

  it("ignores menus and controls outside the transcript", () => {
    const { scroller, button } = setup();
    button.setAttribute("aria-haspopup", "menu");
    expect(captureTimelineDisclosure(scroller, button)).toBeNull();
    expect(captureTimelineDisclosure(document.createElement("div"), button)).toBeNull();
    expect(captureTimelineDisclosure(scroller, null)).toBeNull();
  });

  it("follows the measured extent through growth, shrinkage, and underflow", () => {
    const { scroller } = setup();
    let height = 2_000;
    Object.defineProperty(scroller, "scrollHeight", { get: () => height });
    Object.defineProperty(scroller, "clientHeight", { value: 600 });
    followTimelineEnd(scroller);
    expect(scroller.scrollTop).toBe(1_400);
    height = 2_450;
    followTimelineEnd(scroller);
    expect(scroller.scrollTop).toBe(1_850);
    height = 800;
    followTimelineEnd(scroller);
    expect(scroller.scrollTop).toBe(200);
    height = 400;
    followTimelineEnd(scroller);
    expect(scroller.scrollTop).toBe(0);
  });
});
