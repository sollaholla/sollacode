import { DEFAULT_USAGE_GUARD_PROVIDER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import type { ModelSelection, ProviderOptionDescriptor } from "@t3tools/contracts";
import type {
  UsageGuardEvaluation,
  UsageGuardInstanceState,
  UsageGuardWindowEstimate,
} from "./ProviderUsageGuard.ts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyUsageGuardOptimization,
  providerReportsExhausted,
  userPinnedEffortDuringHold,
  DEFAULT_TOKENS_PER_PERCENT_BY_DRIVER,
  emptyUsageGuardInstanceState,
  evaluateUsageGuard,
  extractUsageWindows,
  modelCostMultiplier,
  modelPercentPerMillionTokens,
  defaultEffortCostFactor,
  measuredEffortCost,
  recordBackgroundAdmission,
  recordTokensIntoState,
  recordWindowsIntoState,
  resolveUsageGuardProviderConfig,
  USAGE_GUARD_RECHECK_MS,
  usageGuardWakeAtMs,
  type UsageWindowSample,
} from "./ProviderUsageGuard.ts";

const NOW = Date.parse("2026-09-05T22:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const config = DEFAULT_USAGE_GUARD_PROVIDER_SETTINGS;
const CLAUDE_RATIO = DEFAULT_TOKENS_PER_PERCENT_BY_DRIVER.claudeAgent!;

function window(
  overrides: Partial<UsageWindowSample> & { readonly key: string; readonly usedPercent: number },
): UsageWindowSample {
  return {
    label: overrides.key,
    resetsAtMs: NOW + 2 * HOUR,
    windowDurationMs: 5 * HOUR,
    scope: "account",
    family: null,
    ...overrides,
  };
}

/** A window with a measured pace: two reports `spanMs` apart climbing `climb` points. */
function paced(input: {
  readonly key: string;
  readonly percent: number;
  readonly climb: number;
  readonly spanMs: number;
  readonly resetsAtMs: number;
  readonly scope?: UsageWindowSample["scope"];
  readonly family?: string | null;
  readonly driver?: string;
  readonly windowDurationMs?: number | null;
}) {
  const base = window({
    key: input.key,
    usedPercent: input.percent - input.climb,
    resetsAtMs: input.resetsAtMs,
    // Real windows carry their length, which is what puts usage on a time bar.
    windowDurationMs:
      input.windowDurationMs === undefined
        ? input.key.startsWith("five_hour")
          ? 5 * HOUR
          : 7 * DAY
        : input.windowDurationMs,
    scope: input.scope ?? "account",
    family: input.family ?? null,
  });
  const first = recordWindowsIntoState(
    emptyUsageGuardInstanceState(input.driver ?? "claudeAgent"),
    [base],
    NOW - input.spanMs,
  );
  return recordWindowsIntoState(first, [{ ...base, usedPercent: input.percent }], NOW);
}

describe("extractUsageWindows", () => {
  it("reads Claude typed rate-limit events and scopes each window", () => {
    const windows = extractUsageWindows("claudeAgent", {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        resetsAt: 1788663600,
        rateLimitType: "five_hour",
        unifiedWindows: {
          five_hour: { utilization: 0.54, resetsAt: 1788663600 },
          seven_day: { utilization: 0.34, resetsAt: 1788832800 },
          seven_day_fable: { utilization: 0.83, resetsAt: 1788832800 },
          seven_day_overage_included: { utilization: 0.88, resetsAt: 1788832800 },
        },
      },
    });
    expect(
      windows.map((entry) => [entry.key, entry.usedPercent, entry.scope, entry.family]),
    ).toEqual([
      ["five_hour", 54, "account", null],
      ["seven_day", 34, "account", null],
      ["seven_day_fable", 83, "model-family", "fable"],
      ["seven_day_overage_included", 88, "extra-usage", null],
    ]);
    expect(windows[0]?.windowDurationMs).toBe(5 * HOUR);
    expect(windows[2]?.label).toBe("Fable weekly");
  });

  it("reads the Fable window out of Claude's model-scoped usage arrays", () => {
    // The live `/usage` payload for a Fable-tier plan (2026-09-06): the
    // typed `seven_day_fable` key is absent, and the only place the window
    // appears is the `model_scoped` array and the `limits` array, both keyed
    // by display name. The guard skipped both, saw a 71% weekly window with
    // room, and let Fable be hammered at 99%.
    const windows = extractUsageWindows("claudeAgent", {
      rate_limits: {
        five_hour: { utilization: 24, resets_at: "2026-08-31T08:29:59.725375+00:00" },
        seven_day: { utilization: 71, resets_at: "2026-09-05T05:59:59.725399+00:00" },
        seven_day_opus: null,
        extra_usage: { is_enabled: true, utilization: null },
        limits: [
          { kind: "session", group: "session", percent: 24, scope: null },
          {
            kind: "weekly_scoped",
            group: "weekly",
            percent: 99,
            resets_at: "2026-09-05T05:59:59.725712+00:00",
            scope: { model: { display_name: "Fable", id: null }, surface: null },
          },
        ],
        model_scoped: [
          { display_name: "Fable", utilization: 99, resets_at: "2026-09-05T05:59:59.725712+00:00" },
        ],
      },
    });
    expect(
      windows.map((entry) => [entry.key, entry.usedPercent, entry.scope, entry.family]),
    ).toEqual([
      ["five_hour", 24, "account", null],
      ["seven_day", 71, "account", null],
      ["seven_day_fable", 99, "model-family", "fable"],
    ]);
    const fable = windows[2]!;
    expect(fable.label).toBe("Fable weekly");
    expect(fable.windowDurationMs).toBe(7 * DAY);
    expect(fable.resetsAtMs).toBe(Date.parse("2026-09-05T05:59:59.725Z"));
  });

  it("falls back to the limits array when model_scoped is missing", () => {
    const windows = extractUsageWindows("claudeAgent", {
      rate_limits: {
        seven_day: { utilization: 40, resets_at: "2026-09-05T05:59:59Z" },
        limits: [
          {
            kind: "weekly_scoped",
            percent: 88,
            resets_at: "2026-09-05T05:59:59Z",
            scope: { model: { display_name: "Claude Opus 5" } },
          },
        ],
      },
    });
    expect(windows.map((entry) => [entry.key, entry.usedPercent])).toEqual([
      ["seven_day", 40],
      ["seven_day_opus", 88],
    ]);
  });

  it("treats a Claude rejection without utilization as a full window", () => {
    const windows = extractUsageWindows("claudeAgent", {
      rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 1788832800 },
    });
    expect(windows).toHaveLength(1);
    expect(windows[0]?.usedPercent).toBe(100);
    expect(windows[0]?.key).toBe("seven_day");
  });

  it("reads Codex weekly windows and skips the retired five-hour one", () => {
    const windows = extractUsageWindows("codex", {
      rateLimits: {
        primary: { usedPercent: 83, resetsAt: 1789230247, windowDurationMins: 10080 },
        secondary: { usedPercent: 0, resetsAt: 1788660000, windowDurationMins: 300 },
      },
    });
    expect(windows).toEqual([
      {
        key: "weekly",
        label: "weekly",
        usedPercent: 83,
        resetsAtMs: 1789230247_000,
        windowDurationMs: 10080 * MINUTE,
        scope: "account",
        family: null,
      },
    ]);
  });

  it("reads Grok credit pools and ignores drivers without usage", () => {
    expect(
      extractUsageWindows("grok", {
        config: { creditUsagePercent: 41, currentPeriod: { end: 1789230247 } },
      }),
    ).toMatchObject([{ key: "weekly", usedPercent: 41, scope: "account" }]);
    expect(extractUsageWindows("cursor", { anything: true })).toEqual([]);
  });
});

