// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { GUEST_SELECT_MENU_SOURCE } from "./GuestSelectMenu.ts";

// A browser's own events are trusted; the script ignores any a page fabricates.
function press(target: Element, type = "mousedown"): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, composed: true });
  Object.defineProperty(event, "isTrusted", { value: true });
  target.dispatchEvent(event);
  return event;
}

function pressKey(target: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  Object.defineProperty(event, "isTrusted", { value: true });
  target.dispatchEvent(event);
  return event;
}

const optionsOf = (...labels: ReadonlyArray<string>) =>
  labels.map((label) => `<option>${label}</option>`).join("");

function addSelect(...labels: ReadonlyArray<string>): HTMLSelectElement {
  const parent = document.createElement("div");
  parent.innerHTML = `<select>${optionsOf(...labels)}</select>`;
  document.body.append(parent);
  const select = parent.querySelector("select")!;
  // happy-dom has no default here.
  Object.defineProperty(select, "size", { value: 0, writable: true });
  return select;
}

const menuHost = () => document.querySelector("[data-probe]");
const menuRows = () =>
  Array.from(menuHost()?.shadowRoot?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);

describe("guest select menu", () => {
  beforeAll(() => {
    // happy-dom has no top layer or constructable sheets.
    vi.stubGlobal(
      "CSSStyleSheet",
      class {
        replaceSync() {}
      },
    );
    HTMLElement.prototype.showPopover = function showPopover(this: HTMLElement) {
      this.setAttribute("data-probe", "");
    };
    HTMLElement.prototype.scrollIntoView = () => undefined;
    new Function(GUEST_SELECT_MENU_SOURCE)();
  });

  beforeEach(() => {
    // A press anywhere closes whatever a test left open.
    press(document.body);
    document.body.replaceChildren();
  });

  it("opens the list in the page instead of the browser's popup", () => {
    const select = addSelect("One", "Two");

    const event = press(select);

    expect(event.defaultPrevented).toBe(true);
    expect(menuRows()).toHaveLength(2);
  });

  it("makes a choice the way a real one arrives", () => {
    const select = addSelect("One", "Two");
    const fired: Array<string> = [];
    select.addEventListener("input", () => fired.push("input"));
    select.addEventListener("change", () => fired.push("change"));

    press(select);
    menuRows()[1]!.click();

    expect(select.value).toBe("Two");
    expect(fired).toEqual(["input", "change"]);
    expect(menuHost()).toBeNull();
  });

  it("leaves a press alone when the page cancelled it for its own list", () => {
    const select = addSelect("One");
    select.addEventListener("mousedown", (event) => event.preventDefault());

    press(select);

    expect(menuHost()).toBeNull();
  });

  it("leaves list boxes alone, which have no popup", () => {
    const select = addSelect("One");
    select.size = 4;

    expect(press(select).defaultPrevented).toBe(false);
    expect(menuHost()).toBeNull();
  });

  it("finds the same choice when a live page rebuilt the options", () => {
    const select = addSelect("One", "Two");

    press(select);
    select.innerHTML = optionsOf("New", "One", "Two");
    menuRows()[1]!.click();

    expect(select.selectedIndex).toBe(2);
  });

  it("opens from the keyboard and closes without changing anything", () => {
    const select = addSelect("One", "Two");

    pressKey(select, " ");
    expect(menuRows()).toHaveLength(2);
    pressKey(select, "ArrowDown");
    pressKey(select, "Escape");

    expect(menuHost()).toBeNull();
    expect(select.value).toBe("One");
  });

  it("installs once however many times a frame is told to", () => {
    const select = addSelect("One");

    new Function(GUEST_SELECT_MENU_SOURCE)();
    press(select);

    expect(menuRows()).toHaveLength(1);
  });
});
