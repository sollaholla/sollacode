// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

/**
 * Guards the rule that stops iOS from zooming the page on a double tap.
 *
 * It has to be on every element and in the base layer: WebKit resets
 * touch-action at each scroll container, so a rule on `html` alone leaves the
 * transcript and sidebar zoomable, and an unlayered rule would beat the
 * `touch-none` and `touch-auto` utilities that gesture surfaces and the
 * composer depend on. Neither mistake fails any other check.
 */
const CSS = NodeFS.readFileSync(
  NodeURL.fileURLToPath(new URL("./index.css", import.meta.url)),
  "utf8",
);

/** The text of the first `@layer base { ... }` block, found by brace depth. */
function baseLayer(css: string): string {
  const start = css.indexOf("@layer base {");
  if (start < 0) return "";
  let depth = 0;
  for (let index = css.indexOf("{", start); index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, index + 1);
    }
  }
  return "";
}

describe("double-tap zoom", () => {
  it("is disabled on every element through the base layer", () => {
    expect(baseLayer(CSS)).toMatch(/\*\s*\{\s*touch-action:\s*manipulation;?\s*\}/u);
  });

  it("is not set by an unlayered universal rule that would override touch utilities", () => {
    const outsideBase = CSS.replace(baseLayer(CSS), "");
    expect(outsideBase).not.toMatch(/(^|\n)\s*\*\s*\{[^}]*touch-action/u);
  });
});
