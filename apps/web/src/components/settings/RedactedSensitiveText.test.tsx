import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { RedactedSensitiveText } from "./RedactedSensitiveText";

describe("RedactedSensitiveText", () => {
  it("keeps the raw sensitive value out of initial markup", () => {
    const markup = renderToStaticMarkup(
      <RedactedSensitiveText
        value="person@example.com"
        ariaLabel="Toggle account visibility"
        revealTooltip="Reveal"
        hideTooltip="Hide"
      />,
    );

    expect(markup).not.toContain("person@example.com");
    expect(markup).toContain("blur-[2px]");
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('aria-label="Toggle account visibility"');
  });
});
