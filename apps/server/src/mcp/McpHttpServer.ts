import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpBody, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { mcpServerInstructionsForScope } from "./McpServerInstructions.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import { ActionApprovalToolkitHandlersLive } from "./toolkits/actionApproval/handlers.ts";
import * as ActionApprovalPrompt from "./toolkits/actionApproval/prompt.ts";
import { ActionApprovalToolkit } from "./toolkits/actionApproval/tools.ts";
import { AppUpdateToolkitHandlersLive } from "./toolkits/appUpdate/handlers.ts";
import { AppUpdateToolkit } from "./toolkits/appUpdate/tools.ts";
import { ThreadArtifactToolkitHandlersLive } from "./toolkits/artifacts/handlers.ts";
import { ThreadArtifactToolkit } from "./toolkits/artifacts/tools.ts";
import * as DesktopAppUpdateConfirmation from "./toolkits/appUpdate/confirmation.ts";
import { ThreadCollaborationToolkitHandlersLive } from "./toolkits/collaboration/handlers.ts";
import { ThreadCollaborationToolkit } from "./toolkits/collaboration/tools.ts";
import { ThreadHistoryToolkitHandlersLive } from "./toolkits/history/handlers.ts";
import * as ThreadHistoryQuery from "./toolkits/history/ThreadHistoryQuery.ts";
import { ThreadHistoryToolkit } from "./toolkits/history/tools.ts";
import { ThreadTerminalsToolkitHandlersLive } from "./toolkits/terminals/handlers.ts";
import { ThreadTerminalsToolkit } from "./toolkits/terminals/tools.ts";
import { WorkspaceConsultToolkitHandlersLive } from "./toolkits/consult/handlers.ts";
import { WorkspaceConsultToolkit } from "./toolkits/consult/tools.ts";
import { WorkspaceOrchestrationToolkitHandlersLive } from "./toolkits/workspace/handlers.ts";
import { WorkspaceOrchestrationToolkit } from "./toolkits/workspace/tools.ts";
import { AgentBuilderToolkitHandlersLive } from "./toolkits/agentBuilder/handlers.ts";
import { AgentBuilderToolkit } from "./toolkits/agentBuilder/tools.ts";
import { AgentWorkspaceToolkitHandlersLive } from "./toolkits/agentWorkspace/handlers.ts";
import { AgentWorkspaceToolkit } from "./toolkits/agentWorkspace/tools.ts";
import { AgentCollaborationToolkitHandlersLive } from "./toolkits/agentCollaboration/handlers.ts";
import { AgentCollaborationToolkit } from "./toolkits/agentCollaboration/tools.ts";
import {
  PreviewSnapshotToolkitHandlersLive,
  PreviewStandardToolkitHandlersLive,
} from "./toolkits/preview/handlers.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_mcp_credential",
    message: "A valid provider-scoped MCP bearer credential is required.",
  },
  {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": "Bearer",
    },
  },
);

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>;

type McpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function injectInitializeInstructions(value: unknown, instructions: string): boolean {
  if (!isRecord(value) || !isRecord(value.result)) return false;
  const result = value.result;
  if (
    typeof result.protocolVersion !== "string" ||
    !isRecord(result.capabilities) ||
    !isRecord(result.serverInfo) ||
    result.instructions !== undefined
  ) {
    return false;
  }
  result.instructions = instructions;
  return true;
}

function withMcpInitializeInstructions(
  response: HttpServerResponse.HttpServerResponse,
  invocation: McpInvocationContext.McpInvocationScope | undefined,
): HttpServerResponse.HttpServerResponse {
  if (
    invocation === undefined ||
    response.status !== 200 ||
    response.body._tag !== "Uint8Array" ||
    !response.body.contentType.includes("json") ||
    response.body.contentLength === 0
  ) {
    return response;
  }

  try {
    const payload = JSON.parse(new TextDecoder().decode(response.body.body)) as unknown;
    const instructions = mcpServerInstructionsForScope(invocation);
    let changed = false;
    if (Array.isArray(payload)) {
      for (const entry of payload) {
        changed = injectInitializeInstructions(entry, instructions) || changed;
      }
    } else {
      changed = injectInitializeInstructions(payload, instructions);
    }
    return changed
      ? HttpServerResponse.setBody(
          response,
          HttpBody.jsonUnsafe(payload, response.body.contentType),
        )
      : response;
  } catch {
    return response;
  }
}

