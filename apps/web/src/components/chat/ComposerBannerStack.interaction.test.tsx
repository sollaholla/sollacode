// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerBannerStack, type ComposerBannerStackItem } from "./ComposerBannerStack";

vi.mock("~/hooks/useOnScreenKeyboard", () => ({ useOnScreenKeyboard: () => true }));

let container: HTMLDivElement;
let root: Root;

const reconnect = vi.fn();
const connections = vi.fn();
const connectionNotice: ComposerBannerStackItem = {
  id: "environment-unavailable:remote",
  variant: "warning",
  icon: <span aria-hidden>!</span>,
  title: "Remote Mac: Failed to connect. Reconnecting…",
  collapsedLabel: "Reconnecting…",
  description: "Messages are saved on this device until the connection returns.",
  actions: (
    <>
      <button onClick={reconnect}>Reconnect</button>
      <button onClick={connections}>Connections</button>
    </>
  ),
};

describe("compact connection notice on touch", () => {
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

  it("starts collapsed, opens the help and actions on tap, and collapses again", async () => {
    await act(async () => root.render(<ComposerBannerStack items={[connectionNotice]} />));
    const details = container.querySelector("details")!;
    const summary = details.querySelector("summary")!;
    expect(details.open).toBe(false);
    expect(summary.textContent).toBe("!Reconnecting…");
    await act(async () => summary.click());
    expect(details.open).toBe(true);
    expect(details.textContent).toContain("Messages are saved on this device");
    const buttons = details.querySelectorAll("button");
    await act(async () => {
      buttons[0]!.click();
      buttons[1]!.click();
    });
    expect(reconnect).toHaveBeenCalledOnce();
    expect(connections).toHaveBeenCalledOnce();
    await act(async () => summary.click());
    expect(details.open).toBe(false);
  });

  it("keeps the user's expansion through status updates and resets after recovery", async () => {
    await act(async () => root.render(<ComposerBannerStack items={[connectionNotice]} />));
    await act(async () => container.querySelector("summary")!.click());
    await act(async () =>
      root.render(
        <ComposerBannerStack
          items={[{ ...connectionNotice, collapsedLabel: "Disconnected", variant: "error" }]}
        />,
      ),
    );
    expect(container.querySelector("details")!.open).toBe(true);
    await act(async () => root.render(<ComposerBannerStack items={[]} />));
    expect(container.querySelector("details")).toBeNull();
    await act(async () => root.render(<ComposerBannerStack items={[connectionNotice]} />));
    expect(container.querySelector("details")!.open).toBe(false);
  });

  it("does not collapse other warnings or auto-expand the connection help in a touch stack", async () => {
    await act(async () =>
      root.render(
        <ComposerBannerStack
          items={[
            { id: "sign-in", variant: "error", icon: null, title: "Sign in required" },
            connectionNotice,
          ]}
        />,
      ),
    );
    expect(container.querySelector("details")!.open).toBe(false);
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("Sign in required");
  });
});
