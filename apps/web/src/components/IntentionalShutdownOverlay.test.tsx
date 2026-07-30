import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { IntentionalShutdownOverlayView } from "./IntentionalShutdownOverlay";

describe("IntentionalShutdownOverlayView", () => {
  it("covers the app with a clear intentional-quit state", () => {
    const html = renderToStaticMarkup(<IntentionalShutdownOverlayView active />);
    expect(html).toContain("data-intentional-shutdown-overlay");
    expect(html).toContain("Quitting Solla Code");
    expect(html).toContain("Closing your local services safely");
    expect(html).toContain('role="status"');
  });

  it("does not mask genuine runtime errors outside an intentional quit", () => {
    expect(renderToStaticMarkup(<IntentionalShutdownOverlayView active={false} />)).toBe("");
  });
});
