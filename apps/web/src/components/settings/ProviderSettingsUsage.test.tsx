import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { deriveProviderUsageSummaries, type ProviderUsageSummary } from "../chat/ProviderUsageBar";
import {
  IDLE_PROVIDER_USAGE_REFRESH_STATE,
  ProviderSettingsUsage,
  shouldShowProviderSettingsUsage,
} from "./ProviderSettingsUsage";
import { createProviderUsageRefreshCoordinator } from "./providerUsageRefresh";

const claudeProvider = (usage?: unknown): ServerProvider => ({
  instanceId: ProviderInstanceId.make("claude-personal"),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude Personal",
  enabled: true,
  installed: true,
  version: "2.1.219",
  status: "ready",
  auth: { status: "authenticated", email: "person@example.com" },
  checkedAt: "2026-07-29T15:00:00.000Z",
  ...(usage !== undefined
    ? {
        accountUsage: usage,
        accountUsageReportedAt: "2026-07-29T15:00:00.000Z",
      }
    : {}),
  models: [],
  slashCommands: [],
  skills: [],
});

function summary(overrides: Partial<ProviderUsageSummary> = {}): ProviderUsageSummary {
  return {
    provider: claudeProvider(),
    accountKey: "environment-local\0claudeAgent:account:test@example.com",
    state: "stale",
    reportedAt: "2026-07-29T15:00:00.000Z",
    resetCredits: null,
    windows: [
      {
        key: "current_session",
        label: "Current session",
        usedPercent: 40,
        resetAt: Date.parse("2026-07-29T22:00:00.000Z"),
      },
      {
        key: "seven_day",
        label: "Weekly",
        usedPercent: 70,
        resetAt: Date.parse("2026-08-03T00:00:00.000Z"),
      },
    ],
    ...overrides,
  };
}

