import { VmAgentTaskPromptGenerationResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  sanitizeCorrectedVoiceTranscript,
  toCodexJsonSchemaObject,
} from "./TextGenerationUtils.ts";

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsKey(entry, key));
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return key in record || Object.values(record).some((entry) => containsKey(entry, key));
}

describe("toCodexJsonSchemaObject", () => {
  it("flattens Effect refinement allOf nodes into Codex-supported constraints", () => {
    const schema = toCodexJsonSchemaObject(VmAgentTaskPromptGenerationResult) as {
      properties: {
        schedule: {
          anyOf: Array<{
            anyOf?: Array<{
              properties?: { everyMinutes?: Record<string, unknown> };
            }>;
          }>;
        };
        completionCriteria: Record<string, unknown>;
      };
    };

    expect(containsKey(schema, "allOf")).toBe(false);
    const interval = schema.properties.schedule.anyOf[0]?.anyOf?.[1];
    expect(interval?.properties?.everyMinutes).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 525_600,
    });
    expect(schema.properties.completionCriteria).toMatchObject({
      type: "array",
      maxItems: 50,
    });
  });
});

describe("sanitizeCorrectedVoiceTranscript", () => {
  it("trims a valid correction", () => {
    expect(sanitizeCorrectedVoiceTranscript("  Veera Medical  ", "Vera medical")).toBe(
      "Veera Medical",
    );
  });

  it("preserves the raw transcript exactly when generated output is unsafe", () => {
    expect(sanitizeCorrectedVoiceTranscript("   ", "  raw wording  ")).toBe("  raw wording  ");
    expect(sanitizeCorrectedVoiceTranscript("x".repeat(8_001), "raw wording")).toBe("raw wording");
  });

  it("unwraps one accidental structured-output layer without corrupting dictated JSON", () => {
    expect(
      sanitizeCorrectedVoiceTranscript(
        '{"transcript":"The settings render behind the chat."}',
        "The settings renders behind chat.",
      ),
    ).toBe("The settings render behind the chat.");
    expect(
      sanitizeCorrectedVoiceTranscript(
        '{"transcript":"literal user data"}',
        '{"transcript":"literal user data"}',
      ),
    ).toBe('{"transcript":"literal user data"}');
  });

  it("repairs lip as ellipsis only in an unambiguous text truncation context", () => {
    const raw =
      "Show the transcription in a short form with lip but then when hover over it expands fully";
    expect(sanitizeCorrectedVoiceTranscript(raw, raw)).toBe(
      "Show the transcription in a short form with an ellipsis, but then when you hover over it, it expands fully",
    );
    expect(sanitizeCorrectedVoiceTranscript("", raw)).toBe(
      "Show the transcription in a short form with an ellipsis, but then when you hover over it, it expands fully",
    );
  });

  it("preserves literal lip references and ambiguous short phrases", () => {
    expect(
      sanitizeCorrectedVoiceTranscript(
        "Use a cup with a lip so it does not spill.",
        "Use a cup with a lip so it does not spill.",
      ),
    ).toBe("Use a cup with a lip so it does not spill.");
    expect(sanitizeCorrectedVoiceTranscript("Keep the short form with lip.", "same")).toBe(
      "Keep the short form with lip.",
    );
    const separateLiteralReference =
      "The notification text is short and expands on hover. Use a cup with a lip.";
    expect(
      sanitizeCorrectedVoiceTranscript(separateLiteralReference, separateLiteralReference),
    ).toBe(separateLiteralReference);
  });
});