describe("modelCostMultiplier", () => {
  it("weights tokens by the model's cost tier and defaults to 1", () => {
    expect(modelCostMultiplier("claudeAgent", "claude-fable-5-1")).toBe(5);
    expect(modelCostMultiplier("claudeAgent", "claude-opus-5")).toBe(2.5);
    expect(modelCostMultiplier("claudeAgent", "claude-sonnet-5")).toBe(1);
    expect(modelCostMultiplier("claudeAgent", "claude-haiku-4-5")).toBe(0.5);
    // Codex, relative to GPT-6 Astra (250 credits/MTok input).
    expect(modelCostMultiplier("codex", "gpt-6-astra")).toBe(1);
    expect(modelCostMultiplier("codex", "gpt-5.6-daybreak-red")).toBe(1.25);
    expect(modelCostMultiplier("codex", "gpt-5.5")).toBe(0.5);
    expect(modelCostMultiplier("codex", "gpt-5.6-sol")).toBe(0.4);
    expect(modelCostMultiplier("codex", "gpt-5.6-daybreak-blue")).toBe(0.4);
    expect(modelCostMultiplier("codex", "gpt-5.4")).toBe(0.25);
    expect(modelCostMultiplier("codex", "gpt-5.6-terra")).toBe(0.2);
    expect(modelCostMultiplier("codex", "gpt-5.4-mini")).toBe(0.075);
    expect(modelCostMultiplier("codex", "gpt-5.6-luna")).toBe(0.02);
    expect(modelCostMultiplier("codex", "gpt-5.3-codex-spark")).toBe(1);
    // Grok, relative to Grok 4.6 ($2/MTok input).
    expect(modelCostMultiplier("grok", "grok-4.6")).toBe(1);
    expect(modelCostMultiplier("grok", "grok-4-5")).toBe(1);
    expect(modelCostMultiplier("grok", "grok-build")).toBe(0.5);
    expect(modelCostMultiplier("grok", "grok-4.3")).toBe(0.625);
    expect(modelCostMultiplier("grok", "grok-4-1-fast")).toBe(0.625);
    expect(modelCostMultiplier("claudeAgent", null)).toBe(1);
  });
});

