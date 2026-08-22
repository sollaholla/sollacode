import { describe, expect, it } from "vite-plus/test";

import type { ThreadSnapshot } from "./events";
import {
  matchModelSlug,
  reserveSettingsUpdatePrompt,
  resolveThreadSettings,
  type ProviderCatalog,
} from "./threadSettings";

const thread = (overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot => ({
  threadKey: "env-1:thread-a",
  threadId: "thread-a",
  environmentId: "env-1",
  title: "Rover",
  isWorking: false,
  waitingOn: "nothing",
  isSideChat: false,
  sideChatParentThreadId: null,
  hasError: false,
  environmentUnreachable: false,
  lastError: null,
  failureKind: null,
  errorAt: null,
  settled: false,
  model: "claude-opus-5",
  provider: "claudeAgent",
  accessMode: "approval-required",
  interactionMode: "default",
  effort: "high",
  latestTurnState: "completed",
  projectId: "project-1",
  projectName: "Rover Project",
  workspaceName: "rover",
  ...overrides,
});

const current = (
  overrides: Partial<Parameters<typeof resolveThreadSettings>[0]["current"]> = {},
) => ({
  instanceId: "claudeAgent",
  model: "claude-opus-5",
  options: [{ id: "effort", value: "high" as const }],
  runtimeMode: "approval-required",
  interactionMode: "default",
  ...overrides,
});

const AVAILABLE: Record<string, ReadonlyArray<string>> = {
  claudeAgent: ["claude-opus-5", "claude-sonnet-5"],
  codex: ["gpt-5.6-sol"],
  // The user's real setup: a browser bridge offering only its own two models.
  mcpBridge: ["chatgpt-browser", "claude-browser"],
};

const catalog: ProviderCatalog = {
  hasInstance: (instanceId) => instanceId in AVAILABLE,
  resolveModel: (instanceId, model) => {
    const models = AVAILABLE[instanceId];
    if (models === undefined) return null;
    if (model === undefined) return models[0] ?? null;
    return models.includes(model) ? model : null;
  },
  listModels: (instanceId) => AVAILABLE[instanceId] ?? [],
  findModelAcrossInstances: (model) =>
    Object.entries(AVAILABLE)
      .filter(([, models]) => models.includes(model))
      .map(([instanceId]) => ({ instanceId, model })),
  effortOption: (instanceId) =>
    instanceId === "claudeAgent"
      ? { id: "effort", values: ["low", "medium", "high", "xhigh", "max"] }
      : { id: "reasoningEffort", values: ["low", "high"] },
};

const resolve = (
  request: Parameters<typeof resolveThreadSettings>[0]["request"],
  overrides: { thread?: Partial<ThreadSnapshot>; current?: Record<string, unknown> } = {},
) =>
  resolveThreadSettings({
    thread: thread(overrides.thread),
    current: current(overrides.current as never),
    request,
    catalog,
  });

describe("effect timing", () => {
  it("reports access permissions as immediate and everything else as next-turn", () => {
    // Not a preference: a runtime-mode event restarts the live provider session
    // from its resume cursor, while a model change is only cached until the
    // next session is established. Telling the user the wrong one is worse
    // than saying nothing.
    const { plan } = resolve({
      accessMode: "auto",
      model: "claude-sonnet-5",
      interactionMode: "plan",
    });
    const byField = Object.fromEntries(plan.changes.map((c) => [c.field, c.effectiveOn]));
    expect(byField).toEqual({
      accessMode: "immediately",
      model: "next-turn",
      interactionMode: "next-turn",
    });
  });

  it("warns that deferred changes wait when the thread is mid-turn", () => {
    const { plan } = resolve({ model: "claude-sonnet-5" }, { thread: { isWorking: true } });
    expect(plan.warnings.join(" ")).toContain("next turn");
  });

  it("stays quiet about waiting when the thread is idle", () => {
    const { plan } = resolve({ model: "claude-sonnet-5" });
    expect(plan.warnings).toEqual([]);
  });
});

describe("validation", () => {
  it("refuses a model no configured provider offers, listing what is available", () => {
    const { plan } = resolve({ model: "imaginary-model" });
    expect(plan.rejections[0]).toContain("imaginary-model");
    expect(plan.rejections[0]).toContain("claude-opus-5");
    expect(plan.changes).toEqual([]);
  });

  it("refuses an unknown provider", () => {
    const { plan } = resolve({ provider: "wishful" });
    expect(plan.rejections[0]).toContain("wishful");
  });

  it("refuses an illegal effort and lists the legal ones", () => {
    const { plan } = resolve({ effort: "turbo" });
    expect(plan.rejections[0]).toContain("low, medium, high, xhigh, max");
  });

  it("produces no changes when the request matches what is already set", () => {
    const { plan, nextModelSelection } = resolve({
      model: "claude-opus-5",
      effort: "high",
      accessMode: "approval-required",
      interactionMode: "default",
    });
    expect(plan.changes).toEqual([]);
    expect(nextModelSelection).toBeNull();
  });
});

describe("permission raises", () => {
  it("flags a widening of access", () => {
    expect(resolve({ accessMode: "full-access" }).plan.raisesPermissions).toBe(true);
    expect(resolve({ accessMode: "auto" }).plan.raisesPermissions).toBe(true);
  });

  it("does not flag a narrowing", () => {
    // Taking access away is always safe to do on a misheard word; granting it
    // is the direction that needs the user in the loop.
    const { plan } = resolve(
      { accessMode: "approval-required" },
      { thread: { accessMode: "full-access" }, current: { runtimeMode: "full-access" } },
    );
    expect(plan.changes).toHaveLength(1);
    expect(plan.raisesPermissions).toBe(false);
  });
});

describe("model selection assembly", () => {
  it("replaces only the effort option and keeps the rest", () => {
    const { nextModelSelection } = resolve(
      { effort: "max" },
      {
        current: {
          options: [
            { id: "effort", value: "high" },
            { id: "fastMode", value: true },
          ],
        },
      },
    );
    expect(nextModelSelection?.options).toEqual([
      { id: "fastMode", value: true },
      { id: "effort", value: "max" },
    ]);
  });

  it("switches provider and takes that provider's default model", () => {
    const { plan, nextModelSelection } = resolve({ provider: "codex" });
    expect(nextModelSelection).toMatchObject({ instanceId: "codex", model: "gpt-5.6-sol" });
    expect(plan.changes.map((c) => c.field)).toEqual(["provider", "model"]);
  });

  it("warns that a provider switch ends a running turn", () => {
    const { plan } = resolve({ provider: "codex" }, { thread: { isWorking: true } });
    expect(plan.warnings.join(" ")).toContain("ends the turn");
  });

  it("leaves the model alone when only access mode changes", () => {
    expect(resolve({ accessMode: "auto" }).nextModelSelection).toBeNull();
  });
});

describe("agent mode", () => {
  it("calls out that leaving agent mode stops queued follow-ups", () => {
    // The one part of an interaction-mode change that is not deferred.
    const { plan } = resolve(
      { interactionMode: "default" },
      { thread: { interactionMode: "agent" }, current: { interactionMode: "agent" } },
    );
    expect(plan.warnings.join(" ")).toContain("stops any follow-up turns");
  });
});

describe("a model that lives on another provider", () => {
  // Reported against "Fix Native Quest Rendering Performance": switching from
  // chatgpt-browser to claude-opus-5 reported "already-set" while the thread
  // still showed chatgpt-browser. The picker-oriented resolver fell back to the
  // instance default on a miss, so the "new" model resolved to the current one
  // and the plan came out empty.
  const onBridge = {
    thread: { model: "chatgpt-browser", provider: "mcpBridge" },
    current: { instanceId: "mcpBridge", model: "chatgpt-browser", options: [] },
  };

  it("never reports already-set for a model the thread is not on", () => {
    const { plan } = resolve({ model: "claude-opus-5" }, onBridge);
    expect(plan.changes.length).toBeGreaterThan(0);
  });

  it("moves the thread to the provider that has it", () => {
    const { plan, nextModelSelection } = resolve({ model: "claude-opus-5" }, onBridge);
    expect(plan.rejections).toEqual([]);
    expect(nextModelSelection).toMatchObject({
      instanceId: "claudeAgent",
      model: "claude-opus-5",
    });
    expect(plan.changes.map((c) => c.field).sort()).toEqual(["model", "provider"]);
  });

  it("asks which provider when the model exists on several", () => {
    const ambiguousCatalog: ProviderCatalog = {
      ...catalog,
      findModelAcrossInstances: (model) => [
        { instanceId: "claudeAgent", model },
        { instanceId: "claudeOpenrouter", model },
      ],
    };
    const { plan } = resolveThreadSettings({
      thread: thread(onBridge.thread),
      current: current(onBridge.current as never),
      request: { model: "claude-opus-5" },
      catalog: ambiguousCatalog,
    });
    expect(plan.rejections[0]).toContain("claudeAgent");
    expect(plan.rejections[0]).toContain("claudeOpenrouter");
    expect(plan.changes).toEqual([]);
  });

  it("respects an explicitly named provider instead of searching", () => {
    // An explicit provider is an instruction, not a hint — if the model is not
    // there, say so rather than quietly routing somewhere else.
    const { plan } = resolve({ provider: "mcpBridge", model: "claude-opus-5" }, onBridge);
    expect(plan.rejections[0]).toContain("mcpBridge");
    expect(plan.rejections[0]).toContain("chatgpt-browser");
  });
});

describe("matchModelSlug", () => {
  const slugs = ["claude-opus-5", "gpt-5.6-sol", "chatgpt-browser"];

  it("matches the slug exactly", () => {
    expect(matchModelSlug(slugs, "claude-opus-5")).toBe("claude-opus-5");
  });

  it("accepts the spellings speech and people produce", () => {
    // Reported: alternate formatting attempts all came back already-set,
    // because every one of them fell through to the instance default.
    for (const spoken of ["claude opus 5", "Claude-Opus-5", "claude_opus_5", "  CLAUDE OPUS 5 "]) {
      expect(matchModelSlug(slugs, spoken), spoken).toBe("claude-opus-5");
    }
  });

  it("keeps dots and decimals working", () => {
    expect(matchModelSlug(slugs, "gpt 5.6 sol")).toBe("gpt-5.6-sol");
  });

  it("accepts a slug read aloud", () => {
    // Nobody says "dash" or "five" as a digit, and the transcriber writes what
    // it heard — words, not the slug's punctuation.
    expect(matchModelSlug(slugs, "claude opus five")).toBe("claude-opus-5");
    expect(matchModelSlug(slugs, "Claude Opus Five")).toBe("claude-opus-5");
  });

  it("will not pick between two models that sound alike", () => {
    // There is nobody to ask from in here, and choosing wrong changes a
    // thread's settings rather than merely looking something up.
    expect(matchModelSlug(["sonnet-5", "sonet-five"], "sonnett five")).toBeNull();
  });

  it("returns null rather than guessing at a model that is not there", () => {
    // The whole bug: a miss must not silently become the instance default.
    expect(matchModelSlug(slugs, "claude-sonnet-5")).toBeNull();
    expect(matchModelSlug(slugs, "")).toBeNull();
    expect(matchModelSlug([], "claude-opus-5")).toBeNull();
  });
});

describe("reserveSettingsUpdatePrompt", () => {
  it("allows one marker per settings change during projection lag", () => {
    const recent = new Map<string, number>();
    expect(reserveSettingsUpdatePrompt(recent, "env:thread:model:gpt-5.6-sol", 1_000)).toBe(true);
    expect(reserveSettingsUpdatePrompt(recent, "env:thread:model:gpt-5.6-sol", 1_001)).toBe(false);
  });

  it("keeps distinct changes and permits a later intentional retry", () => {
    const recent = new Map<string, number>();
    expect(reserveSettingsUpdatePrompt(recent, "model:gpt-5.6-sol", 1_000, 500)).toBe(true);
    expect(reserveSettingsUpdatePrompt(recent, "effort:xhigh", 1_001, 500)).toBe(true);
    expect(reserveSettingsUpdatePrompt(recent, "model:gpt-5.6-sol", 1_500, 500)).toBe(true);
  });
});
