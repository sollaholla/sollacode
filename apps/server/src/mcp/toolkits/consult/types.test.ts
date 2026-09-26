import { assert, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";
import * as Schema from "effect/Schema";

import { WorkspaceConsultTool } from "./tools.ts";
import { WorkspaceConsultInput } from "./types.ts";

const decode = Schema.decodeUnknownSync(WorkspaceConsultInput);

it("accepts numeric strings for waitMs and limit, as weaker models emit them", () => {
  // 2026-09-17: OpenCode's union-alpha sent waitMs "5000.0" and the strict
  // number schema rejected the whole workspace_consult call.
  const decoded = decode({ action: "ask", question: "q", waitMs: "5000.0", limit: "10" });
  assert.equal(decoded.waitMs, 5000);
  assert.equal(decoded.limit, 10);
  assert.deepEqual(decode({ action: "ask", question: "q", waitMs: 250 }).waitMs, 250);
  assert.throws(() => decode({ action: "ask", question: "q", waitMs: "soon" }));
});

it("advertises the lenient fields as number-or-string in the MCP input schema", () => {
  const jsonSchema = Tool.getJsonSchema(WorkspaceConsultTool) as {
    readonly properties?: Record<string, unknown>;
  };
  // Effect nests `anyOf` for optional and union members; the validator on the
  // provider side (OpenCode checks MCP arguments itself) only needs both leaf
  // types to be reachable.
  const leafTypes = (node: unknown): ReadonlyArray<string> => {
    if (!node || typeof node !== "object") return [];
    const record = node as {
      readonly type?: unknown;
      readonly anyOf?: unknown;
      readonly enum?: unknown;
    };
    if (Array.isArray(record.anyOf)) return record.anyOf.flatMap(leafTypes);
    return typeof record.type === "string" && record.enum === undefined ? [record.type] : [];
  };
  for (const field of ["waitMs", "limit"]) {
    const types = leafTypes(jsonSchema.properties?.[field]);
    assert.ok(types.includes("number"), `${field} accepts a number`);
    assert.ok(types.includes("string"), `${field} accepts a numeric string`);
  }
});