describe("evaluateUsageGuard", () => {
  it("is idle with no report", () => {
    const evaluation = evaluateUsageGuard({
      state: emptyUsageGuardInstanceState("claudeAgent"),
      config,
      nowMs: NOW,
    });
    expect(evaluation.tier).toBe("none");
    expect(evaluation.estimatedPercent).toBeNull();
    expect(evaluation.admitBackground).toBe(true);
    expect(evaluation.tokensPerPercent).toBe(CLAUDE_RATIO);
  });

  it("waits for the clock to catch up rather than for the reset", () => {
    // The 2026-09-06 regression: a fixed 80% threshold paused a thread's
    // continuation for a day at 81% with five days left and ~4%/day burn.
    const state = paced({
      key: "seven_day",
      percent: 81,
      climb: 1,
      spanMs: 12 * HOUR,
      resetsAtMs: NOW + 5 * DAY,
    });
    const evaluation = evaluateUsageGuard({ state, config, nowMs: NOW, model: "claude-opus-5" });
    // Two of seven days gone with 81% spent is genuinely ahead of pace, so the
    // guard does pull — but what it must never do, and the regression this
    // guards, is hold the thread. It trims and keeps working.
    // 81% spent two days into a week is ahead of pace, so work waits — but for
    // the bar to catch up, which is sooner than the reset. Never a hold.
    expect(evaluation.aheadOfPacePercent).toBeCloseTo(81 - (2 / 7) * 100, 5);
    expect(evaluation.tier).toBe("optimize");
    expect(evaluation.admitBackground).toBe(false);
    expect(evaluation.backgroundCooldownMs!).toBeLessThan(5 * DAY);
  });

  it("optimizes when the pace would overrun the reset, by as much as the overrun needs", () => {
    // 4h left of a 5h window is 20% of the way through. How hard the guard
    // pulls is how far usage sits past that bar, and nothing else.
    const gentle = paced({
      key: "five_hour",
      percent: 40,
      climb: 4,
      spanMs: 20 * MINUTE,
      resetsAtMs: NOW + 4 * HOUR,
    });
    const mild = evaluateUsageGuard({ state: gentle, config, nowMs: NOW });
    expect(mild.tier).toBe("optimize");
    expect(mild.pressure).toBeGreaterThan(1);
    expect(mild.aheadOfPacePercent).toBeCloseTo(20, 5);

    const steep = paced({
      key: "five_hour",
      percent: 80,
      climb: 4,
      spanMs: 20 * MINUTE,
      resetsAtMs: NOW + 4 * HOUR,
    });
    const severe = evaluateUsageGuard({ state: steep, config, nowMs: NOW });
    expect(severe.tier).toBe("optimize");
    expect(severe.aheadOfPacePercent).toBeCloseTo(60, 5);
    expect(severe.pressure).toBeGreaterThan(mild.pressure);
    expect(severe.effortTarget).toBe("low");
  });

  it("never lowers effort when the provider's switch for it is off", () => {
    const steep = paced({
      key: "five_hour",
      percent: 60,
      climb: 15,
      spanMs: 20 * MINUTE,
      resetsAtMs: NOW + 4 * HOUR,
    });
    const evaluation = evaluateUsageGuard({
      state: steep,
      config: { ...config, reduceEffort: false },
      nowMs: NOW,
    });
    expect(evaluation.tier).toBe("optimize");
    expect(evaluation.effortTarget).toBeNull();
  });

  it("holds only when one more turn on the chosen model no longer fits", () => {
    let state = recordWindowsIntoState(
      emptyUsageGuardInstanceState("claudeAgent"),
      [window({ key: "five_hour", usedPercent: 85 })],
      NOW - MINUTE,
    );
    // Teach the guard what a Fable turn costs: 3M raw tokens × 5 = 15M weighted = 7.5 points.
    state = recordTokensIntoState(state, {
      tokens: 3_000_000,
      model: "claude-fable-5-1",
      nowMs: NOW,
    });
    // Pinned rather than left to the driver default, because a turn cost the
    // guard only guessed at is not allowed to hold work; this test is about
    // the fits rule and per-model weighting, not about where the scale
    // came from. The number is the Claude default, so the arithmetic below is
    // unchanged.
    const priced = { ...config, tokensPerPercent: CLAUDE_RATIO };
    const fable = evaluateUsageGuard({
      state,
      config: priced,
      nowMs: NOW,
      model: "claude-fable-5-1",
    });
    expect(fable.turnCostPercent).toBeCloseTo(7.5, 5);
    // Estimated ~92.5% (the 15M weighted tokens since the report) + 7.5 + 3 headroom > 100.
    expect(fable.tier).toBe("pause");
    expect(fable.admitBackground).toBe(false);

    // A Haiku turn on the same account: ten times cheaper, and the window is
    // read with Haiku's own weight.
    const haiku = evaluateUsageGuard({
      state,
      config: priced,
      nowMs: NOW,
      model: "claude-haiku-4-5",
    });
    expect(haiku.turnCostPercent).toBeLessThan(1);
    expect(haiku.tier).not.toBe("pause");
  });

  it("does not hold when holding is switched off", () => {
    let state = recordWindowsIntoState(
      emptyUsageGuardInstanceState("claudeAgent"),
      [window({ key: "five_hour", usedPercent: 99 })],
      NOW,
    );
    state = recordTokensIntoState(state, {
      tokens: 3_000_000,
      model: "claude-fable-5-1",
      nowMs: NOW,
    });
    const evaluation = evaluateUsageGuard({
      state,
      config: { ...config, pauseWhenExhausted: false },
      nowMs: NOW,
      model: "claude-fable-5-1",
    });
    expect(evaluation.tier).toBe("optimize");
  });

  it("compares usage against the time bar and leaves work alone when behind it", () => {
    // The 2026-09-06 report: weekly 59% used with 1d 1h left of seven days.
    // That is 85% of the way through the window, so usage is 26 points BEHIND
    // the bar and nothing should be limited. The old burn-rate model paced
    // this at roughly one turn every three hours.
    const state = recordWindowsIntoState(
      emptyUsageGuardInstanceState("claudeAgent"),
      [
        window({
          key: "seven_day",
          usedPercent: 59,
          resetsAtMs: NOW + 25 * HOUR,
          windowDurationMs: 7 * DAY,
        }),
      ],
      NOW,
    );
    const evaluation = evaluateUsageGuard({ state, config, nowMs: NOW, model: "claude-opus-5" });
    expect(evaluation.elapsedPercent).toBeCloseTo((143 / 168) * 100, 5);
    expect(evaluation.aheadOfPacePercent).toBeLessThan(0);
    expect(evaluation.pressure).toBe(0);
    expect(evaluation.tier).toBe("none");
    expect(evaluation.admitBackground).toBe(true);
    expect(evaluation.backgroundCooldownMs).toBeNull();
  });

  it("limits harder the further usage runs ahead of the time bar", () => {
    const at = (usedPercent: number) =>
      evaluateUsageGuard({
        state: recordWindowsIntoState(
          emptyUsageGuardInstanceState("claudeAgent"),
          [
            window({
              key: "seven_day",
              usedPercent,
              resetsAtMs: NOW + 5 * DAY,
              windowDurationMs: 7 * DAY,
            }),
          ],
          NOW,
        ),
        config,
        nowMs: NOW,
        model: "claude-opus-5",
      });
    // Two sevenths through the window: ~28.6% is exactly on pace.
    const onPace = at(28);
    expect(onPace.tier).toBe("none");
    const ahead = at(45);
    const further = at(60);
    expect(ahead.tier).toBe("optimize");
    expect(further.pressure).toBeGreaterThan(ahead.pressure);
  });

  it("states each model's cost as a fixed percentage per million tokens", () => {
    // The whole per-model cost model, so the saving between two options is the
    // difference of two constants rather than anything learned.
    expect(modelPercentPerMillionTokens("claudeAgent", "claude-fable-5-1")).toBeCloseTo(2.5, 10);
    expect(modelPercentPerMillionTokens("claudeAgent", "claude-opus-5")).toBeCloseTo(1.25, 10);
    expect(modelPercentPerMillionTokens("claudeAgent", "claude-sonnet-5")).toBeCloseTo(0.5, 10);
    expect(modelPercentPerMillionTokens("claudeAgent", "claude-haiku-4-5")).toBeCloseTo(0.25, 10);
  });

  it("releases the hold on a spent window with no credits behind it", () => {
    // Claude reporting overageStatus rejected / out_of_credits: there is
    // nothing to wait for but the reset, so let the provider refuse rather
    // than hold the person's work silently for hours.
    const state = recordWindowsIntoState(
      emptyUsageGuardInstanceState("claudeAgent"),
      [
        window({
          key: "seven_day",
          usedPercent: 100,
          resetsAtMs: NOW + 2 * DAY,
          windowDurationMs: 7 * DAY,
        }),
      ],
      NOW,
    );
    const evaluation = evaluateUsageGuard({ state, config, nowMs: NOW, model: "claude-opus-5" });
    expect(evaluation.tier).not.toBe("pause");
    expect(evaluation.admitBackground).toBe(true);
  });

  it("ignores a family window when the turn's own family is unknown", () => {
    // Observed live on 0.1.461: an opus thread governed by "Fable weekly" at
    // 100% and paced to a turn a day. An unknown family made every family
    // window apply, so a spent one it had no business obeying governed it.
    const state = recordWindowsIntoState(
      emptyUsageGuardInstanceState("claudeAgent"),
      [
        window({
          key: "seven_day",
          usedPercent: 20,
          resetsAtMs: NOW + 5 * DAY,
          windowDurationMs: 7 * DAY,
        }),
        window({
          key: "seven_day_fable",
          usedPercent: 100,
          resetsAtMs: NOW + 5 * DAY,
          windowDurationMs: 7 * DAY,
          scope: "model-family",
          family: "fable",
        }),
      ],
      NOW,
    );
    const unknown = evaluateUsageGuard({ state, config, nowMs: NOW, model: null });
    expect(unknown.windowKey).toBe("seven_day");
    expect(unknown.tier).toBe("none");
    // And a model that really is Fable still answers to it.
    const onFable = evaluateUsageGuard({ state, config, nowMs: NOW, model: "claude-fable-5-1" });
    expect(onFable.windowKey).toBe("seven_day_fable");
  });

  it("does not meter background work on a window it declined to hold", () => {
    // Releasing the hold has to mean releasing it: pacing a spent window to one
    // turn every 25 hours is the same hold under another name.
    const state = recordWindowsIntoState(
      emptyUsageGuardInstanceState("claudeAgent"),
      [
        window({
          key: "seven_day",
          usedPercent: 100,
          resetsAtMs: NOW + 25 * HOUR,
          windowDurationMs: 7 * DAY,
        }),
      ],
      NOW,
    );
    const evaluation = evaluateUsageGuard({
      state,
      config: { ...config, holdBackgroundWork: true },
      nowMs: NOW,
      model: "claude-opus-5",
    });
    expect(evaluation.tier).not.toBe("pause");
    expect(evaluation.admitBackground).toBe(true);
    expect(evaluation.backgroundCooldownMs).toBeNull();
  });

  it("drops a window whose model id it does not recognise", () => {
    // Live on 0.1.462: Claude reported a `nimbus_quill` window. Unrecognised
    // keys fell through to account scope, so it attached to every model, listed
    // itself under every entry in the model comparison, and — being duration-
    // less — paced 0%-used work to a turn every 23 minutes.
    const windows = extractUsageWindows("claudeAgent", {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        unifiedWindows: {
          five_hour: { utilization: 0.14, resetsAt: 1788755400 },
          nimbus_quill: { utilization: 0, resetsAt: 1788832800 },
        },
      },
    });
    expect(windows.map((entry) => entry.key)).toEqual(["five_hour"]);
  });

  it("never limits on a window it cannot place on a clock", () => {
    // No duration and no reset: there is no time bar, and the time bar is the
    // whole model. Extrapolating a burn instead is what produced the pacing.
    const state = paced({
      key: "seven_day",
      percent: 40,
      climb: 20,
      spanMs: HOUR,
      resetsAtMs: NOW + 3 * HOUR,
      windowDurationMs: null,
    });
    const evaluation = evaluateUsageGuard({
      state,
      config: { ...config, holdBackgroundWork: true },
      nowMs: NOW,
      model: "claude-opus-5",
    });
    expect(evaluation.pressure).toBe(0);
    expect(evaluation.tier).toBe("none");
    expect(evaluation.backgroundCooldownMs).toBeNull();
  });

  it("honours a token cap the person set, on top of the window maths", () => {
    // A ceiling of the user's own choosing: at most N weighted tokens in any
    // rolling window. It is additive — with no cap set, nothing about the
    // guard's behaviour changes.
    const healthy = paced({
      key: "seven_day",
      percent: 5,
      climb: 1,
      spanMs: 12 * HOUR,
      resetsAtMs: NOW + 6 * DAY,
    });
    let state = healthy;
    for (let index = 0; index < 4; index += 1) {
      state = recordTokensIntoState(state, {
        tokens: 500_000,
        model: "claude-sonnet-5",
        nowMs: NOW - 3 * HOUR + index * MINUTE,
      });
    }

    // The provider's own windows are healthy, so without a cap work goes ahead.
    const uncapped = evaluateUsageGuard({ state, config, nowMs: NOW, model: "claude-sonnet-5" });
    expect(uncapped.tier).toBe("none");
    expect(uncapped.admitBackground).toBe(true);
    expect(uncapped.tokenCapSpent).toBeNull();

    // 2M weighted tokens spent against a 1M cap: held, even though the account
    // is at 5%. The wait is the rolling window freeing, not the provider reset.
    const capped = evaluateUsageGuard({
      state,
      config: { ...config, tokenCapTokens: 1_000_000, tokenCapHours: 4 },
      nowMs: NOW,
      model: "claude-sonnet-5",
    });
    expect(capped.tokenCapSpent).toBe(2_000_000);
    expect(capped.admitBackground).toBe(false);
    expect(capped.summary).toContain("your own cap");
    expect(capped.nextBackgroundAdmitAtMs).toBe(NOW - 3 * HOUR + 4 * HOUR);

    // A cap with room left does not interfere.
    const roomy = evaluateUsageGuard({
      state,
      config: { ...config, tokenCapTokens: 50_000_000, tokenCapHours: 4 },
      nowMs: NOW,
      model: "claude-sonnet-5",
    });
    expect(roomy.admitBackground).toBe(true);

    // And spend outside the window does not count against it.
    const aged = evaluateUsageGuard({
      state,
      config: { ...config, tokenCapTokens: 1_000_000, tokenCapHours: 1 },
      nowMs: NOW,
      model: "claude-sonnet-5",
    });
    expect(aged.tokenCapSpent).toBe(0);
    expect(aged.admitBackground).toBe(true);
  });

  it("binds a model-family window only to turns on that family", () => {
    const state = recordWindowsIntoState(
      emptyUsageGuardInstanceState("claudeAgent"),
      [
        window({ key: "seven_day", usedPercent: 45, resetsAtMs: NOW + 2 * DAY }),
        window({
          key: "seven_day_fable",
          usedPercent: 99,
          resetsAtMs: NOW + 2 * DAY,
          scope: "model-family",
          family: "fable",
        }),
      ],
      NOW,
    );
    const onFable = evaluateUsageGuard({ state, config, nowMs: NOW, model: "claude-fable-5-1" });
    expect(onFable.windowKey).toBe("seven_day_fable");
    expect(onFable.tier).toBe("pause");
    const onSonnet = evaluateUsageGuard({ state, config, nowMs: NOW, model: "claude-sonnet-5" });
    expect(onSonnet.windowKey).toBe("seven_day");
    expect(onSonnet.tier).toBe("none");
  });

  it("keeps working on paid extra usage instead of holding, unless told to avoid it", () => {
    const state = recordWindowsIntoState(
      emptyUsageGuardInstanceState("claudeAgent"),
      [
        window({ key: "seven_day", usedPercent: 100, resetsAtMs: NOW + 2 * DAY }),
        window({
          key: "seven_day_overage_included",
          usedPercent: 40,
          resetsAtMs: NOW + 2 * DAY,
          scope: "extra-usage",
        }),
      ],
      NOW,
    );
    const allowed = evaluateUsageGuard({ state, config, nowMs: NOW, model: "claude-sonnet-5" });
    expect(allowed.tier).toBe("extra-usage");
    expect(allowed.windowKey).toBe("seven_day_overage_included");
    expect(allowed.effortTarget).not.toBeNull();
    expect(allowed.admitBackground).toBe(true);

    const avoided = evaluateUsageGuard({
      state,
      config: { ...config, extraUsage: "avoid" },
      nowMs: NOW,
      model: "claude-sonnet-5",
    });
    expect(avoided.tier).toBe("pause");
  });

  it("never lets an extra-usage window alone hold work", () => {
    // The 2026-09-06 screenshot: weekly 45%, extra usage 88%. Extra usage
    // measures paid overage; it must not read as a hold on its own.
    const state = recordWindowsIntoState(
      emptyUsageGuardInstanceState("claudeAgent"),
      [
        window({ key: "seven_day", usedPercent: 45, resetsAtMs: NOW + 2 * DAY }),
        window({
          key: "seven_day_overage_included",
          usedPercent: 88,
          resetsAtMs: NOW + 2 * DAY,
          scope: "extra-usage",
        }),
      ],
      NOW,
    );
    const evaluation = evaluateUsageGuard({ state, config, nowMs: NOW, model: "claude-opus-5" });
    expect(evaluation.tier).toBe("none");
    expect(evaluation.windowKey).toBe("seven_day");
  });

  it("meters admissions even when the account can afford a whole thread", () => {
    // 60% used, 4h left: 37 points of budget ≈ 9.25%/h allowed.
    // Lower reasoning must not manufacture an assumed 50% saving.
    let state = paced({
      key: "five_hour",
      percent: 60,
      climb: 5,
      spanMs: 20 * MINUTE,
      resetsAtMs: NOW + 4 * HOUR,
    });
    for (let index = 0; index < 8; index += 1) {
      state = recordTokensIntoState(state, {
        tokens: 1_000,
        model: null,
        nowMs: NOW - 8 * MINUTE + index * MINUTE,
        activeThreads: 3,
      });
    }
    const busy = evaluateUsageGuard({ state, config, nowMs: NOW, activeThreads: 3 });
    expect(busy.tier).toBe("optimize");
    expect(busy.backgroundBudget).toBe(0);
    // One hour into a five-hour window with 60% gone is well past the bar, so
    // work waits. There is no free first turn: admission is what the tokens say.
    expect(busy.admitBackground).toBe(false);
    expect(busy.backgroundCooldownMs).toBeGreaterThan(0);

    // Finishing a sibling must not bypass the account's admission clock.
    const roomier = evaluateUsageGuard({
      state: recordBackgroundAdmission(state, NOW),
      config,
      nowMs: NOW,
      activeThreads: 1,
    });
    expect(roomier.backgroundBudget).toBe(0);
    // Freeing a sibling does not move the bar, so the wait stands.
    expect(roomier.admitBackground).toBe(false);

    // Metering off: background goes through at reduced effort like everything else.
    const unmetered = evaluateUsageGuard({
      state,
      config: { ...config, holdBackgroundWork: false },
      nowMs: NOW,
      activeThreads: 3,
    });
    expect(unmetered.admitBackground).toBe(true);
  });

  it("paces background turns once the thread budget is spent instead of holding to the reset", () => {
    // A Fable window well ahead of its pace: 89% used with 44h to go, filling
    // 2%/h under one thread. 8 points of room over 44h affords ~0.18%/h,
    // which is not one thread's worth - the budget is 0. That used to mean
    // "hold until the reset", 44 hours of a thread parked at 89%. Now it
    // means one turn every so often, spaced so the window lands on 100% at
    // the reset, not before.
    let state = paced({
      key: "seven_day_fable",
      percent: 89,
      climb: 2,
      spanMs: HOUR,
      resetsAtMs: NOW + 44 * HOUR,
      scope: "model-family",
      family: "fable",
    });
    for (let index = 0; index < 4; index += 1) {
      state = recordTokensIntoState(state, {
        tokens: 200_000,
        model: "claude-fable-5-1",
        nowMs: NOW - 40 * MINUTE + index * 10 * MINUTE,
        activeThreads: 1,
      });
    }
    const first = evaluateUsageGuard({
      state,
      config,
      nowMs: NOW,
      model: "claude-fable-5-1",
      activeThreads: 1,
    });
    expect(first.tier).toBe("optimize");
    expect(first.windowKey).toBe("seven_day_fable");
    expect(first.backgroundBudget).toBe(0);
    expect(first.backgroundCooldownMs).not.toBeNull();
    const cooldown = first.backgroundCooldownMs!;
    expect(cooldown).toBeGreaterThan(30 * MINUTE);
    expect(cooldown).toBeLessThan(44 * HOUR);
    // Nothing has gone out yet under the cooldown: the first turn is admitted.
    expect(first.admitBackground).toBe(false);
    expect(first.summary).toContain("paced to one turn every");

    // Straight after one goes out, the next waits its spacing - and the wake
    // is the end of that spacing, not the five-minute recheck.
    const admitted = recordBackgroundAdmission(state, NOW);
    const held = evaluateUsageGuard({
      state: admitted,
      config,
      nowMs: NOW + MINUTE,
      model: "claude-fable-5-1",
      activeThreads: 1,
    });
    expect(held.admitBackground).toBe(false);
    // The spacing is recomputed on every read as the runway shrinks, so it
    // drifts by seconds between evaluations; the wake tracks it exactly.
    expect(Math.abs(held.nextBackgroundAdmitAtMs! - (NOW + cooldown))).toBeLessThan(MINUTE);
    expect(usageGuardWakeAtMs(held, NOW + MINUTE)).toBe(held.nextBackgroundAdmitAtMs);

    // Once the spacing has elapsed the next turn goes.
    const later = evaluateUsageGuard({
      state: admitted,
      config,
      nowMs: NOW + cooldown,
      model: "claude-fable-5-1",
      activeThreads: 1,
    });
    expect(later.admitBackground).toBe(true);
    expect(later.nextBackgroundAdmitAtMs).toBeNull();

    // The cooldown is a pace, not a pause switch: with metering off there is none.
    const unmetered = evaluateUsageGuard({
      state: admitted,
      config: { ...config, holdBackgroundWork: false },
      nowMs: NOW + MINUTE,
      model: "claude-fable-5-1",
      activeThreads: 1,
    });
    expect(unmetered.admitBackground).toBe(true);
    expect(unmetered.backgroundCooldownMs).toBeNull();
  });

  it("holds when observed spending exhausts the estimate before another report arrives", () => {
    let state = recordWindowsIntoState(
      emptyUsageGuardInstanceState("claudeAgent"),
      [window({ key: "five_hour", usedPercent: 30, resetsAtMs: NOW + 4 * HOUR })],
      NOW,
    );
    state = recordTokensIntoState(state, { tokens: 10_000_000_000, model: null, nowMs: NOW + 1 });
    const evaluation = evaluateUsageGuard({
      state,
      config: { ...config, tokensPerPercent: 1_000 },
      nowMs: NOW + 1,
    });
    expect(evaluation.estimatedPercent).toBe(100);
    expect(evaluation.admitBackground).toBe(false);
    expect(evaluation.tokensPerPercentSource).toBe("configured");
  });

  it("treats a window whose reset passed as empty until the next report", () => {
    const state = recordWindowsIntoState(
      emptyUsageGuardInstanceState("claudeAgent"),
      [window({ key: "five_hour", usedPercent: 99, resetsAtMs: NOW - MINUTE })],
      NOW - HOUR,
    );
    const evaluation = evaluateUsageGuard({ state, config, nowMs: NOW });
    expect(evaluation.tier).toBe("none");
    expect(evaluation.windows[0]?.expired).toBe(true);
  });

  it("re-checks held work within minutes rather than sleeping to the reset", () => {
    const state = recordWindowsIntoState(
      emptyUsageGuardInstanceState("codex"),
      [
        window({
          key: "weekly",
          usedPercent: 99,
          resetsAtMs: NOW + 5 * DAY,
          windowDurationMs: null,
        }),
      ],
      NOW,
    );
    const evaluation = evaluateUsageGuard({ state, config, nowMs: NOW });
    expect(usageGuardWakeAtMs(evaluation, NOW)).toBe(NOW + USAGE_GUARD_RECHECK_MS);
    const soon = recordWindowsIntoState(
      emptyUsageGuardInstanceState("codex"),
      [
        window({
          key: "weekly",
          usedPercent: 99,
          resetsAtMs: NOW + 2 * MINUTE,
          windowDurationMs: null,
        }),
      ],
      NOW,
    );
    expect(usageGuardWakeAtMs(evaluateUsageGuard({ state: soon, config, nowMs: NOW }), NOW)).toBe(
      NOW + 2 * MINUTE + 30_000,
    );
  });
});

