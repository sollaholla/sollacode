import {
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationMessage,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderHandoffTurnInput,
  buildProviderHandoffSummary,
  classifyDeferredRecoveryFailure,
  decideDeferredRecoveryOutcome,
  detectProviderUsageLimitExhaustion,
  detectProviderUsageLimitRefusal,
  deriveProviderHandoffContinuity,
  isAccountWideProviderExhaustion,
  isCodexQuotaWindowExhausted,
  isProviderNotice,
  PROVIDER_HANDOFF_MAX_SERIALIZED_CHARS,
  PROVIDER_HANDOFF_TURN_MAX_SERIALIZED_CHARS,
  providerFailoverModelKey,
  resolveUsageLimitFailoverRestore,
  selectProviderFailoverTarget,
  detectProviderUnusableRefusal,
  isAccountWideUnusableRefusal,
} from "./ProviderUsageLimitFailover.ts";
import { DEEPCODE_PROGRESS_TIMEOUT_MESSAGE } from "../provider/deepcodeProtocol.ts";

it("recognizes authoritative DeepSeek billing exhaustion without inferring a reset", () => {
  const driver = ProviderDriverKind.make("deepcode");
  expect(
    detectProviderUsageLimitExhaustion(driver, { is_available: false, balance_infos: [] }),
  ).toEqual({ reason: "insufficient_account_credit", resetsAt: null });
  expect(
    detectProviderUsageLimitExhaustion(driver, { is_available: true, balance_infos: [] }),
  ).toBeNull();
  expect(detectProviderUsageLimitExhaustion(driver, { error: "network failure" })).toBeNull();
});

function provider(input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly model?: string;
  readonly models?: ReadonlyArray<string>;
  readonly accountUsage?: unknown;
  readonly enabled?: boolean;
  readonly installed?: boolean;
  readonly status?: ServerProvider["status"];
  readonly authStatus?: ServerProvider["auth"]["status"];
  readonly capabilitiesBySlug?: Readonly<
    Record<string, NonNullable<ServerProvider["models"][number]["capabilities"]>>
  >;
  readonly usageGuard?: ServerProvider["usageGuard"];
}): ServerProvider {
  const slugs = input.models ?? (input.model === undefined ? [] : [input.model]);
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: input.enabled ?? true,
    installed: input.installed ?? true,
    version: "1.0.0",
    status: input.status ?? "ready",
    auth: { status: input.authStatus ?? "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    ...(input.accountUsage === undefined ? {} : { accountUsage: input.accountUsage }),
    ...(input.usageGuard === undefined ? {} : { usageGuard: input.usageGuard }),
    models: slugs.map((slug, index) => ({
      slug,
      name: slug,
      isCustom: false,
      // Mirrors the registry: only a single-model fixture declares a default,
      // so multi-model Claude fixtures fall through to capability order.
      ...(slugs.length === 1 && index === 0 ? { isDefault: true } : {}),
      capabilities: input.capabilitiesBySlug?.[slug] ?? null,
    })),
    slashCommands: [],
    skills: [],
  };
}

const OPUS_5_CAPABILITIES = {
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select" as const,
      currentValue: "high",
      options: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
        { id: "xhigh", label: "Extra High" },
      ],
    },
  ],
};

const CLAUDE_MODELS = ["claude-fable-5", "claude-opus-5", "claude-opus-4-8", "claude-sonnet-5"];

function claudeFailoverModel(input: {
  readonly accountUsage: unknown;
  readonly nowEpochMs?: number;
}): string | null {
  const target = selectProviderFailoverTarget({
    providers: [
      provider({ instanceId: "codex", driver: "codex", model: "gpt-5.6-sol" }),
      provider({
        instanceId: "claude",
        driver: "claudeAgent",
        models: CLAUDE_MODELS,
        accountUsage: input.accountUsage,
      }),
    ],
    currentInstanceId: ProviderInstanceId.make("codex"),
    currentDriver: ProviderDriverKind.make("codex"),
    ...(input.nowEpochMs === undefined ? {} : { nowEpochMs: input.nowEpochMs }),
  });
  return target?.modelSelection.model ?? null;
}

function message(index: number, text: string): OrchestrationMessage {
  return {
    id: MessageId.make(`message-${index}`),
    role: index % 2 === 0 ? "user" : "assistant",
    text,
    turnId: null,
    streaming: false,
    createdAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    updatedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
  };
}

describe("detectProviderUsageLimitExhaustion", () => {
  it("detects typed Codex and Claude exhaustion but ignores warnings and unsupported providers", () => {
    expect(
      detectProviderUsageLimitExhaustion(ProviderDriverKind.make("codex"), {
        rateLimits: {
          rateLimitReachedType: "rate_limit_reached",
          primary: { usedPercent: 100, resetsAt: 1_800_000_000 },
        },
      }),
    ).toEqual({
      reason: "rate_limit_reached",
      resetsAt: 1_800_000_000,
    });
    expect(
      detectProviderUsageLimitExhaustion(ProviderDriverKind.make("claudeAgent"), {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: 1_800_000_001,
        },
      }),
    ).toEqual({
      reason: "rate_limit_rejected:five_hour",
      resetsAt: 1_800_000_001,
    });
    expect(
      detectProviderUsageLimitExhaustion(ProviderDriverKind.make("claudeAgent"), {
        rate_limit_info: { status: "allowed_warning", utilization: 0.99 },
      }),
    ).toBeNull();
    expect(
      detectProviderUsageLimitExhaustion(ProviderDriverKind.make("cursor"), {
        rate_limit_info: { status: "rejected" },
      }),
    ).toBeNull();
    expect(
      detectProviderUsageLimitExhaustion(ProviderDriverKind.make("grok"), {
        config: {
          creditUsagePercent: 6,
          currentPeriod: { end: "2026-08-22T00:00:00+00:00" },
        },
      }),
    ).toBeNull();
    expect(
      detectProviderUsageLimitExhaustion(ProviderDriverKind.make("grok"), {
        config: {
          creditUsagePercent: 100,
          currentPeriod: { end: "2026-08-22T00:00:00+00:00" },
        },
      }),
    ).toEqual({
      reason: "weekly_usage_pool_exhausted",
      resetsAt: Date.parse("2026-08-22T00:00:00+00:00"),
    });
  });
});

