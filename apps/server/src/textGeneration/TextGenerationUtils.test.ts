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
});
