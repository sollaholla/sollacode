import { groupAntigravityModels } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ServerConfig } from "@t3tools/contracts";

import { buildModelOptions } from "./modelOptions";

describe("mobile model options", () => {
  it("normalizes a legacy fallback selection against current capabilities", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-test",
              name: "GPT Test",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "serviceTier",
                    label: "Service Tier",
                    type: "select",
                    options: [
                      { id: "default", label: "Standard", isDefault: true },
                      { id: "priority", label: "Fast" },
                    ],
                    currentValue: "default",
                  },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const [option] = buildModelOptions(config, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-test",
      options: [{ id: "fastMode", value: true }],
    });

    expect(option?.capabilities?.optionDescriptors?.[0]?.id).toBe("serviceTier");
    expect(option?.selection.options).toEqual([{ id: "serviceTier", value: "default" }]);
  });
});

it("groups AGY models and retains a selected legacy effort without a duplicate row", () => {
  const instanceId = ProviderInstanceId.make("agy-personal");
  const config = {
    providers: [
      {
        instanceId,
        driver: "antigravity",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        models: groupAntigravityModels([
          { slug: "gemini-flash-high", label: "Gemini Flash (High)" },
          { slug: "gemini-flash-low", label: "Gemini Flash (Low)" },
        ]),
      },
    ],
  } as unknown as ServerConfig;
  const options = buildModelOptions(config, { instanceId, model: "gemini-flash-low" });
  expect(options).toHaveLength(1);
  expect(options[0]?.label).toBe("Gemini Flash");
  expect(options[0]?.selection).toEqual({
    instanceId,
    model: "gemini-flash-low",
    options: [{ id: "effort", value: "low" }],
  });
});