describe("isCodexQuotaWindowExhausted", () => {
  const NOW = Date.parse("2026-01-02T00:00:00.000Z");
  const spentWindow = (overrides: Record<string, unknown> = {}) => ({
    rateLimits: {
      credits: { balance: "0", hasCredits: false, unlimited: false },
      planType: "pro",
      primary: { usedPercent: 100, resetsAt: 1_800_000_000, windowDurationMins: 10080 },
      rateLimitReachedType: null,
      secondary: null,
      spendControlReached: null,
      ...overrides,
    },
  });

  it("reads a spent window with no fallback credit as exhausted", () => {
    expect(isCodexQuotaWindowExhausted(spentWindow(), NOW)).toBe(true);
    expect(
      isCodexQuotaWindowExhausted(
        spentWindow({ primary: null, secondary: { usedPercent: 100, resetsAt: 1_800_000_000 } }),
        NOW,
      ),
    ).toBe(true);
  });

  it("treats fallback credit as still serving past 100%", () => {
    expect(
      isCodexQuotaWindowExhausted(
        spentWindow({ credits: { balance: "0", hasCredits: true, unlimited: false } }),
        NOW,
      ),
    ).toBe(false);
    expect(
      isCodexQuotaWindowExhausted(
        spentWindow({ credits: { balance: "0", hasCredits: false, unlimited: true } }),
        NOW,
      ),
    ).toBe(false);
    expect(
      isCodexQuotaWindowExhausted(
        spentWindow({ credits: { balance: "12.50", hasCredits: false, unlimited: false } }),
        NOW,
      ),
    ).toBe(false);
    // Unknown credit state says nothing and must not move the thread.
    expect(isCodexQuotaWindowExhausted(spentWindow({ credits: null }), NOW)).toBe(false);
    expect(isCodexQuotaWindowExhausted(spentWindow({ credits: undefined }), NOW)).toBe(false);
    expect(
      isCodexQuotaWindowExhausted(
        spentWindow({ credits: { balance: "n/a", hasCredits: false, unlimited: false } }),
        NOW,
      ),
    ).toBe(false);
  });

  it("treats a rolled-over window as stale rather than spent", () => {
    expect(isCodexQuotaWindowExhausted(spentWindow(), Date.parse("2027-06-01T00:00:00.000Z"))).toBe(
      false,
    );
    expect(
      isCodexQuotaWindowExhausted(
        spentWindow({ primary: { usedPercent: 99, resetsAt: 1_800_000_000 } }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe("detectProviderUsageLimitRefusal", () => {
  const NOW = Date.parse("2026-01-02T00:00:00.000Z");
  const CODEX = ProviderDriverKind.make("codex");
  const REFUSAL =
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 19th, 2026 6:19 PM.";
  const spentUsage = {
    rateLimits: {
      credits: { balance: "0", hasCredits: false, unlimited: false },
      primary: { usedPercent: 100, resetsAt: 1_800_000_000 },
      rateLimitReachedType: null,
      secondary: null,
      spendControlReached: null,
    },
  };

  it("detects a Codex refusal corroborated by a spent window", () => {
    expect(detectProviderUsageLimitRefusal(CODEX, REFUSAL, spentUsage, NOW)).toEqual({
      reason: "usage_limit_refused",
      resetsAt: 1_800_000_000,
    });
    // Curly apostrophe variant.
    expect(
      detectProviderUsageLimitRefusal(
        CODEX,
        "You’ve hit your usage limit. Try again later.",
        spentUsage,
        NOW,
      ),
    ).toEqual({ reason: "usage_limit_refused", resetsAt: 1_800_000_000 });
  });

  it("prefers the typed signal when the snapshot already carries it", () => {
    expect(
      detectProviderUsageLimitRefusal(
        CODEX,
        REFUSAL,
        { rateLimits: { ...spentUsage.rateLimits, rateLimitReachedType: "rate_limit_reached" } },
        NOW,
      ),
    ).toEqual({ reason: "rate_limit_reached", resetsAt: 1_800_000_000 });
  });

  it("requires both the refusal text and the spent window", () => {
    // Unrelated failure text must not move the thread, even at 100%.
    expect(
      detectProviderUsageLimitRefusal(CODEX, "Codex process exited unexpectedly.", spentUsage, NOW),
    ).toBeNull();
    // A refusal naming a healthy window is flaky, not exhausted.
    expect(
      detectProviderUsageLimitRefusal(
        CODEX,
        REFUSAL,
        {
          rateLimits: {
            ...spentUsage.rateLimits,
            primary: { usedPercent: 40, resetsAt: 1_800_000_000 },
          },
        },
        NOW,
      ),
    ).toBeNull();
    // Fallback credit keeps serving past the window.
    expect(
      detectProviderUsageLimitRefusal(
        CODEX,
        REFUSAL,
        {
          rateLimits: {
            ...spentUsage.rateLimits,
            credits: { balance: "5", hasCredits: true, unlimited: false },
          },
        },
        NOW,
      ),
    ).toBeNull();
    // Drivers without a refusal shape never match.
    expect(
      detectProviderUsageLimitRefusal(ProviderDriverKind.make("cursor"), REFUSAL, spentUsage, NOW),
    ).toBeNull();
  });

  it("detects an Antigravity 429 with resets from the stored windows", () => {
    const AGY = ProviderDriverKind.make("antigravity");
    const REJECTION =
      "Antigravity was rejected by Google with RESOURCE_EXHAUSTED (429). Check the account quota or switch accounts before retrying.";
    const usage = {
      windows: [
        {
          key: "gemini",
          family: "gemini",
          label: "Gemini",
          remainingPercent: 60,
          usedPercent: 40,
          resetsAt: "2026-09-11T18:00:00Z",
          windowDurationMs: null,
        },
        {
          key: "claude-gpt",
          family: "claude-gpt",
          label: "Claude and GPT",
          remainingPercent: 0,
          usedPercent: 100,
          resetsAt: "2026-09-12T18:00:00Z",
          windowDurationMs: null,
        },
      ],
    };
    expect(
      detectProviderUsageLimitRefusal(AGY, REJECTION, usage, Date.parse("2026-09-10T18:00:00Z")),
    ).toEqual({
      reason: "resource_exhausted",
      resetsAt: Date.parse("2026-09-12T18:00:00Z"),
    });
    // No probe yet: the rejection is positive evidence on its own, with no
    // known reset.
    expect(detectProviderUsageLimitRefusal(AGY, REJECTION, undefined, NOW)).toEqual({
      reason: "resource_exhausted",
      resetsAt: null,
    });
    // Stale windows cannot date the restore, but never block the move.
    expect(
      detectProviderUsageLimitRefusal(
        AGY,
        REJECTION,
        {
          windows: [
            {
              key: "gemini",
              family: "gemini",
              label: "Gemini",
              remainingPercent: 0,
              usedPercent: 100,
              resetsAt: "2026-09-09T18:00:00Z",
              windowDurationMs: null,
            },
          ],
        },
        Date.parse("2026-09-10T18:00:00Z"),
      ),
    ).toEqual({ reason: "resource_exhausted", resetsAt: null });
    expect(
      detectProviderUsageLimitRefusal(AGY, "Run: attempt 1 failed (boom)", usage, NOW),
    ).toBeNull();
  });

  it("detects a Claude rejection that arrives as text when the snapshot agrees", () => {
    const CLAUDE = ProviderDriverKind.make("claudeAgent");
    const REFUSAL_TEXT = "You've hit your session limit · resets 6pm (America/New_York)";
    // The typed signal wins when the snapshot already carries it.
    expect(
      detectProviderUsageLimitRefusal(
        CLAUDE,
        REFUSAL_TEXT,
        {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "rejected",
            rateLimitType: "five_hour",
            resetsAt: 1_800_000_001,
          },
        },
        NOW,
      ),
    ).toEqual({ reason: "rate_limit_rejected:five_hour", resetsAt: 1_800_000_001 });
    // Otherwise a spent unexpired window corroborates the text.
    expect(
      detectProviderUsageLimitRefusal(
        CLAUDE,
        REFUSAL_TEXT,
        {
          rate_limits: {
            sonnet: { utilization: 100, resets_at: 1_800_000_000 },
          },
        },
        NOW,
      ),
    ).toEqual({ reason: "rate_limit_window_exhausted:sonnet", resetsAt: 1_800_000_000_000 });
    // A healthy snapshot means the text is stale noise, not a stop.
    expect(
      detectProviderUsageLimitRefusal(
        CLAUDE,
        REFUSAL_TEXT,
        {
          rate_limits: {
            sonnet: { utilization: 40, resets_at: 1_800_000_000 },
          },
        },
        NOW,
      ),
    ).toBeNull();
    expect(
      detectProviderUsageLimitRefusal(CLAUDE, "Something unrelated broke.", undefined, NOW),
    ).toBeNull();
  });

  it("detects a Deep Code stall marker with no quota snapshot to corroborate it", () => {
    const DEEPCODE = ProviderDriverKind.make("deepcode");
    expect(
      detectProviderUsageLimitRefusal(DEEPCODE, DEEPCODE_PROGRESS_TIMEOUT_MESSAGE, undefined, NOW),
    ).toEqual({ reason: "upstream_stalled", resetsAt: NOW + 30 * 60 * 1000 });
    // No clock, no restore date — but the move still happens.
    expect(
      detectProviderUsageLimitRefusal(DEEPCODE, DEEPCODE_PROGRESS_TIMEOUT_MESSAGE, undefined, null),
    ).toEqual({ reason: "upstream_stalled", resetsAt: null });
    // Anything but the exact marker is an ordinary failure.
    expect(
      detectProviderUsageLimitRefusal(
        DEEPCODE,
        "Deep Code exited 1 without a successful terminal result.",
        undefined,
        NOW,
      ),
    ).toBeNull();
    expect(
      detectProviderUsageLimitRefusal(CODEX, DEEPCODE_PROGRESS_TIMEOUT_MESSAGE, undefined, NOW),
    ).toBeNull();
  });
});

describe("selectProviderFailoverTarget", () => {
  it("prefers an eligible different driver in registry order and skips exhausted or unusable instances", () => {
    const target = selectProviderFailoverTarget({
      providers: [
        provider({ instanceId: "codex", driver: "codex", model: "gpt-5" }),
        provider({ instanceId: "codex_work", driver: "codex", model: "gpt-5" }),
        provider({
          instanceId: "claude_disabled",
          driver: "claudeAgent",
          model: "claude-opus",
          enabled: false,
        }),
        provider({
          instanceId: "cursor_logged_out",
          driver: "cursor",
          model: "composer",
          authStatus: "unauthenticated",
        }),
        provider({ instanceId: "claude", driver: "claudeAgent", model: "claude-sonnet" }),
        provider({ instanceId: "grok", driver: "grok", model: "grok-code" }),
      ],
      currentInstanceId: ProviderInstanceId.make("codex"),
      currentDriver: ProviderDriverKind.make("codex"),
      excludedInstanceIds: new Set(["grok"]),
    });

    expect(target).toEqual({
      instanceId: ProviderInstanceId.make("claude"),
      driver: ProviderDriverKind.make("claudeAgent"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claude"),
        model: "claude-sonnet",
      },
    });
  });

  it("falls back to another instance of the same driver", () => {
    expect(
      selectProviderFailoverTarget({
        providers: [
          provider({ instanceId: "codex", driver: "codex", model: "gpt-5" }),
          provider({ instanceId: "codex_work", driver: "codex", model: "gpt-5-mini" }),
        ],
        currentInstanceId: ProviderInstanceId.make("codex"),
        currentDriver: ProviderDriverKind.make("codex"),
      }),
    ).toMatchObject({
      instanceId: ProviderInstanceId.make("codex_work"),
      driver: ProviderDriverKind.make("codex"),
    });
  });

  it("skips a Codex instance whose window is spent even without a typed refusal signal", () => {
    // Codex refused turns on 2026-09-14 while its snapshot still read
    // `rateLimitReachedType: null`; handing a thread to that instance just
    // moves the refusal. The spent window with no fallback credit screens it.
    const spentCodexUsage = {
      rateLimits: {
        credits: { balance: "0", hasCredits: false, unlimited: false },
        primary: { usedPercent: 100, resetsAt: 1_800_000_000 },
        rateLimitReachedType: null,
        secondary: null,
        spendControlReached: null,
      },
    };
    const nowEpochMs = Date.parse("2026-01-02T00:00:00.000Z");
    expect(
      selectProviderFailoverTarget({
        providers: [
          provider({ instanceId: "claude", driver: "claudeAgent", model: "claude-sonnet" }),
          provider({
            instanceId: "codex",
            driver: "codex",
            model: "gpt-5",
            accountUsage: spentCodexUsage,
          }),
        ],
        currentInstanceId: ProviderInstanceId.make("claude"),
        currentDriver: ProviderDriverKind.make("claudeAgent"),
        nowEpochMs,
      }),
    ).toBeNull();
    expect(
      selectProviderFailoverTarget({
        providers: [
          provider({ instanceId: "claude", driver: "claudeAgent", model: "claude-sonnet" }),
          provider({
            instanceId: "codex",
            driver: "codex",
            model: "gpt-5",
            accountUsage: {
              rateLimits: {
                ...spentCodexUsage.rateLimits,
                primary: { usedPercent: 40, resetsAt: 1_800_000_000 },
              },
            },
          }),
        ],
        currentInstanceId: ProviderInstanceId.make("claude"),
        currentDriver: ProviderDriverKind.make("claudeAgent"),
        nowEpochMs,
      }),
    ).toMatchObject({ instanceId: ProviderInstanceId.make("codex") });
  });
});

describe("selectProviderFailoverTarget with Claude model quotas", () => {
  it("keeps the highest Claude model when no model-scoped quota is spent", () => {
    expect(claudeFailoverModel({ accountUsage: undefined })).toBe("claude-fable-5");
    expect(
      claudeFailoverModel({
        accountUsage: {
          rate_limits: {
            seven_day: { utilization: 41, resets_at: "2026-01-08T00:00:00.000Z" },
            seven_day_fable: { utilization: 99.4, resets_at: "2026-01-08T00:00:00.000Z" },
          },
        },
      }),
    ).toBe("claude-fable-5");
  });

  it("skips Fable for the next-highest Claude model when the Fable window is spent", () => {
    expect(
      claudeFailoverModel({
        accountUsage: {
          rate_limits: {
            seven_day: { utilization: 60, resets_at: "2026-01-08T00:00:00.000Z" },
            seven_day_fable: { utilization: 100, resets_at: "2026-01-08T00:00:00.000Z" },
          },
        },
        nowEpochMs: Date.parse("2026-01-02T00:00:00.000Z"),
      }),
    ).toBe("claude-opus-5");
  });

  it("reads the model-scoped and generic limit shapes Claude Code also reports", () => {
    expect(
      claudeFailoverModel({
        accountUsage: {
          rate_limits: {
            model_scoped: [{ display_name: "Fable 5", utilization: 100, resets_at: null }],
          },
        },
      }),
    ).toBe("claude-opus-5");
    expect(
      claudeFailoverModel({
        accountUsage: {
          rate_limits: {
            limits: [{ scope: { model: { display_name: "Fable 5" } }, percent: 100 }],
          },
        },
      }),
    ).toBe("claude-opus-5");
  });

  it("skips Fable when the extra-usage credit pool is depleted", () => {
    expect(
      claudeFailoverModel({
        accountUsage: {
          rate_limits: {
            extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 50 },
          },
        },
      }),
    ).toBe("claude-opus-5");
    expect(
      claudeFailoverModel({
        accountUsage: {
          rate_limits: {
            extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 12 },
          },
        },
      }),
    ).toBe("claude-fable-5");
  });

  it("advances past every spent Claude family and treats reset windows as usable", () => {
    const accountUsage = {
      rate_limits: {
        seven_day_fable: { utilization: 100, resets_at: "2026-01-08T00:00:00.000Z" },
        seven_day_opus: { utilization: 100, resets_at: "2026-01-08T00:00:00.000Z" },
      },
    };
    expect(
      claudeFailoverModel({
        accountUsage,
        nowEpochMs: Date.parse("2026-01-02T00:00:00.000Z"),
      }),
    ).toBe("claude-sonnet-5");
    // A cached snapshot whose windows already rolled over is stale, not spent.
    expect(
      claudeFailoverModel({
        accountUsage,
        nowEpochMs: Date.parse("2026-01-09T00:00:00.000Z"),
      }),
    ).toBe("claude-fable-5");
  });

  it("passes over a Claude instance with no usable model instead of ending the search", () => {
    const target = selectProviderFailoverTarget({
      providers: [
        provider({ instanceId: "codex", driver: "codex", model: "gpt-5.6-sol" }),
        provider({
          instanceId: "claude",
          driver: "claudeAgent",
          models: ["claude-fable-5"],
          accountUsage: { rate_limits: { seven_day_fable: { utilization: 100, resets_at: null } } },
        }),
        provider({ instanceId: "grok", driver: "grok", model: "grok-code" }),
      ],
      currentInstanceId: ProviderInstanceId.make("codex"),
      currentDriver: ProviderDriverKind.make("codex"),
    });

    expect(target).toMatchObject({
      instanceId: ProviderInstanceId.make("grok"),
      modelSelection: { model: "grok-code" },
    });
  });
});

describe("selectProviderFailoverTarget same-instance Claude models", () => {
  const enabledProviders = () => [
    provider({ instanceId: "codex", driver: "codex", model: "gpt-5.6-sol" }),
    provider({
      instanceId: "claude",
      driver: "claudeAgent",
      models: CLAUDE_MODELS,
      capabilitiesBySlug: { "claude-opus-5": OPUS_5_CAPABILITIES },
    }),
    provider({ instanceId: "grok", driver: "grok", model: "grok-code" }),
  ];

  it("stays on Claude Opus 5 High when Fable is the exhausted current model", () => {
    const target = selectProviderFailoverTarget({
      providers: enabledProviders(),
      currentInstanceId: ProviderInstanceId.make("claude"),
      currentDriver: ProviderDriverKind.make("claudeAgent"),
      currentModel: "claude-fable-5",
    });

    expect(target).toMatchObject({
      instanceId: ProviderInstanceId.make("claude"),
      driver: ProviderDriverKind.make("claudeAgent"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claude"),
        model: "claude-opus-5",
        options: [{ id: "effort", value: "high" }],
      },
    });
  });

  it("skips Fable from a live rate-limit snapshot and still picks Opus 5", () => {
    const target = selectProviderFailoverTarget({
      providers: [
        provider({ instanceId: "codex", driver: "codex", model: "gpt-5.6-sol" }),
        provider({
          instanceId: "claude",
          driver: "claudeAgent",
          models: CLAUDE_MODELS,
          accountUsage: {
            type: "rate_limit_event",
            rate_limit_info: { status: "rejected", rateLimitType: "seven_day_fable" },
          },
        }),
      ],
      currentInstanceId: ProviderInstanceId.make("claude"),
      currentDriver: ProviderDriverKind.make("claudeAgent"),
      currentModel: "claude-fable-5",
    });

    expect(target?.modelSelection.model).toBe("claude-opus-5");
  });

  it("leaves Claude for the next enabled provider after every Claude model is spent", () => {
    const target = selectProviderFailoverTarget({
      providers: enabledProviders(),
      currentInstanceId: ProviderInstanceId.make("claude"),
      currentDriver: ProviderDriverKind.make("claudeAgent"),
      currentModel: "claude-sonnet-5",
      excludedModels: new Set(
        CLAUDE_MODELS.map((model) => providerFailoverModelKey("claude", model)),
      ),
    });

    expect(target).toMatchObject({
      instanceId: ProviderInstanceId.make("codex"),
      modelSelection: { model: "gpt-5.6-sol" },
    });
  });

  it("walks remaining enabled providers then returns null", () => {
    const providers = enabledProviders();
    const afterClaude = selectProviderFailoverTarget({
      providers,
      currentInstanceId: ProviderInstanceId.make("codex"),
      currentDriver: ProviderDriverKind.make("codex"),
      currentModel: "gpt-5.6-sol",
      excludedInstanceIds: new Set(["claude"]),
    });
    expect(afterClaude?.instanceId).toBe("grok");

    expect(
      selectProviderFailoverTarget({
        providers,
        currentInstanceId: ProviderInstanceId.make("grok"),
        currentDriver: ProviderDriverKind.make("grok"),
        currentModel: "grok-code",
        excludedInstanceIds: new Set(["claude", "codex"]),
      }),
    ).toBeNull();
  });

  it("treats a Claude five-hour rejection as account-wide and skips remaining Claude models", () => {
    const target = selectProviderFailoverTarget({
      providers: [
        provider({ instanceId: "codex", driver: "codex", model: "gpt-5.6-sol" }),
        provider({
          instanceId: "claude",
          driver: "claudeAgent",
          models: CLAUDE_MODELS,
          accountUsage: {
            type: "rate_limit_event",
            rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
          },
        }),
      ],
      currentInstanceId: ProviderInstanceId.make("claude"),
      currentDriver: ProviderDriverKind.make("claudeAgent"),
      currentModel: "claude-fable-5",
    });

    expect(target?.instanceId).toBe("codex");
  });
});

describe("selectProviderFailoverTarget with partial provider configs", () => {
  function walkFailover(input: {
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly currentInstanceId: string;
    readonly currentDriver: string;
    readonly currentModel: string;
  }): ReadonlyArray<string> {
    const excludedInstances = new Set<string>();
    const excludedModels = new Set<string>();
    const hops: string[] = [];
    let currentInstanceId = ProviderInstanceId.make(input.currentInstanceId);
    let currentDriver = ProviderDriverKind.make(input.currentDriver);
    let currentModel = input.currentModel;

    for (let step = 0; step < 16; step += 1) {
      excludedModels.add(providerFailoverModelKey(currentInstanceId, currentModel));
      const target = selectProviderFailoverTarget({
        providers: input.providers,
        currentInstanceId,
        currentDriver,
        currentModel,
        excludedInstanceIds: excludedInstances,
        excludedModels,
      });
      if (!target) {
        return hops;
      }
      hops.push(`${String(target.instanceId)}:${target.modelSelection.model}`);
      if (target.instanceId !== currentInstanceId) {
        excludedInstances.add(String(currentInstanceId));
      }
      currentInstanceId = target.instanceId;
      currentDriver = target.driver;
      currentModel = target.modelSelection.model;
    }
    throw new Error("failover walk did not stop after the last enabled provider");
  }

  it("does not require Grok or Claude to be configured", () => {
    expect(
      walkFailover({
        providers: [
          provider({ instanceId: "codex", driver: "codex", model: "gpt-5.6-sol" }),
          provider({ instanceId: "cursor", driver: "cursor", model: "composer" }),
        ],
        currentInstanceId: "codex",
        currentDriver: "codex",
        currentModel: "gpt-5.6-sol",
      }),
    ).toEqual(["cursor:composer"]);
  });

  it("skips disabled or logged-out providers and uses the next enabled one", () => {
    expect(
      walkFailover({
        providers: [
          provider({ instanceId: "codex", driver: "codex", model: "gpt-5.6-sol" }),
          provider({
            instanceId: "claude",
            driver: "claudeAgent",
            model: "claude-fable-5",
            enabled: false,
          }),
          provider({
            instanceId: "grok",
            driver: "grok",
            model: "grok-code",
            authStatus: "unauthenticated",
          }),
          provider({ instanceId: "opencode", driver: "opencode", model: "opencode-model" }),
        ],
        currentInstanceId: "codex",
        currentDriver: "codex",
        currentModel: "gpt-5.6-sol",
      }),
    ).toEqual(["opencode:opencode-model"]);
  });

  it("still uses Opus 5 High when Grok is absent, then the remaining enabled providers", () => {
    expect(
      walkFailover({
        providers: [
          provider({
            instanceId: "claude",
            driver: "claudeAgent",
            models: ["claude-fable-5", "claude-opus-5"],
            capabilitiesBySlug: { "claude-opus-5": OPUS_5_CAPABILITIES },
          }),
          provider({ instanceId: "codex", driver: "codex", model: "gpt-5.6-sol" }),
          provider({ instanceId: "cursor", driver: "cursor", model: "composer", enabled: false }),
        ],
        currentInstanceId: "claude",
        currentDriver: "claudeAgent",
        currentModel: "claude-fable-5",
      }),
    ).toEqual(["claude:claude-opus-5", "codex:gpt-5.6-sol"]);
  });

  it("stops when the current provider is the only enabled one", () => {
    expect(
      walkFailover({
        providers: [provider({ instanceId: "codex", driver: "codex", model: "gpt-5.6-sol" })],
        currentInstanceId: "codex",
        currentDriver: "codex",
        currentModel: "gpt-5.6-sol",
      }),
    ).toEqual([]);
  });
});

describe("classifyDeferredRecoveryFailure", () => {
  const NOW = Date.parse("2026-01-02T00:00:00.000Z");
  const codexSpentUsage = {
    rateLimits: {
      credits: { balance: "0", hasCredits: false, unlimited: false },
      primary: { usedPercent: 100, resetsAt: 1_800_000_000 },
      rateLimitReachedType: null,
      secondary: null,
      spendControlReached: null,
    },
  };

  it("classifies exhaustion, silent retries, and ordinary failures", () => {
    expect(
      classifyDeferredRecoveryFailure({
        driver: ProviderDriverKind.make("codex"),
        message: "You've hit your usage limit. Try again later.",
        accountUsage: codexSpentUsage,
        nowEpochMs: NOW,
      }),
    ).toBe("usage-exhaustion");
    expect(
      classifyDeferredRecoveryFailure({
        driver: ProviderDriverKind.make("antigravity"),
        message: "Antigravity was rejected by Google with RESOURCE_EXHAUSTED (429).",
        accountUsage: undefined,
        nowEpochMs: NOW,
      }),
    ).toBe("usage-exhaustion");
    expect(
      classifyDeferredRecoveryFailure({
        driver: ProviderDriverKind.make("deepcode"),
        message: DEEPCODE_PROGRESS_TIMEOUT_MESSAGE,
        accountUsage: undefined,
        nowEpochMs: NOW,
      }),
    ).toBe("usage-exhaustion");
    expect(
      classifyDeferredRecoveryFailure({
        driver: ProviderDriverKind.make("deepcode"),
        message: "Execution failed: HTTP 400: This model's maximum context length is 100 tokens.",
        accountUsage: undefined,
        nowEpochMs: NOW,
      }),
    ).toBe("context-overflow-retry");
    expect(
      classifyDeferredRecoveryFailure({
        driver: ProviderDriverKind.make("muse"),
        message: "[muse-progress-timeout] Muse stopped reporting progress.",
        accountUsage: undefined,
        nowEpochMs: NOW,
      }),
    ).toBe("progress-timeout-retry");
    // The finished-but-unverified delivery resumes to recover its saved
    // response; the failure stays silent unless recovery gives up.
    for (const message of [
      "[muse-progress-timeout] Muse finished, but delivery of its final reply could not be verified. Resume to recover the saved response.",
      "[muse-progress-timeout] Muse finished, but delivery of its final reply could not be verified and its host exit could not be confirmed. Check the host before resuming.",
    ]) {
      expect(
        classifyDeferredRecoveryFailure({
          driver: ProviderDriverKind.make("muse"),
          message,
          accountUsage: undefined,
          nowEpochMs: NOW,
        }),
      ).toBe("progress-timeout-retry");
    }
    // Uncorroborated text and ordinary failures fall through.
    expect(
      classifyDeferredRecoveryFailure({
        driver: ProviderDriverKind.make("codex"),
        message: "You've hit your usage limit. Try again later.",
        accountUsage: undefined,
        nowEpochMs: NOW,
      }),
    ).toBeNull();
    expect(
      classifyDeferredRecoveryFailure({
        driver: ProviderDriverKind.make("codex"),
        message: "Codex process exited unexpectedly.",
        accountUsage: codexSpentUsage,
        nowEpochMs: NOW,
      }),
    ).toBeNull();
  });
});

describe("decideDeferredRecoveryOutcome", () => {
  const CAPS = { maxAttempts: 8, silentRetryMaxAttempts: 2 };
  const target = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "sonnet" },
  };

  it("retries while recovery is live and records exactly once when it gives up", () => {
    expect(decideDeferredRecoveryOutcome({ kind: "exhaustion", target }, 1, CAPS)).toBe("retry");
    expect(decideDeferredRecoveryOutcome({ kind: "exhaustion", target }, 8, CAPS)).toBe(
      "record-and-cancel",
    );
    expect(decideDeferredRecoveryOutcome({ kind: "exhaustion", target: null }, 1, CAPS)).toBe(
      "record-and-cancel",
    );
    expect(decideDeferredRecoveryOutcome({ kind: "silent-retry" }, 1, CAPS)).toBe("retry");
    expect(decideDeferredRecoveryOutcome({ kind: "silent-retry" }, 2, CAPS)).toBe(
      "record-and-cancel",
    );
    expect(decideDeferredRecoveryOutcome(null, 1, CAPS)).toBe("fall-through");
  });
});

describe("isAccountWideProviderExhaustion", () => {
  it("keeps Claude Fable rejections on the same instance and treats shared windows as account-wide", () => {
    expect(
      isAccountWideProviderExhaustion(ProviderDriverKind.make("claudeAgent"), {
        reason: "rate_limit_rejected:seven_day_fable",
        resetsAt: null,
      }),
    ).toBe(false);
    expect(
      isAccountWideProviderExhaustion(ProviderDriverKind.make("claudeAgent"), {
        reason: "rate_limit_rejected:five_hour",
        resetsAt: null,
      }),
    ).toBe(true);
    expect(
      isAccountWideProviderExhaustion(ProviderDriverKind.make("codex"), {
        reason: "rate_limit_reached",
        resetsAt: null,
      }),
    ).toBe(true);
    // A stall leaves Deep Code for another provider; it never retries in place.
    expect(
      isAccountWideProviderExhaustion(ProviderDriverKind.make("deepcode"), {
        reason: "upstream_stalled",
        resetsAt: null,
      }),
    ).toBe(true);
  });

  it("keeps Antigravity eligible while any family pool still has quota", () => {
    const AGY = ProviderDriverKind.make("antigravity");
    const exhaustion = { reason: "resource_exhausted", resetsAt: null };
    const now = Date.parse("2026-09-10T18:00:00Z");
    const window = (family: string, remainingPercent: number, resetsAt: string | null) => ({
      key: family,
      family,
      label: family,
      remainingPercent,
      usedPercent: 100 - remainingPercent,
      resetsAt,
      windowDurationMs: null,
    });
    // One dead pool: same instance stays eligible for the surviving family.
    expect(
      isAccountWideProviderExhaustion(
        AGY,
        exhaustion,
        {
          windows: [
            window("gemini", 60, "2026-09-11T18:00:00Z"),
            window("claude-gpt", 0, "2026-09-11T18:00:00Z"),
          ],
        },
        now,
      ),
    ).toBe(false);
    // Every known pool spent: the instance is out.
    expect(
      isAccountWideProviderExhaustion(
        AGY,
        exhaustion,
        {
          windows: [
            window("gemini", 0, "2026-09-11T18:00:00Z"),
            window("claude-gpt", 0, "2026-09-11T18:00:00Z"),
          ],
        },
        now,
      ),
    ).toBe(true);
    // No probe yet: stay eligible and let the per-model exclusions converge.
    expect(isAccountWideProviderExhaustion(AGY, exhaustion, undefined, now)).toBe(false);
  });
});

describe("deriveProviderHandoffContinuity", () => {
  it("looks past the refusal that caused the handoff", () => {
    // Live 2026-09-02: the outgoing provider's last two messages were both
    // notices, so the digest reported an error string as the work in flight
    // and never named the half-finished change the thread was actually on.
    const messages = [
      message(0, "Fix the recovery ladder."),
      message(1, "Assessed recovery behavior. I am adding the regressions now."),
      // Odd indices are the assistant in this fixture: both notices are the
      // outgoing provider talking, not the user.
      message(3, "Too many concurrent requests"),
      message(
        5,
        "Our systems have detected unusual activity coming from your system. Please try again later.",
      ),
    ];

    expect(deriveProviderHandoffContinuity(messages)).toEqual({
      immediateRequirement: "Fix the recovery ladder.",
      inProgressWork: "Assessed recovery behavior. I am adding the regressions now.",
    });
  });

  it("says nothing rather than pass a refusal off as work", () => {
    const messages = [
      message(0, "Fix the recovery ladder."),
      message(1, "You've reached your usage limit."),
    ];

    expect(deriveProviderHandoffContinuity(messages).inProgressWork).toBe(null);
  });

  it("recognises a provider notice without swallowing real work", () => {
    for (const notice of [
      "Too many concurrent requests",
      "Our systems have detected unusual activity coming from your system.",
      "Please try again later.",
      "You are being rate limited.",
      DEEPCODE_PROGRESS_TIMEOUT_MESSAGE,
      "   ",
    ]) {
      expect(isProviderNotice(notice)).toBe(true);
    }
    for (const work of [
      "I am tracing visualViewport and scroll ownership now.",
      "The suite is green; I am writing the changelog entry.",
      "Rate limiting the retry loop is the next change I will make.",
    ]) {
      expect(isProviderNotice(work)).toBe(false);
    }
  });
});

describe("buildProviderHandoffSummary", () => {
  it("calls out the latest user requirement and active assistant work", () => {
    const messages = [
      message(0, "Keep the mobile composer anchored."),
      message(1, "I am tracing visualViewport and scroll ownership now."),
    ];

    expect(deriveProviderHandoffContinuity(messages)).toEqual({
      immediateRequirement: "Keep the mobile composer anchored.",
      inProgressWork: "I am tracing visualViewport and scroll ownership now.",
    });

    const decoded = JSON.parse(
      buildProviderHandoffSummary({
        threadId: ThreadId.make("thread-continuity"),
        threadTitle: "Mobile composer",
        messages,
        from: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          driver: ProviderDriverKind.make("claudeAgent"),
        },
        to: {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6",
          },
        },
        exhaustion: { reason: "manual_provider_switch", resetsAt: null },
        generatedAt: "2026-01-01T00:01:00.000Z",
      }),
    ) as {
      continuity?: { immediateRequirement?: string; inProgressWork?: string };
    };

    expect(decoded.continuity).toEqual({
      immediateRequirement: "Keep the mobile composer anchored.",
      inProgressWork: "I am tracing visualViewport and scroll ownership now.",
    });
  });

  it("names the history tool only for a target that mounts the t3-code MCP server", () => {
    // Live 2026-09-10: a Deep Code handoff named
    // mcp__t3-code__thread_history_query even though the Deep Code adapter
    // never mounts the server, so the model stalled on a tool it could not call
    // instead of working from the digest and the workspace.
    const messages = [message(0, "Keep the mobile composer anchored.")];
    const instructionFor = (driver: string): string => {
      const decoded = JSON.parse(
        buildProviderHandoffSummary({
          threadId: ThreadId.make("thread-handoff-tool"),
          threadTitle: "Handoff tool",
          messages,
          from: {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
          },
          to: {
            instanceId: ProviderInstanceId.make(driver),
            driver: ProviderDriverKind.make(driver),
            modelSelection: {
              instanceId: ProviderInstanceId.make(driver),
              model: "test-model",
            },
          },
          exhaustion: { reason: "manual_provider_switch", resetsAt: null },
          generatedAt: "2026-01-01T00:01:00.000Z",
        }),
      ) as { instruction: string };
      return decoded.instruction;
    };

    expect(instructionFor("codex")).toContain("mcp__t3-code__thread_history_query");

    const deepcode = instructionFor("deepcode");
    expect(deepcode).not.toContain("mcp__t3-code__thread_history_query");
    expect(deepcode).toContain("workspace is the record you can inspect");
    expect(deepcode).toContain("do not report yourself blocked");
    expect(deepcode).not.toContain("Do not repeat completed work");
  });

  it("always emits valid JSON within the hard serialized cap", () => {
    const messages = Array.from({ length: 50 }, (_, index) =>
      message(index, `${"\u0000".repeat(2_500)}-${index}`),
    );
    const serialized = buildProviderHandoffSummary({
      threadId: ThreadId.make("thread-1"),
      threadTitle: "Long context",
      messages,
      from: {
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
      },
      to: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: ProviderDriverKind.make("claudeAgent"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet",
        },
      },
      exhaustion: {
        reason: "rate_limit_reached",
        resetsAt: 1_800_000_000,
      },
      generatedAt: "2026-01-01T00:01:00.000Z",
    });

    expect(serialized.length).toBeLessThanOrEqual(PROVIDER_HANDOFF_MAX_SERIALIZED_CHARS);
    const decoded = JSON.parse(serialized) as {
      kind: string;
      history: {
        includedMessages: number;
        omittedMessages: number;
        messages: ReadonlyArray<{ id: string }>;
      };
    };
    expect(decoded.kind).toBe("t3.provider-handoff");
    expect(decoded.history.includedMessages).toBe(decoded.history.messages.length);
    expect(decoded.history.includedMessages + decoded.history.omittedMessages).toBe(50);
    expect(decoded.history.messages.at(-1)?.id).toBe("message-49");
  });

  it("wraps the bounded summary and current request in one valid JSON handoff turn", () => {
    const summary = buildProviderHandoffSummary({
      threadId: ThreadId.make("thread-existing"),
      threadTitle: "Existing thread",
      messages: [message(1, "Earlier context")],
      from: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: ProviderDriverKind.make("claudeAgent"),
      },
      to: {
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
      },
      exhaustion: {
        reason: "manual_provider_switch",
        resetsAt: null,
      },
      generatedAt: "2026-01-01T00:01:00.000Z",
    });

    const decoded = JSON.parse(
      buildProviderHandoffTurnInput({
        summary,
        currentRequest: "Continue with Codex.",
      }),
    ) as {
      kind: string;
      context: { kind: string; handoff: { reason: string } };
      currentRequest: string;
    };

    expect(decoded.kind).toBe("t3.provider-handoff-turn");
    expect(decoded.context.kind).toBe("t3.provider-handoff");
    expect(decoded.context.handoff.reason).toBe("manual_provider_switch");
    expect(decoded.currentRequest).toBe("Continue with Codex.");
  });

  it("keeps the complete handoff turn inside the provider input limit", () => {
    const summary = buildProviderHandoffSummary({
      threadId: ThreadId.make("thread-large-request"),
      threadTitle: "Large request",
      messages: [message(1, "Earlier context")],
      from: {
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
      },
      to: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: ProviderDriverKind.make("claudeAgent"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus",
        },
      },
      exhaustion: { reason: "manual_provider_switch", resetsAt: null },
      generatedAt: "2026-01-01T00:01:00.000Z",
    });

    const serialized = buildProviderHandoffTurnInput({
      summary,
      // Control characters expand sixfold when JSON encoded, so a source-text
      // slice alone cannot prove the serialized contract is respected.
      currentRequest: "\u0000".repeat(PROVIDER_HANDOFF_TURN_MAX_SERIALIZED_CHARS),
    });
    const decoded = JSON.parse(serialized) as { currentRequest: string };

    expect(serialized.length).toBeLessThanOrEqual(PROVIDER_HANDOFF_TURN_MAX_SERIALIZED_CHARS);
    expect(decoded.currentRequest).toContain("Request truncated for provider transport");
  });

  it("unwraps a persisted handoff turn instead of nesting it again", () => {
    const summary = buildProviderHandoffSummary({
      threadId: ThreadId.make("thread-retried-switch"),
      threadTitle: "Retried switch",
      messages: [],
      from: {
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
      },
      to: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: ProviderDriverKind.make("claudeAgent"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus",
        },
      },
      exhaustion: { reason: "manual_provider_switch", resetsAt: null },
      generatedAt: "2026-01-01T00:01:00.000Z",
    });
    const previousEnvelope = buildProviderHandoffTurnInput({
      summary,
      currentRequest: "Please proceed with Claude.",
    });
    const retried = JSON.parse(
      buildProviderHandoffTurnInput({ summary, currentRequest: previousEnvelope }),
    ) as { currentRequest: string };

    expect(retried.currentRequest).toBe("Please proceed with Claude.");
  });
});

