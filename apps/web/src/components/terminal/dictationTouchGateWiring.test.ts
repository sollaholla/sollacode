// @effect-diagnostics nodeBuiltinImport:off - this test reads sources to assert a
// wiring invariant, which is a build-time concern rather than app runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const source = NodeFS.readFileSync(
  NodePath.join(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "..",
    "ThreadTerminalDrawer.tsx",
  ),
  "utf8",
);

describe("terminal keyboard input wiring", () => {
  it("keeps the touch gate when subscribing to input", () => {
    expect(source).toContain('window.matchMedia("(pointer: coarse)").matches');
    expect(source).toContain("subscribeTerminalKeyboardInput(terminal, usesTouchKeyboard,");
  });

  it("does not bypass the key/IME router with an onData-only subscription", () => {
    expect(source).not.toContain("terminal.onData(");
    expect(source).not.toContain("resolveTerminalDictationInput(");
  });
});