describe("recordWindowsIntoState", () => {
  it("measures what a point of a window costs from the provider's own climb", () => {
    let state = recordWindowsIntoState(
      emptyUsageGuardInstanceState("claudeAgent"),
      [window({ key: "five_hour", usedPercent: 40 })],
      NOW,
    );
    // 100M raw Sonnet tokens (multiplier 1) bought a 5-point climb, so a point
    // of this window costs 20M weighted tokens on this account. The driver
    // default is a guess at the plan's allowance and cannot be right for every
    // plan: shipped at 2,000,000 for Claude, a real account measured 20.9M on
    // its five-hour window and ~700M on its weekly one, so the guard priced a
    // turn at 380x its real cost and held that account's own queued messages
    // behind a reserve nothing could free.
    state = recordTokensIntoState(state, {
      tokens: 100_000_000,
      model: "claude-sonnet-5",
      nowMs: NOW + MINUTE,
    });
    state = recordWindowsIntoState(
      state,
      [window({ key: "five_hour", usedPercent: 45 })],
      NOW + 2 * MINUTE,
    );
    const five = state.windows.five_hour!;
    expect(five.calibrationSamples).toBe(1);
    expect(five.learnedTokensPerPercent).toBe(20_000_000);
    const evaluation = evaluateUsageGuard({ state, config, nowMs: NOW + 2 * MINUTE });
    expect(evaluation.tokensPerPercentSource).toBe("learned");
    expect(evaluation.tokensPerPercent).toBe(20_000_000);
    // Turning calibration off falls back to the driver default.
    const fixed = evaluateUsageGuard({
      state,
      config: { ...config, autoCalibrate: false },
      nowMs: NOW + 2 * MINUTE,
    });
    expect(fixed.tokensPerPercentSource).toBe("default");
    expect(fixed.tokensPerPercent).toBe(CLAUDE_RATIO);
  });

  it("throws away a measurement that undercuts the platform's own floor", () => {
    let state = recordWindowsIntoState(
      emptyUsageGuardInstanceState("claudeAgent"),
      [window({ key: "five_hour", usedPercent: 10 })],
      NOW,
    );
    // A Claude Code running outside this app burns 10 points while we record
    // 10M tokens. Taken at face value that says a point costs 1M — under the
    // driver default, which can only mean the meter missed spend the account
    // really made. Believing it would make every turn look twice as expensive
    // as the constant already did, which is the direction that over-holds.
    state = recordTokensIntoState(state, {
      tokens: 10_000_000,
      model: "claude-sonnet-5",
      nowMs: NOW + MINUTE,
    });
    state = recordWindowsIntoState(
      state,
      [window({ key: "five_hour", usedPercent: 20 })],
      NOW + 2 * MINUTE,
    );
    expect(state.windows.five_hour!.learnedTokensPerPercent).toBeNull();
    expect(state.windows.five_hour!.calibrationSamples).toBe(0);
    expect(
      evaluateUsageGuard({ state, config, nowMs: NOW + 2 * MINUTE }).tokensPerPercentSource,
    ).toBe("default");
    // A reading the meter actually accounts for is kept.
    state = recordTokensIntoState(state, {
      tokens: 200_000_000,
      model: "claude-sonnet-5",
      nowMs: NOW + 3 * MINUTE,
    });
    state = recordWindowsIntoState(
      state,
      [window({ key: "five_hour", usedPercent: 30 })],
      NOW + 4 * MINUTE,
    );
    expect(state.windows.five_hour!.learnedTokensPerPercent).toBe(20_000_000);
  });

  it("resists a measurement that would make turns look more expensive", () => {
    let state = recordWindowsIntoState(
      emptyUsageGuardInstanceState("claudeAgent"),
      [window({ key: "five_hour", usedPercent: 10 })],
      NOW,
    );
    state = recordTokensIntoState(state, {
      tokens: 100_000_000,
      model: "claude-sonnet-5",
      nowMs: NOW + MINUTE,
    });
    state = recordWindowsIntoState(
      state,
      [window({ key: "five_hour", usedPercent: 15 })],
      NOW + 2 * MINUTE,
    );
    expect(state.windows.five_hour!.learnedTokensPerPercent).toBe(20_000_000);
    // Above the floor but still depressed — partly our spend, partly someone
    // else's. It moves the estimate a tenth of the way, not all of it.
    state = recordTokensIntoState(state, {
      tokens: 15_000_000,
      model: "claude-sonnet-5",
      nowMs: NOW + 3 * MINUTE,
    });
    state = recordWindowsIntoState(
      state,
      [window({ key: "five_hour", usedPercent: 20 })],
      NOW + 4 * MINUTE,
    );
    expect(state.windows.five_hour!.learnedTokensPerPercent).toBeCloseTo(
      20_000_000 * 0.9 + 3_000_000 * 0.1,
      5,
    );
    // A reading that makes turns look cheaper is taken quickly instead.
    state = recordTokensIntoState(state, {
      tokens: 200_000_000,
      model: "claude-sonnet-5",
      nowMs: NOW + 5 * MINUTE,
    });
    state = recordWindowsIntoState(
      state,
      [window({ key: "five_hour", usedPercent: 25 })],
      NOW + 6 * MINUTE,
    );
    expect(state.windows.five_hour!.learnedTokensPerPercent).toBeGreaterThan(30_000_000);
  });

  it("takes the first measurement early, then waits for a climb worth dividing by", () => {
    let state = recordWindowsIntoState(
      emptyUsageGuardInstanceState("claudeAgent"),
      [window({ key: "five_hour", usedPercent: 40 })],
      NOW,
    );
    // No measurement at all means the driver default, which can be orders of
    // magnitude out, so the first sample settles for a 2-point climb.
    state = recordTokensIntoState(state, {
      tokens: 40_000_000,
      model: "claude-sonnet-5",
      nowMs: NOW + MINUTE,
    });
    state = recordWindowsIntoState(
      state,
      [window({ key: "five_hour", usedPercent: 42 })],
      NOW + 2 * MINUTE,
    );
    expect(state.windows.five_hour!.calibrationSamples).toBe(1);
    expect(state.windows.five_hour!.learnedTokensPerPercent).toBe(20_000_000);
    // With a measurement in hand, a 2-point climb is mostly the provider's own
    // rounding — utilization arrives quantized to whole points — so it is left
    // alone and the anchor holds.
    state = recordTokensIntoState(state, {
      tokens: 10_000_000,
      model: "claude-sonnet-5",
      nowMs: NOW + 3 * MINUTE,
    });
    state = recordWindowsIntoState(
      state,
      [window({ key: "five_hour", usedPercent: 44 })],
      NOW + 4 * MINUTE,
    );
    expect(state.windows.five_hour!.calibrationSamples).toBe(1);
    expect(state.windows.five_hour!.anchorPercent).toBe(42);
    // Past five points it samples the whole climb since that anchor, not the tail.
    state = recordTokensIntoState(state, {
      tokens: 40_000_000,
      model: "claude-sonnet-5",
      nowMs: NOW + 5 * MINUTE,
    });
    state = recordWindowsIntoState(
      state,
      [window({ key: "five_hour", usedPercent: 47 })],
      NOW + 6 * MINUTE,
    );
    const five = state.windows.five_hour!;
    expect(five.calibrationSamples).toBe(2);
    // 50M weighted over 5 points = 10M/point — cheaper than the first reading
    // said, so it only moves a tenth of the way. Readings that push turn costs
    // up are the ones an external client fakes, so they are damped.
    expect(five.learnedTokensPerPercent).toBeCloseTo(20_000_000 * 0.9 + 10_000_000 * 0.1, 5);
  });

  it("will not hold work on a turn cost it only guessed at", () => {
    // Same shape as the fits test above, minus a measured scale. 85% reported,
    // 15M weighted tokens since — the guard still reads the window as nearly
    // full, but the amount it thinks one more turn costs is the driver default
    // and it declines to hold on that.
    let state = recordWindowsIntoState(
      emptyUsageGuardInstanceState("claudeAgent"),
      [window({ key: "five_hour", usedPercent: 85 })],
      NOW - MINUTE,
    );
    state = recordTokensIntoState(state, {
      tokens: 3_000_000,
      model: "claude-fable-5-1",
      nowMs: NOW,
    });
    const guessed = evaluateUsageGuard({ state, config, nowMs: NOW, model: "claude-fable-5-1" });
    expect(guessed.tokensPerPercentSource).toBe("default");
    expect(guessed.tier).not.toBe("pause");
    // Pin the same number as a deliberate setting and the hold comes back: the
    // rule is intact, it just refuses to run on a guess.
    const priced = evaluateUsageGuard({
      state,
      config: { ...config, tokensPerPercent: CLAUDE_RATIO },
      nowMs: NOW,
      model: "claude-fable-5-1",
    });
    expect(priced.tier).toBe("pause");
  });

  it("keeps a measured ratio across a window reset and never learns from a drop", () => {
    let state = recordWindowsIntoState(
      emptyUsageGuardInstanceState("claudeAgent"),
      [window({ key: "five_hour", usedPercent: 40, resetsAtMs: NOW + HOUR })],
      NOW,
    );
    state = recordTokensIntoState(state, {
      tokens: 10_000_000,
      model: "claude-sonnet-5",
      nowMs: NOW + MINUTE,
    });
    state = recordWindowsIntoState(
      state,
      [window({ key: "five_hour", usedPercent: 45, resetsAtMs: NOW + HOUR })],
      NOW + 2 * MINUTE,
    );
    expect(state.windows.five_hour!.learnedTokensPerPercent).toBe(2_000_000);
    // A fresh window is the same plan, so what a point costs still holds; only
    // the anchor restarts.
    state = recordWindowsIntoState(
      state,
      [window({ key: "five_hour", usedPercent: 2, resetsAtMs: NOW + 6 * HOUR })],
      NOW + 3 * MINUTE,
    );
    const five = state.windows.five_hour!;
    expect(five.learnedTokensPerPercent).toBe(2_000_000);
    expect(five.calibrationSamples).toBe(1);
    expect(five.anchorPercent).toBe(2);
  });

  it("samples the pace over at least ten minutes so one call is not a rate", () => {
    let state = recordWindowsIntoState(
      emptyUsageGuardInstanceState("claudeAgent"),
      [window({ key: "five_hour", usedPercent: 40 })],
      NOW,
    );
    state = recordWindowsIntoState(
      state,
      [window({ key: "five_hour", usedPercent: 41 })],
      NOW + 20_000,
    );
    expect(state.windows.five_hour?.burnPercentPerHour).toBeNull();
    state = recordWindowsIntoState(
      state,
      [window({ key: "five_hour", usedPercent: 43 })],
      NOW + 15 * MINUTE,
    );
    expect(state.windows.five_hour?.burnPercentPerHour).toBeCloseTo(12, 5);
  });

  it("starts a fresh pace when the window resets", () => {
    let state = paced({
      key: "five_hour",
      percent: 60,
      climb: 5,
      spanMs: 20 * MINUTE,
      resetsAtMs: NOW + HOUR,
    });
    expect(state.windows.five_hour?.burnPercentPerHour).toBeGreaterThan(0);
    state = recordWindowsIntoState(
      state,
      [window({ key: "five_hour", usedPercent: 1, resetsAtMs: NOW + 6 * HOUR })],
      NOW + HOUR + MINUTE,
    );
    expect(state.windows.five_hour?.burnPercentPerHour).toBeNull();
  });
});

