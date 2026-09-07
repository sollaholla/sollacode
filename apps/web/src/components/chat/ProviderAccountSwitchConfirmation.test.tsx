// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ProviderAccountSwitchConfirmation } from "./ProviderAccountSwitchConfirmation";

let container: HTMLDivElement;
let root: Root;
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

it.each(["Primary host", "Remote Windows", null])(
  "requires a deliberate second action for %s",
  async (environmentLabel) => {
    const confirm = vi.fn();
    const close = vi.fn();
    await act(async () =>
      root.render(
        <ProviderAccountSwitchConfirmation
          open
          environmentLabel={environmentLabel}
          authenticationPaused={false}
          onConfirm={confirm}
          onClose={close}
        />,
      ),
    );
    expect(document.body.textContent).toContain("This signs out the current provider account.");
    expect(confirm).not.toHaveBeenCalled();
    const buttons = Array.from(document.querySelectorAll("button"));
    await act(async () => buttons.find((button) => button.textContent === "Cancel")!.click());
    expect(close).toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    await act(async () =>
      buttons.find((button) => button.textContent === "Sign out and continue")!.click(),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
  },
);
