import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";
import { DEFAULT_MODEL, ThreadId } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { T3_BROWSER_CONTROL_POLICY } from "../../browserControlPolicy.ts";
import {
  buildCodexDeveloperInstructions,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import { CODEX_APP_SERVER_CONFIG_ARGS, codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import {
  buildTurnStartParams,
  CODEX_EFFECTIVE_CONTEXT_WINDOW_TOKENS,
  hasConfiguredMcpServer,
  hydrateCodexBackgroundTaskMetadata,
  isRecoverableThreadResumeError,
  mcpFormElicitationContent,
  mcpFormElicitationQuestions,
  openCodexThread,
  stopCodexBackgroundTask,
  resolveCodexAutoCompactionTokenLimit,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

describe("CodexSessionRuntimeIdentifierGenerationError", () => {
  it("retains identifier purpose and the random source failure", () => {
    const cause = new Error("random source unavailable");
    const error = new CodexErrors.CodexAppServerIdentifierGenerationError({
      purpose: "provider-event",
      cause,
    });

    NodeAssert.equal(error.purpose, "provider-event");
    NodeAssert.strictEqual(error.cause, cause);
    NodeAssert.equal(
      error.message,
      "Failed to generate Codex App Server identifier for provider-event.",
    );
  });
});

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      createdAt: "2026-04-18T00:00:00.000Z",
      source: { session: "cli" },
      turns: [],
      status: {
        state: "idle",
        activeFlags: [],
      },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("buildTurnStartParams", () => {
  it("keeps invalid turn values only in the schema cause", () => {
    const secret = "codex-turn-input-secret-sentinel";
    const error = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        attachments: [
          {
            type: "image",
            url: { secret } as unknown as string,
          },
        ],
      }).pipe(Effect.flip),
    );
    const { cause, ...directDiagnostics } = error;

    NodeAssert.equal(error.operation, "decode-request-payload");
    NodeAssert.equal(error.method, "turn/start");
    NodeAssert.ok((error.issueCount ?? 0) > 0);
    NodeAssert.ok(error.issueKinds?.includes("Pointer"));
    NodeAssert.ok((error.maximumPathDepth ?? 0) > 0);
    NodeAssert.ok(Schema.isSchemaError(cause));
    NodeAssert.doesNotMatch(error.message, new RegExp(secret));
    NodeAssert.doesNotMatch(JSON.stringify(directDiagnostics), new RegExp(secret));
  });

  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("plan", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "high",
          developer_instructions: buildCodexDeveloperInstructions("default", {
            model: "gpt-5.3-codex",
            reasoningEffort: "high",
          }),
        },
      },
    });
  });

  it("reports the same fallback model and effort in settings and instructions", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Go",
        interactionMode: "default",
      }),
    );

    const settings = params.collaborationMode?.settings;
    NodeAssert.equal(settings?.model, DEFAULT_MODEL);
    NodeAssert.equal(settings?.reasoning_effort, "high");
    NodeAssert.ok(settings?.developer_instructions?.includes(`as ${DEFAULT_MODEL} with high`));
  });

  it.effect("routes approvals to the auto reviewer in auto mode", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto",
        prompt: "Ship it",
      });

      NodeAssert.deepStrictEqual(params, {
        threadId: "provider-thread-1",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
        input: [
          {
            type: "text",
            text: "Ship it",
          },
        ],
      });
    }),
  );

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });
});

describe("buildCodexDeveloperInstructions", () => {
  it("appends runtime info after the mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    NodeAssert.ok(instructions.startsWith(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS));
    NodeAssert.match(instructions, /Solla Code/);
    NodeAssert.match(instructions, /Codex harness/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with high reasoning effort/);
  });

  it("includes runtime info alongside plan mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("plan", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });

    NodeAssert.ok(instructions.startsWith(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS));
    NodeAssert.match(instructions, /as gpt-5\.3-codex with medium reasoning effort/);
  });

  it("varies with the model and effort of each turn", () => {
    const first = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });
    const second = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    NodeAssert.notEqual(first, second);
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("T3 browser developer instructions", () => {
  it("requires the product-native preview tools in both collaboration modes", () => {
    for (const instructions of [
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
    ]) {
      NodeAssert.match(instructions, /t3-code/);
      NodeAssert.match(instructions, /preview_status/);
      NodeAssert.match(instructions, /preview_open/);
      NodeAssert.match(instructions, /selection-required/);
      NodeAssert.match(instructions, /preview_close/);
      NodeAssert.ok(instructions.includes(T3_BROWSER_CONTROL_POLICY));
    }
  });
});

