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
  resolveUsageWindowElapsedPercent,
  resolveUsageWindowPaceDeltaMs,
  formatUsageWindowPaceDelta,
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

  it("normalizes Grok SuperGrok weekly billing into a usage window", () => {
    const grok = {
      ...makeProvider("grok"),
      displayName: "Grok",
      accountUsage: {
        config: {
          creditUsagePercent: 6,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-08-15T00:00:00+00:00",
            end: "2026-08-22T00:00:00+00:00",
          },
          prepaidBalance: { val: 12 },
          onDemandCap: { val: 25 },
          onDemandUsed: { val: 5 },
        },
        subscription_tier: "SuperGrok Plus",
      },
      accountUsageReportedAt: "2026-08-18T15:00:00.000Z",
    } satisfies ServerProvider;

    const summaries = deriveProviderUsageSummaries(
      [grok],
      [],
      {},
      Date.parse("2026-08-18T15:03:00.000Z"),
    );

    expect(summaries[0]?.state).toBe("available");
    expect(summaries[0]?.windows).toEqual([
      expect.objectContaining({
        key: "weekly",
        label: "Weekly",
        usedPercent: 6,
        resetAt: Date.parse("2026-08-22T00:00:00+00:00"),
      }),
      expect.objectContaining({ key: "credits", label: "Credits", detail: "$12" }),
      expect.objectContaining({
        key: "on-demand",
        label: "Pay as you go",
        usedPercent: 20,
        detail: "$5 of $25",
      }),
    ]);
    expect(compactProviderUsageMetric(summaries[0]!)?.label).toBe("Pay as you go");
  });

  it("replaces persisted Grok usage with zero when a new active period omits the scalar", () => {
    const grok = {
      ...makeProvider("grok"),
      displayName: "Grok",
      accountUsage: {
        config: {
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-08-25T17:24:28.593003+00:00",
            end: "2026-09-01T17:24:28.593003+00:00",
          },
          onDemandCap: { val: 0 },
          onDemandUsed: { val: 0 },
          prepaidBalance: { val: 0 },
        },
      },
      accountUsageReportedAt: "2026-08-25T22:37:00.104Z",
    } satisfies ServerProvider;
    const accountKey = providerUsageAccountKey(grok)!;

    const summaries = deriveProviderUsageSummaries(
      [grok],
      [],
      {
        [accountKey]: {
          accountKey,
          driver: grok.driver,
          windows: [
            {
              key: "weekly",
              label: "Weekly",
              usedPercent: 60,
              resetAt: Date.parse("2026-08-25T17:24:28.593003+00:00"),
            },
          ],
          reportedAt: "2026-08-19T18:23:44.941Z",
        },
      },
      Date.parse("2026-08-25T22:37:30.000Z"),
    );

    expect(summaries[0]?.state).toBe("available");
    expect(summaries[0]?.reportedAt).toBe("2026-08-25T22:37:00.104Z");
    expect(summaries[0]?.windows).toEqual([
      expect.objectContaining({
        key: "weekly",
        usedPercent: 0,
        resetAt: Date.parse("2026-09-01T17:24:28.593003+00:00"),
      }),
    ]);
  });

  it("marks Grok usage stale after the freshness window and fresh after a new snapshot", () => {
    const grok = {
      ...makeProvider("grok"),
      displayName: "Grok",
      accountUsage: {
        config: {
          creditUsagePercent: 41,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-08-18T17:24:28.593003+00:00",
            end: "2026-08-25T17:24:28.593003+00:00",
          },
        },
      },
      accountUsageReportedAt: "2026-08-19T12:17:00.000Z",
    } satisfies ServerProvider;

    const stale = deriveProviderUsageSummaries(
      [grok],
      [],
      {},
      Date.parse("2026-08-19T13:58:00.000Z"),
    )[0]!;
    expect(stale.state).toBe("stale");
    expect(stale.windows[0]).toMatchObject({ label: "Weekly", usedPercent: 41 });

    const fresh = deriveProviderUsageSummaries(
      [{ ...grok, accountUsageReportedAt: "2026-08-19T13:58:00.000Z" }],
      [],
      {},
      Date.parse("2026-08-19T13:58:30.000Z"),
    )[0]!;
    expect(fresh.state).toBe("available");
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

  it("treats a definitive Claude rejection without utilization as 100% used", () => {
    const summaries = deriveProviderUsageSummaries(
      [makeProvider("claudeAgent")],
      [
        usageActivity("claude-rejected", "claudeAgent", "claudeAgent", {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "rejected",
            rateLimitType: "five_hour",
            resetsAt: 1_786_401_600,
          },
        }),
      ],
      {},
      Date.parse("2026-07-29T15:01:00.000Z"),
    );

    expect(summaries[0]).toMatchObject({
      state: "available",
      windows: [
        expect.objectContaining({
          key: "current_session",
          label: "Current session",
          usedPercent: 100,
          resetAt: 1_786_401_600_000,
        }),
      ],
    });
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

  it("repairs a stale Codex 100% snapshot from a current non-zero provider report", () => {
    const provider = makeProvider("codex", "codex-work", "work@example.com");
    const accountKey = providerUsageAccountKey(provider)!;
    const resetAt = Date.parse("2026-08-05T15:00:00.000Z");
    const poisoned = mergeProviderUsageEntry(
      {},
      {
        accountKey,
        driver: provider.driver,
        reportedAt: "2026-08-02T19:59:00.000Z",
        windows: [{ key: "weekly", label: "Weekly", usedPercent: 100, resetAt }],
      },
    );
    const corrected = mergeProviderUsageEntry(poisoned, {
      accountKey,
      driver: provider.driver,
      reportedAt: "2026-08-02T20:01:00.000Z",
      windows: [{ key: "weekly", label: "Weekly", usedPercent: 4, resetAt }],
    });

    expect(corrected[accountKey]?.windows).toEqual([
      expect.objectContaining({ key: "weekly", usedPercent: 4 }),
    ]);
  });

  it("repairs a stale Codex 98% snapshot from the current 10% provider report", () => {
    const provider = {
      ...makeProvider("codex", "codex-work", "work@example.com"),
      accountUsage: {
        rateLimits: {
          primary: {
            usedPercent: 10,
            windowDurationMins: 10_080,
            resetsAt: Date.parse("2026-08-05T15:00:00.000Z") / 1_000,
          },
        },
      },
      accountUsageReportedAt: "2026-08-02T23:46:43.652Z",
    } satisfies ServerProvider;
    const accountKey = providerUsageAccountKey(provider)!;
    const persisted = mergeProviderUsageEntry(
      {},
      {
        accountKey,
        driver: provider.driver,
        reportedAt: "2026-08-02T23:40:00.000Z",
        windows: [
          {
            key: "weekly",
            label: "Weekly",
            usedPercent: 98,
            resetAt: Date.parse("2026-08-05T15:00:00.000Z"),
          },
        ],
      },
    );

    const summary = deriveProviderUsageSummaries(
      [provider],
      [],
      persisted,
      Date.parse("2026-08-02T23:47:00.000Z"),
    )[0]!;
    const markup = renderToStaticMarkup(
      <ProviderUsageDetails
        name="Codex"
        state={summary.state}
        reportedAt={summary.reportedAt}
        windows={summary.windows}
      />,
    );

    expect(summary.windows).toEqual([expect.objectContaining({ key: "weekly", usedPercent: 10 })]);
    expect(markup).toContain("10% used");
    expect(markup).not.toContain("98% used");
  });

  it("does not repair a stale Codex 100% snapshot from a transient zero", () => {
    const provider = makeProvider("codex", "codex-work", "work@example.com");
    const accountKey = providerUsageAccountKey(provider)!;
    const resetAt = Date.parse("2026-08-05T15:00:00.000Z");
    const poisoned = mergeProviderUsageEntry(
      {},
      {
        accountKey,
        driver: provider.driver,
        reportedAt: "2026-08-02T19:59:00.000Z",
        windows: [{ key: "weekly", label: "Weekly", usedPercent: 100, resetAt }],
      },
    );
    const transientZero = mergeProviderUsageEntry(poisoned, {
      accountKey,
      driver: provider.driver,
      reportedAt: "2026-08-02T20:01:00.000Z",
      windows: [{ key: "weekly", label: "Weekly", usedPercent: 0, resetAt }],
    });

    expect(transientZero[accountKey]?.windows).toEqual([
      expect.objectContaining({ key: "weekly", usedPercent: 100 }),
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

  it("accepts an out-of-band Codex reset that starts a new weekly window immediately", () => {
    const provider = makeProvider("codex", "codex-work", "work@example.com");
    const accountKey = providerUsageAccountKey(provider)!;
    const previous = mergeProviderUsageEntry(
      {},
      {
        accountKey,
        driver: provider.driver,
        reportedAt: "2026-08-11T18:30:29.273Z",
        windows: [
          {
            key: "weekly",
            label: "Weekly",
            usedPercent: 100,
            resetAt: Date.parse("2026-08-17T20:00:19.000-04:00"),
            windowDurationMs: 7 * 24 * 60 * 60_000,
          },
        ],
      },
    );
    const reset = mergeProviderUsageEntry(previous, {
      accountKey,
      driver: provider.driver,
      reportedAt: "2026-08-13T14:48:36.619Z",
      windows: [
        {
          key: "weekly",
          label: "Weekly",
          usedPercent: 0,
          resetAt: Date.parse("2026-08-20T10:31:33.000-04:00"),
          windowDurationMs: 7 * 24 * 60 * 60_000,
        },
      ],
    });

    expect(reset[accountKey]?.windows).toEqual([
      expect.objectContaining({
        key: "weekly",
        usedPercent: 0,
        resetAt: Date.parse("2026-08-20T10:31:33.000-04:00"),
      }),
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
          windowDurationMs: 7 * 24 * 60 * 60_000,
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

  it("offers the existing account switch flow from the usage popup", () => {
    const summary = {
      provider: makeProvider("codex"),
      state: "available" as const,
      windows: [],
      reportedAt: null,
    };
    const markup = renderToStaticMarkup(
      <ProviderUsageBadgeDetails summary={summary} onSwitchUser={() => undefined} />,
    );

    expect(markup).toContain(">Switch user<");
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
    expect(markup).toContain("shrink-0");
    expect(markup).not.toContain("overflow-x-auto");
    expect(markup).toContain('aria-label="Show Claude usage details; Claude Fable: 91% used"');
    expect(markup).toContain(
      'aria-label="Show Codex account usage details; Codex Weekly: 38% used"',
    );
    // No native `title`: it doubled up with the custom hover popover, showing
    // two tooltips at once. The aria-label above keeps the text accessible.
    expect(markup).not.toContain('title="Claude Fable: 91% used"');
    expect(markup).not.toContain('title="Codex Weekly: 38% used"');
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

  it("adds Fable to the current-session and weekly limits only while Fable is selected", () => {
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
      label: "Weekly",
      window: expect.objectContaining({ key: "seven_day", usedPercent: 95 }),
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

  it("shows weekly when it exceeds Fable for a Fable-selected Claude session", () => {
    const provider = makeProvider("claudeAgent");
    const metric = compactProviderUsageMetric(
      {
        provider,
        state: "available",
        reportedAt: null,
        windows: [
          { key: "current_session", label: "Current session", usedPercent: 0, resetAt: null },
          { key: "seven_day", label: "Weekly", usedPercent: 98, resetAt: null },
          { key: "fable", label: "Fable", usedPercent: 61, resetAt: null },
        ],
      },
      {
        instanceId: provider.instanceId,
        model: "claude-fable-5",
      },
    );

    expect(metric).toEqual({
      label: "Weekly",
      window: expect.objectContaining({ key: "seven_day", usedPercent: 98 }),
    });
  });
});

describe("resolveUsageWindowElapsedPercent", () => {
  const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
  // A window that started at t=0 and resets five hours later.
  const resetAt = FIVE_HOURS_MS;

  it("reports elapsed time as a share of the window", () => {
    expect(
      resolveUsageWindowElapsedPercent({
        resetAt,
        windowDurationMs: FIVE_HOURS_MS,
        nowMs: FIVE_HOURS_MS / 2,
      }),
    ).toBe(50);
    expect(
      resolveUsageWindowElapsedPercent({
        resetAt,
        windowDurationMs: FIVE_HOURS_MS,
        nowMs: FIVE_HOURS_MS / 4,
      }),
    ).toBe(25);
  });

  it("omits the overlay when the window length is unknown", () => {
    // Claude never reports a length, so an unmapped key must render nothing
    // rather than imply a start time the provider never gave.
    expect(
      resolveUsageWindowElapsedPercent({ resetAt, windowDurationMs: null, nowMs: 1_000 }),
    ).toBeNull();
    expect(
      resolveUsageWindowElapsedPercent({ resetAt, windowDurationMs: undefined, nowMs: 1_000 }),
    ).toBeNull();
    expect(
      resolveUsageWindowElapsedPercent({
        resetAt: null,
        windowDurationMs: FIVE_HOURS_MS,
        nowMs: 1_000,
      }),
    ).toBeNull();
  });

  it("clamps to the track rather than overshooting it", () => {
    // A stale reset time keeps the bar pinned at full instead of running past.
    expect(
      resolveUsageWindowElapsedPercent({
        resetAt,
        windowDurationMs: FIVE_HOURS_MS,
        nowMs: FIVE_HOURS_MS * 10,
      }),
    ).toBe(100);
    // A clock behind the window start reads as not yet begun.
    expect(
      resolveUsageWindowElapsedPercent({
        resetAt,
        windowDurationMs: FIVE_HOURS_MS,
        nowMs: -FIVE_HOURS_MS,
      }),
    ).toBe(0);
  });

  it("rejects a non-positive or non-finite window length", () => {
    for (const windowDurationMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        resolveUsageWindowElapsedPercent({ resetAt, windowDurationMs, nowMs: 1_000 }),
      ).toBeNull();
    }
  });
});

describe("usage-window pace delta", () => {
  const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

  it("reports positive time until elapsed pace reaches heavier usage", () => {
    const delta = resolveUsageWindowPaceDeltaMs({
      usedPercent: 80,
      resetAt: FIVE_HOURS_MS,
      windowDurationMs: FIVE_HOURS_MS,
      nowMs: 2 * 60 * 60 * 1000,
    });
    expect(delta).toBe(2 * 60 * 60 * 1000);
    expect(formatUsageWindowPaceDelta(delta)).toBe("+2h until time bar reaches usage");
  });

  it("reports negative time after elapsed pace has passed lighter usage", () => {
    const delta = resolveUsageWindowPaceDeltaMs({
      usedPercent: 25,
      resetAt: FIVE_HOURS_MS,
      windowDurationMs: FIVE_HOURS_MS,
      nowMs: 2 * 60 * 60 * 1000,
    });
    expect(delta).toBe(-45 * 60 * 1000);
    expect(formatUsageWindowPaceDelta(delta)).toBe("−45m since time bar passed usage");
  });

  it("uses seconds at the crossover and omits unknown windows", () => {
    expect(formatUsageWindowPaceDelta(0)).toBe("±0s — time and usage bars meet now");
    expect(formatUsageWindowPaceDelta(42_000)).toBe("+42s until time bar reaches usage");
    expect(
      resolveUsageWindowPaceDeltaMs({
        usedPercent: 50,
        resetAt: FIVE_HOURS_MS,
        windowDurationMs: null,
        nowMs: 0,
      }),
    ).toBeNull();
  });

  it("puts the signed pace duration on the hoverable quota line", () => {
    const nowMs = Date.now();
    const markup = renderToStaticMarkup(
      <ProviderUsageDetails
        name="Claude"
        state="available"
        reportedAt="2026-08-03T16:00:00.000Z"
        windows={[
          {
            key: "current_session",
            label: "Current session",
            usedPercent: 80,
            resetAt: nowMs + FIVE_HOURS_MS,
            windowDurationMs: FIVE_HOURS_MS,
          },
        ]}
      />,
    );

    expect(markup).toContain("until time bar reaches usage");
    expect(markup).toContain("aria-valuetext=");
    expect(markup).toContain('data-usage-window-elapsed-marker="dots"');
    expect(markup).toContain("provider-usage-elapsed-dots");
  });
});
