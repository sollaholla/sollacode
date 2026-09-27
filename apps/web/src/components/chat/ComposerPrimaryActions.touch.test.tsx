// @vitest-environment happy-dom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

describe("touch reset of staged conversation settings", () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: ComponentProps<typeof ComposerPrimaryActions>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    props = {
      compact: true,
      pendingAction: null,
      isRunning: false,
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: false,
      settingsUpdateLabel: "New model",
      onApplySettings: vi.fn(),
      onRevertSettings: vi.fn(),
      onPreviousPendingQuestion: vi.fn(),
      onInterrupt: vi.fn(),
      onImplementPlanInNewThread: vi.fn(),
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function render() {
    await act(async () => root.render(<ComposerPrimaryActions {...props} />));
    return container.querySelector<HTMLButtonElement>('button[aria-label^="Apply conversation"]')!;
  }

  async function pointer(button: HTMLElement, type: string, init: PointerEventInit = {}) {
    await act(async () => {
      button.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerType: "touch",
          pointerId: 1,
          clientX: 100,
          clientY: 200,
          button: 0,
          ...init,
        }),
      );
    });
  }

  const popup = () => document.querySelector('[aria-label="Reset conversation changes"]');
  const waitForHold = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });

  it("applies on a short tap without opening reset", async () => {
    const button = await render();
    await pointer(button, "pointerdown");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await pointer(button, "pointerup");
    await act(async () => button.click());
    await waitForHold();
    expect(props.onApplySettings).toHaveBeenCalledOnce();
    expect(popup()).toBeNull();
  });

  it("opens a reset button on hold and never applies on release", async () => {
    const button = await render();
    await pointer(button, "pointerdown");
    await waitForHold();
    expect(popup()?.textContent).toBe("Reset to defaults");
    await pointer(button, "pointerup");
    await act(async () => button.click());
    expect(props.onApplySettings).not.toHaveBeenCalled();
    expect(props.onRevertSettings).not.toHaveBeenCalled();
    await act(async () => popup()?.querySelector<HTMLButtonElement>("button")?.click());
    expect(props.onRevertSettings).toHaveBeenCalledOnce();
    expect(props.onApplySettings).not.toHaveBeenCalled();
  });

  it.each(["pointermove", "pointercancel", "pointerout"])(
    "cancels the hold on %s",
    async (type) => {
      const button = await render();
      await pointer(button, "pointerdown");
      await pointer(button, type, { clientY: 225 });
      await waitForHold();
      expect(popup()).toBeNull();
      expect(props.onApplySettings).not.toHaveBeenCalled();
      expect(props.onRevertSettings).not.toHaveBeenCalled();
    },
  );

  it("does not duplicate the popup when the browser also sends a context menu event", async () => {
    const button = await render();
    await pointer(button, "pointerdown");
    await waitForHold();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => button.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelectorAll('[aria-label="Reset conversation changes"]')).toHaveLength(1);
    expect(props.onApplySettings).not.toHaveBeenCalled();
  });

  it("allows a fresh tap to apply after dismissing a hold", async () => {
    const button = await render();
    await pointer(button, "pointerdown");
    await waitForHold();
    await pointer(button, "pointerup");
    await pointer(container, "pointerdown", { pointerId: 2 });
    await pointer(container, "pointerup", { pointerId: 2 });
    await act(async () => container.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await act(async () => container.click());
    expect(popup()).toBeNull();
    await pointer(button, "pointerdown", { pointerId: 3 });
    await pointer(button, "pointerup", { pointerId: 3 });
    await act(async () => button.click());
    expect(props.onApplySettings).toHaveBeenCalledOnce();
    expect(props.onRevertSettings).not.toHaveBeenCalled();
  });

  it("cancels a pending hold when settings become disabled", async () => {
    const button = await render();
    await pointer(button, "pointerdown");
    props.isApplyingSettings = true;
    await render();
    await waitForHold();
    expect(popup()).toBeNull();
  });

  it("does not reopen an old popup when another pending change appears", async () => {
    const button = await render();
    await pointer(button, "pointerdown");
    await waitForHold();
    props.settingsUpdateLabel = null;
    await render();
    props.settingsUpdateLabel = "Another model";
    await render();
    expect(popup()).toBeNull();
  });

  it("does not open reset just from holding the mouse button", async () => {
    const button = await render();
    await pointer(button, "pointerdown", { pointerType: "mouse" });
    await waitForHold();
    expect(popup()).toBeNull();
  });

  it("cleans up a pending hold when the composer action unmounts", async () => {
    const button = await render();
    await pointer(button, "pointerdown");
    await act(async () => root.render(null));
    await waitForHold();
    expect(popup()).toBeNull();
    expect(props.onApplySettings).not.toHaveBeenCalled();
    expect(props.onRevertSettings).not.toHaveBeenCalled();
  });
});
