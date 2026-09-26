import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ModelCapabilities } from "@t3tools/contracts";

import {
  groupAntigravityModels,
  antigravityCapabilitiesForSelection,
  antigravityUsageModelFamily,
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
  normalizeCustomModelSlug,
  normalizeModelSlug,
} from "./model.ts";

const codexCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "xhigh", label: "Extra High" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
    },
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

const claudeCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
        { id: "ultrathink", label: "Ultrathink" },
      ],
      currentValue: "high",
      promptInjectedValues: ["ultrathink"],
    },
    {
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: [
        { id: "200k", label: "200k" },
        { id: "1m", label: "1M", isDefault: true },
      ],
      currentValue: "1m",
    },
  ],
});

describe("descriptor helpers", () => {
  it("applies selection values to capability descriptors", () => {
    expect(
      getProviderOptionDescriptors({
        caps: claudeCaps,
        selections: [
          { id: "effort", value: "medium" },
          { id: "contextWindow", value: "200k" },
        ],
      }),
    ).toEqual([
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "ultrathink", label: "Ultrathink" },
        ],
        currentValue: "medium",
        promptInjectedValues: ["ultrathink"],
      },
      {
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        options: [
          { id: "200k", label: "200k" },
          { id: "1m", label: "1M", isDefault: true },
        ],
        currentValue: "200k",
      },
    ]);
  });

  it("builds wire-format option selections from descriptors", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });

    expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
  });

  it("stores option selection arrays in model selections", () => {
    expect(
      createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });
  });

  it("reads typed option selection values", () => {
    const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);

    expect(getProviderOptionStringSelectionValue(selection.options, "reasoningEffort")).toBe(
      "high",
    );
    expect(getProviderOptionStringSelectionValue(selection.options, "fastMode")).toBeUndefined();
    expect(getProviderOptionBooleanSelectionValue(selection.options, "fastMode")).toBe(true);
    expect(
      getProviderOptionBooleanSelectionValue(selection.options, "reasoningEffort"),
    ).toBeUndefined();
    expect(getModelSelectionStringOptionValue(selection, "reasoningEffort")).toBe("high");
    expect(getModelSelectionBooleanOptionValue(selection, "fastMode")).toBe(true);
  });
});

describe("model slug normalization", () => {
  it("preserves exact custom slugs instead of expanding provider aliases", () => {
    const claude = ProviderDriverKind.make("claudeAgent");

    expect(normalizeModelSlug("opus", claude)).toBe("claude-opus-5-5");
    expect(normalizeCustomModelSlug(" opus ")).toBe("opus");
  });

  it("normalizes Opus 5.5 spellings without moving explicitly pinned older models", () => {
    const claude = ProviderDriverKind.make("claudeAgent");
    for (const alias of ["opus-5.5", "opus-5-5", "claude-opus-5.5", "claude-opus-5-5"]) {
      expect(normalizeModelSlug(alias, claude)).toBe("claude-opus-5-5");
    }
    expect(normalizeModelSlug("opus-5", claude)).toBe("claude-opus-5");
    expect(normalizeModelSlug("claude-opus-4-8", claude)).toBe("claude-opus-4-8");
  });

  it("resolves Deep Code's retired slugs onto the model they now serve", () => {
    const deepCode = ProviderDriverKind.make("deepcode");

    expect(normalizeModelSlug("deepseek-v4-flash", deepCode)).toBe("deepseek-flash");
    expect(normalizeModelSlug("deepseek-v4-flash-vision-exp", deepCode)).toBe("deepseek-flash");
    // A current slug is left alone.
    expect(normalizeModelSlug("deepseek-v4-pro", deepCode)).toBe("deepseek-v4-pro");
  });
});

describe("Antigravity model families", () => {
  it("maps native /usage rows and model slugs onto the same quota families", () => {
    expect(antigravityUsageModelFamily("Gemini Models")).toBe("gemini");
    expect(antigravityUsageModelFamily("gemini-3.8-flash-low")).toBe("gemini");
    expect(antigravityUsageModelFamily("Claude and GPT models")).toBe("claude-gpt");
    expect(antigravityUsageModelFamily("claude-sonnet-4-5")).toBe("claude-gpt");
    expect(antigravityUsageModelFamily("gpt-5")).toBe("claude-gpt");
    expect(antigravityUsageModelFamily("unknown-model")).toBeNull();
  });

  const models = groupAntigravityModels([
    { slug: "gemini-flash-high", label: "Gemini Flash (High)" },
    { slug: "gemini-flash-low", label: "Gemini Flash (Low)" },
    { slug: "gemini-flash-medium", label: "Gemini Flash (Medium)" },
    { slug: "gemini-pro-high", label: "Gemini Pro (High)" },
    { slug: "gemini-pro-low", label: "Gemini Pro (Low)" },
    { slug: "claude-opus-thinking", label: "Claude Opus (Thinking)" },
  ]);
  it("groups native variants once and exposes only supported effort levels", () => {
    expect(models.map((model) => model.slug)).toEqual([
      "gemini-flash",
      "gemini-pro",
      "claude-opus-thinking",
    ]);
    expect(models[0]?.name).toBe("Gemini Flash");
    const descriptor = models[1]?.capabilities?.optionDescriptors?.[0];
    expect(descriptor).toMatchObject({
      id: "effort",
      currentValue: "high",
      options: [{ id: "low" }, { id: "high" }],
    });
    expect(models[2]?.capabilities).toBeNull();
  });
  it("preserves a legacy variant effort and lets explicit options override it", () => {
    const caps = antigravityCapabilitiesForSelection(models[0]?.capabilities, "gemini-flash-low");
    // The grouped catalog always carries capabilities on the base model, and
    // every assertion below is vacuous without them, so fail loudly here
    // instead of passing `undefined` into a descriptor read.
    if (!caps) throw new Error("expected capabilities on the grouped Antigravity model");
    expect(getProviderOptionDescriptors({ caps, selections: undefined })[0]?.currentValue).toBe(
      "low",
    );
    expect(
      getProviderOptionDescriptors({ caps, selections: [{ id: "effort", value: "medium" }] })[0]
        ?.currentValue,
    ).toBe("medium");
    expect(models[0]?.capabilities?.optionDescriptors?.[0]?.currentValue).toBe("high");
  });
});