export const normalizeMcpHttpResponse = (
  response: HttpServerResponse.HttpServerResponse,
  invocation?: McpInvocationContext.McpInvocationScope,
): HttpServerResponse.HttpServerResponse => {
  const normalized = withMcpInitializeInstructions(response, invocation);
  const bodyIsEmpty =
    normalized.body._tag === "Empty" ||
    (normalized.body._tag === "Uint8Array" && normalized.body.contentLength === 0) ||
    (normalized.body._tag === "Raw" && normalized.body.contentLength === 0);
  return normalized.status === 200 && bodyIsEmpty
    ? HttpServerResponse.setStatus(normalized, 202)
    : normalized;
};

const makeMcpAuthMiddleware = McpSessionRegistry.McpSessionRegistry.pipe(
  Effect.map(
    (registry): McpAuthMiddleware =>
      Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers.authorization;
        const token =
          authorization?.startsWith("Bearer ") === true
            ? authorization.slice("Bearer ".length).trim()
            : "";
        const invocation = yield* registry.resolve(token);
        if (!invocation) {
          // Without this the only symptom of a dead credential is the agent
          // quietly losing the whole `t3-code` toolkit for the rest of its
          // session, with nothing on the server to explain why.
          yield* Effect.logWarning("rejected MCP request with an unusable credential", {
            reason: token.length === 0 ? "missing_bearer_token" : "unknown_or_expired_token",
          });
          return unauthorized;
        }
        return yield* httpEffect.pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.map((response) => normalizeMcpHttpResponse(response, invocation)),
        );
      }),
  ),
  Effect.withSpan("McpHttpServer.makeAuthMiddleware"),
);

const McpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware).layer;

const previewSnapshotFailure = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.failCause(cause).pipe(Effect.orDie);
  }
  const failures = cause.reasons.filter(Cause.isFailReason);
  const firstFailure = failures[0]?.error;
  const errorTag =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "_tag" in firstFailure &&
    typeof firstFailure._tag === "string"
      ? firstFailure._tag
      : "PreviewSnapshotError";
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: errorTag,
        operation: "snapshot",
        failureCount: failures.length,
      },
    },
    content: [{ type: "text", text: "Preview snapshot failed." }],
  });
  return Effect.logWarning("preview snapshot failed", {
    operation: "snapshot",
    errorTag,
    failureCount: failures.length,
  }).pipe(Effect.as(result));
};

const registerPreviewSnapshot = Effect.fn("McpHttpServer.registerPreviewSnapshot")(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const built = yield* PreviewSnapshotToolkit;
  const tool = PreviewSnapshotTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return built.handle("preview_snapshot", payload).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.matchCauseEffect({
            onFailure: previewSnapshotFailure,
            onSuccess: ({ encodedResult }) => {
              const snapshot = encodedResult as {
                readonly screenshot: {
                  readonly mimeType: "image/png";
                  readonly data: string;
                  readonly width: number;
                  readonly height: number;
                };
                readonly [key: string]: unknown;
              };
              const { screenshot, ...page } = snapshot;
              const metadata = {
                ...page,
                screenshot: {
                  mimeType: screenshot.mimeType,
                  width: screenshot.width,
                  height: screenshot.height,
                },
              };
              return Effect.succeed(
                new McpSchema.CallToolResult({
                  isError: false,
                  structuredContent: metadata,
                  content: [
                    { type: "text", text: JSON.stringify(metadata) },
                    {
                      type: "image",
                      data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
                      mimeType: screenshot.mimeType,
                    },
                  ],
                }),
              );
            },
          }),
        );
      }),
  });
});

