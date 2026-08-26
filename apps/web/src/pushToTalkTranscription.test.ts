import { describe, expect, it } from "vite-plus/test";

import {
  assembleTranscriptionText,
  DEFAULT_NATIVE_TRANSCRIPTION_CONTEXT,
  LOCAL_TRANSCRIPTION_MODEL,
  LONG_FORM_TRANSCRIPTION_OPTIONS,
  mergeVoiceTranscriptPrompt,
  resolveVoiceTranscriptInputUpdate,
  shouldTranscribeStoppedRecording,
} from "./pushToTalkTranscription";

describe("long-form push-to-talk transcription", () => {
  it("uses overlapping Whisper chunks so recordings beyond 30 seconds are retained", () => {
    expect(LONG_FORM_TRANSCRIPTION_OPTIONS).toEqual({
      chunk_length_s: 30,
      stride_length_s: 5,
      language: "english",
      task: "transcribe",
    });
  });

  it("uses the accurate distilled model rather than Whisper tiny", () => {
    expect(LOCAL_TRANSCRIPTION_MODEL).toEqual({
      id: "onnx-community/distil-small.en",
      revision: "69be759f982d1d4c5b8a987d4140752742619bd0",
      dtype: "q4",
    });
  });

  it("biases native dictation toward coding product names", () => {
    expect(DEFAULT_NATIVE_TRANSCRIPTION_CONTEXT).toContain("Solla Code");
    expect(DEFAULT_NATIVE_TRANSCRIPTION_CONTEXT).toContain("TypeScript");
    expect(DEFAULT_NATIVE_TRANSCRIPTION_CONTEXT.length).toBeLessThanOrEqual(100);
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

  it("routes dictation into the visible pending plan answer instead of the background draft", () => {
    expect(
      resolveVoiceTranscriptInputUpdate({
        currentPrompt: "Existing answer",
        transcript: " plus the dictated detail ",
        pendingQuestionId: "scope",
      }),
    ).toEqual({
      prompt: "Existing answer plus the dictated detail",
      target: { kind: "pending-user-input", questionId: "scope" },
    });
  });

  it("routes ordinary dictation into the composer draft", () => {
    expect(
      resolveVoiceTranscriptInputUpdate({
        currentPrompt: "",
        transcript: "Normal chat message",
        pendingQuestionId: null,
      }),
    ).toEqual({
      prompt: "Normal chat message",
      target: { kind: "composer-draft" },
    });
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
