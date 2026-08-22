// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

/**
 * Guards the custom properties the app chrome is laid out with.
 *
 * These are declared once in `index.css` and read from Tailwind arbitrary
 * values all over the app (`top-[var(--workspace-controls-top)]` and friends).
 * An undefined custom property does not raise anything — the declaration is
 * simply invalid and the element collapses to its initial position — so losing
 * one strips the padding off the entire titlebar while every test, typecheck,
 * and lint still passes. That is exactly how it got shipped once: a scripted
 * edit removing an unrelated block took the `:root` declarations with it, and
 * nothing failed until it was looked at.
 *
 * Asserting the declarations exist is crude, but it is the cheapest thing that
 * actually fails when they go missing.
 */

const CSS = NodeFS.readFileSync(
  NodeURL.fileURLToPath(new URL("./index.css", import.meta.url)),
  "utf8",
);

/** Declared on `:root`, consumed by the titlebar and workspace controls. */
const ROOT_TOKENS = [
  "--workspace-topbar-height",
  "--workspace-controls-top",
  "--workspace-controls-left",
  "--workspace-controls-right",
  "--workspace-native-controls-inset",
  "--workspace-titlebar-control-size",
  "--workspace-titlebar-control-gap",
];

/** Derived on the sidebar wrapper so header content clears the parked toggles. */
const WRAPPER_TOKENS = ["--workspace-titlebar-content-left", "--workspace-titlebar-content-right"];

describe("workspace chrome tokens", () => {
  it.each(ROOT_TOKENS)("declares %s", (token) => {
    expect(CSS).toContain(`${token}:`);
  });

  it.each(WRAPPER_TOKENS)("derives %s", (token) => {
    expect(CSS).toContain(`${token}:`);
  });

  it("keeps the Window Controls Overlay geometry", () => {
    // Without this block the native titlebar reports its inset and nothing
    // reads it, so controls sit under the system window buttons.
    expect(CSS).toContain(".wco {");
    expect(CSS).toContain("env(titlebar-area-height");
    expect(CSS).toContain("env(titlebar-area-x");
    expect(CSS).toContain("env(titlebar-area-width");
  });

  it("keeps the safe-area insets on the workspace controls", () => {
    // A phone with a notch or home indicator needs these; dropping to a bare
    // 0.75rem puts the controls under the system UI.
    expect(CSS).toContain("env(safe-area-inset-left)");
    expect(CSS).toContain("env(safe-area-inset-right)");
  });

  it("keeps every token it references defined", () => {
    // A `var(--workspace-…)` pointing at a property nothing declares is the
    // same silent failure, just one level down.
    const referenced = new Set(
      [...CSS.matchAll(/var\((--workspace-[a-z-]+)/gu)].map((match) => match[1] ?? ""),
    );
    const declared = new Set(
      [...CSS.matchAll(/(--workspace-[a-z-]+)\s*:/gu)].map((match) => match[1] ?? ""),
    );
    expect([...referenced].filter((token) => !declared.has(token))).toEqual([]);
  });
});