describe("resolveUsageGuardProviderConfig", () => {
  it("fills a partial provider entry with defaults and folds in the global switch", () => {
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const resolved = resolveUsageGuardProviderConfig(
      {
        usageGuard: {
          enabled: true,
          providers: { [instanceId]: { ...DEFAULT_USAGE_GUARD_PROVIDER_SETTINGS, enabled: false } },
        },
      },
      instanceId,
    );
    expect(resolved.active).toBe(false);
    expect(resolved.headroomPercent).toBe(DEFAULT_USAGE_GUARD_PROVIDER_SETTINGS.headroomPercent);
    expect(
      resolveUsageGuardProviderConfig({ usageGuard: { enabled: false, providers: {} } }, instanceId)
        .active,
    ).toBe(false);
    expect(
      resolveUsageGuardProviderConfig({ usageGuard: { enabled: true, providers: {} } }, instanceId)
        .active,
    ).toBe(true);
  });
});

describe("applyUsageGuardOptimization", () => {
  const descriptors: ReadonlyArray<ProviderOptionDescriptor> = [
    {
      type: "select",
      id: "effort",
      label: "Effort",
      options: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
        { id: "xhigh", label: "Extra high" },
      ],
    } as ProviderOptionDescriptor,
  ];
  const selection: ModelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-5",
    options: [{ id: "effort", value: "xhigh" }],
  };

  it("lowers effort to the target and never raises it", () => {
    const lowered = applyUsageGuardOptimization({
      modelSelection: selection,
      descriptors,
      targetEffort: "medium",
    });
    expect(lowered.applied).toEqual({ optionId: "effort", from: "xhigh", to: "medium" });
    expect(lowered.modelSelection.options).toEqual([{ id: "effort", value: "medium" }]);
    const already = applyUsageGuardOptimization({
      modelSelection: { ...selection, options: [{ id: "effort", value: "low" }] },
      descriptors,
      targetEffort: "medium",
    });
    expect(already.applied).toBeNull();
    expect(already.modelSelection).toBe(already.modelSelection);
  });

  it("uses the catalog default when the selection carries no effort", () => {
    const result = applyUsageGuardOptimization({
      modelSelection: { ...selection, options: [] },
      descriptors,
      targetEffort: "low",
    });
    expect(result.applied).toEqual({ optionId: "effort", from: "high", to: "low" });
  });

  it("leaves models without an effort control alone", () => {
    const result = applyUsageGuardOptimization({
      modelSelection: selection,
      descriptors: [],
      targetEffort: "low",
    });
    expect(result.applied).toBeNull();
    expect(result.modelSelection).toBe(selection);
  });
});