describe("hasConfiguredMcpServer", () => {
  it("detects inline Codex MCP configuration arguments", () => {
    NodeAssert.equal(hasConfiguredMcpServer(undefined), false);
    NodeAssert.equal(hasConfiguredMcpServer(["--model", "gpt-5.4"]), false);
    NodeAssert.equal(
      hasConfiguredMcpServer(["-c", 'mcp_servers.t3-code.url="http://127.0.0.1/mcp"']),
      true,
    );
  });
});

describe("MCP form elicitation", () => {
  const payload: EffectCodexSchema.McpServerElicitationRequestParams = {
    mode: "form",
    message:
      "Install Solla Code 0.1.96? The app will close, install, and restart with auto-resume.",
    serverName: "Solla Code",
    threadId: "provider-thread-1",
    turnId: "provider-turn-1",
    requestedSchema: {
      type: "object",
      properties: {
        confirmation: {
          type: "string",
          title: "Update app",
          description: "Choose Yes to install the update.",
          enum: ["yes", "no"],
        },
      },
      required: ["confirmation"],
    },
  };

  it("converts a standard MCP enum form into the native in-chat question UI", () => {
    NodeAssert.deepStrictEqual(mcpFormElicitationQuestions(payload), [
      {
        id: "confirmation",
        header: "Update app",
        question: payload.message,
        isOther: false,
        isSecret: false,
        options: [
          { label: "Yes", description: "Select Yes." },
          { label: "No", description: "Select No." },
        ],
      },
    ]);
  });

  it("maps the displayed option label back to the MCP enum value", () => {
    NodeAssert.deepStrictEqual(mcpFormElicitationContent(payload, { confirmation: "Yes" }), {
      confirmation: "yes",
    });
    NodeAssert.deepStrictEqual(
      mcpFormElicitationContent(payload, { confirmation: { answers: ["No"] } }),
      { confirmation: "no" },
    );
  });

  it("offers a default action while preserving typed correction feedback", () => {
    const actionApprovalPayload: EffectCodexSchema.McpServerElicitationRequestParams = {
      mode: "form",
      message:
        "Review this email:\n\nTo: pat@example.com\nSubject: Status\n\nThe work is complete.",
      serverName: "Solla Code",
      threadId: "provider-thread-1",
      turnId: "provider-turn-1",
      requestedSchema: {
        type: "object",
        properties: {
          t3_action_approval: {
            type: "string",
            title: "Approval",
            description: "Choose Approve or type corrections.",
            default: "Approve",
            minLength: 1,
            maxLength: 20_000,
          },
        },
        required: ["t3_action_approval"],
      },
    };

    NodeAssert.deepStrictEqual(mcpFormElicitationQuestions(actionApprovalPayload), [
      {
        id: "t3_action_approval",
        header: "Approval",
        question: actionApprovalPayload.message,
        isOther: false,
        isSecret: false,
        options: [{ label: "Approve", description: "Select Approve." }],
      },
    ]);
    NodeAssert.deepStrictEqual(
      mcpFormElicitationContent(actionApprovalPayload, {
        t3_action_approval: "Use a more specific subject line.",
      }),
      { t3_action_approval: "Use a more specific subject line." },
    );
    NodeAssert.deepStrictEqual(
      mcpFormElicitationContent(actionApprovalPayload, { t3_action_approval: "Approve" }),
      { t3_action_approval: "Approve" },
    );
  });

  it("declines unsupported elicitation modes and malformed answers", () => {
    NodeAssert.equal(
      mcpFormElicitationQuestions({
        mode: "url",
        elicitationId: "external-update",
        message: "Open an external form",
        url: "https://example.invalid/form",
        serverName: "Solla Code",
        threadId: "provider-thread-1",
      }),
      null,
    );
    NodeAssert.equal(mcpFormElicitationContent(payload, { confirmation: "Maybe" }), null);
  });
});

