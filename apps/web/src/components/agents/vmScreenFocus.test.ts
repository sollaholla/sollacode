import { describe, expect, it } from "vite-plus/test";

import {
  isEditableElement,
  shouldForwardKeyToVm,
  shouldReclaimVmScreenFocus,
} from "./vmScreenFocus";

const textarea = { tagName: "TEXTAREA" };
// The chat composer is a Lexical contenteditable, not a textarea.
const composer = { isContentEditable: true, tagName: "DIV" };
const button = { tagName: "BUTTON" };
const body = { tagName: "BODY" };

describe("shouldForwardKeyToVm", () => {
  it("claims the keyboard while the user holds control", () => {
    expect(shouldForwardKeyToVm({ canDrive: true, activeElement: null })).toBe(true);
    expect(shouldForwardKeyToVm({ canDrive: true, activeElement: body })).toBe(true);
    // A focused button does not divert typing: only releasing control or
    // moving into a text field ends the claim.
    expect(shouldForwardKeyToVm({ canDrive: true, activeElement: button })).toBe(true);
  });

  it("yields to a deliberately focused text field", () => {
    expect(shouldForwardKeyToVm({ canDrive: true, activeElement: textarea })).toBe(false);
    expect(shouldForwardKeyToVm({ canDrive: true, activeElement: composer })).toBe(false);
  });

  it("never claims without control", () => {
    expect(shouldForwardKeyToVm({ canDrive: false, activeElement: null })).toBe(false);
  });
});

describe("shouldReclaimVmScreenFocus", () => {
  it("reclaims after a programmatic steal by an editor", () => {
    // The reported bug: streaming updates autofocus the chat composer while
    // the user is typing into the VM — no pointer press preceded the blur.
    expect(
      shouldReclaimVmScreenFocus({
        canDrive: true,
        hadRecentOutsidePointerDown: false,
        blurredTo: composer,
      }),
    ).toBe(true);
    expect(
      shouldReclaimVmScreenFocus({
        canDrive: true,
        hadRecentOutsidePointerDown: false,
        blurredTo: null,
      }),
    ).toBe(true);
  });

  it("respects a deliberate click away", () => {
    expect(
      shouldReclaimVmScreenFocus({
        canDrive: true,
        hadRecentOutsidePointerDown: true,
        blurredTo: composer,
      }),
    ).toBe(false);
  });

  it("leaves dialog focus traps alone", () => {
    // A modal moves focus to non-editable chrome; fighting it would trap the
    // user in a focus tug-of-war.
    expect(
      shouldReclaimVmScreenFocus({
        canDrive: true,
        hadRecentOutsidePointerDown: false,
        blurredTo: button,
      }),
    ).toBe(false);
  });

  it("does nothing once control is released", () => {
    expect(
      shouldReclaimVmScreenFocus({
        canDrive: false,
        hadRecentOutsidePointerDown: false,
        blurredTo: null,
      }),
    ).toBe(false);
  });
});

describe("isEditableElement", () => {
  it("recognizes the editable family", () => {
    expect(isEditableElement(textarea)).toBe(true);
    expect(isEditableElement({ tagName: "INPUT" })).toBe(true);
    expect(isEditableElement({ tagName: "SELECT" })).toBe(true);
    expect(isEditableElement(composer)).toBe(true);
    expect(isEditableElement(button)).toBe(false);
    expect(isEditableElement(null)).toBe(false);
  });
});
