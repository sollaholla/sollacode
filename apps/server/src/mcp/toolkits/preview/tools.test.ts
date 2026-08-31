import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { PreviewToolkit } from "./tools.ts";

const schemaHasDescription = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (typeof record.description === "string" && record.description.length > 0) return true;
  return [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .some((members) => members.some(schemaHasDescription));
};

it("exports provider-compatible object schemas with described parameters", () => {
  for (const tool of Object.values(PreviewToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    expect(
      schema.properties?.tabId,
      `${tool.name} must allow an explicit collaborative browser tab target`,
    ).toBeDefined();
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      expect(
        schemaHasDescription(fieldSchema),
        `${tool.name}.${field} should explain what data the agent must pass`,
      ).toBe(true);
    }
  }
});

it("tells agents that preview_status.visible is presentation, not a blocker", () => {
  // A Suno session stalled on 2026-08-31: the tab reported
  // `available: true, visible: false` (the renderer overwrites the host's
  // value with its on-screen presentation flag), and the agent abandoned
  // already-approved work. Every other flag this description names is a real
  // stop condition, so `visible` must say plainly that it is not one.
  const description = PreviewToolkit.tools.preview_status.description ?? "";
  expect(description).toContain("is the only readiness flag here");
  expect(description).toContain("is NOT a blocker");
  expect(description).toContain("keep clicking, typing, and snapshotting it");
  expect(description).not.toMatch(/title, visibility, loading state/);
});
