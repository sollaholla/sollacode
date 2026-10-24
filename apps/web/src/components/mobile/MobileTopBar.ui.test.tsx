// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

let pathname = "/";
let portraitSettingsLayout = false;
let routeParams: Record<string, string> = {};

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname }),
  useParams: () => routeParams,
  useCanGoBack: () => true,
  useNavigate: () => () => Promise.resolve(),
  useRouter: () => ({
    history: { location: { state: { __TSR_index: 1 } }, go: () => {} },
    navigate: () => Promise.resolve(),
  }),
}));
vi.mock("../chat/HostVitalsChip", () => ({
  HostVitalsChip: ({ environmentId }: { environmentId: string }) => (
    <span data-host-vitals-chip={environmentId} />
  ),
}));
vi.mock("../../composerDraftStore", () => ({
  DraftId: { make: (id: string) => id },
  useComposerDraftStore: () => null,
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
    routeParams = {};
  });

  it("stays a phone-only row", () => {
    expect(renderToStaticMarkup(<MobileTopBar />)).toContain("md:hidden");
  });

  it("keeps a slot at the right edge for a screen's folded-away header", () => {
    const markup = renderToStaticMarkup(<MobileTopBar />);
    const slot = markup.indexOf("data-mobile-top-bar-trailing");
    expect(slot).toBeGreaterThan(markup.indexOf("Solla"));
    // The slot is the last thing in a group pinned to the right edge.
    expect(markup.lastIndexOf("ml-auto", slot)).toBeGreaterThan(markup.indexOf("Solla"));
    expect(markup.slice(slot)).not.toContain("<button");
  });

  it("puts the remote machine's battery and disk at the far right, left of the slot", () => {
    routeParams = { environmentId: "remote-1", agentId: "agent-1" };
    const markup = renderToStaticMarkup(<MobileTopBar />);
    const chip = markup.indexOf('data-host-vitals-chip="remote-1"');
    expect(chip).toBeGreaterThan(markup.indexOf("Solla"));
    // Before the slot, so an agent's avatar portaled there lands to its right.
    expect(chip).toBeLessThan(markup.indexOf("data-mobile-top-bar-trailing"));
  });

  it("never hides the slot, because the agent fold drag measures it", () => {
    // display:none reads as a 0x0 rect at the top-left, so the avatar was
    // steered away from the top right and a drag could never fold the card.
    for (const params of [{}, { environmentId: "remote-1", agentId: "agent-1" }]) {
      routeParams = params;
      const markup = renderToStaticMarkup(<MobileTopBar />);
      const slotTag = /<div[^>]*data-mobile-top-bar-trailing[^>]*>/.exec(markup)?.[0] ?? "";
      expect(slotTag).not.toBe("");
      expect(slotTag).not.toMatch(/(^|[\s"])(empty:)?hidden([\s"]|$)/);
      expect(slotTag).not.toMatch(/display:\s*none/);
    }
  });

  it("shows no chip where no thread is on screen", () => {
    expect(renderToStaticMarkup(<MobileTopBar />)).not.toContain("data-host-vitals-chip");
  });

  it("offers the way into navigation everywhere else", () => {
    const markup = renderToStaticMarkup(<MobileTopBar />);
    expect(markup).toContain('aria-label="Open navigation"');
    expect(markup).not.toContain('aria-label="Close settings"');
  });

  it("becomes Close settings on settings, where the drawer has nothing left to show", () => {
    // Sections moved to the tab strip on this layout, so the drawer trigger
    // would open a sheet the person has no reason to open.
    pathname = "/settings/general";
    portraitSettingsLayout = true;
    const markup = renderToStaticMarkup(<MobileTopBar />);
    expect(markup).toContain('aria-label="Close settings"');
    expect(markup).not.toContain('aria-label="Open navigation"');
  });

  it("keeps the drawer on settings when the strip is not showing", () => {
    // Landscape and wider still list sections in the drawer, so taking its
    // trigger away there would strand section navigation entirely.
    pathname = "/settings/general";
    portraitSettingsLayout = false;
    const markup = renderToStaticMarkup(<MobileTopBar />);
    expect(markup).toContain('aria-label="Open navigation"');
    expect(markup).not.toContain('aria-label="Close settings"');
  });
});
