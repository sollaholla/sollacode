// @effect-diagnostics nodeBuiltinImport:off - The native speech engine runs in a bounded OS process.
import { runVoiceProcess } from "./VoiceProcess.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  DesktopVoiceTranscriptionInput,
  DesktopVoiceTranscriptionResult,
} from "@t3tools/contracts";
import type { NativeVoiceEnvironment } from "./environment.ts";
import { encodeMonoPcm16Wav } from "./MacSpeechTranscription.ts";
import { WINDOWS_SPEECH_SCRIPT } from "./WindowsSpeechScript.ts";

export function windowsSpeechTimeoutMs(audioBytes: number, sampleRate: number): number {
  return Math.min(30_000, 5_000 + Math.ceil((audioBytes / (sampleRate * 2)) * 250));
}

export function parseWindowsSpeechResult(stdout: string): DesktopVoiceTranscriptionResult {
  try {
    const result: unknown = JSON.parse(stdout.trim());
    if (typeof result === "object" && result !== null && "status" in result) {
      if (
        result.status === "success" &&
        "text" in result &&
        typeof result.text === "string" &&
        result.text.trim()
      ) {
        return { status: "success", text: result.text.trim() };
      }
      if (
        result.status === "unavailable" &&
        "reason" in result &&
        typeof result.reason === "string"
      ) {
        return { status: "unavailable", reason: result.reason };
      }
    }
  } catch {
    /* A broken native response falls back using the original audio. */
  }
  return {
    status: "unavailable",
    reason: "Windows speech recognition returned no reliable transcript.",
  };
}

export async function transcribeWindowsVoice(
  input: DesktopVoiceTranscriptionInput,
  environment: Pick<NativeVoiceEnvironment, "platform" | "stateDir">,
  signal?: AbortSignal,
): Promise<DesktopVoiceTranscriptionResult> {
  if (environment.platform !== "win32")
    return { status: "unavailable", reason: "Windows speech recognition requires Windows." };
  if (input.pcm16.byteLength === 0) return { status: "success", text: "" };
  if (
    input.pcm16.byteLength > 8 * 1024 * 1024 ||
    input.pcm16.byteLength % 2 !== 0 ||
    !Number.isInteger(input.sampleRate) ||
    input.sampleRate < 8_000 ||
    input.sampleRate > 48_000
  ) {
    return {
      status: "unavailable",
      reason: "Unsupported audio format for Windows speech recognition.",
    };
  }
  let directory: string | undefined;
  try {
    const root = NodePath.join(environment.stateDir, "voice-transcription");
    await NodeFSP.mkdir(root, { recursive: true });
    directory = await NodeFSP.mkdtemp(NodePath.join(root, "windows-"));
    const audioPath = NodePath.join(directory, "recording.wav");
    await NodeFSP.writeFile(audioPath, encodeMonoPcm16Wav(input));
    const timeoutMs = windowsSpeechTimeoutMs(input.pcm16.byteLength, input.sampleRate);
    const command = NodePath.win32.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const result = await runVoiceProcess(
      command,
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(WINDOWS_SPEECH_SCRIPT, "utf16le").toString("base64"),
      ],
      {
        timeoutMs: timeoutMs + 3_000,
        signal,
        maxBuffer: 256 * 1024,
        input: JSON.stringify({ path: audioPath, locale: input.locale, timeoutMs }),
      },
    );
    return result.exitCode === 0
      ? parseWindowsSpeechResult(result.stdout)
      : { status: "unavailable", reason: "Windows speech recognition failed or timed out." };
  } catch {
    return { status: "unavailable", reason: "Windows speech recognition could not start." };
  } finally {
    if (directory)
      await NodeFSP.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
