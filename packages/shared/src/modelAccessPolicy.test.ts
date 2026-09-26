import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ServerSettings,
  type ModelAccessPolicy,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  modelAccessPolicyAllows,
  modelAccessPoliciesAllow,
  threadModelPolicyChain,
} from "./modelAccessPolicy.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const selection = { instanceId: ProviderInstanceId.make("codex-work"), model: "gpt-6-astra" };
const allow: ModelAccessPolicy = { mode: "allow", models: [selection] };
describe("model restrictions", () => {
  it("decodes old settings as unrestricted", () => {
    const settings = decodeSettings({});
    expect(settings.fallbackModelPolicy).toEqual({ mode: "all", models: [] });
    expect(settings.threadModelPolicies).toEqual({});
  });
  it.each([undefined, { mode: "all", models: [] }, { mode: "block", models: [] }] as const)(
    "keeps unrestricted policies compatible: %j",
    (policy) => expect(modelAccessPolicyAllows(policy, selection)).toBe(true),
  );
  it("an empty allowlist denies every model", () =>
    expect(modelAccessPolicyAllows({ mode: "allow", models: [] }, selection)).toBe(false));
  it("matches the exact provider instance, model and case", () => {
    expect(modelAccessPolicyAllows(allow, selection)).toBe(true);
    expect(
      modelAccessPolicyAllows(allow, {
        ...selection,
        instanceId: ProviderInstanceId.make("codex"),
      }),
    ).toBe(false);
    expect(modelAccessPolicyAllows(allow, { ...selection, model: "GPT-6-ASTRA" })).toBe(false);
    expect(modelAccessPolicyAllows(allow, { ...selection, model: "gpt-6-sol" })).toBe(false);
  });
  it("a child's allowlist cannot override a parent block", () =>
    expect(
      modelAccessPoliciesAllow([allow, { mode: "block", models: [selection] }], selection),
    ).toBe(false));
  it("inherits all ancestors and detects cycles and missing ancestry", () => {
    const policies = {
      root: allow,
      child: { mode: "block", models: [] } satisfies ModelAccessPolicy,
    };
    expect(
      threadModelPolicyChain({
        threadId: "child",
        policies,
        getParent: (id) => (id === "child" ? "root" : null),
      }),
    ).toEqual({ policies: [policies.child, allow], complete: true });
    expect(
      threadModelPolicyChain({ threadId: "child", policies, getParent: () => "child" }).complete,
    ).toBe(false);
    expect(
      threadModelPolicyChain({ threadId: "child", policies, getParent: () => undefined }).complete,
    ).toBe(false);
  });
  it("patches one thread without dropping another and replaces its previous list", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      threadModelPolicies: { a: allow, b: allow },
    });
    const second = applyServerSettingsPatch(first, {
      threadModelPolicies: { a: { mode: "allow", models: [] } },
    });
    expect(second.threadModelPolicies).toEqual({ a: { mode: "allow", models: [] }, b: allow });
    const reset = applyServerSettingsPatch(second, {
      threadModelPolicies: { a: { mode: "all", models: [] } },
    });
    expect(modelAccessPolicyAllows(reset.threadModelPolicies.a, selection)).toBe(true);
  });
  it("replaces the global list without merging old selections back", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { fallbackModelPolicy: allow });
    expect(
      applyServerSettingsPatch(first, { fallbackModelPolicy: { mode: "allow", models: [] } })
        .fallbackModelPolicy.models,
    ).toEqual([]);
  });
});
