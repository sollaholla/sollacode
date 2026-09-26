import { assert, it } from "@effect/vitest";
import { getProviderOptionDescriptors } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import {
  applyPreferredCodexDefaultModel,
  CODEX_OPTIONAL_RATE_LIMITS_TIMEOUT,
  mapCodexModelCapabilities,
  codexUsageStatusFor,
  settleOptionalCodexRateLimits,
} from "./CodexProvider.ts";

it.effect("does not let optional rate limits block Codex readiness", () =>
  Effect.gen(function* () {
    const fiber = yield* settleOptionalCodexRateLimits(Effect.never).pipe(Effect.forkChild);

    yield* TestClock.adjust(CODEX_OPTIONAL_RATE_LIMITS_TIMEOUT);

    const result = yield* Fiber.join(fiber);
    // Times out without failing the probe - and says so. It used to answer
    // `None`, indistinguishable from "this account reports no usage", which
    // is how a slow network answer aged a card into "Stale" with no reason.
    assert.equal(result.kind, "timeout");
    assert.equal(codexUsageStatusFor(result).state, "error");
  }),
);

it.effect("reports a rejected usage request as a reason, not as absent usage", () =>
  Effect.gen(function* () {
    const result = yield* settleOptionalCodexRateLimits(
      Effect.fail({ _tag: "CodexRequestError" as const, message: "method not found" }),
    );
    assert.equal(result.kind, "failed");
    assert.equal(codexUsageStatusFor(result).state, "error");
  }),
);

it.effect("passes a real reading straight through as available", () =>
  Effect.gen(function* () {
    const payload = { rateLimits: [] } as never;
    const result = yield* settleOptionalCodexRateLimits(Effect.succeed(payload));
    assert.equal(result.kind, "ok");
    assert.equal(codexUsageStatusFor(result).state, "available");
  }),
);

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("defaults GPT-5.6-Sol to high reasoning and standard routing unless options override it", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "high",
    defaultServiceTier: "priority",
    description: "Test model",
    displayName: "GPT-5.6-Sol",
    hidden: false,
    id: "gpt-5.6-sol",
    isDefault: true,
    model: "gpt-5.6-sol",
    serviceTiers: [
      {
        id: "priority",
        name: "Priority",
        description: "Lower latency responses.",
      },
    ],
    supportedReasoningEfforts: [
      { description: "Balanced reasoning", reasoningEffort: "medium" },
      { description: "More reasoning", reasoningEffort: "high" },
    ],
  });

  assert.deepStrictEqual(
    capabilities.optionDescriptors?.map((descriptor) => ({
      id: descriptor.id,
      currentValue: descriptor.currentValue,
      defaultOption:
        descriptor.type === "select"
          ? descriptor.options.find((option) => option.isDefault)?.id
          : undefined,
    })),
    [
      { id: "reasoningEffort", currentValue: "high", defaultOption: "high" },
      { id: "serviceTier", currentValue: "default", defaultOption: "default" },
    ],
  );

  const overridden = getProviderOptionDescriptors({
    caps: capabilities,
    selections: [
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "priority" },
    ],
  });
  assert.deepStrictEqual(
    overridden.map((descriptor) => ({
      id: descriptor.id,
      currentValue: descriptor.currentValue,
    })),
    [
      { id: "reasoningEffort", currentValue: "high" },
      { id: "serviceTier", currentValue: "priority" },
    ],
  );
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("promotes astra the moment Codex starts offering it", () => {
  // Listed ahead of release. The preference is applied per snapshot, so the
  // first model/list that carries Astra promotes it with no release of ours in
  // between - which is the whole point of putting it in early.
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "gpt-5.6-sol",
      name: "GPT-5.6-Sol",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "gpt-6-astra", name: "GPT-6 Astra", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-6-astra");
});

it("leaves today's default alone while astra is still unavailable", () => {
  // The anticipatory entry must be inert: an account that cannot see Astra yet
  // has to keep landing on Sol exactly as before.
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});
