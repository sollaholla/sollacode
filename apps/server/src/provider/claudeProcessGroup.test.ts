// @effect-diagnostics globalTimers:off - Waits for the OS to reap real processes.
import * as NodeOS from "node:os";
import type * as NodeStream from "node:stream";

import { describe, expect, it } from "vite-plus/test";

import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

import { spawnClaudeProcessGroup } from "./claudeProcessGroup.ts";

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A SIGKILLed orphan lingers as a zombie until launchd/init reaps it.
const waitUntilGone = async (pid: number) => {
  for (let attempt = 0; attempt < 100 && isAlive(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isAlive(pid);
};

const exitOf = (child: SpawnedProcess) =>
  new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
    child.once("exit", (code, signal) => resolve([code, signal])),
  );

const firstLine = async (stream: NodeStream.Readable) => {
  let text = "";
  for await (const chunk of stream) {
    text += String(chunk);
    if (text.includes("\n")) break;
  }
  return Number.parseInt(text, 10);
};

// eslint-disable-next-line t3code/no-global-process-runtime -- This case spawns real POSIX process groups on the test host.
describe.skipIf(NodeOS.platform() === "win32")("spawnClaudeProcessGroup", () => {
  it("stops what the CLI leaves running once it exits", async () => {
    const child = spawnClaudeProcessGroup({
      command: "/bin/sh",
      args: ["-c", "sleep 60 & echo $!; exit 0"],
      env: { ...process.env },
      signal: new AbortController().signal,
    });
    const exited = exitOf(child);
    const leftover = await firstLine(child.stdout);
    await exited;

    expect(await waitUntilGone(leftover)).toBe(true);
  });

  it("stops the CLI when the server end of the watch pipe closes", async () => {
    const child = spawnClaudeProcessGroup({
      command: "/bin/sh",
      args: ["-c", "echo ready; sleep 60 & wait"],
      env: { ...process.env },
      signal: new AbortController().signal,
    });
    const exited = exitOf(child);
    await firstLine(child.stdout);

    // What a crashed server leaves behind: fd 3 closes and nobody calls kill.
    const watchPipe = (child as unknown as { stdio: Array<NodeStream.Writable | null> }).stdio[3];
    watchPipe?.destroy();

    const [code, signal] = await exited;
    expect(code === null ? signal : "exited").toBe("SIGTERM");
  });
});
