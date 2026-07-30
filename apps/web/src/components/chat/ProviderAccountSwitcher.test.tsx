import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProviderAccountSwitcher } from "./ProviderAccountSwitcher";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex_personal"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex Personal",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", email: "personal@example.com" },
  checkedAt: "2026-07-29T15:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("ProviderAccountSwitcher", () => {
  it("renders an accessible account indicator beside composer actions", () => {
    const markup = renderToStaticMarkup(
      <ProviderAccountSwitcher
        providers={[provider]}
        activeInstanceId={provider.instanceId}
        disabledReason={null}
        hasDraftContent={false}
        onSelectProfile={() => undefined}
        onPrepareNativeLogin={() => undefined}
      />,
    );

    expect(markup).toContain('data-chat-provider-account-switcher="true"');
    expect(markup).toContain('aria-label="Provider account: personal@example.com"');
  });

  it("truthfully labels an unauthenticated configured profile", () => {
    const signedOut: ServerProvider = {
      ...provider,
      auth: { status: "unauthenticated" },
    };
    const markup = renderToStaticMarkup(
      <ProviderAccountSwitcher
        providers={[signedOut]}
        activeInstanceId={signedOut.instanceId}
        disabledReason="Finish or stop the active turn before switching accounts."
        hasDraftContent={false}
        onSelectProfile={() => undefined}
        onPrepareNativeLogin={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Provider account: Not signed in"');
  });
});
