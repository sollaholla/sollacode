// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
}));
vi.mock("../ui/sidebar", () => ({
  SidebarTrigger: (props: Record<string, unknown>) => <button type="button" {...props} />,
}));

const { MobileTopBar } = await import("./MobileTopBar.tsx");

/**
 * The phone shell has no bottom bar any more - it duplicated the sheet's own
 * navigation and cost a row directly above the browser chrome. Everything it
 * carried is a section of the sheet EXCEPT settings, which would otherwise be
 * three taps away (sheet, command palette, Settings). This row is what keeps
 * both the way into navigation and the way into settings on screen.
 */
describe("MobileTopBar", () => {
  const markup = renderToStaticMarkup(<MobileTopBar />);

  it("always offers the way into navigation", () => {
    expect(markup).toContain('aria-label="Open navigation"');
  });

  it("keeps settings one tap from anywhere", () => {
    expect(markup).toContain('aria-label="Settings"');
    expect(markup).toContain('to="/settings"');
  });

  it("stays a phone-only row", () => {
    expect(markup).toContain("md:hidden");
  });
});
