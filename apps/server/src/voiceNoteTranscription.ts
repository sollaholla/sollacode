// @effect-diagnostics globalTimers:off - Deadline bounds the Promise API consumed by the command normalizer.
// @effect-diagnostics nodeBuiltinImport:off - Local speech helpers and model cache belong to the host.
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import { transcribeMacVoice } from "@t3tools/shared/nativeVoice/MacSpeechTranscription";
import { transcribeWindowsVoice } from "@t3tools/shared/nativeVoice/WindowsSpeechTranscription";
import { transcribeVoiceFallback } from "./voiceNoteFallback.ts";
import { resolveVoiceMlxRuntime } from "./voiceNoteMlxRuntime.ts";
import { transcribeVoiceMlx } from "./voiceNoteMlx.ts";
import { PROVIDER_SEND_TURN_MAX_AUDIO_BYTES } from "@t3tools/contracts";

/** Only accept the bounded mono PCM format produced by the recording client. */
export function readVoiceNotePcm(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, length: number) =>
    new TextDecoder().decode(bytes.subarray(offset, offset + length));
  if (
    bytes.length <= 44 ||
    bytes.length > PROVIDER_SEND_TURN_MAX_AUDIO_BYTES ||
    ascii(0, 4) !== "RIFF" ||
    ascii(8, 4) !== "WAVE" ||
    ascii(12, 4) !== "fmt " ||
    ascii(36, 4) !== "data" ||
    view.getUint32(4, true) !== bytes.length - 8 ||
    view.getUint32(16, true) !== 16 ||
    view.getUint16(20, true) !== 1 ||
    view.getUint16(22, true) !== 1 ||
    view.getUint32(24, true) !== 16_000 ||
    view.getUint32(28, true) !== 32_000 ||
    view.getUint16(32, true) !== 2 ||
    view.getUint16(34, true) !== 16 ||
    view.getUint32(40, true) !== bytes.length - 44 ||
    (bytes.length - 44) % 2 !== 0 ||
    bytes.length - 44 > 120 * 32_000
  )
    throw new Error("Voice note must be a mono 16 kHz PCM recording of at most two minutes.");
  return { pcm16: bytes.subarray(44), durationMs: Math.round((bytes.length - 44) / 32) };
}

export function makeVoiceNoteTranscriber(timeoutMs = 180_000) {
  let activeTranscription: Promise<string> | null = null;
  return function transcribeVoiceNote(
    bytes: Uint8Array,
    stateDir: string,
    platform: NodeJS.Platform,
    hostEnvironment: NodeJS.ProcessEnv,
  ): Promise<string> {
    const { pcm16 } = readVoiceNotePcm(bytes);
    // Recognizers can hallucinate words from an empty capture. Reject only exact
    // digital silence, without an amplitude threshold that could discard quiet speech.
    if (!pcm16.some((byte) => byte !== 0))
      return Promise.reject(
        new Error(
          "The recording contains only silence. Check your microphone and record again. Your voice note has not been sent and remains in the draft.",
        ),
      );
    if (activeTranscription)
      return Promise.reject(
        new Error(
          "The host is transcribing another voice note. Your recording remains in the draft; try again shortly.",
        ),
      );
    const cancellation = new AbortController();
    const timeout = setTimeout(
      () =>
        cancellation.abort(
          new Error(
            "Host transcription timed out. Your voice note has not been sent and remains in the draft.",
          ),
        ),
      timeoutMs,
    );
    const run = (async () => {
      const resourcesPath = NodePath.resolve(NodePath.dirname(process.execPath), "..", "Resources");
      const isPackaged = NodeFS.existsSync(NodePath.join(resourcesPath, "app.asar"));
      const environment = {
        platform,
        stateDir,
        resourcesPath,
        isPackaged,
        appRoot: NodePath.resolve(import.meta.dirname, "../../.."),
        path: NodePath,
      };
      const input = {
        pcm16,
        sampleRate: 16_000,
        locale: "en-US",
        contextualStrings: ["Solla Code", "TypeScript", "GitHub", "Codex", "Claude"],
      };
      let transcript = "";
      if (platform === "darwin") {
        try {
          // Setup runs separately from recording. A first note must never wait
          // for a model download inside its transcription deadline.
          const runtime = await resolveVoiceMlxRuntime({
            baseDir: NodePath.dirname(stateDir),
            platform,
          });
          cancellation.signal.throwIfAborted();
          if (runtime)
            transcript = await transcribeVoiceMlx(
              pcm16,
              runtime,
              cancellation.signal,
              hostEnvironment,
            );
        } catch {
          cancellation.signal.throwIfAborted();
          // A missing or damaged optional runtime leaves native speech usable.
        }
      }
      if (!transcript) {
        const native =
          platform === "win32"
            ? await transcribeWindowsVoice(input, environment, cancellation.signal)
            : await transcribeMacVoice(input, environment, cancellation.signal);
        cancellation.signal.throwIfAborted();
        transcript = native.status === "success" ? native.text.trim() : "";
      }
      if (!transcript) {
        transcript = await transcribeVoiceFallback(
          pcm16,
          NodePath.join(stateDir, "voice-models"),
          cancellation.signal,
          hostEnvironment,
        );
      }
      cancellation.signal.throwIfAborted();
      if (!transcript)
        throw new Error("No speech was detected. Your voice note has not been sent.");
      if (transcript.length > 32_000) throw new Error("The voice note transcript is too long.");
      return transcript;
    })();
    activeTranscription = run;
    return run.finally(() => {
      clearTimeout(timeout);
      if (activeTranscription === run) activeTranscription = null;
    });
  };
}

export const transcribeVoiceNote = makeVoiceNoteTranscriber();
