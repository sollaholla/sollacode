// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  beginMicrophoneHold,
  preventMicrophoneTouchDefault,
  type MicrophoneHold,
} from "./microphoneHold";

let active: MicrophoneHold | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  active?.dispose();
  active = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

function pointer(target: EventTarget, type: string, pointerId = 1) {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId,
    pointerType: "touch",
  });
  target.dispatchEvent(event);
  return event;
}

function setup() {
  const microphone = document.createElement("button");
  const other = document.createElement("button");
  const input = document.createElement("textarea");
  input.value = "Existing draft";
  const transcript = document.createElement("p");
  transcript.textContent = "Transcript text";
  document.body.append(microphone, other, input, transcript);
  const onRelease = vi.fn();
  const start = () =>
    (active = beginMicrophoneHold(microphone, { kind: "pointer", pointerId: 1 }, onRelease));
  return { microphone, other, input, transcript, onRelease, start };
}

describe("microphone hold interaction ownership", () => {
  it("clears selection and blocks other controls and selection gestures for the hold", () => {
    const { other, input, transcript, start, onRelease } = setup();
    input.focus();
    input.setSelectionRange(0, input.value.length);
    const range = document.createRange();
    range.selectNodeContents(transcript);
    document.getSelection()?.addRange(range);
    start();
    expect(document.getSelection()?.rangeCount).toBe(0);
    expect(input.selectionStart).toBe(input.selectionEnd);
    expect(input.value).toBe("Existing draft");
    const clicked = vi.fn();
    other.addEventListener("click", clicked);
    for (const type of [
      "click",
      "contextmenu",
      "selectstart",
      "touchstart",
      "touchmove",
      "beforeinput",
      "wheel",
    ]) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      expect(other.dispatchEvent(event)).toBe(false);
      expect(event.defaultPrevented).toBe(true);
    }
    document.getSelection()?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    expect(document.getSelection()?.rangeCount).toBe(0);
    expect(clicked).not.toHaveBeenCalled();
    expect(onRelease).not.toHaveBeenCalled();
    expect(document.documentElement.getAttribute("data-microphone-hold")).toBe("true");
  });

  it("releases once outside the mic and blocks the delayed release click but accepts a fresh tap", () => {
    const { other, onRelease, start } = setup();
    start();
    pointer(other, "pointerup");
    pointer(other, "pointercancel");
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(active?.isHolding()).toBe(false);
    expect(document.documentElement.hasAttribute("data-microphone-hold")).toBe(false);
    const clicked = vi.fn();
    other.addEventListener("click", clicked);
    other.click();
    expect(clicked).not.toHaveBeenCalled();
    expect(pointer(other, "pointerdown", 2).defaultPrevented).toBe(false);
    pointer(other, "pointerup", 2);
    other.click();
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("blocks a second finger until it is released, even after the recording finger lifts", () => {
    const { other, onRelease, start } = setup();
    start();
    expect(pointer(other, "pointerdown", 2).defaultPrevented).toBe(true);
    pointer(document, "pointerup", 1);
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(document.documentElement.hasAttribute("data-microphone-hold")).toBe(true);
    const clicked = vi.fn();
    other.addEventListener("click", clicked);
    other.click();
    expect(clicked).not.toHaveBeenCalled();
    pointer(other, "pointerup", 2);
    other.click();
    expect(clicked).not.toHaveBeenCalled();
    expect(document.documentElement.hasAttribute("data-microphone-hold")).toBe(false);
    vi.advanceTimersByTime(750);
    other.click();
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("stops on lost capture and keeps guarding the held finger until its release", () => {
    const { microphone, onRelease, start } = setup();
    start();
    pointer(microphone, "lostpointercapture");
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(document.documentElement.hasAttribute("data-microphone-hold")).toBe(true);
    pointer(document, "pointercancel");
    expect(document.documentElement.hasAttribute("data-microphone-hold")).toBe(false);
    vi.advanceTimersByTime(750);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it.each(["unmount", "window blur", "Escape"])("cleans up immediately after %s", (reason) => {
    const { other, start, onRelease } = setup();
    start();
    if (reason === "unmount") active?.dispose();
    else if (reason === "window blur") window.dispatchEvent(new Event("blur"));
    else window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(document.documentElement.hasAttribute("data-microphone-hold")).toBe(false);
    const clicked = vi.fn();
    other.addEventListener("click", clicked);
    other.click();
    expect(clicked).toHaveBeenCalledTimes(1);
    active?.dispose();
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it("supports keyboard holds and allows keyboard interaction again after release", () => {
    const { microphone, onRelease } = setup();
    active = beginMicrophoneHold(microphone, { kind: "key", key: " " }, onRelease);
    const tab = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    window.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keyup", { key: " ", cancelable: true }));
    expect(onRelease).toHaveBeenCalledTimes(1);
    const nextTab = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    window.dispatchEvent(nextTab);
    expect(nextTab.defaultPrevented).toBe(false);
  });

  it("cancels native Safari touch default handling", () => {
    const event = new TouchEvent("touchstart", { cancelable: true });
    preventMicrophoneTouchDefault(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
