// @effect-diagnostics nodeBuiltinImport:off - this test reads sources to assert a
// wiring invariant, which is a build-time concern rather than app runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

/**
 * The dictation reconciliation guesses an input method's intent from the
 * contents of xterm's textarea. That guess is only safe for the thing it was
 * built for - iOS keyboard dictation rewriting words it already committed.
 *
 * Run against a hardware keyboard it misreads ordinary typing, and the cost is
 * silent: the reconciled payload comes back empty and the caller drops it, so
 * keystrokes vanish with nothing logged. That shipped once. The gate is the
 * fix, and a unit test cannot catch its removal because the predicate itself
 * stays perfectly correct - only its call site decides who is exposed to it.
 */
const source = NodeFS.readFileSync(
  NodePath.join(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "..",
    "ThreadTerminalDrawer.tsx",
  ),
  "utf8",
);

describe("terminal dictation touch gate", () => {
  it("only reconciles dictation on a coarse pointer", () => {
    expect(source).toContain('window.matchMedia("(pointer: coarse)").matches');
    expect(source).toMatch(/const usesTouchKeyboard\s*=/);
  });

  it("passes the payload straight through when the pointer is not coarse", () => {
    // The ternary is the whole guarantee: without it a desktop keystroke is
    // routed into the reconciliation and can be reconciled away to nothing.
    expect(source).toMatch(
      /const dictation = usesTouchKeyboard\s*\?\s*resolveTerminalDictationInput\(/,
    );
    expect(source).toMatch(/:\s*\{\s*payload: data,\s*state: emptyTerminalDictationState\s*\}/);
  });
});
