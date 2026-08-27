import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  buildVoiceTranscriptConversationContext,
  cancelActiveVoiceTranscriptCorrection,
  correctVoiceTranscriptWithFallback,
  normalizeVoiceTranscriptSpeechArtifacts,
  VOICE_TRANSCRIPT_CORRECTION_DEADLINE_MS,
} from "./voiceTranscriptCorrection";

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-mini",
} as const;

describe("buildVoiceTranscriptConversationContext", () => {
  it("keeps a small recent snapshot and omits in-progress output", () => {
    expect(
      buildVoiceTranscriptConversationContext(
        [
          { role: "system", text: "old setup" },
          { role: "user", text: "We are fixing Veera Medical." },
          { role: "assistant", text: "I will inspect the MedXR scene." },
          { role: "assistant", text: "unfinished", streaming: true },
          { role: "user", text: "  use   the Quest build  " },
        ],
        { maxMessages: 3 },
      ),
    ).toBe(
      "User: We are fixing Veera Medical.\nAssistant: I will inspect the MedXR scene.\nUser: use the Quest build",
    );
  });

  it("bounds the serialized context from the newest messages", () => {
    const context = buildVoiceTranscriptConversationContext(
      [
        { role: "user", text: "old" },
        { role: "assistant", text: "x".repeat(200) },
      ],
      { maxChars: 40 },
    );
    expect(context.length).toBeLessThanOrEqual(40);
    expect(context.startsWith("Assistant: ")).toBe(true);
    expect(context).not.toContain("User: old");
  });
});

describe("correctVoiceTranscriptWithFallback", () => {
  it("inserts a valid correction from the configured model", async () => {
    const request = vi.fn(async () => "Open the Veera Medical project.");
    const onRefining = vi.fn();
    await expect(
      correctVoiceTranscriptWithFallback({
        enabled: true,
        transcript: "Open the Vera medical project.",
        cwd: "/workspace",
        conversationContext: "User: Veera Medical",
        modelSelection,
        request,
        onRefining,
      }),
    ).resolves.toBe("Open the Veera Medical project.");
    expect(request).toHaveBeenCalledWith({
      cwd: "/workspace",
      transcript: "Open the Vera medical project.",
      conversationContext: "User: Veera Medical",
      modelSelection,
    });
    expect(onRefining).toHaveBeenCalledOnce();
  });

  it("does not request correction when disabled", async () => {
    const request = vi.fn(async () => "changed");
    const onRefining = vi.fn();
    await expect(
      correctVoiceTranscriptWithFallback({
        enabled: false,
        transcript: "leave this alone",
        cwd: "/workspace",
        conversationContext: "",
        modelSelection,
        request,
        onRefining,
      }),
    ).resolves.toBe("leave this alone");
    expect(request).not.toHaveBeenCalled();
    expect(onRefining).not.toHaveBeenCalled();
  });

  it("still repairs high-confidence recognition artifacts when AI correction is disabled", async () => {
    const request = vi.fn(async () => "changed");
    await expect(
      correctVoiceTranscriptWithFallback({
        enabled: false,
        transcript:
          "And .2 show the transcription in a short form with lip but then when hover over it expands fully.",
        cwd: "/workspace",
        conversationContext: "",
        modelSelection,
        request,
      }),
    ).resolves.toBe(
      "And point two, show the transcription in a short form with an ellipsis, but then when you hover over it, it expands fully.",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("falls back to the raw transcript on errors, timeout, or implausible expansion", async () => {
    await expect(
      correctVoiceTranscriptWithFallback({
        enabled: true,
        transcript: "raw words",
        cwd: "/workspace",
        conversationContext: "",
        modelSelection,
        request: async () => {
          throw new Error("offline");
        },
      }),
    ).resolves.toBe("raw words");

    await expect(
      correctVoiceTranscriptWithFallback({
        enabled: true,
        transcript: "raw words",
        cwd: "/workspace",
        conversationContext: "",
        modelSelection,
        request: async () => "x".repeat(300),
      }),
    ).resolves.toBe("raw words");

    vi.useFakeTimers();
    const timedOut = correctVoiceTranscriptWithFallback({
      enabled: true,
      transcript: "raw words",
      cwd: "/workspace",
      conversationContext: "",
      modelSelection,
      timeoutMs: 25,
      request: () => new Promise<string>(() => undefined),
    });
    await vi.advanceTimersByTimeAsync(25);
    await expect(timedOut).resolves.toBe("raw words");
    vi.useRealTimers();
  });

  it("allows a normal utility-model correction that takes a little over nine seconds", async () => {
    expect(VOICE_TRANSCRIPT_CORRECTION_DEADLINE_MS).toBe(20_000);
    vi.useFakeTimers();
    const corrected = correctVoiceTranscriptWithFallback({
      enabled: true,
      transcript: "The settings renders behind chat.",
      cwd: "/workspace",
      conversationContext: "",
      modelSelection,
      request: () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("The settings render behind the chat."), 9_400);
        }),
    });
    await vi.advanceTimersByTimeAsync(9_400);
    await expect(corrected).resolves.toBe("The settings render behind the chat.");
    vi.useRealTimers();
  });

  it("repairs a spoken point-two list marker when model correction fails", async () => {
    await expect(
      correctVoiceTranscriptWithFallback({
        enabled: true,
        transcript: "And .2 if it is a Codex thread keep its preview mounted.",
        cwd: "/workspace",
        conversationContext: "",
        modelSelection,
        request: async () => {
          throw new Error("offline");
        },
      }),
    ).resolves.toBe("And point two, if it is a Codex thread keep its preview mounted.");
  });

  it("repairs point two when the correction model returns the artifact unchanged", async () => {
    await expect(
      correctVoiceTranscriptWithFallback({
        enabled: true,
        transcript: "Then .2 make the notification expandable.",
        cwd: "/workspace",
        conversationContext: "",
        modelSelection,
        request: async ({ transcript }) => transcript,
      }),
    ).resolves.toBe("Then point two, make the notification expandable.");
  });

  it("lets the visible cancel action interrupt the correction wait", async () => {
    const correction = correctVoiceTranscriptWithFallback({
      enabled: true,
      transcript: "raw words",
      cwd: "/workspace",
      conversationContext: "",
      modelSelection,
      request: () => new Promise<string>(() => undefined),
    });

    expect(cancelActiveVoiceTranscriptCorrection()).toBe(true);
    await expect(correction).rejects.toMatchObject({
      name: "AbortError",
      message: "Voice transcript correction was cancelled.",
    });
    expect(cancelActiveVoiceTranscriptCorrection()).toBe(false);
  });
});

