// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

/**
 * Guards that both remote-control streams reach consumers as event windows.
 *
 * A consumer reads an atom, and an atom shows only the newest element of a
 * batch. Without the window the phone's viewer lost the "approved" update the
 * broker sends together with the retained video chunk, and sat on "Approve on
 * <host>" while the host streamed to it; the host could equally lose an access
 * request, or a key's `up`. Nothing else fails when the transform is removed,
 * because the stream still flows and every type still lines up.
 */
/** The shared atoms the viewer and the host coordinator both subscribe through. */
const SOURCE = NodeFS.readFileSync(
  NodeURL.fileURLToPath(
    new URL("../../../../../packages/client-runtime/src/state/remoteControl.ts", import.meta.url),
  ),
  "utf8",
);

/** The text of one atom family's options, from its key to the closing of `{ ... }`. */
function familyOptions(key: string): string {
  const start = SOURCE.indexOf(`${key}: createEnvironmentRpcSubscriptionAtomFamily(`);
  if (start < 0) return "";
  const open = SOURCE.indexOf("{", SOURCE.indexOf("runtime,", start));
  let depth = 0;
  for (let index = open; index < SOURCE.length; index += 1) {
    if (SOURCE[index] === "{") depth += 1;
    if (SOURCE[index] === "}") {
      depth -= 1;
      if (depth === 0) return SOURCE.slice(open, index + 1);
    }
  }
  return "";
}

describe("remote control stream atoms", () => {
  it.each(["hostEvents", "watch"])("%s is delivered as an event window", (key) => {
    const options = familyOptions(key);
    expect(options).not.toBe("");
    expect(options).toContain("transform: toEventWindows(");
  });
});
