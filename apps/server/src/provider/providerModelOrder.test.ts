import type { ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { modelVersionFromSlug, orderProviderModels } from "./providerModelOrder.ts";
import { orderProviderSnapshots } from "./providerStatusCache.ts";

const model = (slug: string, name: string, extra?: Partial<ServerProviderModel>) =>
  ({ slug, name, isCustom: false, capabilities: null, ...extra }) as ServerProviderModel;

const slugs = (models: ReadonlyArray<ServerProviderModel>) => models.map((entry) => entry.slug);

describe("modelVersionFromSlug", () => {
  it("reads the version out of either provider's ids", () => {
    expect(modelVersionFromSlug("claude-opus-5-5")).toEqual([5, 5]);
    expect(modelVersionFromSlug("claude-sonnet-5")).toEqual([5, 0]);
    expect(modelVersionFromSlug("claude-sonnet-5-5[1m]")).toEqual([5, 5]);
    expect(modelVersionFromSlug("claude-opus-4-5-20251101")).toEqual([4, 5]);
    expect(modelVersionFromSlug("claude-opus-4-20250514")).toEqual([4, 0]);
    expect(modelVersionFromSlug("gpt-5.3-codex-spark")).toEqual([5, 3]);
    expect(modelVersionFromSlug("gpt-5-codex")).toEqual([5, 0]);
  });

  it("finds none where an id names none", () => {
    expect(modelVersionFromSlug("crest-alpha")).toBeNull();
    expect(modelVersionFromSlug("preview-20250514")).toBeNull();
  });
});

describe("orderProviderModels", () => {
  it("puts newer Claude versions first, then sorts each version by name", () => {
    // Sonnet and Haiku 5.5 arrive from discovery, after the built-in list.
    const ordered = orderProviderModels("claudeAgent", [
      model("claude-fable-5-1", "Claude Fable 5.1"),
      model("claude-fable-5", "Claude Fable 5"),
      model("claude-opus-5-5", "Claude Opus 5.5"),
      model("claude-opus-5", "Claude Opus 5"),
      model("claude-opus-4-8", "Claude Opus 4.8"),
      model("claude-sonnet-5", "Claude Sonnet 5"),
      model("claude-sonnet-4-6", "Claude Sonnet 4.6"),
      model("claude-opus-4-6", "Claude Opus 4.6"),
      model("claude-sonnet-5-5", "Claude Sonnet 5.5"),
      model("claude-haiku-5-5", "Claude Haiku 5.5"),
    ]);
    expect(slugs(ordered)).toEqual([
      "claude-haiku-5-5",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-opus-4-8",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ]);
  });

  it("sorts Codex the same way and keeps its default where it was marked", () => {
    const ordered = orderProviderModels("codex", [
      model("gpt-5.6-sol", "GPT-5.6-Sol", { isDefault: true }),
      model("gpt-5.6-terra", "GPT-5.6-Terra"),
      model("gpt-5.6-luna", "GPT-5.6-Luna"),
      model("gpt-5.4-mini", "GPT-5.4-Mini"),
      model("gpt-5.5", "GPT-5.5"),
      model("gpt-5.4", "GPT-5.4"),
    ]);
    expect(slugs(ordered)).toEqual([
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
    ]);
    expect(ordered.filter((entry) => entry.isDefault).map((entry) => entry.slug)).toEqual([
      "gpt-5.6-sol",
    ]);
  });

  it("keeps the model clients fell back to as the default when another sorts first", () => {
    const ordered = orderProviderModels("claudeAgent", [
      model("claude-fable-5-1", "Claude Fable 5.1"),
      model("claude-haiku-5-5", "Claude Haiku 5.5"),
    ]);
    expect(slugs(ordered)).toEqual(["claude-haiku-5-5", "claude-fable-5-1"]);
    expect(ordered[1]?.isDefault).toBe(true);
    expect(ordered[0]?.isDefault).toBeUndefined();
  });

  it("marks nothing when the first model stays first", () => {
    const models = [
      model("claude-opus-5-5", "Claude Opus 5.5"),
      model("claude-opus-5", "Claude Opus 5"),
    ];
    expect(orderProviderModels("claudeAgent", models)).toEqual(models);
  });

  it("puts ids with no version last, and sorts custom models in with the rest", () => {
    const ordered = orderProviderModels("claudeAgent", [
      model("claude-opus-5", "Claude Opus 5"),
      model("crest-alpha", "crest-alpha", { isCustom: true }),
      model("claude-sonnet-5-5", "claude-sonnet-5-5", { isCustom: true }),
    ]);
    expect(slugs(ordered)).toEqual(["claude-sonnet-5-5", "claude-opus-5", "crest-alpha"]);
  });

  it("leaves other providers in the order they gave", () => {
    const models = [model("grok-3", "Grok 3"), model("grok-4", "Grok 4")];
    expect(orderProviderModels("grok", models)).toBe(models);
  });
});

describe("orderProviderSnapshots", () => {
  it("orders the models of what every client is sent", () => {
    const [provider] = orderProviderSnapshots([
      {
        driver: "claudeAgent",
        instanceId: "claudeAgent",
        displayName: "Claude",
        models: [
          model("claude-opus-5-5", "Claude Opus 5.5"),
          model("claude-sonnet-5-5", "Claude Sonnet 5.5"),
          model("claude-opus-5", "Claude Opus 5"),
          model("claude-haiku-5-5", "Claude Haiku 5.5"),
        ],
      } as unknown as ServerProvider,
    ]);
    expect(slugs(provider?.models ?? [])).toEqual([
      "claude-haiku-5-5",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-opus-5",
    ]);
  });
});
