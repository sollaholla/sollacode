// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ComposerConnectionChip } from "./ComposerConnectionChip";
import { OfflineOutboxChip } from "./OfflineOutbox";
import { ComposerStatusRail } from "./ComposerStatusRail";

let container: HTMLDivElement;
let root: Root;
const reconnect = vi.fn();
const connections = vi.fn();

describe("connection and outbox icon chips", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(reconnecting = false) {
    await act(async () =>
      root.render(
        <ComposerStatusRail
          actions={
            <>
              <ComposerConnectionChip
                title="Mac: Reconnecting…"
                description="Messages are saved on this device."
                reconnecting={reconnecting}
                onReconnect={reconnect}
                onConnections={connections}
              />
              <OfflineOutboxChip
                phase="waiting"
                messages={[
                  {
                    id: "one",
                    text: "Continue",
                    savedAt: "2026-09-27T00:00:00Z",
                    attachmentCount: 0,
                    error: undefined,
                  },
                ]}
                timestampFormat="24-hour"
                onRetry={() => {}}
                onDiscard={() => {}}
              />
            </>
          }
        />,
      ),
    );
  }

  it("keeps two separate, matching icon-only triggers in the actions row", async () => {
    await render();
    const actions = container.querySelector('[data-chat-composer-status-slot="actions"]')!;
    const chips = actions.querySelectorAll("button");
    expect(chips).toHaveLength(2);
    for (const chip of chips) {
      expect(chip.textContent).toBe("");
      expect(chip.className).toContain("h-7 min-w-7");
      expect(chip.className).toContain("border-amber-500/35");
      expect(chip.getAttribute("aria-label")).toBeTruthy();
    }
    expect(document.body.textContent).not.toContain("Messages are saved");
  });

  it("opens connection guidance and actions on tap, then closes on a second tap", async () => {
    await render();
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-chat-composer-status-chip="connection"]',
    )!;
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.textContent).toContain("Messages are saved on this device.");
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
    await act(async () => {
      buttons.find((b) => b.textContent === "Reconnect")!.click();
      buttons.find((b) => b.textContent === "Connections")!.click();
    });
    expect(reconnect).toHaveBeenCalledOnce();
    expect(connections).toHaveBeenCalledOnce();
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not offer a duplicate reconnect while a retry is already running", async () => {
    await render(true);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-chat-composer-status-chip="connection"]')!
        .click(),
    );
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Reconnecting…",
    )!;
    expect(button.disabled).toBe(true);
  });
});