describe("codexSessionAppServerArgs", () => {
  it("keeps the app-server subcommand when explicit args are provided", () => {
    NodeAssert.deepStrictEqual(codexSessionAppServerArgs(["-c", "model=gpt-5"], undefined), [
      "app-server",
      ...CODEX_APP_SERVER_CONFIG_ARGS,
      "-c",
      "model=gpt-5",
    ]);
  });

  it("keeps launch args when explicit app-server args are provided", () => {
    NodeAssert.deepStrictEqual(
      codexSessionAppServerArgs(
        ["-c", "mcp_servers.t3-code.url=http://127.0.0.1/mcp"],
        "--strict-config --enable foo",
      ),
      [
        "app-server",
        ...CODEX_APP_SERVER_CONFIG_ARGS,
        "--strict-config",
        "--enable",
        "foo",
        "-c",
        "mcp_servers.t3-code.url=http://127.0.0.1/mcp",
      ],
    );
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("matches a missing rollout for a known thread id", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "no rollout found for thread id 019fdf74-aaa9-7950-b252-7cc7a8650470",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("openCodexThread", () => {
  it("derives the native limit from the user-visible effective context window", () => {
    NodeAssert.equal(CODEX_EFFECTIVE_CONTEXT_WINDOW_TOKENS, 258_400);
    NodeAssert.equal(resolveCodexAutoCompactionTokenLimit(80), 206_720);
    NodeAssert.equal(resolveCodexAutoCompactionTokenLimit(49), undefined);
  });

  it.effect("falls back to thread/start when resume fails recoverably", () =>
    Effect.gen(function* () {
      const calls: Array<{
        method: "thread/start" | "thread/resume" | "thread/fork";
        payload: unknown;
      }> = [];
      const started = makeThreadOpenResponse("fresh-thread");
      const client = {
        request: <M extends "thread/start" | "thread/resume" | "thread/fork">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "thread not found",
              }),
            );
          }
          return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };

      const opened = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        autoCompactionTokenLimit: 206_720,
        resumeThreadId: "stale-thread",
        forkThread: false,
      });

      NodeAssert.equal(opened.thread.id, "fresh-thread");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["thread/resume", "thread/start"],
      );
      for (const call of calls) {
        NodeAssert.deepStrictEqual((call.payload as { config?: unknown }).config, {
          model_auto_compact_token_limit: 206_720,
          model_auto_compact_token_limit_scope: "total",
        });
      }
    }),
  );

  it.effect("propagates non-recoverable resume failures", () =>
    Effect.gen(function* () {
      const client = {
        request: <M extends "thread/start" | "thread/resume" | "thread/fork">(
          method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "timed out waiting for server",
              }),
            );
          }
          return Effect.succeed(
            makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };

      const error = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
        forkThread: false,
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.equal(error.errorMessage, "timed out waiting for server");
    }),
  );

  for (const errorMessage of [
    "failed to prepare paginated fork: thread-store internal error: thread history projection for source-thread expected ordinal 1345, got 1344",
    "thread not found",
    "authentication failed",
  ]) {
    it.effect(`handles failed native fork: ${errorMessage}`, () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const client = {
          request: <M extends "thread/start" | "thread/resume" | "thread/fork">(
            method: M,
            _payload: CodexRpc.ClientRequestParamsByMethod[M],
          ) => {
            calls.push(method);
            return method === "thread/fork"
              ? Effect.fail(
                  new CodexErrors.CodexAppServerRequestError({ code: -32603, errorMessage }),
                )
              : Effect.succeed(
                  makeThreadOpenResponse(
                    "fresh-child",
                  ) as CodexRpc.ClientRequestResponsesByMethod[M],
                );
          },
        };
        const result = yield* openCodexThread({
          client,
          threadId: ThreadId.make("child"),
          runtimeMode: "full-access",
          cwd: "/tmp/project",
          requestedModel: "gpt-5.3-codex",
          serviceTier: undefined,
          resumeThreadId: "source-thread",
          forkThread: true,
        }).pipe(Effect.result);
        if (errorMessage === "authentication failed") {
          NodeAssert.equal(result._tag, "Failure");
          NodeAssert.deepStrictEqual(calls, ["thread/fork"]);
        } else {
          NodeAssert.equal(result._tag, "Success");
          if (result._tag === "Success") NodeAssert.equal(result.success.thread.id, "fresh-child");
          NodeAssert.deepStrictEqual(calls, ["thread/fork", "thread/start"]);
        }
      }),
    );
  }

  it.effect("forks a persisted Codex thread into an independent thread", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; payload: unknown }> = [];
      const forked = makeThreadOpenResponse("forked-thread");
      const client = {
        request: <M extends "thread/start" | "thread/resume" | "thread/fork">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          return Effect.succeed(forked as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };

      const opened = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-fork"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        autoCompactionTokenLimit: 206_720,
        resumeThreadId: "source-thread",
        forkThread: true,
      });

      NodeAssert.equal(opened.thread.id, "forked-thread");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["thread/fork"],
      );
      NodeAssert.equal((calls[0]?.payload as { threadId?: string }).threadId, "source-thread");
      NodeAssert.deepStrictEqual((calls[0]?.payload as { config?: unknown }).config, {
        model_auto_compact_token_limit: 206_720,
        model_auto_compact_token_limit_scope: "total",
      });
    }),
  );
});

