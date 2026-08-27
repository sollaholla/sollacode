import { describe, expect, it, vi } from "vite-plus/test";

import {
  formatPendingPrimaryActionLabel,
  formatPushToTalkActionLabel,
  showSettingsUpdateContextMenu,
} from "./ComposerPrimaryActions";

describe("formatPushToTalkActionLabel", () => {
  it("names the model correction pass as refining", () => {
    expect(formatPushToTalkActionLabel("refining", "MacIntel")).toBe(
      "Refining voice transcription (Cmd+D)",
    );
  });
});

describe("formatPendingPrimaryActionLabel", () => {
  it("returns 'Submitting...' while responding", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: true,
        questionIndex: 0,
      }),
    ).toBe("Submitting...");
  });

  it("returns 'Submitting...' while responding regardless of other flags", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: true,
        isResponding: true,
        questionIndex: 3,
      }),
    ).toBe("Submitting...");
  });

  it("returns 'Submit' in compact mode on the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Submit");
  });

  it("returns 'Next' in compact mode when not the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: false,
        isResponding: false,
        questionIndex: 1,
      }),
    ).toBe("Next");
  });

  it("returns 'Next question' when not the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Next question");
  });

  it("returns singular 'Submit answer' on the last question when it is the only question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Submit answer");
  });

  it("uses a purpose-specific approval response label", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
        submitLabel: "Request changes",
      }),
    ).toBe("Request changes");
  });

  it("returns plural 'Submit answers' on the last question when there are multiple questions", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 1,
      }),
    ).toBe("Submit answers");
  });

  it("returns plural 'Submit answers' for higher question indices", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 5,
      }),
    ).toBe("Submit answers");
  });
});

describe("showSettingsUpdateContextMenu", () => {
  it("offers Revert and invokes it when selected", async () => {
    const showContextMenu = vi.fn().mockResolvedValue("revert");
    const onRevert = vi.fn();

    await showSettingsUpdateContextMenu({
      position: { x: 12, y: 34 },
      showContextMenu,
      onRevert,
    });

    expect(showContextMenu).toHaveBeenCalledWith([{ id: "revert", label: "Revert" }], {
      x: 12,
      y: 34,
    });
    expect(onRevert).toHaveBeenCalledOnce();
  });

  it("leaves staged settings alone when the menu is dismissed", async () => {
    const onRevert = vi.fn();

    await showSettingsUpdateContextMenu({
      position: { x: 0, y: 0 },
      showContextMenu: vi.fn().mockResolvedValue(null),
      onRevert,
    });

    expect(onRevert).not.toHaveBeenCalled();
  });
});
