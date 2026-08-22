import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_KEYBINDINGS } from "./keybindings.ts";

const rules = DEFAULT_KEYBINDINGS as ReadonlyArray<{
  readonly key: string;
  readonly command: string;
  readonly when?: string;
}>;

describe("orchestrator voice keybinding", () => {
  it("ships a default binding so the microphone is reachable without the mouse", () => {
    const rule = rules.find((candidate) => candidate.command === "orchestrator.voice.toggle");
    expect(rule, "orchestrator.voice.toggle should have a default binding").toBeDefined();
    expect(rule?.key).toBe("mod+shift+v");
  });

  it("does not steal a chord another command already owns in the same context", () => {
    const rule = rules.find((candidate) => candidate.command === "orchestrator.voice.toggle");
    const clashes = rules.filter(
      (candidate) =>
        candidate.key === rule?.key &&
        candidate.command !== rule.command &&
        // Same `when` (or both unscoped) means they genuinely compete.
        candidate.when === rule.when,
    );
    expect(clashes.map((candidate) => candidate.command)).toEqual([]);
  });

  it("stays out of the terminal, where the chord belongs to the shell", () => {
    const rule = rules.find((candidate) => candidate.command === "orchestrator.voice.toggle");
    expect(rule?.when).toBe("!terminalFocus");
  });
});
