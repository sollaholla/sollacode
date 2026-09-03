// @effect-diagnostics nodeBuiltinImport:off - this test reads its own source file to
// assert a wiring invariant, which is a build-time concern rather than app runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

/**
 * The stale-echo guard only works if the editor actually remembers what it
 * emitted, and it is emitted from more than one place.
 *
 * The first attempt at this fix recorded echoes in `readSnapshot`, which the
 * parent calls imperatively - not in `handleEditorChange`, which is the path
 * that runs on every keystroke and every dictated word. The history stayed
 * empty, `isComposerStaleEcho` always answered false, and the fix shipped as a
 * no-op that read correctly in review. Nothing failed, because no unit test can
 * see a call site that was never added.
 *
 * So assert the wiring itself: every upward emit records first.
 */
const SOURCE = NodeFS.readFileSync(
  NodePath.join(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "ComposerPromptEditor.tsx",
  ),
  "utf8",
);

describe("composer emitted-echo wiring", () => {
  it("records an echo at every upward emit", () => {
    const lines = SOURCE.split("\n");
    const emitLines = lines
      .map((line, index) => ({ line, index }))
      .filter((entry) => entry.line.includes("onChangeRef.current("));

    expect(emitLines.length).toBeGreaterThan(0);

    for (const emit of emitLines) {
      const preceding = lines.slice(Math.max(0, emit.index - 12), emit.index).join("\n");
      expect(
        preceding,
        `the emit on line ${String(emit.index + 1)} does not remember what it emitted, so a ` +
          `value returning as a lagging prop will not be recognised as this editor's own echo`,
      ).toContain("rememberComposerEmittedValue");
    }
  });
});
