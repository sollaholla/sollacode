import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  buildVoiceTranscriptConversationContext,
  correctVoiceTranscriptWithFallback,
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
    await expect(
      correctVoiceTranscriptWithFallback({
        enabled: true,
        transcript: "Open the Vera medical project.",
        cwd: "/workspace",
        conversationContext: "User: Veera Medical",
        modelSelection,
        request,
      }),
    ).resolves.toBe("Open the Veera Medical project.");
    expect(request).toHaveBeenCalledWith({
      cwd: "/workspace",
      transcript: "Open the Vera medical project.",
      conversationContext: "User: Veera Medical",
      modelSelection,
    });
  });

  it("does not request correction when disabled", async () => {
    const request = vi.fn(async () => "changed");
    await expect(
      correctVoiceTranscriptWithFallback({
        enabled: false,
        transcript: "leave this alone",
        cwd: "/workspace",
        conversationContext: "",
        modelSelection,
        request,
      }),
    ).resolves.toBe("leave this alone");
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
});