describe("shared account pacing", () => {
  it("recognizes the screenshot's overspending on the first report after a restart", () => {
    const state = recordWindowsIntoState(
      emptyUsageGuardInstanceState("claudeAgent"),
      [
        window({
          key: "five_hour",
          usedPercent: 54,
          resetsAtMs: NOW + 226 * MINUTE,
        }),
      ],
      NOW,
    );
    const evaluation = evaluateUsageGuard({ state, config, nowMs: NOW });
    expect(evaluation.tier).toBe("optimize");
    expect(evaluation.burnPercentPerHour).toBeGreaterThan(40);
    expect(evaluation.backgroundCooldownMs).toBeGreaterThan(0);
  });
  it("charges the entire multi-call slice across siblings and never invents effort savings", () => {
    const base = paced({
      key: "five_hour",
      percent: 54,
      climb: 10,
      spanMs: 20 * MINUTE,
      resetsAtMs: NOW + 226 * MINUTE,
    });
    const admitted = recordBackgroundAdmission(base, NOW);
    const before = evaluateUsageGuard({ state: admitted, config, nowMs: NOW });
    let state = admitted;
    for (let i = 0; i < 6; i++)
      state = recordTokensIntoState(state, {
        tokens: 150_000,
        model: null,
        nowMs: NOW + i * 1000,
        activeThreads: 3,
      });
    const after = evaluateUsageGuard({ state, config, nowMs: NOW + 6_000 });
    // Tokens spent move the bar, so the catch-up lengthens. It tracks the spend
    // itself now, not a slice charged against an admission stopwatch.
    expect(after.backgroundCooldownMs!).toBeGreaterThan(before.backgroundCooldownMs!);
    expect(after.admitBackground).toBe(false);
    const unchanged = evaluateUsageGuard({
      state,
      config: { ...config, reduceEffort: false },
      nowMs: NOW + 6_000,
    });
    expect(unchanged.backgroundCooldownMs).toBe(after.backgroundCooldownMs);
    const fewerThreads = evaluateUsageGuard({
      state,
      config,
      nowMs: NOW + 6_000,
      activeThreads: 0,
    });
    expect(fewerThreads.admitBackground).toBe(false);
    expect(fewerThreads.nextBackgroundAdmitAtMs).toBe(after.nextBackgroundAdmitAtMs);
  });
});