describe("ProviderSettingsUsage", () => {
  it("omits usage for unsupported drivers and unsupported summaries", () => {
    const unsupported = summary({ state: "unsupported", windows: [], reportedAt: null });
    const markup = renderToStaticMarkup(
      <ProviderSettingsUsage
        displayName="External Bridge"
        driverKind={ProviderDriverKind.make("mcpBridge")}
        provider={undefined}
        summary={undefined}
        refreshState={IDLE_PROVIDER_USAGE_REFRESH_STATE}
        onRefresh={undefined}
      />,
    );

    expect(shouldShowProviderSettingsUsage(ProviderDriverKind.make("mcpBridge"), undefined)).toBe(
      false,
    );
    expect(shouldShowProviderSettingsUsage(ProviderDriverKind.make("grok"), undefined)).toBe(true);
    expect(shouldShowProviderSettingsUsage(claudeProvider().driver, unsupported)).toBe(false);
    expect(markup).toBe("");
  });

  it("shows account windows, stale state, and an accessible refresh action", () => {
    const markup = renderToStaticMarkup(
      <ProviderSettingsUsage
        displayName="Claude Personal"
        driverKind={claudeProvider().driver}
        provider={claudeProvider()}
        summary={summary()}
        refreshState={IDLE_PROVIDER_USAGE_REFRESH_STATE}
        onRefresh={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Claude Personal account usage"');
    expect(markup).toContain("Current session");
    expect(markup).toContain("Weekly");
    expect(markup).toContain("Stale");
    expect(markup).toContain('aria-label="Refresh Claude Personal usage"');
  });

  it("shows redeemable reset inventory and a use action", () => {
    const markup = renderToStaticMarkup(
      <ProviderSettingsUsage
        displayName="Codex Work"
        driverKind={ProviderDriverKind.make("codex")}
        provider={{
          ...claudeProvider(),
          instanceId: ProviderInstanceId.make("codex-work"),
          driver: ProviderDriverKind.make("codex"),
          displayName: "Codex Work",
        }}
        summary={summary({
          provider: {
            ...claudeProvider(),
            instanceId: ProviderInstanceId.make("codex-work"),
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
          },
          resetCredits: {
            availableCount: 1,
            credits: [
              {
                id: "credit-1",
                title: "Full reset",
                description: "Ready to redeem",
                expiresAt: Date.parse("2026-09-20T23:57:00.000Z"),
              },
            ],
          },
        })}
        refreshState={IDLE_PROVIDER_USAGE_REFRESH_STATE}
        onRefresh={() => undefined}
        onUseReset={async () => "reset"}
      />,
    );

    expect(markup).toContain("Usage limit resets");
    expect(markup).toContain("1 available");
    expect(markup).toContain("Full reset");
    expect(markup).toContain("Use reset");
  });

  it("links Grok to its web-only reset inventory", () => {
    const grokProvider = {
      ...claudeProvider(),
      instanceId: ProviderInstanceId.make("grok"),
      driver: ProviderDriverKind.make("grok"),
      displayName: "Grok",
    } satisfies ServerProvider;
    const markup = renderToStaticMarkup(
      <ProviderSettingsUsage
        displayName="Grok"
        driverKind={grokProvider.driver}
        provider={grokProvider}
        summary={summary({ provider: grokProvider })}
        refreshState={IDLE_PROVIDER_USAGE_REFRESH_STATE}
        onRefresh={() => undefined}
      />,
    );

    expect(markup).toContain("View Grok usage and resets");
    expect(markup).toContain("https://grok.com/automations?_s=usage");
    expect(markup).toContain('target="_blank"');
    expect(markup).not.toContain("Use reset");
  });

  it("announces in-flight refresh and keeps a truthful retryable error", () => {
    const loading = renderToStaticMarkup(
      <ProviderSettingsUsage
        displayName="Claude Personal"
        driverKind={claudeProvider().driver}
        provider={claudeProvider()}
        summary={summary()}
        refreshState={{ status: "loading", error: null }}
        onRefresh={() => undefined}
      />,
    );
    expect(loading).toContain('role="status"');
    expect(loading).toContain("Refreshing");
    expect(loading).toContain("animate-spin");
    // Announced to screen readers only. A visible "Refreshing…" line grew the
    // card by a row and pushed the quota figures down every refresh.
    expect(loading).toContain("sr-only");

    const idle = renderToStaticMarkup(
      <ProviderSettingsUsage
        displayName="Claude Personal"
        driverKind={claudeProvider().driver}
        provider={claudeProvider()}
        summary={summary()}
        refreshState={{ status: "idle", error: null }}
        onRefresh={() => undefined}
      />,
    );
    // Refreshing may disable the button and spin its icon. Nothing else about
    // the card is allowed to move while it does.
    const neutralise = (markup: string) =>
      markup
        .replaceAll(' disabled=""', "")
        .replaceAll(' aria-busy="true"', "")
        .replaceAll(' aria-busy="false"', "")
        .replaceAll(" animate-spin", "")
        .replace(/data-provider-usage-state="[a-z]+"/g, 'data-provider-usage-state="x"')
        .replaceAll(`Refreshing Claude Personal usage`, "");
    expect(neutralise(loading)).toBe(neutralise(idle));

    const failed = renderToStaticMarkup(
      <ProviderSettingsUsage
        displayName="Claude Personal"
        driverKind={claudeProvider().driver}
        provider={claudeProvider()}
        summary={summary()}
        refreshState={{ status: "error", error: "Claude usage request failed." }}
        onRefresh={() => undefined}
      />,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Claude usage request failed.");
    expect(failed).toContain("Try again");
  });

  it("propagates a targeted refresh snapshot into visible account-keyed usage", async () => {
    let currentProvider = claudeProvider();
    const refresh = vi.fn(async (instanceId: ProviderInstanceId) => {
      expect(instanceId).toBe(ProviderInstanceId.make("claude-personal"));
      currentProvider = claudeProvider({
        rate_limits_available: true,
        rate_limits: {
          five_hour: {
            utilization: 37,
            resets_at: "2026-07-29T22:00:00.000Z",
          },
          seven_day: {
            utilization: 61,
            resets_at: "2026-08-03T00:00:00.000Z",
          },
        },
      });
    });
    const coordinator = createProviderUsageRefreshCoordinator({ refresh });

    await coordinator.request(currentProvider, { ignoreFailureBackoff: true });
    const refreshedSummary = deriveProviderUsageSummaries(
      [currentProvider],
      [],
      {},
      Date.parse("2026-07-29T15:01:00.000Z"),
    )[0];
    expect(refreshedSummary).toBeDefined();

    const markup = renderToStaticMarkup(
      <ProviderSettingsUsage
        displayName="Claude Personal"
        driverKind={currentProvider.driver}
        provider={currentProvider}
        summary={refreshedSummary}
        refreshState={IDLE_PROVIDER_USAGE_REFRESH_STATE}
        onRefresh={() => undefined}
      />,
    );

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(markup).toContain("Current session");
    expect(markup).toContain("37% used");
    expect(markup).toContain("Weekly");
    expect(markup).toContain("61% used");
  });
});
