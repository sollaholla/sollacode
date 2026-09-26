import { bytesToBase64 } from "@t3tools/shared/base64";
import { randomUUID } from "./lib/utils";
import type { UploadChatAttachment } from "@t3tools/contracts";
import type { ComposerImageAttachment } from "./composerDraftStore";
import {
  decodeAudio,
  encodeFloat32Pcm16,
  withTranscriptionDeadline,
  AUDIO_DECODE_DEADLINE_MS,
} from "./pushToTalk";
import { prepareImageAttachmentsForSend } from "./lib/sendImageCompression";

/** Keep the compact original recording in the draft; prepare host-readable PCM only at send. */
export function createVoiceNoteDraft(audio: Blob, durationMs: number): ComposerImageAttachment {
  const id = randomUUID();
  const name = `Voice note ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  const file = new File([audio], name, { type: audio.type });
  return {
    type: "audio",
    id,
    name,
    mimeType: audio.type,
    sizeBytes: audio.size,
    durationMs: Math.min(120_000, Math.max(0, Math.round(durationMs))),
    file,
    previewUrl: URL.createObjectURL(audio),
  };
}

export async function prepareVoiceNoteForSend(file: File): Promise<UploadChatAttachment> {
  const controller = new AbortController();
  const samples = await withTranscriptionDeadline(
    decodeAudio(file, controller.signal),
    (error) => controller.abort(error),
    AUDIO_DECODE_DEADLINE_MS,
    "Voice note could not be prepared. Your recording remains in the draft.",
  );
  if (samples.length > 120 * 16_000)
    throw new Error("This voice note exceeds two minutes. Your recording remains in the draft.");
  const audio = samples;
  if (audio.length === 0) throw new Error("This voice note contains no audio.");
  const pcm = encodeFloat32Pcm16(audio);
  const wav = new Uint8Array(44 + pcm.length);
  const view = new DataView(wav.buffer);
  for (const [offset, text] of [
    [0, "RIFF"],
    [8, "WAVE"],
    [12, "fmt "],
    [36, "data"],
  ] as const) {
    for (let i = 0; i < text.length; i++) wav[offset + i] = text.charCodeAt(i);
  }
  view.setUint32(4, wav.length - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);
  return {
    type: "audio",
    name: `${file.name}.wav`,
    mimeType: "audio/wav",
    sizeBytes: wav.length,
    durationMs: Math.round(audio.length / 16),
    dataUrl: `data:audio/wav;base64,${bytesToBase64(wav)}`,
  };
}

export async function prepareComposerAttachmentsForSend(
  attachments: readonly ComposerImageAttachment[],
): Promise<UploadChatAttachment[]> {
  const output: UploadChatAttachment[] = [];
  for (const attachment of attachments) {
    if (attachment.type === "audio") output.push(await prepareVoiceNoteForSend(attachment.file));
    else {
      const [image] = await prepareImageAttachmentsForSend([attachment]);
      if (image)
        output.push({
          type: "image",
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          dataUrl: image.dataUrl,
        });
    }
  }
  return output;
}
