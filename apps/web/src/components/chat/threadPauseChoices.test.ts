import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderUsageSummary, ProviderUsageWindow } from "./ProviderUsageBar";
import {
  pauseAccountChoices,
  pauseModelChoices,
  pauseResetAt,
  percentLeftForModel,
} from "./threadPauseChoices";

const NOW = 1_000_000;

function usageWindow(key: string, usedPercent: number | null, resetAt: number | null = NOW + 1) {
  return { key, label: key, usedPercent, resetAt } satisfies ProviderUsageWindow;
}

function provider(id: string, driver: string, models: ReadonlyArray<string>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
  };
}

function summary(target: ServerProvider, windows: ReadonlyArray<ProviderUsageWindow>) {
  return {
    provider: target,
    state: "available",
    windows: [...windows],
    reportedAt: null,
  } satisfies ProviderUsageSummary;
}

const labelOf = (entry: ServerProvider) => String(entry.instanceId);

describe("percentLeftForModel", () => {
  it("reads the tightest window the model draws on", () => {
    const windows = [usageWindow("seven_day", 40), usageWindow("seven_day_fable", 90)];
    expect(percentLeftForModel(windows, "claude-fable-5", NOW)).toBe(10);
    expect(percentLeftForModel(windows, "claude-opus-5", NOW)).toBe(60);
  });

  it("knows nothing without a live reading", () => {
    expect(percentLeftForModel([], "gpt-6", NOW)).toBeNull();
    expect(percentLeftForModel([usageWindow("week", 100, NOW - 1)], "gpt-6", NOW)).toBeNull();
    expect(percentLeftForModel([usageWindow("week", null)], "gpt-6", NOW)).toBeNull();
  });
});

describe("pauseModelChoices", () => {
  const claude = provider("claude", "claudeAgent", ["claude-fable-5", "claude-opus-5"]);
  const codex = provider("codex", "codex", ["gpt-6"]);

  it("leaves out the model that stopped and any known to be spent", () => {
    const groups = pauseModelChoices({
      providers: [claude, codex],
      summaries: [summary(claude, [usageWindow("seven_day_opus", 100)])],
      currentInstanceId: claude.instanceId,
      currentModel: "claude-fable-5",
      labelOf,
      nowMs: NOW,
    });
    expect(groups.map((group) => group.label)).toEqual(["codex"]);
    expect(groups[0]?.models[0]).toMatchObject({ model: "gpt-6", percentLeft: null });
  });

  it("puts the most room first and skips a signed-out provider", () => {
    const signedOut = {
      ...provider("grok", "grok", ["grok-5"]),
      auth: { status: "unauthenticated" },
    } satisfies ServerProvider;
    const groups = pauseModelChoices({
      providers: [claude, signedOut],
      summaries: [summary(claude, [usageWindow("seven_day_fable", 90)])],
      currentInstanceId: null,
      currentModel: null,
      labelOf,
      nowMs: NOW,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.models.map((model) => model.model)).toEqual([
      "claude-fable-5",
      "claude-opus-5",
    ]);
  });
});

describe("pauseAccountChoices", () => {
  it("offers the provider's other accounts, on the same model where they have it", () => {
    const work = provider("claude-work", "claudeAgent", ["claude-opus-5"]);
    const home = provider("claude-home", "claudeAgent", ["claude-opus-5"]);
    const codex = provider("codex", "codex", ["claude-opus-5"]);
    expect(
      pauseAccountChoices({
        providers: [work, home, codex],
        summaries: [summary(home, [usageWindow("week", 25)])],
        current: work,
        currentModel: "claude-opus-5",
        labelOf,
        nowMs: NOW,
      }),
    ).toEqual([
      {
        instanceId: home.instanceId,
        label: "claude-home",
        model: "claude-opus-5",
        percentLeft: 75,
      },
    ]);
  });
});

describe("pauseResetAt", () => {
  it("names when a full window reopens", () => {
    expect(pauseResetAt([usageWindow("week", 100, NOW + 50)], NOW)).toBe(NOW + 50);
    expect(pauseResetAt([usageWindow("week", 60, NOW + 50)], NOW)).toBeNull();
  });
});
