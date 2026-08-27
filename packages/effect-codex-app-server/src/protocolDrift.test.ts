import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as CodexSchema from "./schema.ts";

/**
 * Codex updates itself underneath the app, and these bindings encode upstream
 * string enums as *closed* unions. When 0.150 added values to three of them,
 * every `thread/resume` carrying one stopped decoding and the provider became
 * unusable on any thread with history — with an error naming no cause.
 *
 * These assertions are not about the values being interesting; they are a
 * tripwire for a regeneration that silently narrows an enum again.
 */
const decodesAll = <A>(schema: Schema.Codec<A, string>, values: ReadonlyArray<string>) => {
  const decode = Schema.decodeUnknownSync(schema);
  for (const value of values) {
    assert.equal(decode(value), value as unknown as A);
  }
};

it("accepts every sub-agent activity kind codex can emit", () => {
  decodesAll(CodexSchema.V2ThreadResumeResponse__SubAgentActivityKind, [
    "started",
    "interacted",
    "interrupted",
    // Added in 0.150. Its absence is what broke resume.
    "completed",
  ]);
});

it("accepts every collab agent tool call status codex can emit", () => {
  decodesAll(CodexSchema.V2ThreadResumeResponse__CollabAgentToolCallStatus, [
    "inProgress",
    "completed",
    "failed",
    "interrupted",
  ]);
});

it("accepts every collab agent tool codex can emit", () => {
  decodesAll(CodexSchema.V2ThreadResumeResponse__CollabAgentTool, [
    "spawnAgent",
    "sendInput",
    "resumeAgent",
    "wait",
    "closeAgent",
    "followupTask",
    "interruptAgent",
    "listAgents",
    "sendMessage",
  ]);
});

it("keeps request methods whose params upstream made optional", () => {
  // `account/usage/read` gained `params?:` in 0.150. The generator matched only
  // `params:`, so the method vanished from the bindings without any error —
  // a dropped method is invisible until something calls it.
  assert.ok(CodexSchema.CLIENT_REQUEST_PARAMS["account/usage/read"] !== undefined);
  assert.ok(CodexSchema.CLIENT_REQUEST_RESPONSES["account/usage/read"] !== undefined);
});
