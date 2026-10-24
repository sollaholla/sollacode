// @effect-diagnostics nodeBuiltinImport:off - The Claude SDK's spawn hook is a synchronous Node API.
import * as NodeChildProcess from "node:child_process";

import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

// A watcher shares the CLI's process group and reads fd 3, a pipe only this
// server holds. The read ends at EOF when the server exits for any reason,
// and the watcher then stops the whole group.
const CLAUDE_GROUP_WATCH_SCRIPT = [
  "{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep 5; kill -KILL 0; } </dev/null >/dev/null 2>&1 &",
  'exec "$@" 3<&-',
].join("\n");

/**
 * Spawns the Claude CLI in its own process group, for the SDK's
 * `spawnClaudeCodeProcess` option. POSIX only: Windows has no process groups.
 *
 * Two leaks it closes:
 * - When the CLI exits it stops the MCP servers it started, but not their
 *   children (a plugin's `bun run start` dies, its `bun server.ts` lives on).
 *   They stay in the CLI's group, so the group gets SIGKILL once the CLI exits.
 * - The CLI finishes its turn after its pipes close, so a server that crashed
 *   or was killed left it working beside the session the restarted server
 *   resumes. The watcher stops it instead.
 */
export function spawnClaudeProcessGroup(options: SpawnOptions): SpawnedProcess {
  const child = NodeChildProcess.spawn(
    "/bin/sh",
    ["-c", CLAUDE_GROUP_WATCH_SCRIPT, "solla-claude", options.command, ...options.args],
    {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "ignore", "pipe"],
      detached: true,
    },
  );
  child.once("exit", () => signalProcessGroup(child.pid, "SIGKILL"));
  // Node's typings make stdin and stdout nullable once stdio has a fourth
  // entry; both are pipes here.
  return child as unknown as SpawnedProcess;
}

/**
 * `kill(0)` would signal this server's own group and `kill(-1)` every process
 * the user owns, so only a real spawned group id is accepted.
 */
function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}
