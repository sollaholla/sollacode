import {
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationThreadActivity,
  type ServerProvider,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  claudePopupWindows,
  compactProviderUsageMetric,
  deriveProviderUsageReports,
  deriveProviderUsageSummaries,
  ProviderUsageBar,
  ProviderUsageBadgeDetails,
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
const localEnvironmentId = EnvironmentId.make("environment-local");

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

  it("normalizes Claude current, weekly, and Fable quota fields into used percentages", () => {
    const claude = {
      ...makeProvider("claudeAgent"),
      accountUsage: {
        rate_limits: {
          five_hour: { utilization: 2, resets_at: "2026-07-30T18:00:00.000Z" },
          seven_day: { utilization: 79, resets_at: "2026-08-03T00:00:00.000Z" },
          model_scoped: {
            utilization: 38,
            resets_at: "2026-08-04T00:00:00.000Z",
          },
        },
      },
      accountUsageReportedAt: "2026-07-30T15:00:00.000Z",
    } satisfies ServerProvider;

    const summaries = deriveProviderUsageSummaries(
      [claude],
      [],
      {},
      Date.parse("2026-07-30T15:03:00.000Z"),
    );

    expect(summaries[0]?.windows).toEqual([
      expect.objectContaining({ key: "current_session", usedPercent: 2 }),
      expect.objectContaining({ key: "seven_day", usedPercent: 79 }),
      expect.objectContaining({ key: "fable", label: "Fable", usedPercent: 38 }),
    ]);
  });

  it("reads the Fable quota from Claude Code model_scoped arrays", () => {
    const summaries = deriveProviderUsageSummaries(
      [makeProvider("claudeAgent")],
      [
        usageActivity("claude-model-scoped", "claudeAgent", "claudeAgent", {
          rate_limits: {
            five_hour: { utilization: 2, resets_at: "2026-07-30T18:49:59.000Z" },
            seven_day: { utilization: 79, resets_at: "2026-08-01T05:59:59.000Z" },
            model_scoped: [
              {
                display_name: "Fable",
                utilization: 100,
                resets_at: "2026-08-01T05:59:59.000Z",
              },
            ],
          },
        }),
      ],
      {},
      Date.parse("2026-07-30T13:00:00.000Z"),
    );

    expect(summaries[0]?.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "fable", label: "Fable", usedPercent: 100 }),
      ]),
    );
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

  it("never reuses a persisted usage snapshot from another environment", () => {
    const provider = makeProvider("codex", "codex-work", "work@example.com");
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const localKey = providerUsageAccountKey(provider, localEnvironmentId)!;
    const persisted = mergeProviderUsageEntry(
      {},
      {
        accountKey: localKey,
        driver: provider.driver,
        reportedAt: "2026-07-29T15:00:00.000Z",
        windows: [{ key: "secondary", label: "Weekly", usedPercent: 20, resetAt: null }],
      },
    );

    const localSummary = deriveProviderUsageSummaries(
      [provider],
      [],
      persisted,
      Date.parse("2026-07-29T15:05:00.000Z"),
      localEnvironmentId,
    );
    const remoteSummary = deriveProviderUsageSummaries(
      [provider],
      [],
      persisted,
      Date.parse("2026-07-29T15:05:00.000Z"),
      remoteEnvironmentId,
    );

    expect(providerUsageAccountKey(provider, remoteEnvironmentId)).not.toBe(localKey);
    expect(localSummary[0]).toMatchObject({
      state: "available",
      windows: [expect.objectContaining({ usedPercent: 20 })],
    });
    expect(remoteSummary[0]).toMatchObject({ state: "unavailable", windows: [] });
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
      windows: [expect.objectContaining({ key: "weekly", label: "Weekly", usedPercent: 41 })],
      reportedAt: "2026-07-29T15:00:00.000Z",
    });
  });

  it("ignores a transient Codex zero within the same weekly reset cycle", () => {
    const provider = makeProvider("codex", "codex-work", "work@example.com");
    const accountKey = providerUsageAccountKey(provider)!;
    const resetAt = Date.parse("2026-08-05T15:00:00.000Z");
    const previous = mergeProviderUsageEntry(
      {},
      {
        accountKey,
        driver: provider.driver,
        reportedAt: "2026-07-30T15:00:00.000Z",
        windows: [{ key: "weekly", label: "Weekly", usedPercent: 49, resetAt }],
      },
    );
    const transientZero = mergeProviderUsageEntry(previous, {
      accountKey,
      driver: provider.driver,
      reportedAt: "2026-07-30T15:01:00.000Z",
      windows: [
        {
          key: "weekly",
          label: "Weekly",
          usedPercent: 0,
          resetAt: resetAt + 1_000,
        },
      ],
    });

    expect(transientZero[accountKey]?.windows).toEqual([
      expect.objectContaining({ key: "weekly", usedPercent: 49 }),
    ]);
  });

  it("accepts a real Codex reset when the weekly cycle changes", () => {
    const provider = makeProvider("codex", "codex-work", "work@example.com");
    const accountKey = providerUsageAccountKey(provider)!;
    const previous = mergeProviderUsageEntry(
      {},
      {
        accountKey,
        driver: provider.driver,
        reportedAt: "2026-07-30T15:00:00.000Z",
        windows: [
          {
            key: "weekly",
            label: "Weekly",
            usedPercent: 49,
            resetAt: Date.parse("2026-08-05T15:00:00.000Z"),
          },
        ],
      },
    );
    const reset = mergeProviderUsageEntry(previous, {
      accountKey,
      driver: provider.driver,
      reportedAt: "2026-08-05T15:01:00.000Z",
      windows: [
        {
          key: "weekly",
          label: "Weekly",
          usedPercent: 0,
          resetAt: Date.parse("2026-08-12T15:00:00.000Z"),
        },
      ],
    });

    expect(reset[accountKey]?.windows).toEqual([
      expect.objectContaining({ key: "weekly", usedPercent: 0 }),
    ]);
  });

  it("ignores a Codex zero with a changed reset timestamp before the current cycle ends", () => {
    const provider = makeProvider("codex", "codex-work", "work@example.com");
    const accountKey = providerUsageAccountKey(provider)!;
    const currentResetAt = Date.parse("2026-08-05T15:00:00.000Z");
    const previous = mergeProviderUsageEntry(
      {},
      {
        accountKey,
        driver: provider.driver,
        reportedAt: "2026-07-30T15:00:00.000Z",
        windows: [
          {
            key: "weekly",
            label: "Weekly",
            usedPercent: 49,
            resetAt: currentResetAt,
          },
        ],
      },
    );
    const transientZero = mergeProviderUsageEntry(previous, {
      accountKey,
      driver: provider.driver,
      reportedAt: "2026-07-30T15:01:00.000Z",
      windows: [
        {
          key: "weekly",
          label: "Weekly",
          usedPercent: 0,
          resetAt: Date.parse("2026-08-12T15:00:00.000Z"),
        },
      ],
    });

    expect(transientZero[accountKey]?.windows).toEqual([
      expect.objectContaining({ key: "weekly", usedPercent: 49 }),
    ]);
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
    expect(markup).toContain("20% used");
    expect(markup).toContain("50% used");
    expect(markup).toContain("75% used");
    expect(markup).toContain("Stale");
    expect(markup).toContain("bg-foreground/55");
    expect(markup).toContain("bg-amber-500");
    expect(markup).toContain("bg-red-600");
    expect(markup).toContain('aria-label="Claude usage windows"');
    expect(markup).toContain('role="progressbar"');
  });

  it("renders exactly one Claude card with Current session, Weekly, and Fable", () => {
    const claude = {
      ...makeProvider("claudeAgent", "claudeAgent", "claude-secret@example.com"),
      accountUsage: {
        rate_limits: {
          five_hour: {
            utilization: 2,
            resets_at: "2026-07-30T18:00:00.000Z",
          },
          seven_day: {
            utilization: 79,
            resets_at: "2026-08-03T00:00:00.000Z",
          },
          model_scoped: {
            utilization: 38,
            resets_at: "2026-08-04T00:00:00.000Z",
          },
        },
      },
      accountUsageReportedAt: "2026-07-30T15:00:00.000Z",
    } satisfies ServerProvider;
    const summary = deriveProviderUsageSummaries(
      [claude],
      [],
      {},
      Date.parse("2026-07-30T15:03:00.000Z"),
    )[0]!;

    const markup = renderToStaticMarkup(<ProviderUsageBadgeDetails summary={summary} />);
    expect(markup).toContain('data-provider-usage-card-count="1"');
    expect(markup).toContain('data-provider-usage-card="Claude"');
    expect(markup).toContain('data-provider-instance-id="claudeAgent"');
    expect(markup.match(/>Claude usage</g)).toHaveLength(1);
    expect(markup.match(/>Current session</g)).toHaveLength(1);
    expect(markup.match(/>Weekly</g)).toHaveLength(1);
    expect(markup.match(/>Fable</g)).toHaveLength(1);
    expect(markup.match(/role="progressbar"/g)).toHaveLength(3);
    expect(markup).toContain('aria-label="Claude Current session used"');
    expect(markup).toContain('aria-label="Claude Weekly used"');
    expect(markup).toContain('aria-label="Claude Fable used"');
    expect(markup).toContain('aria-valuenow="2"');
    expect(markup).toContain('aria-valuenow="79"');
    expect(markup).toContain('aria-valuenow="38"');
    expect(markup).toContain(">2% used<");
    expect(markup).toContain(">79% used<");
    expect(markup).toContain(">38% used<");
    expect(markup.match(/>Reported /g)).toHaveLength(1);
    expect(markup.match(/>Resets /g)).toHaveLength(3);
    expect(markup).not.toContain("claude-secret@example.com");
  });

  it("keeps the three Claude rows ordered and marks missing values Not reported", () => {
    const windows = claudePopupWindows([
      { key: "seven_day", label: "Weekly", usedPercent: 100, resetAt: null },
      { key: "current_session", label: "Current session", usedPercent: 0, resetAt: null },
    ]);

    expect(windows.map((window) => window.label)).toEqual(["Current session", "Weekly", "Fable"]);
    expect(windows.map((window) => window.usedPercent)).toEqual([0, 100, null]);
    expect(windows[2]?.detail).toBe("Not reported");

    const markup = renderToStaticMarkup(
      <ProviderUsageDetails
        name="Claude"
        state="available"
        reportedAt="2026-07-30T15:00:00.000Z"
        windows={windows}
      />,
    );
    expect(markup).toContain(">0% used<");
    expect(markup).toContain(">100% used<");
    expect(markup).toContain(">Not reported<");
    expect(markup).not.toContain("% left");
    expect(markup.match(/role="progressbar"/g)).toHaveLength(2);
    expect(markup).toContain('aria-valuenow="0"');
    expect(markup).toContain('aria-valuenow="100"');
  });

  it("renders loading, unavailable, and stale state per card", () => {
    const loadingMarkup = renderToStaticMarkup(
      <ProviderUsageDetails
        name="Claude"
        state="unavailable"
        reportedAt={null}
        windows={[]}
        isRefreshing
      />,
    );
    expect(loadingMarkup).toContain('data-provider-usage-state="loading"');
    expect(loadingMarkup).toContain(">Loading<");
    expect(loadingMarkup).toContain("Loading usage…");

    const unavailableMarkup = renderToStaticMarkup(
      <ProviderUsageDetails name="Fable" state="unavailable" reportedAt={null} windows={[]} />,
    );
    expect(unavailableMarkup).toContain('data-provider-usage-state="unavailable"');
    expect(unavailableMarkup).toContain(">Unavailable<");

    const staleMarkup = renderToStaticMarkup(
      <ProviderUsageDetails
        name="Claude"
        state="stale"
        reportedAt="2026-07-30T15:00:00.000Z"
        windows={[{ key: "seven_day", label: "Weekly", usedPercent: 44, resetAt: null }]}
      />,
    );
    expect(staleMarkup).toContain('data-provider-usage-state="stale"');
    expect(staleMarkup).toContain(">Stale<");
    expect(staleMarkup).toContain("Last reported");
  });

  it("opens New Thread usage details into the viewport and exposes stale refresh state", () => {
    expect(providerUsageDetailsSide(true)).toBe("bottom");
    expect(providerUsageDetailsSide(false)).toBe("top");

    const idleMarkup = renderToStaticMarkup(
      <ProviderUsageDetails
        name="Claude"
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

  it("does not add Claude quota placeholders to Codex", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageDetails
        name="Codex"
        state="available"
        reportedAt="2026-07-29T15:00:00.000Z"
        windows={[{ key: "secondary", label: "Weekly", usedPercent: 12, resetAt: null }]}
      />,
    );

    expect(markup).not.toContain("Current session");
    expect(markup).not.toContain("Fable");
  });

  it("renders clear unavailable detail state without a fabricated progress value", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageDetails name="Codex" state="unavailable" reportedAt={null} windows={[]} />,
    );

    expect(markup).toContain("Usage has not been reported for this provider account yet.");
    expect(markup).not.toContain('role="progressbar"');
  });

  it("renders only icon, percent used, and matching bars while keeping metric names accessible", () => {
    const providers = [makeProvider("claudeAgent"), makeProvider("codex")];
    const activities = [
      usageActivity("claude-render", "claudeAgent", "claudeAgent", {
        rate_limits: {
          current_session: { utilization: 2 },
          seven_day: { utilization: 79 },
          seven_day_fable: { utilization: 91 },
        },
      }),
      usageActivity("codex-render", "codex", "codex", {
        rateLimits: {
          secondary: { usedPercent: 38, windowDurationMins: 10_080 },
          credits: { hasCredits: true, unlimited: false, balance: "42" },
        },
      }),
    ];
    const markup = renderToStaticMarkup(
      <ProviderUsageBar
        environmentId={localEnvironmentId}
        providers={providers}
        activities={activities}
        selectedModelSelection={{
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-fable-5",
        }}
      />,
    );

    expect(markup).toContain('aria-label="Provider usage"');
    expect(markup).toContain('aria-label="Show Claude usage details; Claude Fable: 91% used"');
    expect(markup).toContain(
      'aria-label="Show Codex account usage details; Codex Weekly: 38% used"',
    );
    expect(markup).toContain('title="Claude Fable: 91% used"');
    expect(markup).toContain('title="Codex Weekly: 38% used"');
    expect(markup).toContain('data-provider-usage-compact-driver="claudeAgent"');
    expect(markup).toContain('data-provider-usage-compact-driver="codex"');
    expect(markup).not.toContain(">Current session<");
    expect(markup).not.toContain(">Weekly<");
    expect(markup).toContain(">91%<");
    expect(markup).toContain(">38%<");
    expect(markup.match(/role="progressbar"/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="Claude Fable used"');
    expect(markup).toContain('aria-label="Codex Weekly used"');
    expect(markup).toContain('aria-valuenow="91"');
    expect(markup).toContain('aria-valuenow="38"');
    expect(markup).not.toContain(">Claude<");
    expect(markup).not.toContain(">Codex<");
    expect(markup).not.toContain(">Credits<");
    expect(markup).not.toContain(">79%<");
    expect(markup).not.toContain("% left");
  });

  it("uses the highest reported compact usage limit and ignores unreported limits", () => {
    const provider = makeProvider("claudeAgent");
    const metric = compactProviderUsageMetric({
      provider,
      state: "available",
      reportedAt: null,
      windows: [
        { key: "current_session", label: "Current session", usedPercent: 74, resetAt: null },
        { key: "seven_day", label: "Weekly", usedPercent: 81, resetAt: null },
        {
          key: "fable",
          label: "Fable",
          usedPercent: null,
          resetAt: null,
          detail: "Not reported",
        },
      ],
    });

    expect(metric).toEqual({
      label: "Weekly",
      window: expect.objectContaining({ key: "seven_day", usedPercent: 81 }),
    });
  });

  it("uses max(Fable, Current session) only while Fable is selected", () => {
    const provider = makeProvider("claudeAgent");
    const summary = {
      provider,
      state: "available" as const,
      reportedAt: null,
      windows: [
        { key: "current_session", label: "Current session", usedPercent: 74, resetAt: null },
        { key: "seven_day", label: "Weekly", usedPercent: 81, resetAt: null },
        { key: "fable", label: "Fable", usedPercent: 86, resetAt: null },
        { key: "overage", label: "Overage", usedPercent: 100, resetAt: null },
      ],
    };

    expect(compactProviderUsageMetric(summary)).toEqual({
      label: "Weekly",
      window: expect.objectContaining({ key: "seven_day", usedPercent: 81 }),
    });
    expect(
      compactProviderUsageMetric(summary, {
        instanceId: provider.instanceId,
        model: "claude-fable-5",
      }),
    ).toEqual({
      label: "Fable",
      window: expect.objectContaining({ key: "fable", usedPercent: 86 }),
    });
    expect(
      compactProviderUsageMetric(
        {
          ...summary,
          windows: summary.windows.map((window) =>
            window.key === "current_session" ? { ...window, usedPercent: 92 } : window,
          ),
        },
        {
          instanceId: provider.instanceId,
          model: "claude-fable-5",
        },
      ),
    ).toEqual({
      label: "Current session",
      window: expect.objectContaining({ key: "current_session", usedPercent: 92 }),
    });
    expect(
      compactProviderUsageMetric({
        ...summary,
        windows: summary.windows.map((window) =>
          window.key === "seven_day" ? { ...window, usedPercent: 95 } : window,
        ),
      }),
    ).toEqual({
      label: "Weekly",
      window: expect.objectContaining({ key: "seven_day", usedPercent: 95 }),
    });
    expect(
      compactProviderUsageMetric(
        {
          ...summary,
          windows: summary.windows.map((window) =>
            window.key === "seven_day" ? { ...window, usedPercent: 95 } : window,
          ),
        },
        {
          instanceId: provider.instanceId,
          model: "claude-fable-5",
        },
      ),
    ).toEqual({
      label: "Fable",
      window: expect.objectContaining({ key: "fable", usedPercent: 86 }),
    });
    expect(
      compactProviderUsageMetric(summary, {
        instanceId: ProviderInstanceId.make("another-claude-account"),
        model: "claude-fable-5",
      }),
    ).toEqual({
      label: "Weekly",
      window: expect.objectContaining({ key: "seven_day", usedPercent: 81 }),
    });
  });
});
