// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vite-plus/test";

import { attachRemoteKeyboardInput } from "./remoteBrowserInput";

const FORWARDED = new Set(["Enter", "Backspace", "Tab", "ArrowLeft"]);

function setup(options: { blocked?: () => boolean } = {}) {
  const input = document.createElement("input");
  document.body.append(input);
  const sent: Array<{ text: string } | { key: string }> = [];
  const detach = attachRemoteKeyboardInput(input, {
    forwardedKeys: FORWARDED,
    onText: (text) => sent.push({ text }),
    onKey: (key) => sent.push({ key }),
    isBlocked: options.blocked ?? (() => false),
  });
  // What a keyboard does to the field: the edit lands, then `input` fires.
  const typeInto = (data: string, inputType = "insertText") => {
    const before = new InputEvent("beforeinput", { data, inputType, cancelable: true });
    if (!input.dispatchEvent(before)) return;
    input.value += data;
    input.dispatchEvent(new InputEvent("input", { data, inputType }));
  };
  const key = (name: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key: name, cancelable: true, ...init });
    input.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { input, sent, detach, typeInto, key };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("attachRemoteKeyboardInput", () => {
  it("sends each typed letter as text and empties the field", () => {
    const { input, sent, typeInto } = setup();
    typeInto("h");
    typeInto("i");
    expect(sent).toEqual([{ text: "h" }, { text: "i" }]);
    expect(input.value).toBe("");
  });

  it("sends a predicted word or a paste whole", () => {
    const { sent, typeInto } = setup();
    typeInto("hello ", "insertReplacementText");
    typeInto("pasted text", "insertFromPaste");
    expect(sent).toEqual([{ text: "hello " }, { text: "pasted text" }]);
  });

  it("holds a composition in the field until it ends", () => {
    const { input, sent } = setup();
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    for (const partial of ["h", "he", "hel"]) {
      input.value = partial;
      input.dispatchEvent(new InputEvent("input", { inputType: "insertCompositionText" }));
    }
    // Backspace inside the word edits the word, not the page.
    expect(sent).toEqual([]);
    input.value = "help";
    input.dispatchEvent(new CompositionEvent("compositionend"));
    expect(sent).toEqual([{ text: "help" }]);
    expect(input.value).toBe("");
  });

  it("forwards named keys as presses and leaves letter keydowns to the field", () => {
    const { sent, key } = setup();
    expect(key("Enter")).toBe(true);
    expect(key("ArrowLeft")).toBe(true);
    expect(key("a")).toBe(false);
    expect(key("Enter", { keyCode: 229 })).toBe(false);
    expect(sent).toEqual([{ key: "Enter" }, { key: "ArrowLeft" }]);
  });

  it("sends Backspace to the page only when the field has nothing to delete", () => {
    const { input, sent, key } = setup();
    expect(key("Backspace")).toBe(true);
    input.value = "x";
    expect(key("Backspace")).toBe(false);
    expect(sent).toEqual([{ key: "Backspace" }]);
  });

  it("reads the edit for keyboards that report every key as Unidentified", () => {
    const { input, sent } = setup();
    const del = new InputEvent("beforeinput", {
      inputType: "deleteContentBackward",
      cancelable: true,
    });
    input.dispatchEvent(del);
    const enter = new InputEvent("beforeinput", { inputType: "insertLineBreak", cancelable: true });
    input.dispatchEvent(enter);
    expect([del.defaultPrevented, enter.defaultPrevented]).toEqual([true, true]);
    expect(sent).toEqual([{ key: "Backspace" }, { key: "Enter" }]);
  });

  it("discards input while blocked and stops listening once detached", () => {
    let blocked = true;
    const { input, sent, detach, typeInto, key } = setup({ blocked: () => blocked });
    typeInto("x");
    key("Enter");
    expect(input.value).toBe("");
    blocked = false;
    detach();
    typeInto("y");
    expect(sent).toEqual([]);
  });
});
