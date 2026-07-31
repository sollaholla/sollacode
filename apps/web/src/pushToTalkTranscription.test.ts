import { describe, expect, it } from "vite-plus/test";

import {
  assembleTranscriptionText,
  LONG_FORM_TRANSCRIPTION_OPTIONS,
  mergeVoiceTranscriptPrompt,
  shouldTranscribeStoppedRecording,
} from "./pushToTalkTranscription";

describe("long-form push-to-talk transcription", () => {
  it("uses overlapping Whisper chunks so recordings beyond 30 seconds are retained", () => {
    expect(LONG_FORM_TRANSCRIPTION_OPTIONS).toEqual({
      chunk_length_s: 30,
      stride_length_s: 5,
    });
  });

  it("preserves every returned transcription segment", () => {
    expect(
      assembleTranscriptionText([{ text: "It just tries to" }, { text: "use the Finder." }]),
    ).toBe("It just tries to use the Finder.");
  });

  it("normalizes the normal single-result response", () => {
    expect(assembleTranscriptionText({ text: "  Complete dictation.  " })).toBe(
      "Complete dictation.",
    );
  });

  it("keeps completed dictation in the current composer draft", () => {
    expect(mergeVoiceTranscriptPrompt("", "  Keep this text. ")).toBe("Keep this text.");
    expect(mergeVoiceTranscriptPrompt("Existing draft", "and dictation.")).toBe(
      "Existing draft and dictation.",
    );
  });

  it("transcribes the captured blob when the two-minute limit stops recording", () => {
    expect(
      shouldTranscribeStoppedRecording({
        audioByteLength: 42_000,
        reachedRecordingLimit: true,
      }),
    ).toBe(true);
    expect(
      shouldTranscribeStoppedRecording({
        audioByteLength: 0,
        reachedRecordingLimit: true,
      }),
    ).toBe(false);
  });
});
