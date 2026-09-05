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

describe("MobileTopBar", () => {
  const markup = renderToStaticMarkup(<MobileTopBar />);

  it("always offers the way into navigation", () => {
    expect(markup).toContain('aria-label="Open navigation"');
  });

  it("stays a phone-only row", () => {
    expect(markup).toContain("md:hidden");
  });
});
