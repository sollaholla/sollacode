// @effect-diagnostics nodeBuiltinImport:off - this test reads sources to assert a
// wiring invariant, which is a build-time concern rather than app runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

/**
 * Microphone availability is asked twice and both answers have to agree.
 *
 * `ComposerPrimaryActions` decides whether to render the button;
 * `ChatView` decides whether to arm push-to-talk at all. When only the first
 * one learned about the browser's speech recogniser, a phone rendered a
 * microphone whose effect had already returned early - a control that looks
 * live and does nothing. That is the same shape as the composer echo bug: every
 * function correct on its own, one call site left behind.
 */
const WEB_SRC = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..", "..");

const CALL_SITES = [
  NodePath.join(WEB_SRC, "components", "ChatView.tsx"),
  NodePath.join(WEB_SRC, "components", "chat", "ComposerPrimaryActions.tsx"),
];

describe("app voice capture wiring", () => {
  it("asks the same question at every call site", () => {
    for (const file of CALL_SITES) {
      const source = NodeFS.readFileSync(file, "utf8");
      const calls = source.split("shouldOfferAppVoiceCapture({").slice(1);
      expect(calls.length, `${NodePath.basename(file)} no longer calls it`).toBeGreaterThan(0);
      for (const call of calls) {
        const args = call.slice(0, call.indexOf("})"));
        expect(
          args,
          `${NodePath.basename(file)} decides microphone availability without asking whether the ` +
            `browser can transcribe, so its answer can disagree with the other call site`,
        ).toContain("hasNativeSpeechDictation");
      }
    }
  });

  it("covers every call site in the app", () => {
    // A third caller would be invisible to the check above.
    const searched = NodeFS.readdirSync(NodePath.join(WEB_SRC, "components"), {
      recursive: true,
      withFileTypes: true,
    })
      .filter(
        (entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.includes(".test."),
      )
      .map((entry) => NodePath.join(entry.parentPath, entry.name))
      .filter((file) => NodeFS.readFileSync(file, "utf8").includes("shouldOfferAppVoiceCapture({"));
    expect(searched.sort()).toEqual(CALL_SITES.sort());
  });
});