describe("selectProviderFailoverTarget account-level exhaustion", () => {
  const NOW = Date.parse("2026-08-06T21:19:17.000Z");
  const codexExhausted = {
    rateLimits: {
      primary: { usedPercent: 100, resetsAt: Math.floor(Date.parse("2026-08-08T00:53:00.000Z")) },
      rateLimitReachedType: "weekly",
    },
  };

  it("skips a Codex candidate whose own usage snapshot is already spent", () => {
    // The 2026-08-06 regression: Claude hit its five-hour window, failover chose
    // Codex, and Codex rejected the replacement turn seven seconds later.
    const target = selectProviderFailoverTarget({
      providers: [
        provider({ instanceId: "claude", driver: "claudeAgent", model: "claude-opus-5" }),
        provider({
          instanceId: "codex",
          driver: "codex",
          model: "gpt-5.6-sol",
          accountUsage: codexExhausted,
        }),
        provider({ instanceId: "grok", driver: "grok", model: "grok-5" }),
      ],
      currentInstanceId: ProviderInstanceId.make("claude"),
      currentDriver: ProviderDriverKind.make("claudeAgent"),
      nowEpochMs: NOW,
    });
    expect(target?.instanceId).toBe("grok");
  });

  it("returns null when every candidate is out of quota", () => {
    expect(
      selectProviderFailoverTarget({
        providers: [
          provider({ instanceId: "claude", driver: "claudeAgent", model: "claude-opus-5" }),
          provider({
            instanceId: "codex",
            driver: "codex",
            model: "gpt-5.6-sol",
            accountUsage: codexExhausted,
          }),
        ],
        currentInstanceId: ProviderInstanceId.make("claude"),
        currentDriver: ProviderDriverKind.make("claudeAgent"),
        nowEpochMs: NOW,
      }),
    ).toBeNull();
  });

  it("still uses a Codex candidate whose window has already reset", () => {
    const target = selectProviderFailoverTarget({
      providers: [
        provider({ instanceId: "claude", driver: "claudeAgent", model: "claude-opus-5" }),
        provider({
          instanceId: "codex",
          driver: "codex",
          model: "gpt-5.6-sol",
          accountUsage: codexExhausted,
        }),
      ],
      currentInstanceId: ProviderInstanceId.make("claude"),
      currentDriver: ProviderDriverKind.make("claudeAgent"),
      nowEpochMs: Date.parse("2026-08-09T00:00:00.000Z"),
    });
    expect(target?.instanceId).toBe("codex");
  });

  it("uses a Codex candidate with no usage snapshot at all", () => {
    const target = selectProviderFailoverTarget({
      providers: [
        provider({ instanceId: "claude", driver: "claudeAgent", model: "claude-opus-5" }),
        provider({ instanceId: "codex", driver: "codex", model: "gpt-5.6-sol" }),
      ],
      currentInstanceId: ProviderInstanceId.make("claude"),
      currentDriver: ProviderDriverKind.make("claudeAgent"),
      nowEpochMs: NOW,
    });
    expect(target?.instanceId).toBe("codex");
  });
});

