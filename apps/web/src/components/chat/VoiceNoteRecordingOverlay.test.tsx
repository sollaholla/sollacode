// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { VoiceNoteRecordingOverlay, voiceLevelFromSamples } from "./VoiceNoteRecordingOverlay";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

it("reads silence as nothing and loud speech as a full bar", () => {
  expect(voiceLevelFromSamples(new Uint8Array(512).fill(128))).toBe(0);
  const loud = Uint8Array.from({ length: 512 }, (_, index) => (index % 2 === 0 ? 0 : 255));
  expect(voiceLevelFromSamples(loud)).toBe(1);
  expect(voiceLevelFromSamples(new Uint8Array(0))).toBe(0);
});

it("covers the screen with Done and Cancel while recording", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onDone = vi.fn();
  const onCancel = vi.fn();
  await act(async () =>
    root.render(
      <VoiceNoteRecordingOverlay stream={{} as MediaStream} onDone={onDone} onCancel={onCancel} />,
    ),
  );
  const overlay = document.querySelector("[data-voice-note-recording-overlay]");
  expect(overlay?.className).toContain("fixed inset-0");
  const buttons = Array.from(document.querySelectorAll("button"));
  await act(async () => buttons.find((button) => button.textContent === "Done")?.click());
  await act(async () => buttons.find((button) => button.textContent === "Cancel")?.click());
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(onCancel).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});
