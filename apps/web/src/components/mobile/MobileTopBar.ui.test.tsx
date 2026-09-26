// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

let pathname = "/";
let portraitSettingsLayout = false;

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname }),
  useCanGoBack: () => true,
  useNavigate: () => () => Promise.resolve(),
}));
vi.mock("../ui/sidebar", () => ({
  SidebarTrigger: (props: Record<string, unknown>) => <button type="button" {...props} />,
}));
vi.mock("../settings/SettingsMobileTabs", () => ({
  useSettingsMobileTabs: () => portraitSettingsLayout,
}));

const { MobileTopBar } = await import("./MobileTopBar.tsx");

describe("MobileTopBar", () => {
  beforeEach(() => {
    pathname = "/";
    portraitSettingsLayout = false;
  });

  it("stays a phone-only row", () => {
    expect(renderToStaticMarkup(<MobileTopBar />)).toContain("md:hidden");
  });

  it("keeps a slot at the right edge for a screen's folded-away header", () => {
    const markup = renderToStaticMarkup(<MobileTopBar />);
    const slot = markup.indexOf("data-mobile-top-bar-trailing");
    expect(slot).toBeGreaterThan(markup.indexOf("Solla"));
    expect(markup.slice(slot)).toContain("ml-auto");
  });

  it("offers the way into navigation everywhere else", () => {
    const markup = renderToStaticMarkup(<MobileTopBar />);
    expect(markup).toContain('aria-label="Open navigation"');
    expect(markup).not.toContain('aria-label="Back"');
  });

  it("becomes Back on settings, where the drawer has nothing left to show", () => {
    // Sections moved to the tab strip on this layout, so the drawer trigger
    // would open a sheet the person has no reason to open.
    pathname = "/settings/general";
    portraitSettingsLayout = true;
    const markup = renderToStaticMarkup(<MobileTopBar />);
    expect(markup).toContain('aria-label="Back"');
    expect(markup).not.toContain('aria-label="Open navigation"');
  });

  it("keeps the drawer on settings when the strip is not showing", () => {
    // Landscape and wider still list sections in the drawer, so taking its
    // trigger away there would strand section navigation entirely.
    pathname = "/settings/general";
    portraitSettingsLayout = false;
    const markup = renderToStaticMarkup(<MobileTopBar />);
    expect(markup).toContain('aria-label="Open navigation"');
    expect(markup).not.toContain('aria-label="Back"');
  });
});