describe("resolveUsageLimitFailoverRestore", () => {
  const claude = provider({
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    models: ["claude-fable-5-1", "claude-opus-5"],
  });
  const antigravity = provider({
    instanceId: "antigravity",
    driver: "antigravity",
    model: "gemini-3.8-flash-high",
  });
  const providers = [claude, antigravity];
  const resetsAtSeconds = 1_788_570_000;
  const afterReset = resetsAtSeconds * 1_000 + 60_000;
  const beforeReset = resetsAtSeconds * 1_000 - 60_000;
  const onAntigravity = {
    instanceId: ProviderInstanceId.make("antigravity"),
    model: "gemini-3.8-flash-high",
  };
  function failoverActivity(overrides?: {
    readonly payload?: Record<string, unknown>;
    readonly sequence?: number;
    readonly createdAt?: string;
  }) {
    return {
      id: EventId.make("failover-1"),
      tone: "info" as const,
      kind: "provider.failover.completed",
      summary: "claude-fable-5-1 usage exhausted · switched from Claude to Antigravity",
      payload: {
        sourceInstanceId: "claudeAgent",
        sourceProvider: "claudeAgent",
        sourceLabel: "Claude",
        sourceModel: "claude-fable-5-1",
        sourceOptions: [
          { id: "effort", value: "max" },
          { id: "contextWindow", value: "1m" },
        ],
        targetInstanceId: "antigravity",
        targetProvider: "antigravity",
        targetLabel: "Antigravity",
        targetModel: "gemini-3.8-flash-high",
        targetOptions: null,
        reason: "rate_limit_rejected:five_hour",
        resetsAt: resetsAtSeconds,
        ...overrides?.payload,
      },
      turnId: null,
      sequence: overrides?.sequence ?? 10,
      createdAt: overrides?.createdAt ?? "2026-09-04T23:19:57.574Z",
    };
  }

  it("returns the thread to the selection it had before the failover once the window resets", () => {
    const restore = resolveUsageLimitFailoverRestore({
      failover: failoverActivity(),
      restored: null,
      currentSelection: onAntigravity,
      providers,
      nowEpochMs: afterReset,
    });
    expect(restore).not.toBeNull();
    expect(restore?.modelSelection).toEqual({
      instanceId: "claudeAgent",
      model: "claude-fable-5-1",
      options: [
        { id: "effort", value: "max" },
        { id: "contextWindow", value: "1m" },
      ],
    });
    expect(restore?.sourceLabel).toBe("Claude");
    expect(restore?.targetLabel).toBe("Antigravity");
    expect(restore?.targetModel).toBe("gemini-3.8-flash-high");
    expect(restore?.resetsAtEpochMs).toBe(resetsAtSeconds * 1_000);
  });

  it("waits for the recorded window to reset", () => {
    expect(
      resolveUsageLimitFailoverRestore({
        failover: failoverActivity(),
        restored: null,
        currentSelection: onAntigravity,
        providers,
        nowEpochMs: beforeReset,
      }),
    ).toBeNull();
    expect(
      resolveUsageLimitFailoverRestore({
        failover: failoverActivity({ payload: { resetsAt: null } }),
        restored: null,
        currentSelection: onAntigravity,
        providers,
        nowEpochMs: afterReset,
      }),
    ).toBeNull();
  });

  it("reads reset timestamps in milliseconds as well as seconds", () => {
    expect(
      resolveUsageLimitFailoverRestore({
        failover: failoverActivity({ payload: { resetsAt: resetsAtSeconds * 1_000 } }),
        restored: null,
        currentSelection: onAntigravity,
        providers,
        nowEpochMs: afterReset,
      })?.resetsAtEpochMs,
    ).toBe(resetsAtSeconds * 1_000);
  });

  it("keeps a selection the user made after the failover", () => {
    expect(
      resolveUsageLimitFailoverRestore({
        failover: failoverActivity(),
        restored: null,
        currentSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
        providers,
        nowEpochMs: afterReset,
      }),
    ).toBeNull();
    expect(
      resolveUsageLimitFailoverRestore({
        failover: failoverActivity(),
        restored: null,
        currentSelection: { ...onAntigravity, model: "gemini-3.1-pro-high" },
        providers,
        nowEpochMs: afterReset,
      }),
    ).toBeNull();
  });

  it("preserves a later explicit selection even when it matches the old fallback", () => {
    expect(
      resolveUsageLimitFailoverRestore({
        failover: failoverActivity({ sequence: 3_013_972 }),
        restored: null,
        latestClientSelection: { sequence: 3_109_386, createdAt: "2026-09-13T14:54:03.129Z" },
        currentSelection: onAntigravity,
        providers,
        nowEpochMs: afterReset,
      }),
    ).toBeNull();
  });

  it("still restores when the explicit choice predates the failover", () => {
    expect(
      resolveUsageLimitFailoverRestore({
        failover: failoverActivity({ sequence: 10 }),
        restored: null,
        latestClientSelection: { sequence: 9, createdAt: "2026-09-04T23:19:57.574Z" },
        currentSelection: onAntigravity,
        providers,
        nowEpochMs: afterReset,
      }),
    ).not.toBeNull();
  });

  it("does not restore the same failover twice", () => {
    const restored = {
      ...failoverActivity({ sequence: 20, createdAt: "2026-09-05T01:05:00.000Z" }),
      id: EventId.make("restored-1"),
      kind: "provider.failover.restored",
    };
    expect(
      resolveUsageLimitFailoverRestore({
        failover: failoverActivity(),
        restored,
        currentSelection: onAntigravity,
        providers,
        nowEpochMs: afterReset,
      }),
    ).toBeNull();
    // A restore that predates this failover belongs to an earlier episode.
    expect(
      resolveUsageLimitFailoverRestore({
        failover: failoverActivity(),
        restored: { ...restored, sequence: 5, createdAt: "2026-09-04T20:00:00.000Z" },
        currentSelection: onAntigravity,
        providers,
        nowEpochMs: afterReset,
      }),
    ).not.toBeNull();
  });

  it("leaves a same-instance model downgrade alone", () => {
    expect(
      resolveUsageLimitFailoverRestore({
        failover: failoverActivity({
          payload: {
            targetInstanceId: "claudeAgent",
            targetModel: "claude-opus-5",
            targetLabel: "Claude",
          },
        }),
        restored: null,
        currentSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-5",
        },
        providers,
        nowEpochMs: afterReset,
      }),
    ).toBeNull();
  });

  it("only goes back to a provider that can take the turn", () => {
    const loggedOut = provider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      models: ["claude-fable-5-1"],
      authStatus: "unauthenticated",
    });
    expect(
      resolveUsageLimitFailoverRestore({
        failover: failoverActivity(),
        restored: null,
        currentSelection: onAntigravity,
        providers: [loggedOut, antigravity],
        nowEpochMs: afterReset,
      }),
    ).toBeNull();
    const stillRejected = provider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      models: ["claude-fable-5-1"],
      accountUsage: {
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: Math.floor(afterReset / 1_000) + 3_600,
        },
      },
    });
    expect(
      resolveUsageLimitFailoverRestore({
        failover: failoverActivity(),
        restored: null,
        currentSelection: onAntigravity,
        providers: [stillRejected, antigravity],
        nowEpochMs: afterReset,
      }),
    ).toBeNull();
    const modelGone = provider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      models: ["claude-opus-5"],
    });
    expect(
      resolveUsageLimitFailoverRestore({
        failover: failoverActivity(),
        restored: null,
        currentSelection: onAntigravity,
        providers: [modelGone, antigravity],
        nowEpochMs: afterReset,
      }),
    ).toBeNull();
  });
});

