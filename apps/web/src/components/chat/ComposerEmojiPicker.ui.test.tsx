import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { ComposerEmojiPicker } from "./ComposerEmojiPicker";

describe("composer emoji picker", () => {
  it("collapses to a single shortcut-drawer button by default", () => {
    const markup = renderToStaticMarkup(
      <ComposerEmojiPicker disabled={false} hasTextUnderlay={false} onSelect={vi.fn()} />,
    );

    expect(markup).not.toContain('aria-label="Insert ');
    expect(markup).toContain('aria-label="Open emoji shortcuts"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('aria-label="Open searchable emoji picker"');
    expect(markup).toContain('data-chat-composer-emoji-picker="true"');
  });

  it("uses the low-opacity underlay state while text is present", () => {
    const markup = renderToStaticMarkup(
      <ComposerEmojiPicker disabled={false} hasTextUnderlay onSelect={vi.fn()} />,
    );

    expect(markup).toContain('data-chat-composer-emoji-underlay="true"');
    expect(markup).toContain("opacity-[0.12]");
    expect(markup).toContain("hover:opacity-100");
  });
});
