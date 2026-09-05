import {
  ProviderInstanceId,
  type ModelCapabilities,
  type ModelSelection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { selectModelWithHighEffort } from "./modelSelection.ts";

function capabilities(id = "reasoningEffort"): ModelCapabilities {
  return {
    optionDescriptors: [
      {
        id,
        label: "Reasoning",
        type: "select",
        currentValue: "low",
        options: [
          { id: "low", label: "Low", isDefault: true },
          { id: "high", label: "High" },
          { id: "max", label: "Max" },
        ],
      },
      {
        id: "serviceTier",
        label: "Service Tier",
        type: "select",
        currentValue: "default",
        options: [
          { id: "default", label: "Standard" },
          { id: "priority", label: "Fast" },
        ],
      },
    ],
  };
}

const previous: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "first-model",
  options: [{ id: "reasoningEffort", value: "low" }],
};

describe("model selection effort", () => {
  it.each(["reasoningEffort", "effort", "reasoning", "variant"])(
    "selects high through the provider's %s option, preserving other choices",
    (id) => {
      const result = selectModelWithHighEffort(
        previous,
        {
          instanceId: ProviderInstanceId.make("second-instance"),
          model: "second-model",
          options: [
            { id, value: "low" },
            { id: "serviceTier", value: "priority" },
          ],
        },
        capabilities(id),
      );
      expect(result.options).toEqual([
        { id, value: "high" },
        { id: "serviceTier", value: "priority" },
      ]);
    },
  );

  it("resets effort when changing the model on the same instance", () => {
    expect(
      selectModelWithHighEffort(previous, { ...previous, model: "second-model" }, capabilities())
        .options,
    ).toContainEqual({ id: "reasoningEffort", value: "high" });
  });

  it("preserves explicit Low or Max when the selected model has not changed", () => {
    for (const value of ["low", "max"]) {
      const selected = { ...previous, options: [{ id: "reasoningEffort", value }] };
      expect(
        selectModelWithHighEffort(
          selected,
          { instanceId: previous.instanceId, model: previous.model },
          capabilities(),
        ),
      ).toBe(selected);
    }
  });

  it("does not invent High for a provider that has no effort option or does not support it", () => {
    const next = { ...previous, model: "second-model" };
    expect(
      selectModelWithHighEffort(previous, next, { optionDescriptors: [] }).options,
    ).toBeUndefined();
    expect(
      selectModelWithHighEffort(previous, next, {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: [{ id: "medium", label: "Medium", isDefault: true }],
          },
        ],
      }).options,
    ).toEqual([{ id: "effort", value: "medium" }]);
  });
});
