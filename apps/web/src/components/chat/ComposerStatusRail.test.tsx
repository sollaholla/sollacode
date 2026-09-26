// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerStatusRail } from "./ComposerStatusRail";

const CSS = NodeFS.readFileSync(
  NodeURL.fileURLToPath(new URL("../../index.css", import.meta.url)),
  "utf8",
);

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

  // A 0 floor let the usage pill's auto column take its full width first and
  // squeeze the side-chat chip below its content: the count spilled past the
  // chip's border. The side columns keep their content; the usage pill wraps.
  it("never squeezes a side chip below its own content", () => {
    const rail = /\.chat-composer-status-rail \{[^}]*\}/u.exec(CSS)?.[0] ?? "";
    expect(rail).toContain(
      "grid-template-columns: minmax(min-content, 1fr) auto minmax(min-content, 1fr);",
    );
  });

  it("renders nothing when every status is absent", () => {
    expect(renderToStaticMarkup(<ComposerStatusRail />)).toBe("");
  });
});
