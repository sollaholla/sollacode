import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerStatusRail } from "./ComposerStatusRail";

describe("ComposerStatusRail", () => {
  it("renders one coordinated rail with named slots", () => {
    const markup = renderToStaticMarkup(
      <ComposerStatusRail
        voice={<button type="button">Voice</button>}
        usage={<button type="button">Usage</button>}
        actions={<button type="button">Tasks</button>}
      />,
    );

    expect(markup).toContain('data-chat-composer-status-rail="true"');
    expect(markup).toContain('data-chat-composer-status-slot="voice"');
    expect(markup).toContain('data-chat-composer-status-slot="usage"');
    expect(markup).toContain('data-chat-composer-status-slot="actions"');
  });

  // The rail is stacked directly on top of the input bar, so it has to be the
  // same measure. Given its own max-width it was the wider of the two, leaving
  // the end-aligned task chip stranded to the right of the composer.
  it("spans the composer's measure rather than a width of its own", () => {
    const markup = renderToStaticMarkup(<ComposerStatusRail usage={<span>Usage</span>} />);

    expect(markup).toContain("chat-composer-measure");
    expect(markup).not.toMatch(/max-w-\w+/u);
  });

  it("renders nothing when every status is absent", () => {
    expect(renderToStaticMarkup(<ComposerStatusRail />)).toBe("");
  });
});
