import { describe, expect, it } from "vite-plus/test";
import { ThreadId, type ProjectScript } from "@t3tools/contracts";
import { scriptsForThread, setupProjectScript } from "./projectScripts";
const base: ProjectScript = {
  id: "build",
  name: "Build",
  command: "build",
  icon: "play",
  runOnWorktreeCreate: false,
};
describe("agent action ownership", () => {
  it("never shares an owned action with another agent", () => {
    const owned = { ...base, ownerThreadId: ThreadId.make("agent-a") };
    expect(scriptsForThread([owned], "solla-agents", "agent-a")).toEqual([owned]);
    expect(scriptsForThread([owned], "solla-agents", "agent-b")).toEqual([]);
    expect(scriptsForThread([owned], "solla-agents", null)).toEqual([]);
  });
  it("keeps normal project actions shared but hides ambiguous legacy agent actions", () => {
    expect(scriptsForThread([base], "normal-project", "thread")).toEqual([base]);
    expect(scriptsForThread([base], "solla-agents", "agent-a")).toEqual([]);
  });
  it("does not run an agent-owned setup for unrelated project worktrees", () => {
    expect(
      setupProjectScript([
        { ...base, runOnWorktreeCreate: true, ownerThreadId: ThreadId.make("agent-a") },
      ]),
    ).toBeNull();
  });
});
