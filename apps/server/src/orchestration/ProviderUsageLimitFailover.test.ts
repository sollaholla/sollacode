import {
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
  PROVIDER_HANDOFF_MAX_SERIALIZED_CHARS,
  PROVIDER_HANDOFF_TURN_MAX_SERIALIZED_CHARS,
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
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  };
}

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
