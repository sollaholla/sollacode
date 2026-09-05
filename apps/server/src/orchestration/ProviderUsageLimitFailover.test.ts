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
  detectProviderUsageLimitExhaustion,
  deriveProviderHandoffContinuity,
  isAccountWideProviderExhaustion,
  isProviderNotice,
  PROVIDER_HANDOFF_MAX_SERIALIZED_CHARS,
  PROVIDER_HANDOFF_TURN_MAX_SERIALIZED_CHARS,
  providerFailoverModelKey,
  resolveUsageLimitFailoverRestore,
  selectProviderFailoverTarget,
} from "./ProviderUsageLimitFailover.ts";

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
