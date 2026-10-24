// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { ProviderUsageDetails } from "../chat/ProviderUsageBar";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

it("confirms account reveal inside the usage popup without dismissing it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const click = async (label: string) => {
    const button = [...document.querySelectorAll("button")].find(
      (element) => element.getAttribute("aria-label") === label || element.textContent === label,
    );
    if (!button) throw new Error(`Missing button: ${label}`);
    await act(async () => button.click());
  };
  try {
    await act(async () =>
      root.render(
        <Popover defaultOpen>
          <PopoverTrigger>Usage</PopoverTrigger>
          <PopoverPopup>
            <ProviderUsageDetails
              name="Codex"
              state="available"
              windows={[]}
              reportedAt={null}
              account={{ email: "fixture@example.com", label: null, type: "Claude Max" }}
            />
          </PopoverPopup>
        </Popover>,
      ),
    );
    expect(document.body.textContent).not.toContain("fixture@example.com");
    await click("Codex account");
    const warning = document.querySelector('[aria-label="Confirm account reveal"]');
    expect(warning).not.toBeNull();
    expect(warning?.classList.contains("basis-full")).toBe(true);
    expect(warning?.classList.contains("order-last")).toBe(true);
    expect(warning?.parentElement?.classList.contains("flex-wrap")).toBe(true);
    expect(warning?.parentElement?.querySelector('[aria-label="Codex account"]')).not.toBeNull();
    expect(warning?.textContent).not.toContain("Claude Max");
    expect(warning?.parentElement?.textContent).toContain("Claude Max");
    expect(document.body.textContent).not.toContain("fixture@example.com");
    await click("Cancel");
    expect(document.body.textContent).not.toContain("fixture@example.com");
    await click("Codex account");
    await click("Reveal");
    expect(document.body.textContent).toContain("Codex usage");
    expect(document.body.textContent).toContain("fixture@example.com");
    await click("Codex account");
    expect(document.body.textContent).not.toContain("fixture@example.com");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