describe("measured effort pacing", () => {
  function learned() {
    let state = emptyUsageGuardInstanceState("claudeAgent");
    for (const effort of ["high", "low"])
      for (let i = 0; i < 3; i++) {
        state = recordTokensIntoState(state, {
          model: "claude-sonnet-5",
          effort,
          tokens: effort === "high" ? 2_000_000 : 500_000,
          nowMs: NOW,
        });
      }
    return recordBackgroundAdmission(
      recordWindowsIntoState(
        state,
        [window({ key: "5 hour", usedPercent: 70, resetsAtMs: NOW + 4 * HOUR })],
        NOW,
      ),
      NOW,
    );
  }
  it("learns each effort separately and requires three real samples", () => {
    const state = recordTokensIntoState(emptyUsageGuardInstanceState("claudeAgent"), {
      model: "claude-sonnet-5",
      effort: "low",
      tokens: 10,
      nowMs: NOW,
    });
    expect(measuredEffortCost(state, "claude-sonnet-5", "low")).toBeNull();
    expect(measuredEffortCost(learned(), "claude-sonnet-5", "low")?.ewmaWeightedTokens).toBe(
      500_000,
    );
    expect(measuredEffortCost(learned(), "claude-sonnet-5", "low", true)).toBeNull();
    expect(measuredEffortCost(learned(), "another-model", "low")).toBeNull();
  });
  it("uses measured lower cost for shorter waits without inventing quota", () => {
    const state = learned();
    const input = { state, config, nowMs: NOW, model: "claude-sonnet-5" };
    const high = evaluateUsageGuard({ ...input, effort: "high" });
    const low = evaluateUsageGuard({ ...input, effort: "low" });
    expect(high.backgroundCooldownMs).not.toBeNull();
    expect(low.backgroundCooldownMs!).toBeLessThan(high.backgroundCooldownMs!);
    expect(low.estimatedPercent).toBe(high.estimatedPercent);
    expect(low.observedTokens).toBe(high.observedTokens);
    const spent = recordTokensIntoState(state, {
      model: "claude-sonnet-5",
      tokens: 8_000_000,
      nowMs: NOW,
    });
    const highDebt = evaluateUsageGuard({ ...input, state: spent, effort: "high" });
    const lowDebt = evaluateUsageGuard({ ...input, state: spent, effort: "low" });
    // Even carrying debt, the cheaper effort needs less catch-up — that gap is
    // exactly the saving the model comparison quotes.
    expect(lowDebt.backgroundCooldownMs!).toBeLessThan(highDebt.backgroundCooldownMs!);
  });
  it("does not count replayed usage as new effort samples", () => {
    const input = {
      model: "claude-sonnet-5",
      effort: "low",
      tokens: 100,
      threadKey: "a",
      usage: { usedTokens: 100, totalProcessedTokens: 100 },
      nowMs: NOW,
    };
    const once = recordTokensIntoState(emptyUsageGuardInstanceState("claudeAgent"), input);
    expect(recordTokensIntoState(once, input)).toBe(once);
  });
});

