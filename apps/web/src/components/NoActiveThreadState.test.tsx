import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SideChatLoadingState } from "./NoActiveThreadState";

describe("SideChatLoadingState", () => {
  it("shows an unambiguous loading wheel instead of the generic thread picker", () => {
    const markup = renderToStaticMarkup(<SideChatLoadingState />);

    expect(markup).toContain("data-side-chat-loading-state");
    expect(markup).toContain("animate-spin");
    expect(markup).toContain("Loading side chat…");
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain("Pick a thread to continue");
    expect(markup).not.toContain("No active thread");
  });
});
