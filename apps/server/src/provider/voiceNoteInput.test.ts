import { describe, expect, it } from "vite-plus/test";
import { voiceNoteProviderInput } from "./voiceNoteInput.ts";
const note = {
  type: "audio" as const,
  id: "thread-12345678-1234-1234-1234-123456789abc",
  name: "Voice note.wav",
  mimeType: "audio/wav" as const,
  sizeBytes: 32044,
  durationMs: 1000,
  transcript: "Please inspect the road.",
};
describe("voice note provider input", () => {
  it("labels audio provenance, keeps the recording accessible and appends typed text", () => {
    const input = voiceNoteProviderInput("Use geometric splines.", [note], "/tmp/attachments")!;
    expect(input).toContain("transcribed from the user's audio on the host");
    expect(input).toContain(`${note.id}.wav`);
    expect(input.indexOf(note.transcript)).toBeLessThan(input.indexOf("Use geometric splines."));
  });
  it("does not pass the voice-only display placeholder as user-authored text", () => {
    expect(voiceNoteProviderInput("[Voice note attached]", [note])).not.toContain(
      "accompanying text",
    );
  });
  it("preserves ordinary text and image messages exactly", () => {
    expect(voiceNoteProviderInput("hello", [])).toBe("hello");
  });
});
