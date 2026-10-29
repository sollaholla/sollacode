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

  it("hides every provider's unfinished status check, not just Codex's", () => {
    const unknown = (driver: string, message: string): ServerProvider => ({
      ...warningProvider(),
      instanceId: ProviderInstanceId.make(driver),
      driver: ProviderDriverKind.make(driver),
      auth: { status: "unknown" },
      message,
    });
    for (const status of [
      unknown(
        "claudeAgent",
        "Could not verify Claude authentication status from initialization result.",
      ),
      unknown("claudeAgent", "Claude provider status has not been checked in this session yet."),
      unknown("cursor", "Could not verify Cursor Agent authentication status."),
      unknown("cursor", "Checking Cursor Agent availability..."),
      unknown(
        "grok",
        "Grok CLI is installed. ACP handshake timed out after 8000ms; using built-in models.",
      ),
      unknown(
        "kimi",
        "Kimi Code CLI is installed, but its ACP sign-in check timed out after 8000ms.",
      ),
    ]) {
      expect(shouldShowProviderStatusBanner(status, null)).toBe(false);
    }
    // A warning that asks something of the person still shows.
    expect(
      shouldShowProviderStatusBanner(
        unknown(
          "cursor",
          "The `agent about` command is unavailable in this version of the Cursor Agent CLI.",
        ),
        null,
      ),
    ).toBe(true);
    // So does a known sign-out, which is an error, not an unfinished check.
    expect(
      shouldShowProviderStatusBanner(
        {
          ...unknown("claudeAgent", "Could not verify Claude authentication status."),
          status: "error",
          auth: { status: "unauthenticated" },
        },
        null,
      ),
    ).toBe(true);
  });

  it("keeps a reconnect retry subtle while the last authenticated state is retained", () => {
    const status = {
      ...warningProvider(),
      message:
        "Reconnecting to Codex. Showing the last confirmed account status while Solla Code retries.",
    };

    expect(isTransientProviderStatusCheck(status)).toBe(true);
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
