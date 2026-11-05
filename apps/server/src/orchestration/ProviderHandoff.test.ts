import {
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationMessage,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderHandoffTurnInput,
  buildProviderHandoffSummary,
  deriveProviderHandoffContinuity,
  isProviderNotice,
  PROVIDER_HANDOFF_MAX_SERIALIZED_CHARS,
  PROVIDER_HANDOFF_TURN_MAX_SERIALIZED_CHARS,
} from "./ProviderHandoff.ts";
import { DEEPCODE_PROGRESS_TIMEOUT_MESSAGE } from "../provider/deepcodeProtocol.ts";

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
        reason: "manual_provider_switch",
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
          reason: "manual_provider_switch",
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
      reason: "rate_limit_reached",
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
      reason: "manual_provider_switch",
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
      reason: "manual_provider_switch",
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
      reason: "manual_provider_switch",
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