describe("selectProviderFailoverTarget usage readings", () => {
  const NOW = 1700000000000;
  const target = (usageGuard: ServerProvider["usageGuard"]) =>
    selectProviderFailoverTarget({
      providers: [
        provider({ instanceId: "claude", driver: "claudeAgent", model: "claude-opus-5" }),
        provider({
          instanceId: "codex",
          driver: "codex",
          model: "gpt-5.6-sol",
          ...(usageGuard === undefined ? {} : { usageGuard }),
        }),
      ],
      currentInstanceId: ProviderInstanceId.make("claude"),
      currentDriver: ProviderDriverKind.make("claudeAgent"),
      currentModel: "claude-opus-5",
      nowEpochMs: NOW,
    });

  it("passes over a candidate whose account window already reads 100%", () => {
    // Handing the thread to a provider the guard already reads as full just
    // buys one more turn that hits the same wall and bounces again.
    expect(
      target({
        enabled: true,
        tier: "none" as const,
        summary: "",
        windowKey: "weekly",
        windowLabel: "Weekly",
        windowScope: "account" as const,
        reportedPercent: 100,
        estimatedPercent: 100,
        resetsAt: null,
        burnPercentPerHour: null,
        projectedAtResetPercent: null,
        turnCostPercent: null,
        headroomPercent: 0,
        effortTarget: null,
        backgroundBudget: null,
        activeThreads: 0,
        holdingBackgroundWork: false,
        backgroundCooldownMs: null,
        tokensPerPercent: 1,
        tokensPerPercentSource: "default" as const,
        learnedTokensPerPercent: null,
        tokensSinceReport: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("still selects a candidate whose full window is only one model family", () => {
    // Other families on that instance are untouched, and failoverModel skips
    // the exhausted models on its own.
    expect(
      target({
        enabled: true,
        tier: "none" as const,
        summary: "",
        windowKey: "weekly",
        windowLabel: "Weekly",
        windowScope: "model-family" as const,
        reportedPercent: 100,
        estimatedPercent: 100,
        resetsAt: null,
        burnPercentPerHour: null,
        projectedAtResetPercent: null,
        turnCostPercent: null,
        headroomPercent: 0,
        effortTarget: null,
        backgroundBudget: null,
        activeThreads: 0,
        holdingBackgroundWork: false,
        backgroundCooldownMs: null,
        tokensPerPercent: 1,
        tokensPerPercentSource: "default" as const,
        learnedTokensPerPercent: null,
        tokensSinceReport: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
      })?.instanceId,
    ).toBe("codex");
  });

  it("still selects a candidate whose full window has already reset", () => {
    expect(
      target({
        enabled: true,
        tier: "none" as const,
        summary: "",
        windowKey: "weekly",
        windowLabel: "Weekly",
        windowScope: "account" as const,
        reportedPercent: 100,
        estimatedPercent: 100,
        resetsAt: 1699999999000,
        burnPercentPerHour: null,
        projectedAtResetPercent: null,
        turnCostPercent: null,
        headroomPercent: 0,
        effortTarget: null,
        backgroundBudget: null,
        activeThreads: 0,
        holdingBackgroundWork: false,
        backgroundCooldownMs: null,
        tokensPerPercent: 1,
        tokensPerPercentSource: "default" as const,
        learnedTokensPerPercent: null,
        tokensSinceReport: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
      })?.instanceId,
    ).toBe("codex");
  });

  it("still selects a candidate that reports no usage at all", () => {
    // An absent reading is not evidence of exhaustion; failing closed here
    // would leave failover with no target at all.
    expect(target(undefined)?.instanceId).toBe("codex");
  });
});

describe("Antigravity quota fallback", () => {
  const nowEpochMs = Date.parse("2026-09-10T18:00:00Z");
  function select(remainingPercent: number, resetsAt = "2026-09-11T18:00:00Z", excluded = false) {
    const agy = provider({
      instanceId: "antigravity",
      driver: "antigravity",
      models: [
        "gemini-3.8-pro",
        "claude-sonnet-4-5",
        "claude-opus-4-6-thinking",
        "claude-opus-4-8-thinking",
      ],
      accountUsage: {
        windows: [
          {
            key: "gemini",
            family: "gemini",
            label: "Gemini",
            remainingPercent: 0,
            resetsAt: "2026-09-11T18:00:00Z",
          },
          {
            key: "claude-gpt",
            family: "claude-gpt",
            label: "Claude and GPT",
            remainingPercent,
            resetsAt,
          },
        ],
      },
    });
    const models = agy.models.map((model, index) => ({ ...model, isDefault: index === 0 }));
    return (
      selectProviderFailoverTarget({
        providers: [{ ...agy, models }],
        currentInstanceId: ProviderInstanceId.make("codex"),
        currentDriver: ProviderDriverKind.make("codex"),
        nowEpochMs,
        ...(excluded
          ? {
              excludedModels: new Set([
                providerFailoverModelKey("antigravity", "claude-opus-4-8-thinking"),
              ]),
            }
          : {}),
      })?.modelSelection.model ?? null
    );
  }
  it("prefers the highest Claude over default exhausted Gemini", () => {
    expect(select(80)).toBe("claude-opus-4-8-thinking");
  });
  it("uses the next highest secondary model after a failed attempt", () => {
    expect(select(80, undefined, true)).toBe("claude-opus-4-6-thinking");
  });
  it("skips the provider when both independent pools are exhausted", () => {
    expect(select(0)).toBeNull();
  });
  it("allows a Claude quota whose reset has passed", () => {
    expect(select(0, "2026-09-10T17:00:00Z")).toBe("claude-opus-4-8-thinking");
  });

  it("exhausts Gemini before Claude while both pools are healthy", () => {
    const agy = provider({
      instanceId: "antigravity",
      driver: "antigravity",
      models: ["claude-opus-4-8-thinking", "gemini-3.8-flash", "gemini-3.8-pro"],
      accountUsage: {
        windows: [
          {
            key: "gemini",
            family: "gemini",
            label: "Gemini",
            remainingPercent: 60,
            resetsAt: "2026-09-11T18:00:00Z",
          },
          {
            key: "claude-gpt",
            family: "claude-gpt",
            label: "Claude and GPT",
            remainingPercent: 80,
            resetsAt: "2026-09-11T18:00:00Z",
          },
        ],
      },
    });
    const selectWithDefaults = (defaults: ReadonlyArray<number>) => {
      const models = agy.models.map((model, index) => ({
        ...model,
        isDefault: defaults.includes(index),
      }));
      return (
        selectProviderFailoverTarget({
          providers: [{ ...agy, models }],
          currentInstanceId: ProviderInstanceId.make("codex"),
          currentDriver: ProviderDriverKind.make("codex"),
          nowEpochMs,
        })?.modelSelection.model ?? null
      );
    };
    // The default Gemini wins even though a Claude model is the menu default
    // and sorts first.
    expect(selectWithDefaults([0, 2])).toBe("gemini-3.8-pro");
    // Without a default, registry order decides among Gemini models.
    expect(selectWithDefaults([])).toBe("gemini-3.8-flash");
  });

  it("walks Gemini models before falling through to Claude", () => {
    const agy = provider({
      instanceId: "antigravity",
      driver: "antigravity",
      models: ["gemini-3.8-pro", "gemini-3.8-flash", "claude-opus-4-8-thinking"],
      accountUsage: {
        windows: [
          {
            key: "gemini",
            family: "gemini",
            label: "Gemini",
            remainingPercent: 60,
            resetsAt: "2026-09-11T18:00:00Z",
          },
          {
            key: "claude-gpt",
            family: "claude-gpt",
            label: "Claude and GPT",
            remainingPercent: 80,
            resetsAt: "2026-09-11T18:00:00Z",
          },
        ],
      },
    });
    const selectExcluding = (slugs: ReadonlyArray<string>) =>
      selectProviderFailoverTarget({
        providers: [agy],
        currentInstanceId: ProviderInstanceId.make("codex"),
        currentDriver: ProviderDriverKind.make("codex"),
        nowEpochMs,
        excludedModels: new Set(slugs.map((slug) => providerFailoverModelKey("antigravity", slug))),
      })?.modelSelection.model ?? null;
    expect(selectExcluding([])).toBe("gemini-3.8-pro");
    expect(selectExcluding(["gemini-3.8-pro"])).toBe("gemini-3.8-flash");
    expect(selectExcluding(["gemini-3.8-pro", "gemini-3.8-flash"])).toBe(
      "claude-opus-4-8-thinking",
    );
  });
});

describe("detectProviderUnusableRefusal", () => {
  // 2026-09-18: each of these parked a thread behind a Resume banner while
  // other providers sat idle.
  it("moves a thread off a provider that cannot serve it", () => {
    expect(detectProviderUnusableRefusal("model stream idle timeout after 180000ms")).toEqual({
      reason: "provider_unusable",
      resetsAt: null,
    });
    expect(
      detectProviderUnusableRefusal(
        "ProviderModelNotFoundError: Model not found: opencode/union-alpha.",
      ),
    ).not.toBeNull();
    expect(
      detectProviderUnusableRefusal(
        "API error (status 402 Payment Required): Grok Build usage balance exhausted",
      ),
    ).not.toBeNull();
  });

  // 2026-09-18: the first cut moved an exhausted Grok thread from grok-4.6 to
  // grok-4.5, which bills the same empty account and failed again at once.
  it("treats an empty balance as account-wide and a missing model as per-model", () => {
    expect(
      isAccountWideUnusableRefusal(
        "API error (status 402 Payment Required): Grok Build usage balance exhausted",
      ),
    ).toBe(true);
    expect(isAccountWideUnusableRefusal("Model not found: opencode/union-alpha.")).toBe(false);
    expect(isAccountWideUnusableRefusal("model stream idle timeout after 180000ms")).toBe(false);
  });

  // 2026-09-19: a Grok thread burned eight attempts on a bare "Invalid params"
  // and then parked, while Muse sat at 9% used. A rejected request shape is
  // deterministic, and it is the provider's, not the model's.
  it("moves off a provider that rejects the request shape", () => {
    for (const message of ["Invalid params", "Invalid request", "Method not found"]) {
      expect(detectProviderUnusableRefusal(message)).not.toBeNull();
      expect(isAccountWideUnusableRefusal(message)).toBe(true);
    }
  });

  // Each of these owns a better recovery than moving provider.
  it("leaves authentication, overflow and transient failures alone", () => {
    expect(detectProviderUnusableRefusal("Please run /login to authenticate")).toBeNull();
    expect(
      detectProviderUnusableRefusal("This model's maximum context length is 200000 tokens"),
    ).toBeNull();
    expect(
      detectProviderUnusableRefusal(
        "Streaming response failed: [api_error] upstream provider error (HTTP 503)",
      ),
    ).toBeNull();
    expect(detectProviderUnusableRefusal("")).toBeNull();
    expect(detectProviderUnusableRefusal(`model not found ${"x".repeat(700)}`)).toBeNull();
  });
});

describe("fallback model restrictions", () => {
  const codexId = ProviderInstanceId.make("codex");
  const claudeId = ProviderInstanceId.make("claudeAgent");
  const base = {
    providers: [
      provider({ instanceId: "codex", driver: "codex", models: ["gpt-6-astra", "gpt-6-sol"] }),
      provider({
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        models: ["claude-fable-5-1", "claude-opus-5"],
      }),
    ],
    currentInstanceId: codexId,
    currentDriver: ProviderDriverKind.make("codex"),
    currentModel: "gpt-6-astra",
  };
  it("skips a blocked same-account downgrade and chooses an allowed provider", () => {
    expect(
      selectProviderFailoverTarget({
        ...base,
        modelPolicies: [{ mode: "block", models: [{ instanceId: codexId, model: "gpt-6-sol" }] }],
      })?.instanceId,
    ).toBe(claudeId);
  });
  it("considers allowed models after a blocked preferred model", () => {
    expect(
      selectProviderFailoverTarget({
        ...base,
        modelPolicies: [
          { mode: "allow", models: [{ instanceId: claudeId, model: "claude-opus-5" }] },
        ],
      })?.modelSelection.model,
    ).toBe("claude-opus-5");
  });
  it("returns no target when every alternative is blocked", () => {
    expect(
      selectProviderFailoverTarget({ ...base, modelPolicies: [{ mode: "allow", models: [] }] }),
    ).toBeNull();
  });
  it("intersects global and inherited rules", () => {
    const permitted = { instanceId: claudeId, model: "claude-opus-5" };
    expect(
      selectProviderFailoverTarget({
        ...base,
        modelPolicies: [
          { mode: "allow", models: [permitted] },
          { mode: "block", models: [permitted] },
        ],
      }),
    ).toBeNull();
  });
  it("does not transfer permission to a different account of the same provider", () => {
    expect(
      selectProviderFailoverTarget({
        ...base,
        modelPolicies: [
          {
            mode: "allow",
            models: [
              { instanceId: ProviderInstanceId.make("claude-personal"), model: "claude-opus-5" },
            ],
          },
        ],
      }),
    ).toBeNull();
  });
});

describe("Opus 5.5 fallback", () => {
  const instanceId = ProviderInstanceId.make("claude");
  const input = {
    providers: [
      provider({
        instanceId,
        driver: "claudeAgent",
        models: ["claude-opus-5", "claude-opus-4-8", "claude-opus-5-5"],
      }),
    ],
    currentInstanceId: ProviderInstanceId.make("codex"),
    currentDriver: ProviderDriverKind.make("codex"),
  };
  it("chooses the newest Opus independently of catalog order", () => {
    expect(selectProviderFailoverTarget(input)?.modelSelection.model).toBe("claude-opus-5-5");
  });
  it("still obeys exact model restrictions when a new release is discovered", () => {
    expect(
      selectProviderFailoverTarget({
        ...input,
        modelPolicies: [{ mode: "allow", models: [{ instanceId, model: "claude-opus-5" }] }],
      })?.modelSelection.model,
    ).toBe("claude-opus-5");
    expect(
      selectProviderFailoverTarget({
        ...input,
        modelPolicies: [{ mode: "block", models: [{ instanceId, model: "claude-opus-5-5" }] }],
      })?.modelSelection.model,
    ).toBe("claude-opus-5");
  });
});
