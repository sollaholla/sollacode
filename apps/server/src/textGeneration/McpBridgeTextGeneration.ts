import { TextGenerationError, type ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { McpBridgeClient } from "../provider/mcpBridge/McpBridgeConnection.ts";
import { MCP_BRIDGE_PROTOCOL_VERSION } from "../provider/mcpBridge/McpBridgeProtocol.ts";
import type * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPlanRefreshPrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
  buildVmAgentTaskPrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePlanRefreshSteps,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

type Operation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generatePlanRefresh"
  | "generateVmAgentTaskPrompt";

function errorDetail(cause: unknown): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : String(cause);
}

export function makeMcpBridgeTextGeneration(
  connection: McpBridgeClient,
): TextGeneration.TextGeneration["Service"] {
  const runJson = <S extends Schema.Top>(input: {
    readonly operation: Operation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const descriptor = yield* Effect.tryPromise({
        try: () => connection.describe(),
        catch: (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: `Could not negotiate the external bridge descriptor: ${errorDetail(cause)}`,
            cause,
          }),
      });
      if (!descriptor.capabilities.textGeneration) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "This external provider bridge does not advertise textGeneration support.",
        });
      }
      if (!descriptor.models.some((model) => model.id === input.modelSelection.model)) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: `Model '${input.modelSelection.model}' is not advertised by this bridge.`,
        });
      }
      const response = yield* Effect.tryPromise({
        try: () =>
          connection.call(
            "provider_bridge.generate_text",
            {
              protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
              prompt: input.prompt,
              model: input.modelSelection.model,
              workspace: input.cwd,
              timeoutSeconds: 180,
              maxChars: 20_000,
            },
            190_000,
          ),
        catch: (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: `External bridge text generation failed: ${errorDetail(cause)}`,
            cause,
          }),
      });
      if (typeof response.text !== "string" || response.text.trim().length === 0) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "External bridge returned empty text generation output.",
        });
      }
      const responseText = response.text;
      const encoded = yield* Effect.try({
        try: () => extractJsonObject(responseText),
        catch: (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: "External bridge returned output without a JSON object.",
            cause,
          }),
      });
      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchema));
      return yield* decodeOutput(encoded).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "External bridge returned invalid structured text-generation output.",
              cause,
            }),
        ),
      );
    });

  return {
    generateCommitMessage: Effect.fn("McpBridgeTextGeneration.generateCommitMessage")(
      function* (input) {
        const { prompt, outputSchema } = buildCommitMessagePrompt({
          branch: input.branch,
          stagedSummary: input.stagedSummary,
          stagedPatch: input.stagedPatch,
          includeBranch: input.includeBranch === true,
          policy: input.policy,
        });
        const generated = yield* runJson({
          operation: "generateCommitMessage",
          cwd: input.cwd,
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        });
        return {
          subject: sanitizeCommitSubject(generated.subject),
          body: generated.body.trim(),
          ...("branch" in generated && typeof generated.branch === "string"
            ? { branch: sanitizeFeatureBranchName(generated.branch) }
            : {}),
        };
      },
    ),
    generatePrContent: Effect.fn("McpBridgeTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        changeRequestTemplate: input.changeRequestTemplate,
        policy: input.policy,
      });
      const generated = yield* runJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    }),
    generateBranchName: Effect.fn("McpBridgeTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    }),
    generateThreadTitle: Effect.fn("McpBridgeTextGeneration.generateThreadTitle")(
      function* (input) {
        const { prompt, outputSchema } = buildThreadTitlePrompt({
          message: input.message,
          attachments: input.attachments,
        });
        const generated = yield* runJson({
          operation: "generateThreadTitle",
          cwd: input.cwd,
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        });
        return { title: sanitizeThreadTitle(generated.title) };
      },
    ),
    generatePlanRefresh: Effect.fn("McpBridgeTextGeneration.generatePlanRefresh")(
      function* (input) {
        const { prompt, outputSchema } = buildPlanRefreshPrompt({
          transcript: input.transcript,
          currentSteps: input.currentSteps,
        });
        const generated = yield* runJson({
          operation: "generatePlanRefresh",
          cwd: input.cwd,
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        });
        return { steps: sanitizePlanRefreshSteps(generated.steps) };
      },
    ),
    generateVmAgentTaskPrompt: Effect.fn("McpBridgeTextGeneration.generateVmAgentTaskPrompt")(
      function* (input) {
        const { prompt, outputSchema } = buildVmAgentTaskPrompt(input);
        return yield* runJson({
          operation: "generateVmAgentTaskPrompt",
          cwd: input.cwd,
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        });
      },
    ),
  } satisfies TextGeneration.TextGeneration["Service"];
}