describe("reasoning effort default", () => {
  it.effect("falls back to high when the caller names none", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-default-effort",
        runtimeMode: "full-access",
        prompt: "Go",
        model: "gpt-5.3-codex",
        interactionMode: "default",
      });
      // Agentic turns run long; the extra reasoning is worth the latency.
      NodeAssert.equal(params.collaborationMode?.settings.reasoning_effort, "high");
    }),
  );

  it.effect("still honours an effort the caller does name", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-explicit-effort",
        runtimeMode: "full-access",
        prompt: "Go",
        model: "gpt-5.3-codex",
        effort: "low",
        interactionMode: "default",
      });
      NodeAssert.equal(params.collaborationMode?.settings.reasoning_effort, "low");
    }),
  );
});

describe("Codex child metadata hydration", () => {
  it.effect("uses the observed child identity and retains lifecycle on a late response", () =>
    Effect.gen(function* () {
      const tasks = new Map<string, import("./CodexSubagentRouting.ts").CodexBackgroundTask>([
        [
          "child",
          {
            providerThreadId: "child",
            title: "Codex subagent child",
            status: "completed",
            totalTokens: 123,
          },
        ],
      ]);
      const result = yield* hydrateCodexBackgroundTaskMetadata({
        providerThreadId: "child",
        tasks,
        readThread: (threadId) => {
          NodeAssert.equal(threadId, "child");
          return Effect.succeed({
            thread: {
              id: threadId,
              source: { subAgent: { thread_spawn: { agent_path: "/root/probe" } } },
            },
          });
        },
      });
      NodeAssert.equal(result?.title, "Codex subagent /root/probe");
      NodeAssert.equal(result?.status, "completed");
      NodeAssert.equal(result?.totalTokens, 123);
    }),
  );
  it.effect("contains metadata failure without losing the background task", () =>
    Effect.gen(function* () {
      const tasks = new Map<string, import("./CodexSubagentRouting.ts").CodexBackgroundTask>();
      NodeAssert.equal(
        yield* hydrateCodexBackgroundTaskMetadata({
          providerThreadId: "child",
          tasks,
          readThread: () =>
            Effect.fail(CodexErrors.CodexAppServerRequestError.methodNotFound("thread/read")),
        }),
        null,
      );
    }),
  );
});

