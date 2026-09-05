import { ProviderDriverKind } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { PROVIDER_CLIENT_DEFINITION_BY_VALUE } from "../settings/providerDriverMeta";
import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";

describe("external provider icon", () => {
  it("keeps every built-in provider icon consistent with settings", () => {
    for (const definition of Object.values(PROVIDER_CLIENT_DEFINITION_BY_VALUE)) {
      if (definition === undefined) continue;
      expect(PROVIDER_ICON_BY_PROVIDER[definition.value]).toBe(definition.icon);
    }
  });
  it("uses Lucide's plug glyph across chat and provider settings", () => {
    const driver = ProviderDriverKind.make("mcpBridge");
    const chatIcon = PROVIDER_ICON_BY_PROVIDER[driver];
    const settingsIcon = PROVIDER_CLIENT_DEFINITION_BY_VALUE[driver]?.icon;

    expect(chatIcon).toBeDefined();
    expect(settingsIcon).toBe(chatIcon);

    const Icon = chatIcon!;
    const markup = renderToStaticMarkup(<Icon aria-label="External provider" />);
    expect(markup).toContain("lucide-plug");
    expect(markup).toContain('aria-label="External provider"');
  });
});
