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

  it("recedes over draft text without disappearing, and thins further on a phone", () => {
    const markup = renderToStaticMarkup(
      <ComposerEmojiPicker disabled={false} hasTextUnderlay onSelect={vi.fn()} />,
    );

    expect(markup).toContain('data-chat-composer-emoji-underlay="true"');
    // 12% was invisible on a pointer device: you had to know it was there to
    // hover it back. Asserted as the positive value rather than the absence of
    // the old one — the element carries exactly one base opacity class, so
    // this already excludes it, and naming the old class here would put it in
    // Tailwind's scan set and compile a dead `opacity:.12` rule into the
    // production stylesheet.
    expect(markup).toContain("opacity-45");
    // Phone widths are where the control actually collides with the text, so
    // it fades further there — the exact reverse of the old
    // `max-sm:opacity-100`, which pinned it opaque on that very layout. Same
    // breakpoint deliberately: that one demonstrably matched on the device
    // that reported the problem.
    expect(markup).toContain("max-sm:opacity-25");
    expect(markup).not.toContain("max-sm:opacity-100");
    // Touch has no hover, so it has to come back some other way.
    expect(markup).toContain("hover:opacity-100");
    expect(markup).toContain("active:opacity-100");
    expect(markup).toContain("focus-within:opacity-100");
  });

  it("stays fully opaque when there is no text under it", () => {
    const markup = renderToStaticMarkup(
      <ComposerEmojiPicker disabled={false} hasTextUnderlay={false} onSelect={vi.fn()} />,
    );

    expect(markup).toContain('data-chat-composer-emoji-underlay="false"');
    expect(markup).not.toContain("max-sm:opacity-25");
  });
});
