// @effect-diagnostics nodeBuiltinImport:off - Speech runs in a terminable child process.
import * as NodeChildProcess from "node:child_process";

/** Resolves only after the owned process closes, including cancellation and timeout. */
export function runVoiceProcess(
  command: string,
  args: readonly string[],
  options: {
    timeoutMs: number;
    signal?: AbortSignal | undefined;
    input?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    maxBuffer?: number | undefined;
  },
) {
  return new Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = NodeChildProcess.execFile(
      command,
      [...args],
      {
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer ?? 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
        killSignal: "SIGKILL",
        ...(options.env ? { env: options.env } : {}),
      },
      (error, output, diagnostic) => {
        stdout = output;
        stderr = diagnostic || error?.message || "";
      },
    );
    const cancel = () => {
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    child.once("close", (code, signal) => {
      options.signal?.removeEventListener("abort", cancel);
      resolve({ exitCode: code ?? 1, stdout, stderr, signal });
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input);
  });
}
