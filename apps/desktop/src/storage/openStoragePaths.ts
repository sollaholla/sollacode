// @effect-diagnostics nodeBuiltinImport:off - Read-only host inventory for the detached installer.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

/** Fail closed when the host cannot supply an open-file inventory. No processes are stopped. */
export async function openStoragePaths(): Promise<ReadonlySet<string>> {
  const { stdout } = await execFileAsync("lsof", ["-nP", "-Fpn"], {
    maxBuffer: 32 * 1024 ** 2,
    timeout: 15_000,
  });
  if (!stdout.startsWith("p")) throw new Error("No open-file inventory available");
  return new Set(
    stdout
      .split("\n")
      .filter((line) => line.startsWith("n/"))
      .map((line) => line.slice(1)),
  );
}
