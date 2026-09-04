// @effect-diagnostics nodeBuiltinImport:off - The native helper is an OS process, not an Effect service.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import type {
  DesktopVoiceTranscriptionInput,
  DesktopVoiceTranscriptionResult,
} from "@t3tools/contracts";

import type * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const NATIVE_TRANSCRIPTION_MINIMUM_MACOS_MAJOR = 26;
const MAX_NATIVE_PCM_BYTES = 8 * 1024 * 1024;
const HELPER_TIMEOUT_MS = 5 * 60_000;
const HELPER_NAME = "macos-speech-transcriber";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

let developmentHelperPromise: Promise<string> | null = null;

function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = NodeChildProcess.execFile(
      command,
      [...args],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          exitCode:
            error && typeof error === "object" && "code" in error && typeof error.code === "number"
              ? error.code
              : error
                ? 1
                : 0,
          stdout,
          stderr,
        });
      },
    );
    child.stdin?.end();
  });
}

export function readMacosMajorVersion(release: string): number | null {
  const match = /^(\d+)(?:\.|$)/u.exec(release.trim());
  if (!match?.[1]) return null;
  const major = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(major) ? major : null;
}

export function encodeMonoPcm16Wav(input: {
  readonly pcm16: Uint8Array;
  readonly sampleRate: number;
}): Uint8Array {
  const headerLength = 44;
  const wav = new Uint8Array(headerLength + input.pcm16.byteLength);
  const view = new DataView(wav.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      wav[offset + index] = value.charCodeAt(index);
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + input.pcm16.byteLength, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, input.sampleRate, true);
  view.setUint32(28, input.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, input.pcm16.byteLength, true);
  wav.set(input.pcm16, headerLength);
  return wav;
}

async function ensureDevelopmentHelper(
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): Promise<string> {
  if (developmentHelperPromise) return developmentHelperPromise;
  developmentHelperPromise = (async () => {
    const sourcePath = environment.path.join(
      environment.appRoot,
      "apps/desktop/resources/native/MacSpeechTranscriber.swift",
    );
    const outputDirectory = environment.path.join(environment.stateDir, "native-helpers");
    const outputPath = environment.path.join(outputDirectory, HELPER_NAME);
    await NodeFSP.mkdir(outputDirectory, { recursive: true });

    const [sourceStat, outputStat] = await Promise.all([
      NodeFSP.stat(sourcePath),
      NodeFSP.stat(outputPath).catch(() => null),
    ]);
    if (outputStat && outputStat.mtimeMs >= sourceStat.mtimeMs) return outputPath;

    const temporaryPath = `${outputPath}.${process.pid}.tmp`;
    const compile = await runCommand(
      "/usr/bin/xcrun",
      [
        "swiftc",
        "-parse-as-library",
        sourcePath,
        "-o",
        temporaryPath,
        "-framework",
        "Speech",
        "-framework",
        "AVFoundation",
      ],
      60_000,
    );
    if (compile.exitCode !== 0) {
      throw new Error(compile.stderr.trim() || "The macOS speech helper could not be compiled.");
    }
    await NodeFSP.rename(temporaryPath, outputPath);
    return outputPath;
  })().catch((cause) => {
    developmentHelperPromise = null;
    throw cause;
  });
  return developmentHelperPromise;
}

async function resolveHelper(
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): Promise<string> {
  if (!environment.isPackaged) return ensureDevelopmentHelper(environment);
  return environment.path.join(environment.resourcesPath, HELPER_NAME);
}

function unavailable(reason: string): DesktopVoiceTranscriptionResult {
  return { status: "unavailable", reason };
}

export async function transcribeMacVoice(
  input: DesktopVoiceTranscriptionInput,
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): Promise<DesktopVoiceTranscriptionResult> {
  if (environment.platform !== "darwin") {
    return unavailable("Apple native transcription is only available on macOS.");
  }
  const macosMajor = readMacosMajorVersion(process.getSystemVersion?.() ?? "");
  if (macosMajor !== null && macosMajor < NATIVE_TRANSCRIPTION_MINIMUM_MACOS_MAJOR) {
    return unavailable("Apple native transcription requires macOS 26 or newer.");
  }
  if (input.pcm16.byteLength === 0) return { status: "success", text: "" };
  if (input.pcm16.byteLength > MAX_NATIVE_PCM_BYTES) {
    return unavailable("The recording is too long for native transcription.");
  }

  const temporaryDirectory = environment.path.join(environment.stateDir, "voice-transcription");
  const audioPath = environment.path.join(temporaryDirectory, `${NodeCrypto.randomUUID()}.wav`);
  try {
    await NodeFSP.mkdir(temporaryDirectory, { recursive: true });
    await NodeFSP.writeFile(audioPath, encodeMonoPcm16Wav(input));
    const helperPath = await resolveHelper(environment);
    const result = await runCommand(
      helperPath,
      [audioPath, input.locale, ...input.contextualStrings],
      HELPER_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) {
      return unavailable(result.stderr.trim() || "Apple native transcription failed.");
    }
    const parsed = JSON.parse(result.stdout) as { readonly text?: unknown };
    if (typeof parsed.text !== "string") {
      return unavailable("Apple native transcription returned an invalid response.");
    }
    return { status: "success", text: parsed.text.trim() };
  } catch (cause) {
    return unavailable(
      cause instanceof Error ? cause.message : "Apple native transcription failed.",
    );
  } finally {
    await NodeFSP.rm(audioPath, { force: true }).catch(() => undefined);
  }
}
