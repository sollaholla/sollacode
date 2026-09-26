import { describe, expect, it } from "vite-plus/test";

import { shouldOfferAppVoiceCapture } from "./appVoiceCaptureAvailability";

describe("app voice capture availability", () => {
  it("offers voice notes on touch web with recording APIs and no browser speech recognizer", () => {
    expect(
      shouldOfferAppVoiceCapture({
        isDesktopElectron: false,
        hasCoarsePointer: true,
        hasAudioCapture: true,
        hasNativeSpeechDictation: false,
      }),
    ).toBe(true);
  });
  it("hides local Whisper capture on touch/mobile web without a recogniser", () => {
    expect(
      shouldOfferAppVoiceCapture({
        isDesktopElectron: false,
        hasCoarsePointer: true,
      }),
    ).toBe(false);
  });

  it("keeps desktop Electron voice capture regardless of pointer reporting", () => {
    expect(
      shouldOfferAppVoiceCapture({
        isDesktopElectron: true,
        hasCoarsePointer: true,
      }),
    ).toBe(true);
  });

  it("keeps voice capture for fine-pointer desktop web", () => {
    expect(
      shouldOfferAppVoiceCapture({
        isDesktopElectron: false,
        hasCoarsePointer: false,
      }),
    ).toBe(true);
  });

  it("offers the microphone on touch web once the browser can transcribe", () => {
    // Safari has `webkitSpeechRecognition`, so a phone no longer has to fall
    // back to the OS keyboard's mic to dictate.
    expect(
      shouldOfferAppVoiceCapture({
        isDesktopElectron: false,
        hasCoarsePointer: true,
        hasNativeSpeechDictation: true,
      }),
    ).toBe(true);
  });
});
