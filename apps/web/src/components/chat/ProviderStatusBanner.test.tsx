import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  getProviderStatusBannerKey,
  isTransientProviderStatusCheck,
  ProviderStatusBanner,
  shouldShowProviderStatusBanner,
} from "./ProviderStatusBanner";

function warningProvider(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "warning",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-23T12:00:00.000Z",
    message: "Provider is temporarily degraded.",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("ProviderStatusBanner", () => {
  it("stays hidden after its current warning is dismissed", () => {
    const status = warningProvider();

    expect(shouldShowProviderStatusBanner(status, null)).toBe(true);
    expect(shouldShowProviderStatusBanner(status, getProviderStatusBannerKey(status))).toBe(false);
  });

  it("renders an accessible dismiss control for provider warnings", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner status={warningProvider()} onDismiss={() => {}} />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-label="Dismiss Codex provider warning"');
    expect(markup).toContain("absolute top-2 right-2");
  });

  it("renders on a glass surface so the timeline never reads through the banner", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner status={warningProvider()} onDismiss={() => {}} />,
    );

    expect(markup).toContain("alert-glass");
    expect(markup).toContain('data-variant="warning"');
  });

  it("hides transient Codex status checks while the server retries", () => {
    const status = {
      ...warningProvider(),
      auth: { status: "unknown" as const },
      message:
        "Codex can still be used, but its status check timed out. The next provider refresh will try again.",
    };
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner status={status} onDismiss={() => {}} />,
    );

    expect(isTransientProviderStatusCheck(status)).toBe(true);
    expect(shouldShowProviderStatusBanner(status, null)).toBe(false);
    expect(markup).toBe("");
  });

  it("hides the initial Codex status while its first check is running", () => {
    const status = {
      ...warningProvider(),
      auth: { status: "unknown" as const },
      message: "Codex provider status has not been checked in this session yet.",
    };

    expect(shouldShowProviderStatusBanner(status, null)).toBe(false);
  });

  it("labels error dismiss controls with the correct severity", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner
        status={{ ...warningProvider(), status: "error" }}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain('aria-label="Dismiss Codex provider error"');
  });
});
