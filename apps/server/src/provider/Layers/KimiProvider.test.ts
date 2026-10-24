import { describe, expect, it } from "vite-plus/test";

import type { KimiCatalogModel } from "../acp/KimiAcpSupport.ts";
import { kimiModelsFromCatalog } from "./KimiProvider.ts";

const model = (
  alias: string,
  capabilities: ReadonlyArray<string> = ["thinking", "always_thinking"],
): KimiCatalogModel => ({
  alias,
  displayName: alias.toUpperCase(),
  maxContextSize: 1000,
  capabilities,
});

describe("kimiModelsFromCatalog", () => {
  it("puts Kimi's own default first and marks it", () => {
    const models = kimiModelsFromCatalog(
      [model("kimi-code/kimi-for-coding"), model("kimi-code/k3")],
      "kimi-code/k3",
    );
    expect(models.map((entry) => [entry.slug, entry.isDefault ?? false])).toEqual([
      ["kimi-code/k3", true],
      ["kimi-code/kimi-for-coding", false],
    ]);
  });

  it("marks nothing when the default is not in the catalog", () => {
    const models = kimiModelsFromCatalog([model("kimi-code/k3")], "kimi-code/retired");
    expect(models.some((entry) => entry.isDefault)).toBe(false);
  });

  it("offers a thinking toggle only where thinking can be switched off", () => {
    const [alwaysThinking, toggle, none] = kimiModelsFromCatalog(
      [
        model("a/always"),
        model("a/toggle", ["thinking", "tool_use"]),
        model("a/none", ["tool_use"]),
      ],
      undefined,
    );
    expect(alwaysThinking?.capabilities?.optionDescriptors).toEqual([]);
    expect(toggle?.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id)).toEqual([
      "thinking",
    ]);
    expect(none?.capabilities?.optionDescriptors).toEqual([]);
  });
});