describe("normalizeVoiceTranscriptSpeechArtifacts", () => {
  it("restores point to only when .2 occupies a grammatical verb slot", () => {
    expect(normalizeVoiceTranscriptSpeechArtifacts("Can you .2 the Settings button?")).toBe(
      "Can you point to the Settings button?",
    );
    expect(normalizeVoiceTranscriptSpeechArtifacts("Please .2 it.")).toBe("Please point to it.");
    expect(normalizeVoiceTranscriptSpeechArtifacts("I need you .2 the active tab.")).toBe(
      "I need you to point to the active tab.",
    );
  });

  it("restores point two when .2 is clearly a spoken list marker", () => {
    expect(
      normalizeVoiceTranscriptSpeechArtifacts(
        "And .2 if it is a particular Codex thread keep its preview mounted.",
      ),
    ).toBe("And point two, if it is a particular Codex thread keep its preview mounted.");
    expect(normalizeVoiceTranscriptSpeechArtifacts(".2 make the result expandable.")).toBe(
      "point two, make the result expandable.",
    );
    expect(normalizeVoiceTranscriptSpeechArtifacts(".2 I also want the full result.")).toBe(
      "point two, I also want the full result.",
    );
    expect(normalizeVoiceTranscriptSpeechArtifacts(".2")).toBe("point two");
  });

  it("preserves ambiguous decimals and technical notation", () => {
    const technical =
      "Set opacity to .2, run render(.2), keep v0.2.1 at /api/v0.2.1, and open https://example.test/v0.2.1.";
    expect(normalizeVoiceTranscriptSpeechArtifacts(technical)).toBe(technical);
    expect(normalizeVoiceTranscriptSpeechArtifacts(".2 seconds")).toBe(".2 seconds");
    expect(normalizeVoiceTranscriptSpeechArtifacts(".2, .4, and .6")).toBe(".2, .4, and .6");
    expect(normalizeVoiceTranscriptSpeechArtifacts("For .2, use cubic easing.")).toBe(
      "For .2, use cubic easing.",
    );
  });

  it("repairs lip as ellipsis only in an unambiguous truncation context", () => {
    expect(
      normalizeVoiceTranscriptSpeechArtifacts(
        "Show the transcription in a short form with lip but then when hover over it expands fully.",
      ),
    ).toBe(
      "Show the transcription in a short form with an ellipsis, but then when you hover over it, it expands fully.",
    );
    expect(
      normalizeVoiceTranscriptSpeechArtifacts("Use a cup with a lip so it does not spill."),
    ).toBe("Use a cup with a lip so it does not spill.");
  });
});
