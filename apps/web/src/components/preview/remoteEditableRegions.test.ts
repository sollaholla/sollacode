import { describe, expect, it, vi } from "vite-plus/test";

import {
  findRemoteEditableRegion,
  focusRemoteKeyboardForPoint,
  remoteKeyboardActionForBeforeInput,
  remoteKeyboardTextForInput,
  resetRemoteKeyboardTarget,
} from "./remoteEditableRegions";

describe("findRemoteEditableRegion", () => {
  it("finds the text control under a mirrored viewport point", () => {
    expect(
      findRemoteEditableRegion([{ x: 40, y: 80, width: 240, height: 44, inputMode: "email" }], {
        x: 100,
        y: 100,
      }),
    ).toMatchObject({ inputMode: "email" });
    expect(
      findRemoteEditableRegion([{ x: 40, y: 80, width: 240, height: 44 }], {
        x: 10,
        y: 10,
      }),
    ).toBeNull();
  });

  it("prefers the last painted candidate when editable bounds overlap", () => {
    expect(
      findRemoteEditableRegion(
        [
          { x: 0, y: 0, width: 100, height: 100, inputMode: "text" },
          { x: 20, y: 20, width: 60, height: 60, inputMode: "numeric" },
        ],
        { x: 50, y: 50 },
      )?.inputMode,
    ).toBe("numeric");
  });
});

describe("focusRemoteKeyboardForPoint", () => {
  it("configures and focuses the mounted keyboard target during the tap", () => {
    const focus = vi.fn();
    const blur = vi.fn();
    const keyboardTarget = { inputMode: "text", focus, blur };

    expect(
      focusRemoteKeyboardForPoint({
        keyboardTarget,
        regions: [{ x: 40, y: 80, width: 240, height: 44, inputMode: "email" }],
        point: { x: 100, y: 100 },
      }),
    ).toBe(true);
    expect(keyboardTarget.inputMode).toBe("email");
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(blur).not.toHaveBeenCalled();
  });

  it("blurs the keyboard target when the tap is not editable", () => {
    const focus = vi.fn();
    const blur = vi.fn();
    expect(
      focusRemoteKeyboardForPoint({
        keyboardTarget: { inputMode: "text", focus, blur },
        regions: [],
        point: { x: 100, y: 100 },
      }),
    ).toBe(false);
    expect(blur).toHaveBeenCalledOnce();
    expect(focus).not.toHaveBeenCalled();
  });
});

describe("resetRemoteKeyboardTarget", () => {
  it("clears and blurs retained mobile keyboard focus", () => {
    const blur = vi.fn();
    const target = { value: "stale text", blur };

    resetRemoteKeyboardTarget(target);

    expect(target.value).toBe("");
    expect(blur).toHaveBeenCalledOnce();
  });
});

describe("remoteKeyboardActionForBeforeInput", () => {
  it("maps non-text mobile editing input onto focused-guest actions", () => {
    expect(
      remoteKeyboardActionForBeforeInput({ inputType: "insertParagraph", data: null }),
    ).toEqual({ kind: "press", key: "Enter" });
    expect(
      remoteKeyboardActionForBeforeInput({ inputType: "deleteContentBackward", data: null }),
    ).toEqual({ kind: "press", key: "Backspace" });
  });

  it("leaves text insertion to the reliable input event", () => {
    expect(remoteKeyboardActionForBeforeInput({ inputType: "insertText", data: "a" })).toBeNull();
    expect(
      remoteKeyboardActionForBeforeInput({ inputType: "insertCompositionText", data: "a" }),
    ).toBeNull();
    expect(remoteKeyboardActionForBeforeInput({ inputType: "historyUndo", data: null })).toBeNull();
  });
});

describe("remoteKeyboardTextForInput", () => {
  it("uses the hidden input value when iOS omits beforeinput data", () => {
    expect(remoteKeyboardTextForInput({ data: null, value: "hello", isComposing: false })).toBe(
      "hello",
    );
  });

  it("falls back to input-event data and waits for composition to commit", () => {
    expect(remoteKeyboardTextForInput({ data: "a", value: "", isComposing: false })).toBe("a");
    expect(remoteKeyboardTextForInput({ data: "ka", value: "ka", isComposing: true })).toBeNull();
  });
});
