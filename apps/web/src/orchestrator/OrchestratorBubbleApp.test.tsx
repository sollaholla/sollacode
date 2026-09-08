// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { OrchestratorBubbleApp } from "./OrchestratorBubbleApp";

let container: HTMLDivElement;
let root: Root;
const bridge = {
  onState: vi.fn(() => () => undefined),
  setInteractive: vi.fn(async () => undefined),
  beginDrag: vi.fn(async () => undefined),
  move: vi.fn(async () => undefined),
  dragEnd: vi.fn(async () => undefined),
  toggleVoice: vi.fn(async () => undefined),
  open: vi.fn(async () => undefined),
};

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("innerWidth", 288);
  vi.stubGlobal("innerHeight", 288);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("desktopBridge", { orchestratorBubble: bridge });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<OrchestratorBubbleApp />));
  const surface = container.querySelector<HTMLElement>('[data-testid="orchestrator-bubble"]')!;
  surface.setPointerCapture = vi.fn();
  surface.hasPointerCapture = vi.fn(() => true);
  surface.releasePointerCapture = vi.fn();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const tooltip = () => container.querySelector('[role="tooltip"]');
const hoverOrb = async () => {
  await act(async () =>
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 144, clientY: 144 })),
  );
  await act(async () => vi.advanceTimersByTime(500));
};
const pointer = async (type: string) => {
  const surface = container.querySelector<HTMLElement>('[data-testid="orchestrator-bubble"]')!;
  await act(async () =>
    surface.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        button: 0,
        pointerId: 1,
        screenX: 144,
        screenY: 144,
      }),
    ),
  );
};

describe("floating orb hint", () => {
  it("uses a delayed renderer hint with no native title popup", async () => {
    expect(container.querySelector("[title]")).toBeNull();
    expect(tooltip()).toBeNull();
    await hoverOrb();
    expect(tooltip()?.textContent).toContain("Click to talk");
    expect(bridge.setInteractive).toHaveBeenLastCalledWith(true);
  });

  it("expires even if Electron never sends pointerleave and stays closed until re-entry", async () => {
    await hoverOrb();
    expect(tooltip()).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(2_000));
    expect(tooltip()).toBeNull();
    await hoverOrb();
    expect(tooltip()).toBeNull();
    await act(async () =>
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 10, clientY: 10 })),
    );
    expect(bridge.setInteractive).toHaveBeenLastCalledWith(false);
    await hoverOrb();
    expect(tooltip()).not.toBeNull();
  });

  it.each(["mouseleave", "blur"])("closes on %s", async (event) => {
    await hoverOrb();
    await act(async () => window.dispatchEvent(new Event(event)));
    expect(tooltip()).toBeNull();
  });

  it("closes on Escape", async () => {
    await hoverOrb();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(tooltip()).toBeNull();
  });

  it("clears on press and cancels a drag without toggling the microphone", async () => {
    await hoverOrb();
    await pointer("pointerdown");
    expect(tooltip()).toBeNull();
    await pointer("pointercancel");
    await pointer("pointerup");
    expect(bridge.toggleVoice).not.toHaveBeenCalled();
    expect(bridge.dragEnd).toHaveBeenCalledTimes(1);
  });

  it("still toggles voice on a tap", async () => {
    await pointer("pointerdown");
    await pointer("pointerup");
    expect(bridge.toggleVoice).toHaveBeenCalledTimes(1);
  });

  it("opens the thread without toggling voice or leaving the hint open", async () => {
    await hoverOrb();
    const thread = container.querySelector('[data-testid="orchestrator-bubble-open-thread"]')!;
    await act(async () =>
      thread.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }),
      ),
    );
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(bridge.toggleVoice).not.toHaveBeenCalled();
    expect(tooltip()).toBeNull();
  });
});
