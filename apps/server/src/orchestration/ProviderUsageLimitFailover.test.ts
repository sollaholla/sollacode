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
  selectProviderFailoverTarget,
} from "./ProviderUsageLimitFailover.ts";

function provider(input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly model?: string;
  readonly enabled?: boolean;
  readonly installed?: boolean;
  readonly status?: ServerProvider["status"];
  readonly authStatus?: ServerProvider["auth"]["status"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: input.enabled ?? true,
    installed: input.installed ?? true,
    version: "1.0.0",
    status: input.status ?? "ready",
    auth: { status: input.authStatus ?? "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models:
      input.model === undefined
        ? []
        : [
            {
              slug: input.model,
              name: input.model,
              isCustom: false,
              isDefault: true,
              capabilities: null,
            },
          ],
    slashCommands: [],
    skills: [],
  };
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
});
