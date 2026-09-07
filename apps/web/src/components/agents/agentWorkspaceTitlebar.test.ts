// @effect-diagnostics nodeBuiltinImport:off - source-text checks; the web tests
// run without a DOM and this asserts markup wiring, a build-time concern.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

/**
 * The agent workspace header IS the desktop title bar, so it has to move the
 * window. Reported 2026-09-06 as being unable to drag the app by that row.
 */
const read = (name: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, name), "utf8");

const CSS = NodeFS.readFileSync(
  NodePath.join(import.meta.dirname, "..", "..", "index.css"),
  "utf8",
);

describe("agent workspace title bar", () => {
  it("makes the header drag the window in the desktop app", () => {
    const source = read("AgentWorkspace.tsx");
    expect(source).toContain('isElectron && "drag-region"');
  });

  it("never reaches for a responsive variant of it", () => {
    // `.drag-region` is a plain rule in index.css, not a Tailwind utility, so
    // a prefixed form compiles to nothing and ships a header that silently
    // will not drag. Same class of trap as the arbitrary-media-variant bug.
    // Comments are stripped first, or this very explanation trips the guard.
    const code = read("AgentWorkspace.tsx")
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/:drag-region/);
    expect(code).toContain('"drag-region"');
    expect(CSS, "drag-region stopped being a plain class; this guard is stale").toContain(
      ".drag-region {",
    );
  });

  it("relies on the rule that exempts nested controls from the drag region", () => {
    // Without it the tools menu, power toggle and Panel button would be dead:
    // a drag region swallows clicks on everything it covers.
    expect(CSS).toContain(".drag-region button,");
  });

  it("does not let the purpose line be selected out from under a drag", () => {
    const source = read("AgentWorkspace.tsx");
    const paragraph = source.slice(source.indexOf("truncate text-xs leading-4"));
    expect(paragraph.slice(0, 120)).toContain("select-none");
  });
});
