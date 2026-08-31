import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ComposerBannerStack, type ComposerBannerStackItem } from "./ComposerBannerStack";

// A touch device never fires hover, so the stack must not depend on it.
vi.mock("~/hooks/useOnScreenKeyboard", () => ({ useOnScreenKeyboard: () => true }));

const banner = (id: string): ComposerBannerStackItem => ({
  id,
  variant: "warning",
  icon: <span aria-hidden="true">!</span>,
  title: `${id} warning`,
});

describe("ComposerBannerStack on a coarse pointer", () => {
  it("renders stacked banners open, reachable, and without the collapsed cap", () => {
    const markup = renderToStaticMarkup(
      <ComposerBannerStack items={[banner("front"), banner("stacked")]} />,
    );

    const expandedItems = markup.match(
      /<div data-composer-banner-stack-expanded-items="true" class="([^"]+)">/,
    );

    // Open in layout flow rather than collapsed to a zero-height row.
    expect(expandedItems?.[1]).toContain("grid-rows-[1fr]");
    expect(expandedItems?.[1]).not.toContain("grid-rows-[0fr]");
    // Visible and tappable: hidden-but-clickable is the bug being fixed.
    expect(markup).toContain("visible translate-y-0 opacity-100");
    expect(markup).not.toContain("invisible pointer-events-none");
    expect(markup).toContain("stacked warning");
    // The "more behind this one" cap would sit over the open stack.
    expect(markup).not.toContain("rounded-t-[22px]");
  });
});
