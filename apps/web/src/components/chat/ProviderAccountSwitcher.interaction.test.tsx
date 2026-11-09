// @vitest-environment happy-dom
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { ProviderAccountSwitcher } from "./ProviderAccountSwitcher";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("claude_work"),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", email: "work@example.com" },
  checkedAt: "2026-07-29T15:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

it("reveals the account inside the popup without closing it", async () => {
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
        <ProviderAccountSwitcher
          providers={[provider]}
          activeInstanceId={provider.instanceId}
          activeSwitch={null}
          onSwitchUser={() => undefined}
        />,
      ),
    );
    await click("Provider account and switch-user controls");
    expect(document.body.textContent).not.toContain("work@example.com");

    await click("Toggle provider account visibility");
    // A modal dialog counts as a press outside the popup and closes it.
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.querySelector('[aria-label="Confirm account reveal"]')).not.toBeNull();

    await click("Reveal");
    expect(document.body.textContent).toContain("work@example.com");
    expect(document.body.textContent).toContain("Switch user");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
