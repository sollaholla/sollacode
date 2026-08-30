import { describe, expect, it, vi } from "vite-plus/test";

import {
  findRemoteEditableRegion,
  focusRemoteKeyboardForPoint,
  remoteKeyboardActionForBeforeInput,
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

describe("remoteKeyboardActionForBeforeInput", () => {
  it("maps mobile text and editing input onto focused-guest actions", () => {
    expect(remoteKeyboardActionForBeforeInput({ inputType: "insertText", data: "a" })).toEqual({
      kind: "type",
      text: "a",
    });
    expect(
      remoteKeyboardActionForBeforeInput({ inputType: "insertParagraph", data: null }),
    ).toEqual({ kind: "press", key: "Enter" });
    expect(
      remoteKeyboardActionForBeforeInput({ inputType: "deleteContentBackward", data: null }),
    ).toEqual({ kind: "press", key: "Backspace" });
  });

  it("does not invent an action for an unsupported edit", () => {
    expect(remoteKeyboardActionForBeforeInput({ inputType: "historyUndo", data: null })).toBeNull();
  });
});
