import { describe, expect, it } from "vite-plus/test";

import { assessCommand } from "./readOnlyCommand.ts";

describe("assessCommand", () => {
  it("allows ordinary exploration, including things an allowlist would have blocked", () => {
    // The allowlist approach refused all of these at one point, which is why it
    // was dropped: read-only is an instruction the model follows, not a gate.
    for (const command of [
      "ls -la ~/Documents",
      "cat package.json",
      "rg 'useOrchestratorSession' apps/web/src | head -20",
      "git log --oneline -5",
      "find . -name '*.ts' -newer package.json",
      "npm ls --depth=0",
      'node -e "console.log(process.version)"',
      "sed -n '1,20p' README.md",
      "awk '{print $1}' hosts.txt",
      "df -h && du -sh .",
    ]) {
      expect(assessCommand(command), command).toEqual({ ok: true });
    }
  });

  it("refuses the handful of things that cannot be undone", () => {
    // Voice input makes a mis-transcription here a real risk, and none of these
    // is ever a step in looking around a machine.
    const refused = [
      "rm -rf /",
      "rm -rf ~",
      "rm -fr /*",
      "sudo mkfs.ext4 /dev/sda1",
      "dd if=/dev/zero of=/dev/disk2 bs=1m",
      "echo x > /dev/sda",
      "shutdown -h now",
      "diskutil eraseDisk JHFS+ Untitled /dev/disk2",
    ];
    for (const command of refused) {
      const verdict = assessCommand(command);
      expect(verdict.ok, command).toBe(false);
    }
  });

  it("does not mistake an ordinary delete for a catastrophic one", () => {
    // Deleting a build directory is destructive but recoverable, and refusing it
    // would be the over-blocking that made the allowlist unusable.
    expect(assessCommand("rm -rf node_modules")).toEqual({ ok: true });
    expect(assessCommand("rm -rf ./dist")).toEqual({ ok: true });
  });

  it("rejects an empty or absurdly long command", () => {
    expect(assessCommand("   ").ok).toBe(false);
    expect(assessCommand("ls ".repeat(1_000)).ok).toBe(false);
  });
});
