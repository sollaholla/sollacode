import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { VoiceNoteChip } from "./VoiceNoteChip";

describe("voice note attachment", () => {
  it("provides playback and an initially collapsed transcript after send", () => {
    const html = renderToStaticMarkup(
      <VoiceNoteChip src="/assets/note.wav" durationMs={65000} transcript="Spoken instruction." />,
    );
    expect(html).toContain('<audio controls=""');
    expect(html).toContain('src="/assets/note.wav"');
    expect(html).toContain("1:05");
    expect(html).toContain("Transcribed</summary>");
    expect(html).toContain("Spoken instruction.");
    expect(html).not.toContain("<details open");
    expect(html).not.toContain("autoPlay");
    expect(html).not.toContain("Remove voice note");
  });
  it("keeps draft removal and host transcription state visible", () => {
    const html = renderToStaticMarkup(
      <VoiceNoteChip src="blob:draft" durationMs={1000} pending onRemove={() => undefined} />,
    );
    expect(html).toContain("Remove voice note");
    expect(html).toContain("Transcribing on host");
    expect(html).not.toContain("Transcribed</summary>");
  });
});
