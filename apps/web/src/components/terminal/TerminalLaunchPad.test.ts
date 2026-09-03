import { describe, expect, it } from "vite-plus/test";

import { clampLaunchCount, resolveLaunchCommands } from "./TerminalLaunchPad";

const providers = [
  { driverKind: "claudeAgent", label: "Claude", command: "claude" },
  { driverKind: "codex", label: "Codex", command: "codex" },
];

describe("resolveLaunchCommands", () => {
  it("opens plain shells when nothing is selected", () => {
    expect(resolveLaunchCommands(providers, new Set(), 2, 6)).toEqual([null, null]);
  });

  it("repeats each selected provider `each` times in list order", () => {
    expect(resolveLaunchCommands(providers, new Set(["codex", "claudeAgent"]), 2, 6)).toEqual([
      "claude",
      "claude",
      "codex",
      "codex",
    ]);
  });

  it("never exceeds the pane cap", () => {
    expect(resolveLaunchCommands(providers, new Set(["claudeAgent", "codex"]), 4, 6)).toHaveLength(
      6,
    );
    expect(clampLaunchCount(9, 6)).toBe(6);
    expect(clampLaunchCount(0, 6)).toBe(1);
  });
});
