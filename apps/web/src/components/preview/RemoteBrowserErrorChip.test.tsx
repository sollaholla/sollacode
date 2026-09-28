// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { RemoteBrowserErrorChip } from "./RemoteBrowserErrorChip";

describe("collapsed browser errors", () => {
  let container: HTMLDivElement;
  let root: Root;
  const message = "The desktop browser could not render a frame for this tab.";
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const render = (error: string | null = message, onRetry = async () => false) =>
    act(async () => root.render(<RemoteBrowserErrorChip error={error} onRetry={onRetry} />));
  const trigger = () => container.querySelector<HTMLButtonElement>("button")!;

  it("starts with only an accessible icon instead of a message box", async () => {
    await render();
    expect(trigger().textContent).toBe("");
    expect(trigger().getAttribute("aria-label")).toBe("Browser error: show details");
    expect(document.body.textContent).not.toContain(message);
  });

  it("reveals the message on tap and collapses on another tap", async () => {
    await render();
    await act(async () => trigger().click());
    expect(document.body.textContent).toContain(message);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    await act(async () => trigger().click());
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("removes the chip on recovery and starts the next error collapsed", async () => {
    await render();
    await act(async () => trigger().click());
    await render(null);
    expect(container.querySelector("button")).toBeNull();
    expect(document.body.textContent).not.toContain(message);
    await render("The desktop browser did not accept the input.");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.body.textContent).not.toContain("did not accept the input");
  });

  it("lets the user retry without submitting duplicate captures", async () => {
    let finish!: (value: boolean) => void;
    const onRetry = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    await render(message, onRetry);
    await act(async () => trigger().click());
    const retry = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Retry",
    )!;
    await act(async () => retry.click());
    expect(onRetry).toHaveBeenCalledOnce();
    expect(retry.disabled).toBe(true);
    expect(retry.textContent).toBe("Retrying…");
    await act(async () => retry.click());
    expect(onRetry).toHaveBeenCalledOnce();
    await act(async () => finish(false));
    expect(retry.disabled).toBe(false);
    expect(document.body.textContent).toContain(message);
  });
});
