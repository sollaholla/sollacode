// @effect-diagnostics nodeBuiltinImport:off - Verify cancellation against an owned real child process.
import { describe, expect, it } from "vite-plus/test";
import { runVoiceProcess } from "./VoiceProcess.ts";

describe("voice process cancellation", () => {
  it("closes a cancelled process before allowing a subsequent process to finish", async () => {
    const cancellation = new AbortController();
    const stopped = runVoiceProcess(process.execPath, ["-e", "for (;;) {}"], {
      timeoutMs: 60_000,
      signal: cancellation.signal,
    });
    cancellation.abort();
    const result = await stopped;
    expect(result.exitCode).not.toBe(0);
    expect(result.signal).toBe("SIGKILL");
    const next = await runVoiceProcess(
      process.execPath,
      ["-e", "process.stdout.write('next transcript')"],
      { timeoutMs: 10_000 },
    );
    expect(next).toMatchObject({ exitCode: 0, stdout: "next transcript", signal: null });
  });
  it("kills a process that ignores ordinary termination when its deadline expires", async () => {
    const result = await runVoiceProcess(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); for (;;) {}"],
      { timeoutMs: 100 },
    );
    expect(result.signal).toBe("SIGKILL");
    expect(result.exitCode).not.toBe(0);
  });
});
