import type { ChatAttachment } from "@t3tools/contracts";
import { resolveAttachmentPath } from "../attachmentStore.ts";

/** CLI adapters receive the host transcript as user speech, with the original recording available as a file. */
export function voiceNoteProviderInput(
  text: string | undefined,
  attachments: readonly ChatAttachment[],
  attachmentsDir?: string,
) {
  const notes = attachments.filter((attachment) => attachment.type === "audio");
  if (notes.length === 0) return text;
  const blocks = notes.map((note, index) => {
    const path = attachmentsDir
      ? resolveAttachmentPath({ attachmentsDir, attachment: note })
      : null;
    return [
      `[Voice note ${index + 1} — transcribed from the user's audio on the host]`,
      ...(path ? [`Original recording: ${path}`] : []),
      note.transcript || "[No transcript available]",
      `[End voice note ${index + 1}]`,
    ].join("\n");
  });
  return [
    ...blocks,
    ...(text?.trim() && text.trim() !== "[Voice note attached]"
      ? [`[User's accompanying text]\n${text}`]
      : []),
  ].join("\n\n");
}
