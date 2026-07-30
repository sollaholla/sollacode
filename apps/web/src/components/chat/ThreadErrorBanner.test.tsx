import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ThreadErrorBanner } from "./ThreadErrorBanner";

describe("ThreadErrorBanner", () => {
  it("keeps the portrait dismiss action above overlays with a real touch target", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error="Provider failed" onDismiss={vi.fn()} />,
    );

    expect(markup).toContain('data-chat-thread-error-banner="true"');
    expect(markup).toContain("pointer-events-auto");
    expect(markup).toContain("z-30");
    expect(markup).toContain('aria-label="Dismiss error"');
    expect(markup).toContain('data-chat-thread-error-dismiss="true"');
    expect(markup).toContain("size-11");
    expect(markup).toContain("touch-manipulation");
    expect(markup).toContain("opacity-100");
    expect(markup).not.toContain(' disabled=""');
  });
});
