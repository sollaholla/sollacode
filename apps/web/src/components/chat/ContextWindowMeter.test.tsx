import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AutoCompactionThresholdControl } from "./ContextWindowMeter";

describe("AutoCompactionThresholdControl", () => {
  it("renders an accessible 50..95 percent slider with visible ticks and token threshold", () => {
    const markup = renderToStaticMarkup(
      <AutoCompactionThresholdControl
        maxTokens={1_000_000}
        providerDisplayName="Claude"
        thresholdPercentage={80}
        onThresholdChange={() => undefined}
      />,
    );

    expect(markup).toContain('type="range"');
    expect(markup).toContain('min="50"');
    expect(markup).toContain('max="95"');
    expect(markup).toContain('step="5"');
    expect(markup).toContain('aria-label="Automatic compaction threshold"');
    expect(markup).toContain('aria-valuetext="80% (800k tokens)"');
    expect(markup).toContain("50%");
    expect(markup).toContain("55%");
    expect(markup).toContain("65%");
    expect(markup).toContain("75%");
    expect(markup).toContain("85%");
    expect(markup).toContain("95%");
    expect(markup).toContain("800k tokens");
    expect(markup).toContain("Claude compacts before the hard context limit.");
  });

  it("keeps the slider visible but disabled with a reason during an active turn", () => {
    const markup = renderToStaticMarkup(
      <AutoCompactionThresholdControl
        maxTokens={1_000_000}
        thresholdPercentage={80}
        onThresholdChange={() => undefined}
        disabled
        disabledReason="Finish the active turn to change this threshold."
      />,
    );

    expect(markup).toContain('type="range"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("Finish the active turn to change this threshold.");
  });
});
