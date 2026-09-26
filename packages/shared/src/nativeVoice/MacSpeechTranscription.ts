// @effect-diagnostics nodeBuiltinImport:off - The native helper is an OS process, not an Effect service.
import { runVoiceProcess } from "./VoiceProcess.ts";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import type {
  DesktopVoiceTranscriptionInput,
  DesktopVoiceTranscriptionResult,
} from "@t3tools/contracts";

import type { NativeVoiceEnvironment } from "./environment.ts";

const NATIVE_TRANSCRIPTION_MINIMUM_MACOS_MAJOR = 26;
const MAX_NATIVE_PCM_BYTES = 8 * 1024 * 1024;
const HELPER_TIMEOUT_MS = 5 * 60_000;
const HELPER_NAME = "macos-speech-transcriber";

let developmentHelperPromise: Promise<string> | null = null;

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
  environment: NativeVoiceEnvironment,
  signal?: AbortSignal,
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
    const compile = await runVoiceProcess(
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
      { timeoutMs: 60_000, signal },
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
  environment: NativeVoiceEnvironment,
  signal?: AbortSignal,
): Promise<string> {
  if (!environment.isPackaged) return ensureDevelopmentHelper(environment, signal);
  return environment.path.join(environment.resourcesPath, HELPER_NAME);
}

function unavailable(reason: string): DesktopVoiceTranscriptionResult {
  return { status: "unavailable", reason };
}

export async function transcribeMacVoice(
  input: DesktopVoiceTranscriptionInput,
  environment: NativeVoiceEnvironment,
  signal?: AbortSignal,
): Promise<DesktopVoiceTranscriptionResult> {
  if (environment.platform !== "darwin") {
    return unavailable("Apple native transcription is only available on macOS.");
  }
  const macosMajor = readMacosMajorVersion(
    "getSystemVersion" in process && typeof process.getSystemVersion === "function"
      ? String(process.getSystemVersion())
      : "",
  );
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
    const helperPath = await resolveHelper(environment, signal);
    const result = await runVoiceProcess(
      helperPath,
      [audioPath, input.locale, ...input.contextualStrings],
      { timeoutMs: HELPER_TIMEOUT_MS, signal },
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