describe("Codex retained background task stops", () => {
  const rootId = "native-root";
  type ChildThread = Pick<
    EffectCodexSchema.V2ThreadReadResponse["thread"],
    "id" | "source" | "status" | "turns"
  >;
  const childThread = (
    id: string,
    parentId: string,
    status: ChildThread["status"] = { type: "notLoaded" },
    turnStatus: ChildThread["turns"][number]["status"] = "interrupted",
  ): ChildThread => ({
    id,
    source: { subAgent: { thread_spawn: { parent_thread_id: parentId, depth: 1 } } },
    status,
    turns: [{ id: `${id}-turn`, status: turnStatus, items: [] }],
  });
  const harness = (threads: ReadonlyArray<ChildThread>) => {
    const reads: Array<{ threadId: string; includeTurns: boolean }> = [];
    const interrupts: Array<{ threadId: string; turnId: string }> = [];
    const stop = (taskId = "codex-subagent:child") =>
      stopCodexBackgroundTask({
        taskId,
        rootProviderThreadId: rootId,
        tasks: new Map(),
        readThread: (threadId, includeTurns) =>
          Effect.sync(() => {
            reads.push({ threadId, includeTurns });
            const thread = threads.find((entry) => entry.id === threadId);
            NodeAssert.ok(thread, `Unexpected read of ${threadId}`);
            return { thread };
          }),
        interrupt: (target) => Effect.sync(() => interrupts.push(target)),
      });
    return { stop, reads, interrupts };
  };

  it.effect(
    "reconciles the incident's stopped native child after the observed map was replaced",
    () =>
      Effect.gen(function* () {
        for (const status of ["interrupted", "completed", "failed"] as const) {
          const { stop, reads, interrupts } = harness([
            childThread("child", rootId, { type: "notLoaded" }, status),
          ]);
          yield* stop();
          NodeAssert.deepStrictEqual(reads, [{ threadId: "child", includeTurns: true }]);
          NodeAssert.deepStrictEqual(interrupts, []);
        }
      }),
  );

  it.effect("interrupts only the recovered child's active native turn", () =>
    Effect.gen(function* () {
      const { stop, interrupts } = harness([
        childThread("child", rootId, { type: "active", activeFlags: [] }, "inProgress"),
      ]);
      yield* stop();
      NodeAssert.deepStrictEqual(interrupts, [{ threadId: "child", turnId: "child-turn" }]);
    }),
  );

  it.effect("finds the sole active turn independently of native history order", () =>
    Effect.gen(function* () {
      for (const activeIndex of [0, 1, 2]) {
        const child = childThread("child", rootId, { type: "active", activeFlags: [] });
        const turns: ChildThread["turns"] = [
          { id: "completed-turn", status: "completed", items: [] },
          { id: "failed-turn", status: "failed", items: [] },
        ];
        const orderedTurns = turns.toSpliced(activeIndex, 0, {
          id: "active-turn",
          status: "inProgress",
          items: [],
        });
        const { stop, interrupts } = harness([{ ...child, turns: orderedTurns }]);
        yield* stop();
        NodeAssert.deepStrictEqual(interrupts, [{ threadId: "child", turnId: "active-turn" }]);
      }
    }),
  );

  it.effect("reconciles loaded and unloaded histories when every turn is terminal", () =>
    Effect.gen(function* () {
      for (const type of ["idle", "notLoaded"] as const) {
        const child = childThread("child", rootId, { type });
        const turns: ChildThread["turns"] = [
          { id: "interrupted-turn", status: "interrupted", items: [] },
          { id: "completed-turn", status: "completed", items: [] },
          { id: "failed-turn", status: "failed", items: [] },
        ];
        for (const orderedTurns of [turns, turns.toReversed()]) {
          const { stop, interrupts } = harness([{ ...child, turns: orderedTurns }]);
          yield* stop();
          NodeAssert.deepStrictEqual(interrupts, []);
        }
      }
    }),
  );

  it.effect("rejects multiple active turns and inactive histories containing a live turn", () =>
    Effect.gen(function* () {
      const activeTurn = { id: "active-turn", status: "inProgress" as const, items: [] };
      const completedTurn = { id: "completed-turn", status: "completed" as const, items: [] };
      const cases: Array<ChildThread> = [
        {
          ...childThread("child", rootId, { type: "active", activeFlags: [] }),
          turns: [activeTurn, { ...activeTurn, id: "second-active-turn" }, completedTurn],
        },
      ];
      for (const type of ["idle", "notLoaded"] as const) {
        for (const turns of [
          [activeTurn, completedTurn],
          [completedTurn, activeTurn],
        ]) {
          cases.push({ ...childThread("child", rootId, { type }), turns });
        }
      }
      for (const child of cases) {
        const { stop, interrupts } = harness([child]);
        const error = yield* Effect.flip(stop());
        NodeAssert.equal(error._tag, "CodexBackgroundTaskNotRunningError");
        NodeAssert.deepStrictEqual(interrupts, []);
      }
    }),
  );

  it.effect("verifies nested ancestry without loading ancestor transcripts", () =>
    Effect.gen(function* () {
      const { stop, reads, interrupts } = harness([
        childThread("child", "parent"),
        childThread("parent", rootId),
      ]);
      yield* stop();
      NodeAssert.deepStrictEqual(reads, [
        { threadId: "child", includeTurns: true },
        { threadId: "parent", includeTurns: false },
      ]);
      NodeAssert.deepStrictEqual(interrupts, []);
    }),
  );

  it.effect("rejects root, unrecognized, unrelated, and cyclic tasks", () =>
    Effect.gen(function* () {
      const invalid = harness([]);
      for (const id of ["codex-subagent:native-root", "codex-subagent:", "unknown"]) {
        const error = yield* Effect.flip(invalid.stop(id));
        NodeAssert.equal(error._tag, "CodexBackgroundTaskNotRunningError");
      }
      NodeAssert.deepStrictEqual(invalid.reads, []);
      const cases = [
        [{ ...childThread("child", rootId), source: "cli" as const }],
        [
          childThread("child", "foreign"),
          { ...childThread("foreign", rootId), source: "cli" as const },
        ],
        [childThread("child", "parent"), childThread("parent", "child")],
      ];
      for (const threads of cases) {
        const current = harness(threads);
        const error = yield* Effect.flip(current.stop());
        NodeAssert.equal(error._tag, "CodexBackgroundTaskNotRunningError");
        NodeAssert.deepStrictEqual(current.interrupts, []);
      }
    }),
  );

  it.effect("does not infer success from missing turns or an unloaded active tail", () =>
    Effect.gen(function* () {
      const cases = [
        { ...childThread("child", rootId), turns: [] },
        childThread("child", rootId, { type: "notLoaded" }, "inProgress"),
        childThread("child", rootId, { type: "active", activeFlags: [] }, "completed"),
        childThread("child", rootId, { type: "systemError" }, "failed"),
      ];
      for (const child of cases) {
        const { stop, interrupts } = harness([child]);
        const error = yield* Effect.flip(stop());
        NodeAssert.equal(error._tag, "CodexBackgroundTaskNotRunningError");
        NodeAssert.deepStrictEqual(interrupts, []);
      }
    }),
  );

  it.effect("keeps observed child stops targeted without adding a history read", () =>
    Effect.gen(function* () {
      const interrupts: Array<{ threadId: string; turnId: string }> = [];
      yield* stopCodexBackgroundTask({
        taskId: "codex-subagent:child",
        rootProviderThreadId: rootId,
        tasks: new Map([
          [
            "child",
            {
              providerThreadId: "child",
              nativeTurnId: "live-child-turn",
              title: "Child",
              status: "running" as const,
            },
          ],
        ]),
        readThread: () => Effect.die("Observed child stop should not read history"),
        interrupt: (target) => Effect.sync(() => interrupts.push(target)),
      });
      NodeAssert.deepStrictEqual(interrupts, [{ threadId: "child", turnId: "live-child-turn" }]);
    }),
  );

  it.effect("bounds ancestry reads when a native chain never reaches the owner", () =>
    Effect.gen(function* () {
      const children = Array.from({ length: 40 }, (_, index) =>
        childThread(index === 0 ? "child" : `ancestor-${index}`, `ancestor-${index + 1}`),
      );
      const { stop, reads, interrupts } = harness(children);
      const error = yield* Effect.flip(stop());
      NodeAssert.equal(error._tag, "CodexBackgroundTaskNotRunningError");
      NodeAssert.ok(reads.length <= 33);
      NodeAssert.deepStrictEqual(interrupts, []);
    }),
  );

  it.effect("rejects a mismatched native read and propagates unavailable history", () =>
    Effect.gen(function* () {
      const input = {
        taskId: "codex-subagent:child",
        rootProviderThreadId: rootId,
        tasks: new Map<string, import("./CodexSubagentRouting.ts").CodexBackgroundTask>(),
        interrupt: () => Effect.die("Unverified child must not be interrupted"),
      };
      const mismatch = yield* Effect.flip(
        stopCodexBackgroundTask({
          ...input,
          readThread: () => Effect.succeed({ thread: childThread("other-child", rootId) }),
        }),
      );
      NodeAssert.equal(mismatch._tag, "CodexBackgroundTaskNotRunningError");
      const readError = CodexErrors.CodexAppServerRequestError.methodNotFound("thread/read");
      const unavailable = yield* Effect.flip(
        stopCodexBackgroundTask({
          ...input,
          readThread: () => Effect.fail(readError),
        }),
      );
      NodeAssert.strictEqual(unavailable, readError);
    }),
  );
});
