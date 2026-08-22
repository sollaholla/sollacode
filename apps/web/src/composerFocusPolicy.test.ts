// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

/**
 * Keeps restore-focus behaviour funnelled through one policy.
 *
 * The app moves the caret back into the composer after all sorts of actions
 * settle. On a device with an on-screen keyboard each of those raises the
 * keyboard over the conversation, and because the call sites are scattered
 * across menus, pickers, effects and a dialog's `finalFocus`, guarding them
 * one at a time fixed the reported route and left the others — the bug came
 * back reported as "it still does it sometimes".
 *
 * The fix was to make `focusComposer` the single gate. These assertions exist
 * so it stays one: nothing here can catch a brand-new ungated call site, but
 * they do catch the gate being removed or routed around, which is the way this
 * actually regressed.
 */

function read(relativePath: string): string {
  return NodeFS.readFileSync(NodeURL.fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const CHAT_VIEW = read("./components/ChatView.tsx");
const COMMAND_PALETTE = read("./components/CommandPalette.tsx");

/** The body of a `const <name> = useCallback(() => { … }` declaration. */
function callbackBody(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = useCallback(`);
  expect(start, `${name} should be a useCallback`).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("}, [", start));
}

describe("composer restore-focus policy", () => {
  it("gates ChatView's focusComposer on the policy", () => {
    expect(callbackBody(CHAT_VIEW, "focusComposer")).toContain("shouldRestoreComposerFocus");
  });

  it("keeps scheduleComposerFocus delegating rather than focusing itself", () => {
    // If it reached for the composer ref directly it would bypass the gate,
    // and it is the variant most call sites use.
    const body = callbackBody(CHAT_VIEW, "scheduleComposerFocus");
    expect(body).toContain("focusComposer()");
    expect(body).not.toContain("composerRef.current");
  });

  it("gates the command palette's restore-focus on the same policy", () => {
    // Closing the palette returned the caret to the composer unconditionally,
    // which is one of the routes that kept raising the keyboard.
    const start = COMMAND_PALETTE.indexOf("finalFocus={");
    expect(start, "the palette should still set finalFocus").toBeGreaterThan(-1);
    const body = COMMAND_PALETTE.slice(start, COMMAND_PALETTE.indexOf("}}", start));
    expect(body).toContain("shouldRestoreComposerFocus");
  });

  it("reads the keyboard condition from the shared hook, not an ad-hoc query", () => {
    // A hand-rolled media query is how the first attempt went wrong: it also
    // demanded a narrow portrait viewport, so tablets fell straight through.
    expect(CHAT_VIEW).toContain("useOnScreenKeyboard()");
    expect(COMMAND_PALETTE).toContain("useOnScreenKeyboard()");
    expect(read("./hooks/useOnScreenKeyboard.ts")).toContain('pointer: "coarse"');
  });
});
