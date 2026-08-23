import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { AppUpdateToolkit } from "./appUpdate/tools.ts";
import { ActionApprovalToolkit } from "./actionApproval/tools.ts";
import { ThreadCollaborationToolkit } from "./collaboration/tools.ts";
import { ThreadHistoryToolkit } from "./history/tools.ts";
import { PreviewSnapshotToolkit, PreviewStandardToolkit, PreviewToolkit } from "./preview/tools.ts";
import { ThreadTerminalsToolkit } from "./terminals/tools.ts";
import { WorkspaceConsultToolkit } from "./consult/tools.ts";
import { WorkspaceOrchestrationToolkit } from "./workspace/tools.ts";

/**
 * Every toolkit that is (or can be) registered on the MCP server.
 *
 * This list is deliberately exhaustive rather than derived: a new toolkit that
 * nobody adds here is a new toolkit nobody schema-checks.
 */
const ALL_TOOLKITS = {
  ActionApprovalToolkit,
  AppUpdateToolkit,
  ThreadCollaborationToolkit,
  ThreadHistoryToolkit,
  PreviewToolkit,
  PreviewStandardToolkit,
  PreviewSnapshotToolkit,
  WorkspaceOrchestrationToolkit,
  WorkspaceConsultToolkit,
  ThreadTerminalsToolkit,
} as const;

/**
 * MCP requires a tool's `inputSchema` to be a top-level `type: "object"`.
 *
 * This is not a soft compatibility preference: the @modelcontextprotocol/sdk
 * client validates the whole `tools/list` response, so a single tool exporting a
 * root `anyOf` (which is what an Effect `Schema.Union` of per-action structs
 * compiles to) makes the client reject *every* tool on the server, not just the
 * offending one. That failure mode is silent and total, and it has happened —
 * hence this test covering all toolkits rather than one.
 *
 * Model a multi-action tool as a flat struct with an `action` literal union plus
 * optional per-action fields, and enforce the per-action requirements in the
 * handler.
 */
it("exports a top-level object schema for every MCP tool", () => {
  for (const [toolkitName, toolkit] of Object.entries(ALL_TOOLKITS)) {
    for (const tool of Object.values(toolkit.tools)) {
      const schema = Tool.getJsonSchema(tool) as {
        readonly type?: unknown;
        readonly anyOf?: unknown;
        readonly oneOf?: unknown;
        readonly allOf?: unknown;
      };
      const label = `${toolkitName}.${tool.name}`;

      expect(schema.type, `${label} must export a top-level object schema`).toBe("object");
      expect(schema.anyOf, `${label} must not export a root anyOf`).toBeUndefined();
      expect(schema.oneOf, `${label} must not export a root oneOf`).toBeUndefined();
      expect(schema.allOf, `${label} must not export a root allOf`).toBeUndefined();
    }
  }
});

it("gives every MCP tool a description an agent can route on", () => {
  for (const [toolkitName, toolkit] of Object.entries(ALL_TOOLKITS)) {
    for (const tool of Object.values(toolkit.tools)) {
      expect(
        tool.description?.length ?? 0,
        `${toolkitName}.${tool.name} should have a useful description`,
      ).toBeGreaterThan(40);
    }
  }
});