const PreviewStandardToolkitRegistrationLive = McpServer.toolkit(PreviewStandardToolkit).pipe(
  Layer.provide(PreviewStandardToolkitHandlersLive),
);

const PreviewSnapshotRegistrationLive = Layer.effectDiscard(registerPreviewSnapshot()).pipe(
  Layer.provide(PreviewSnapshotToolkitHandlersLive),
);

export const PreviewToolkitRegistrationLive = Layer.mergeAll(
  PreviewStandardToolkitRegistrationLive,
  PreviewSnapshotRegistrationLive,
);

export const ThreadHistoryToolkitRegistrationLive = McpServer.toolkit(ThreadHistoryToolkit).pipe(
  Layer.provide(ThreadHistoryToolkitHandlersLive),
  Layer.provide(ThreadHistoryQuery.layer),
);

export const ThreadCollaborationToolkitRegistration = McpServer.toolkit(
  ThreadCollaborationToolkit,
).pipe(Layer.provide(ThreadCollaborationToolkitHandlersLive));

export const ThreadCollaborationToolkitRegistrationLive =
  ThreadCollaborationToolkitRegistration.pipe(Layer.provide(ThreadHistoryQuery.layer));

export const AppUpdateToolkitRegistrationLive = McpServer.toolkit(AppUpdateToolkit).pipe(
  Layer.provide(AppUpdateToolkitHandlersLive),
  Layer.provide(DesktopAppUpdateConfirmation.layer),
);

export const ActionApprovalToolkitRegistrationLive = McpServer.toolkit(ActionApprovalToolkit).pipe(
  Layer.provide(ActionApprovalToolkitHandlersLive),
  Layer.provide(ActionApprovalPrompt.layer),
);

export const WorkspaceOrchestrationToolkitRegistrationLive = McpServer.toolkit(
  WorkspaceOrchestrationToolkit,
).pipe(Layer.provide(WorkspaceOrchestrationToolkitHandlersLive));

export const ThreadTerminalsToolkitRegistrationLive = McpServer.toolkit(
  ThreadTerminalsToolkit,
).pipe(Layer.provide(ThreadTerminalsToolkitHandlersLive));

export const WorkspaceConsultToolkitRegistrationLive = McpServer.toolkit(
  WorkspaceConsultToolkit,
).pipe(Layer.provide(WorkspaceConsultToolkitHandlersLive));

export const AgentWorkspaceToolkitRegistrationLive = McpServer.toolkit(AgentWorkspaceToolkit).pipe(
  Layer.provide(AgentWorkspaceToolkitHandlersLive),
);

export const AgentBuilderToolkitRegistrationLive = McpServer.toolkit(AgentBuilderToolkit).pipe(
  Layer.provide(AgentBuilderToolkitHandlersLive),
);

export const AgentCollaborationToolkitRegistrationLive = McpServer.toolkit(
  AgentCollaborationToolkit,
).pipe(Layer.provide(AgentCollaborationToolkitHandlersLive));

export const ThreadArtifactToolkitRegistrationLive = McpServer.toolkit(ThreadArtifactToolkit).pipe(
  Layer.provide(ThreadArtifactToolkitHandlersLive),
);

const McpTransportLive = McpServer.layerHttp({
  name: "Solla Code",
  version: packageJson.version,
  path: "/mcp",
}).pipe(Layer.provide(McpAuthMiddlewareLive));

export const layer = Layer.mergeAll(
  PreviewToolkitRegistrationLive,
  ThreadHistoryToolkitRegistrationLive,
  ThreadCollaborationToolkitRegistrationLive,
  ActionApprovalToolkitRegistrationLive,
  AppUpdateToolkitRegistrationLive,
  WorkspaceOrchestrationToolkitRegistrationLive,
  ThreadTerminalsToolkitRegistrationLive,
  WorkspaceConsultToolkitRegistrationLive,
  AgentWorkspaceToolkitRegistrationLive,
  AgentBuilderToolkitRegistrationLive,
  AgentCollaborationToolkitRegistrationLive,
  ThreadArtifactToolkitRegistrationLive,
).pipe(Layer.provideMerge(McpTransportLive));
