import { ProviderDriverKind } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { PROVIDER_CLIENT_DEFINITION_BY_VALUE } from "../settings/providerDriverMeta";
import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";

describe("external provider icon", () => {
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
