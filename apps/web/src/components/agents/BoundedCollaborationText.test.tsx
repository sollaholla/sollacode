import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BoundedCollaborationText, boundedTextPreview } from "./BoundedCollaborationText";

describe("boundedTextPreview", () => {
  it("keeps contract-sized collaboration text out of the collapsed render", () => {
    const text = `Start ${"x".repeat(49_980)} hidden-tail`;
    const preview = boundedTextPreview(text, { maxCharacters: 420, maxLines: 5 });

    expect(preview.truncated).toBe(true);
    expect(preview.text.length).toBeLessThanOrEqual(420);
    expect(preview.text).not.toContain("hidden-tail");

    const markup = renderToStaticMarkup(
      <BoundedCollaborationText text={text} collapsedLabel="Show full brief" />,
    );
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Show full brief");
    expect(markup).not.toContain("hidden-tail");
  });

  it("bounds short log lines by height as well as character count", () => {
    const preview = boundedTextPreview("one\ntwo\nthree\nfour", {
      maxCharacters: 100,
      maxLines: 2,
    });

    expect(preview).toEqual({ text: "one\ntwo…", truncated: true });
  });

  it("leaves small text exact and undisclosed", () => {
    const text = "A concise result.";
    expect(boundedTextPreview(text)).toEqual({ text, truncated: false });
    expect(renderToStaticMarkup(<BoundedCollaborationText text={text} />)).not.toContain(
      "aria-expanded",
    );
  });

  it("does not split an emoji at the collapsed boundary", () => {
    expect(boundedTextPreview("ab😀tail", { maxCharacters: 4, maxLines: 1 })).toEqual({
      text: "ab…",
      truncated: true,
    });
  });
});
