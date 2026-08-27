// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { VoiceTranscriptionResultChip } from "./VoiceTranscriptionResultChip";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("VoiceTranscriptionResultChip", () => {
  it("shows a clamped preview that expands on hover or keyboard focus", async () => {
    await act(async () => {
      root.render(
        <VoiceTranscriptionResultChip
          transcript="A long transcription that should be previewed first."
          onDismiss={() => undefined}
          onSend={() => undefined}
        />,
      );
    });

    const preview = container.querySelector('[role="note"] > span');
    expect(preview?.textContent).toContain("A long transcription");
    expect(preview?.className).toContain("line-clamp-1");
    expect(preview?.className).toContain("group-hover/voice-result:line-clamp-none");
    expect(preview?.className).toContain("group-focus-within/voice-result:line-clamp-none");
    expect(container.querySelector('[role="note"]')?.getAttribute("tabindex")).toBe("0");
  });

  it("dismisses before invoking the canonical send action", async () => {
    const calls: string[] = [];
    await act(async () => {
      root.render(
        <VoiceTranscriptionResultChip
          transcript="Send this transcript."
          onDismiss={() => calls.push("dismiss")}
          onSend={() => calls.push("send")}
        />,
      );
    });

    act(() => {
      const send = container.querySelector('[aria-label="Send transcribed message"]');
      if (!(send instanceof HTMLButtonElement)) throw new Error("Send button missing.");
      send.click();
    });
    expect(calls).toEqual(["dismiss", "send"]);

    act(() => {
      const dismiss = container.querySelector('[aria-label="Dismiss transcription"]');
      if (!(dismiss instanceof HTMLButtonElement)) throw new Error("Dismiss button missing.");
      dismiss.click();
    });
    expect(calls).toEqual(["dismiss", "send", "dismiss"]);
  });
});
