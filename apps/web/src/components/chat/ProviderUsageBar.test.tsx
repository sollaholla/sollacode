import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationThreadActivity,
  type ServerProvider,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveProviderUsageReports,
  deriveProviderUsageSummaries,
  ProviderUsageBar,
  ProviderUsageDetails,
  ProviderUsagePlacementRow,
  providerUsageDetailsSide,
  resolveProviderUsagePlacement,
  usageThreshold,
} from "./ProviderUsageBar";
import { mergeProviderUsageEntry, providerUsageAccountKey } from "../../providerUsageStore";

const makeProvider = (driver: string, instanceId = driver, email?: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  displayName: driver === "claudeAgent" ? "Claude" : driver === "codex" ? "Codex" : driver,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", ...(email ? { email } : {}) },
  checkedAt: "2026-07-29T15:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

const usageActivity = (
  id: string,
  provider: string,
  providerInstanceId: string,
  rateLimits: unknown,
  createdAt = "2026-07-29T15:00:00.000Z",
): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  tone: "info",
  kind: "provider.usage.updated",
  summary: "Provider usage updated",
  payload: {
    provider,
    providerInstanceId,
    rateLimits,
  },
  turnId: null,
  createdAt,
});

describe("provider usage summaries", () => {
  it("omits Codex's retired five-hour window while preserving reported weekly and credit data", () => {
    const summaries = deriveProviderUsageSummaries(
      [makeProvider("codex")],
      [
        usageActivity("codex-usage", "codex", "codex", {
          rateLimits: {
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
            secondary: {
              usedPercent: 60,
              windowDurationMins: 10_080,
              resetsAt: 1_800_100_000,
            },
            credits: { hasCredits: true, unlimited: false, balance: "42" },
          },
        }),
      ],
      {},
      Date.parse("2026-07-29T15:01:00.000Z"),
    );

    expect(summaries[0]?.state).toBe("available");
    expect(summaries[0]?.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Weekly", usedPercent: 60 }),
        expect.objectContaining({ label: "Credits", detail: "42" }),
      ]),
    );
    expect(summaries[0]?.windows).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "5 hour" })]),
    );
  });

  it("merges Claude day, current-session, weekly, and Fable windows only when reported", () => {
    const summaries = deriveProviderUsageSummaries(
      [makeProvider("claudeAgent")],
      [
        usageActivity("claude-day", "claudeAgent", "claudeAgent", {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            rateLimitType: "one_day",
            utilization: 0.2,
          },
        }),
        usageActivity("claude-5h", "claudeAgent", "claudeAgent", {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            rateLimitType: "five_hour",
            utilization: 0.4,
            resetsAt: 1_800_000_000,
          },
        }),
        usageActivity(
          "claude-week",
          "claudeAgent",
          "claudeAgent",
          {
            type: "rate_limit_event",
            rate_limit_info: {
              status: "allowed_warning",
              rateLimitType: "seven_day_opus",
              utilization: 0.85,
            },
          },
          "2026-07-29T15:01:00.000Z",
        ),
        usageActivity(
          "claude-fable",
          "claudeAgent",
          "claudeAgent",
          {
            type: "rate_limit_event",
            rate_limit_info: {
              status: "allowed",
              rateLimitType: "seven_day_fable",
              utilization: 0.6,
            },
          },
          "2026-07-29T15:02:00.000Z",
        ),
      ],
    );

    expect(summaries[0]?.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Day", usedPercent: 20 }),
        expect.objectContaining({
          key: "current_session",
          label: "Current session",
          usedPercent: 40,
        }),
        expect.objectContaining({ label: "Opus weekly", usedPercent: 85 }),
        expect.objectContaining({ label: "Fable", usedPercent: 60 }),
      ]),
    );
    expect(summaries[0]?.windows).toHaveLength(4);
  });

  it("normalizes Claude's interactive Current session label", () => {
    const summaries = deriveProviderUsageSummaries(
      [makeProvider("claudeAgent")],
      [
        usageActivity("claude-current-session", "claudeAgent", "claudeAgent", {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            rateLimitType: "Current session",
            utilization: 0.42,
            resetsAt: 1_800_000_000,
          },
        }),
      ],
    );

    expect(summaries[0]?.windows).toEqual([
      expect.objectContaining({
        key: "current_session",
        label: "Current session",
        usedPercent: 42,
        resetAt: 1_800_000_000_000,
      }),
    ]);
  });

  it("parses Claude's structured usage refresh snapshot without inventing windows", () => {
    const resetAt = "2026-07-30T18:30:00.000Z";
    const provider = {
      ...makeProvider("claudeAgent"),
      accountUsage: {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 42, resets_at: resetAt },
          seven_day: { utilization: 78, resets_at: "2026-08-01T06:00:00.000Z" },
          seven_day_opus: null,
          seven_day_sonnet: { utilization: 18, resets_at: null },
        },
      },
      accountUsageReportedAt: "2026-07-29T21:00:00.000Z",
    } satisfies ServerProvider;

    const summaries = deriveProviderUsageSummaries([provider], []);

    expect(summaries[0]?.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "current_session",
          label: "Current session",
          usedPercent: 42,
          resetAt: Date.parse(resetAt),
        }),
        expect.objectContaining({ key: "seven_day", label: "Weekly", usedPercent: 78 }),
        expect.objectContaining({
          key: "seven_day_sonnet",
          label: "Sonnet weekly",
          usedPercent: 18,
        }),
      ]),
    );
    expect(summaries[0]?.windows).toHaveLength(3);
  });

  it("does not invent a Claude Fable metric when the provider does not report one", () => {
    const summaries = deriveProviderUsageSummaries(
      [makeProvider("claudeAgent")],
      [
        usageActivity("claude-week", "claudeAgent", "claudeAgent", {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            rateLimitType: "seven_day",
            utilization: 0.3,
          },
        }),
      ],
    );

    expect(summaries[0]?.windows).toEqual([
      expect.objectContaining({ label: "Weekly", usedPercent: 30 }),
    ]);
    expect(summaries[0]?.windows.some((window) => window.label === "Fable")).toBe(false);
  });

  it("labels supported-but-unreported and unsupported providers truthfully", () => {
    const summaries = deriveProviderUsageSummaries(
      [makeProvider("codex"), makeProvider("cursor")],
      [],
    );

    expect(summaries.map((summary) => summary.state)).toEqual(["unavailable", "unsupported"]);
  });

  it("shares the latest account usage across chats while isolating another account", () => {
    const work = makeProvider("codex", "codex-work", "work@example.com");
    const personal = makeProvider("codex", "codex-personal", "personal@example.com");
    const workKey = providerUsageAccountKey(work)!;
    const global = mergeProviderUsageEntry(
      {},
      {
        accountKey: workKey,
        driver: work.driver,
        reportedAt: "2026-07-29T15:00:00.000Z",
        windows: [{ key: "secondary", label: "Weekly", usedPercent: 20, resetAt: null }],
      },
    );

    const inAnotherChat = deriveProviderUsageSummaries(
      [work, personal],
      [],
      global,
      Date.parse("2026-07-29T15:05:00.000Z"),
    );
    expect(inAnotherChat[0]).toMatchObject({
      state: "available",
      windows: [expect.objectContaining({ usedPercent: 20 })],
    });
    expect(inAnotherChat[1]?.state).toBe("unavailable");
  });

  it("filters a retired Codex five-hour window from an older account cache", () => {
    const provider = makeProvider("codex", "codex-work", "work@example.com");
    const accountKey = providerUsageAccountKey(provider)!;
    const summaries = deriveProviderUsageSummaries(
      [provider],
      [],
      {
        [accountKey]: {
          accountKey,
          driver: provider.driver,
          reportedAt: "2026-07-29T15:00:00.000Z",
          windows: [
            { key: "primary", label: "5 hour", usedPercent: 40, resetAt: null },
            { key: "secondary", label: "Weekly", usedPercent: 25, resetAt: null },
          ],
        },
      },
      Date.parse("2026-07-29T15:01:00.000Z"),
    );

    expect(summaries[0]?.windows).toEqual([
      expect.objectContaining({ label: "Weekly", usedPercent: 25 }),
    ]);
  });

  it("does not treat a shared plan label as a cross-instance account identity", () => {
    const first = {
      ...makeProvider("codex", "codex-first"),
      auth: {
        status: "authenticated" as const,
        type: "chatgpt",
        label: "ChatGPT Pro Subscription",
      },
    };
    const second = {
      ...makeProvider("codex", "codex-second"),
      auth: {
        status: "authenticated" as const,
        type: "chatgpt",
        label: "ChatGPT Pro Subscription",
      },
    };

    expect(providerUsageAccountKey(first)).not.toBe(providerUsageAccountKey(second));
  });

  it("updates account-global usage immediately from provider events", () => {
    const provider = makeProvider("codex", "codex-work", "work@example.com");
    const reports = deriveProviderUsageReports(
      [provider],
      [
        usageActivity("codex-event", "codex", "codex-work", {
          rateLimits: {
            secondary: { usedPercent: 41, windowDurationMins: 10_080 },
          },
        }),
      ],
    );

    expect(reports[providerUsageAccountKey(provider)!]).toMatchObject({
      windows: [expect.objectContaining({ label: "Weekly", usedPercent: 41 })],
      reportedAt: "2026-07-29T15:00:00.000Z",
    });
  });

  it("ignores ambiguous events and disabled provider instances", () => {
    const work = makeProvider("codex", "codex-work", "work@example.com");
    const personal = makeProvider("codex", "codex-personal", "personal@example.com");
    const disabled = {
      ...work,
      enabled: false,
      accountUsage: {
        rateLimits: {
          primary: { usedPercent: 10, windowDurationMins: 300 },
        },
      },
      accountUsageReportedAt: "2026-07-29T15:00:00.000Z",
    } satisfies ServerProvider;

    expect(
      deriveProviderUsageReports(
        [work, personal],
        [
          {
            ...usageActivity("ambiguous", "codex", "unused", {}),
            payload: {
              provider: "codex",
              rateLimits: {
                rateLimits: {
                  primary: { usedPercent: 10, windowDurationMins: 300 },
                },
              },
            },
          },
        ],
      ),
    ).toEqual({});
    expect(
      deriveProviderUsageReports(
        [disabled],
        [
          usageActivity("disabled", "codex", "codex-work", {
            rateLimits: {
              primary: { usedPercent: 10, windowDurationMins: 300 },
            },
          }),
        ],
      ),
    ).toEqual({});
  });

  it("keeps newer health data while accepting missing windows from an older event", () => {
    const provider = {
      ...makeProvider("codex", "codex", "me@example.com"),
      accountUsage: {
        rateLimits: {
          secondary: { usedPercent: 35, windowDurationMins: 10_080 },
        },
      },
      accountUsageReportedAt: "2026-07-29T15:10:00.000Z",
    } satisfies ServerProvider;
    const summaries = deriveProviderUsageSummaries(
      [provider],
      [
        usageActivity(
          "older-weekly",
          "codex",
          "codex",
          {
            rateLimits: {
              primary: { usedPercent: 80, windowDurationMins: 300 },
              secondary: { usedPercent: 50, windowDurationMins: 10_080 },
            },
          },
          "2026-07-29T15:00:00.000Z",
        ),
      ],
      {},
      Date.parse("2026-07-29T15:11:00.000Z"),
    );

    expect(summaries[0]?.windows).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Weekly", usedPercent: 35 })]),
    );
  });

  it("uses health-check usage immediately and marks old last-known data stale", () => {
    const provider = {
      ...makeProvider("codex", "codex", "me@example.com"),
      accountUsage: {
        rateLimits: {
          secondary: { usedPercent: 35, windowDurationMins: 10_080 },
        },
      },
      accountUsageReportedAt: "2026-07-29T15:00:00.000Z",
    } satisfies ServerProvider;
    expect(
      deriveProviderUsageSummaries([provider], [], {}, Date.parse("2026-07-29T15:01:00.000Z"))[0],
    ).toMatchObject({ state: "available" });
    expect(
      deriveProviderUsageSummaries([provider], [], {}, Date.parse("2026-07-29T16:00:00.000Z"))[0],
    ).toMatchObject({ state: "stale" });
  });

  it("does not expose cached usage after sign-out", () => {
    const authenticated = makeProvider("codex", "codex", "me@example.com");
    const accountKey = providerUsageAccountKey(authenticated)!;
    const signedOut = {
      ...authenticated,
      auth: { status: "unauthenticated" as const },
    };
    const summaries = deriveProviderUsageSummaries(
      [signedOut],
      [],
      {
        [accountKey]: {
          accountKey,
          driver: authenticated.driver,
          reportedAt: "2026-07-29T15:00:00.000Z",
          windows: [{ key: "primary", label: "5 hour", usedPercent: 20, resetAt: null }],
        },
      },
      Date.parse("2026-07-29T15:01:00.000Z"),
    );
    expect(summaries[0]?.state).toBe("unavailable");
  });

  it("uses exact consumed-usage color thresholds", () => {
    expect(usageThreshold(0)).toBe("neutral");
    expect(usageThreshold(49.99)).toBe("neutral");
    expect(usageThreshold(50)).toBe("warning");
    expect(usageThreshold(74.99)).toBe("warning");
    expect(usageThreshold(75)).toBe("critical");
    expect(usageThreshold(100)).toBe("critical");
  });

  it("renders a full accessible usage detail card with truthful stale state and colors", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageDetails
        name="Claude"
        driver={ProviderDriverKind.make("claudeAgent")}
        state="stale"
        reportedAt="2026-07-29T15:00:00.000Z"
        windows={[
          { key: "day", label: "Day", usedPercent: 20, resetAt: null },
          {
            key: "current_session",
            label: "Current session",
            usedPercent: 50,
            resetAt: null,
          },
          { key: "weekly", label: "Weekly", usedPercent: 75, resetAt: null },
          { key: "fable", label: "Fable", usedPercent: null, resetAt: null, detail: "Unavailable" },
        ]}
      />,
    );

    expect(markup).toContain("Claude usage");
    expect(markup).toContain("Day");
    expect(markup).toContain("Current session");
    expect(markup).toContain("Weekly");
    expect(markup).toContain("Fable");
    expect(markup).toContain("80% left");
    expect(markup).toContain("50% left");
    expect(markup).toContain("25% left");
    expect(markup).toContain("Stale");
    expect(markup).toContain("bg-foreground/55");
    expect(markup).toContain("bg-amber-500");
    expect(markup).toContain("bg-red-600");
    expect(markup).toContain('aria-label="Claude usage windows"');
    expect(markup).toContain('role="progressbar"');
  });

  it("opens New Thread usage details into the viewport and exposes stale refresh state", () => {
    expect(providerUsageDetailsSide(true)).toBe("bottom");
    expect(providerUsageDetailsSide(false)).toBe("top");

    const idleMarkup = renderToStaticMarkup(
      <ProviderUsageDetails
        name="Claude"
        driver={ProviderDriverKind.make("claudeAgent")}
        state="stale"
        reportedAt="2026-07-29T15:00:00.000Z"
        windows={[{ key: "seven_day", label: "Weekly", usedPercent: 78, resetAt: null }]}
        onRefresh={() => undefined}
      />,
    );
    expect(idleMarkup).toContain('aria-label="Refresh Claude usage"');
    expect(idleMarkup).toContain(">Refresh<");

    const loadingMarkup = renderToStaticMarkup(
      <ProviderUsageDetails
        name="Claude"
        state="stale"
        reportedAt="2026-07-29T15:00:00.000Z"
        windows={[{ key: "seven_day", label: "Weekly", usedPercent: 78, resetAt: null }]}
        onRefresh={() => undefined}
        isRefreshing
      />,
    );
    expect(loadingMarkup).toContain('aria-busy="true"');
    expect(loadingMarkup).toContain("Refreshing…");
  });

  it("places draft usage at the padded pane top and keeps active usage in the footer", () => {
    expect(resolveProviderUsagePlacement(true)).toBe("draft-pane-top");
    expect(resolveProviderUsagePlacement(false)).toBe("active-footer");

    const draftMarkup = renderToStaticMarkup(
      <ProviderUsagePlacementRow placement="draft-pane-top">
        <span>Usage</span>
      </ProviderUsagePlacementRow>,
    );
    expect(draftMarkup).toContain('data-chat-draft-provider-usage="true"');
    expect(draftMarkup).toContain("pt-3 sm:pt-4");
    expect(draftMarkup).not.toContain("data-chat-footer-provider-usage");

    const activeMarkup = renderToStaticMarkup(
      <ProviderUsagePlacementRow placement="active-footer">
        <span>Usage</span>
      </ProviderUsagePlacementRow>,
    );
    expect(activeMarkup).toContain('data-chat-footer-provider-usage="true"');
    expect(activeMarkup).not.toContain("data-chat-draft-provider-usage");
  });

  it("explains when Claude does not report Current session without inventing usage", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageDetails
        name="Claude"
        driver={ProviderDriverKind.make("claudeAgent")}
        state="available"
        reportedAt="2026-07-29T15:00:00.000Z"
        windows={[{ key: "seven_day", label: "Weekly", usedPercent: 78, resetAt: null }]}
      />,
    );

    expect(markup).toContain("Current session");
    expect(markup).toContain("Not reported by Claude");
    expect(markup).toContain('data-usage-unreported="current_session"');
    expect(markup.match(/role="progressbar"/g)).toHaveLength(1);
  });

  it("does not add a Current session placeholder to Codex", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageDetails
        name="Codex"
        driver={ProviderDriverKind.make("codex")}
        state="available"
        reportedAt="2026-07-29T15:00:00.000Z"
        windows={[{ key: "secondary", label: "Weekly", usedPercent: 12, resetAt: null }]}
      />,
    );

    expect(markup).not.toContain("Current session");
    expect(markup).not.toContain("Not reported by Claude");
  });

  it("renders clear unavailable detail state without a fabricated progress value", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageDetails name="Codex" state="unavailable" reportedAt={null} windows={[]} />,
    );

    expect(markup).toContain("Usage has not been reported for this provider account yet.");
    expect(markup).not.toContain('role="progressbar"');
  });

  it("renders only Claude current-session and Codex weekly metrics in the compact bar", () => {
    const providers = [makeProvider("claudeAgent"), makeProvider("codex")];
    const activities = [
      usageActivity("claude-render", "claudeAgent", "claudeAgent", {
        rate_limits: {
          current_session: { utilization: 40 },
          seven_day: { utilization: 85 },
        },
      }),
      usageActivity("codex-render", "codex", "codex", {
        rateLimits: {
          secondary: { usedPercent: 75, windowDurationMins: 10_080 },
          credits: { hasCredits: true, unlimited: false, balance: "42" },
        },
      }),
    ];
    const markup = renderToStaticMarkup(
      <ProviderUsageBar providers={providers} activities={activities} />,
    );

    expect(markup).toContain('aria-label="Provider usage"');
    expect(markup).toContain('aria-label="Show Claude account usage details"');
    expect(markup).toContain('aria-label="Show Codex account usage details"');
    expect(markup).toContain('data-provider-usage-compact-driver="claudeAgent"');
    expect(markup).toContain('data-provider-usage-compact-driver="codex"');
    expect(markup).toContain(">Current session<");
    expect(markup.match(/>Weekly</g)).toHaveLength(1);
    expect(markup).toContain(">40%<");
    expect(markup).toContain(">75%<");
    expect(markup.match(/role="progressbar"/g)).toHaveLength(2);
    expect(markup).toContain('aria-valuenow="40"');
    expect(markup).toContain('aria-valuenow="75"');
    expect(markup).not.toContain(">Claude<");
    expect(markup).not.toContain(">Codex<");
    expect(markup).not.toContain(">Credits<");
    expect(markup).not.toContain(">85%<");
    expect(markup).toContain("bg-red-600");
  });
});