it("provides conservative defaults before effort calibration", () => {
  expect(defaultEffortCostFactor("low")).toBe(0.8);
  expect(defaultEffortCostFactor("medium")).toBe(0.9);
  expect(defaultEffortCostFactor("high")).toBe(1);
  expect(defaultEffortCostFactor("ultracode")).toBe(1.3);
  expect(defaultEffortCostFactor("unknown")).toBe(1);
  const state = recordBackgroundAdmission(
    recordWindowsIntoState(
      emptyUsageGuardInstanceState("claudeAgent"),
      [
        window({
          key: "weekly",
          usedPercent: 70,
          resetsAtMs: NOW + 5 * DAY,
          windowDurationMs: 7 * DAY,
        }),
      ],
      NOW,
    ),
    NOW,
  );
  const input = { state, model: "claude-fable", config, nowMs: NOW };
  const low = evaluateUsageGuard({ ...input, effort: "low" });
  const high = evaluateUsageGuard({ ...input, effort: "high" });
  expect(low.backgroundCooldownMs!).toBeLessThan(high.backgroundCooldownMs!);
  expect(low.estimatedPercent).toBe(high.estimatedPercent);
});

describe("userPinnedEffortDuringHold", () => {
  const paused = (createdAt: string) => ({ kind: "usage-guard.paused", createdAt });
  const selected = (createdAt: string) => ({ kind: "usage-guard.effort-selected", createdAt });
  it("is false with no chip selection", () => {
    expect(userPinnedEffortDuringHold([paused("2026-09-06T16:00:00Z")])).toBe(false);
  });
  it("stands for a selection made during the current hold", () => {
    expect(
      userPinnedEffortDuringHold([
        paused("2026-09-06T16:00:00Z"),
        selected("2026-09-06T16:05:00Z"),
      ]),
    ).toBe(true);
  });
  it("lapses once a new hold begins", () => {
    expect(
      userPinnedEffortDuringHold([
        paused("2026-09-06T16:00:00Z"),
        selected("2026-09-06T16:05:00Z"),
        paused("2026-09-06T17:00:00Z"),
      ]),
    ).toBe(false);
  });
  it("counts a selection with no hold at all", () => {
    expect(userPinnedEffortDuringHold([selected("2026-09-06T16:05:00Z")])).toBe(true);
  });
});

describe("providerReportsExhausted", () => {
  const window = (over: Partial<UsageGuardWindowEstimate>): UsageGuardWindowEstimate => ({
    key: "weekly",
    label: "weekly",
    scope: "account",
    family: null,
    reportedPercent: 100,
    estimatedPercent: 100,
    elapsedPercent: null,
    aheadOfPacePercent: null,
    windowDurationMs: null,
    resetsAtMs: null,
    expired: false,
    applicable: true,
    hoursLeft: 10,
    burnPercentPerHour: 0,
    projectedAtResetPercent: 100,
    remainingPercent: -3,
    pressure: Number.POSITIVE_INFINITY,
    ...over,
  });
  const evaluation = (windows: UsageGuardWindowEstimate[]) =>
    ({ windows }) as unknown as UsageGuardEvaluation;
  const state = (credits: UsageGuardInstanceState["credits"]) =>
    ({ ...emptyUsageGuardInstanceState("codex"), credits }) as UsageGuardInstanceState;
  it("is true when an included window is reported full and no credits remain", () => {
    expect(providerReportsExhausted(evaluation([window({})]), state(undefined))).toBe(true);
    expect(
      providerReportsExhausted(
        evaluation([window({})]),
        state({ balance: 0, capacity: 1250, unlimited: false, spentAtReport: 0 }),
      ),
    ).toBe(true);
  });
  it("is false while credits or an unfilled window can fund the turn", () => {
    expect(
      providerReportsExhausted(
        evaluation([window({})]),
        state({ balance: 12, capacity: 1250, unlimited: false, spentAtReport: 0 }),
      ),
    ).toBe(false);
    expect(
      providerReportsExhausted(evaluation([window({ reportedPercent: 99 })]), state(undefined)),
    ).toBe(false);
    expect(
      providerReportsExhausted(evaluation([window({ expired: true })]), state(undefined)),
    ).toBe(false);
    expect(
      providerReportsExhausted(evaluation([window({ applicable: false })]), state(undefined)),
    ).toBe(false);
    // Only the guard's own estimate is high: the provider has not said so.
    expect(
      providerReportsExhausted(
        evaluation([window({ reportedPercent: 80, estimatedPercent: 101 })]),
        state(undefined),
      ),
    ).toBe(false);
  });
});
