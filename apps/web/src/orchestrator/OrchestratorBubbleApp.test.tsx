// @vitest-environment happy-dom
import { act } from "react";
import type { DesktopOrchestratorBubbleState } from "@t3tools/contracts";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { OrchestratorBubbleApp } from "./OrchestratorBubbleApp";

let container: HTMLDivElement;
let root: Root;
let stateListener: ((state: DesktopOrchestratorBubbleState) => void) | null = null;
const bridge = {
  onState: vi.fn((listener: (state: DesktopOrchestratorBubbleState) => void) => {
    stateListener = listener;
    return () => undefined;
  }),
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
  stateListener = null;
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

const publishState = async (state: DesktopOrchestratorBubbleState) => {
  expect(stateListener).toBeTypeOf("function");
  await act(async () => stateListener?.(state));
};

describe("floating orb rendering cost", () => {
  it("stops idle motion and applies level-only updates without a frame loop", async () => {
    const initialOrb = container.querySelector<HTMLElement>(".galactic-orb")!;
    expect(initialOrb.hasAttribute("data-orb-animated")).toBe(false);

    await publishState({ status: "listening", micLevel: 0.5, assistantLevel: 0 });
    const activeOrb = container.querySelector<HTMLElement>(".galactic-orb")!;
    expect(activeOrb).toBe(initialOrb);
    expect(activeOrb.hasAttribute("data-orb-animated")).toBe(true);
    expect(activeOrb.style.transform).toBe("scale(1.13)");
    expect(activeOrb.style.getPropertyValue("--orb-intensity")).toBe("0.5");

    await publishState({ status: "listening", micLevel: 1, assistantLevel: 0 });
    expect(container.querySelector(".galactic-orb")).toBe(activeOrb);
    expect(activeOrb.style.transform).toBe("scale(1.26)");
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
});

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
