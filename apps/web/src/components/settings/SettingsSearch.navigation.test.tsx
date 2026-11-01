// @vitest-environment happy-dom
import { act, type HTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SettingsMobileSearch } from "./SettingsMobileSearch";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

const { navigate, closeSettings } = vi.hoisted(() => ({
  navigate: vi.fn(),
  closeSettings: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("./closeSettings", () => ({ useCloseSettings: () => closeSettings }));
vi.mock("../ui/sidebar", () => {
  const Surface = (props: HTMLAttributes<HTMLDivElement>) => <div {...props} />;
  const Item = ({
    isActive: _isActive,
    ...props
  }: HTMLAttributes<HTMLButtonElement> & { isActive?: boolean }) => <button {...props} />;
  return {
    SidebarContent: Surface,
    SidebarFooter: Surface,
    SidebarGroup: Surface,
    SidebarGroupLabel: Surface,
    SidebarMenu: Surface,
    SidebarMenuItem: Surface,
    SidebarMenuButton: Item,
    useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
  };
});

describe.each(["desktop", "mobile"])("%s settings search", (surface) => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    navigate.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root.render(
        surface === "mobile" ? (
          <SettingsMobileSearch />
        ) : (
          <SettingsSidebarNav pathname="/settings/general" />
        ),
      ),
    );
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  const input = () => host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const type = async (value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const key = async (key: string, isComposing = false) => {
    const event = new KeyboardEvent("keydown", {
      key,
      isComposing,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => input().dispatchEvent(event));
    return event;
  };

  it("navigates the selected result with arrows and Enter and clears the search", async () => {
    await type("provider");
    const options = host.querySelectorAll('[role="option"]');
    expect(options.length).toBeGreaterThan(1);
    await key("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    await key("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    await key("ArrowUp");
    await key("Enter");
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/settings/providers",
      hash: "setting-providers",
      replace: true,
    });
    expect(input().value).toBe("");
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("resets selection for a new query and ignores IME confirmation", async () => {
    await type("provider");
    await key("ArrowUp");
    expect(input().getAttribute("aria-activedescendant")).not.toBeNull();
    await type("theme");
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
    await key("Enter", true);
    expect(navigate).not.toHaveBeenCalled();
    await key("Enter");
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/settings/appearance",
      hash: "setting-theme",
      replace: true,
    });
  });

  it("clears Escape before page dismissal and keeps an empty result list addressable", async () => {
    await type("no-such-setting");
    expect(document.getElementById(input().getAttribute("aria-controls")!)).not.toBeNull();
    await key("Enter");
    expect(navigate).not.toHaveBeenCalled();
    expect((await key("Escape")).defaultPrevented).toBe(true);
    expect(input().value).toBe("");
    expect((await key("Escape")).defaultPrevented).toBe(false);
  });
});
