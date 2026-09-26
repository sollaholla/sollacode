// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { AppConfirmHost, chooseInApp, confirmInApp } from "./appConfirm";

it("distinguishes combine, skip, and cancellation without changing boolean confirmations", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<AppConfirmHost />));
    for (const [label, expected] of [
      ["Combine and start", "confirm"],
      ["Skip backlog and start", "alternate"],
      ["Cancel", "cancel"],
    ] as const) {
      let result!: ReturnType<typeof chooseInApp>;
      await act(async () => {
        result = chooseInApp("3 overdue tasks", {
          confirmLabel: "Combine and start",
          alternateLabel: "Skip backlog and start",
        });
      });
      const button = [...document.querySelectorAll("button")].find((e) => e.textContent === label);
      expect(button).toBeDefined();
      await act(async () => button!.click());
      expect(await result).toBe(expected);
    }
    let confirmation!: Promise<boolean>;
    await act(async () => {
      confirmation = confirmInApp("Continue?");
    });
    await act(async () =>
      [...document.querySelectorAll("button")].find((e) => e.textContent === "Cancel")!.click(),
    );
    expect(await confirmation).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
