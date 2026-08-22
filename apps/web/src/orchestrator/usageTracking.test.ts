import { describe, expect, it } from "vite-plus/test";

import {
  dailyBuckets,
  estimateCostUsd,
  estimateVoiceMinutes,
  formatUsd,
  localDayKey,
  monthlyBuckets,
  parseRealtimeUsage,
  pruneUsage,
  ratesForModel,
  recordUsage,
  totalBucket,
  type RealtimeUsage,
  type UsageDay,
} from "./usageTracking";

const usage = (overrides: Partial<RealtimeUsage> = {}): RealtimeUsage => ({
  inputTextTokens: 0,
  inputAudioTokens: 0,
  cachedTextTokens: 0,
  cachedAudioTokens: 0,
  outputTextTokens: 0,
  outputAudioTokens: 0,
  ...overrides,
});

describe("parseRealtimeUsage", () => {
  it("reads the split the API reports", () => {
    const parsed = parseRealtimeUsage({
      usage: {
        input_token_details: { text_tokens: 100, audio_tokens: 900, cached_tokens: 0 },
        output_token_details: { text_tokens: 20, audio_tokens: 400 },
      },
    });
    expect(parsed).toMatchObject({
      inputTextTokens: 100,
      inputAudioTokens: 900,
      outputAudioTokens: 400,
    });
  });

  it("does not bill cached tokens twice", () => {
    // The input totals already include the cached ones; counting both at full
    // rate roughly doubles every estimate.
    const parsed = parseRealtimeUsage({
      usage: {
        input_token_details: {
          text_tokens: 100,
          audio_tokens: 1_000,
          cached_tokens: 800,
          cached_tokens_details: { text_tokens: 50, audio_tokens: 750 },
        },
        output_token_details: { text_tokens: 0, audio_tokens: 0 },
      },
    });
    expect(parsed).toMatchObject({
      inputTextTokens: 50,
      inputAudioTokens: 250,
      cachedTextTokens: 50,
      cachedAudioTokens: 750,
    });
  });

  it("treats an unsplit cached total as audio", () => {
    // Pricing it as text would be 80x cheaper — a wrong answer in the direction
    // that flatters us.
    const parsed = parseRealtimeUsage({
      usage: {
        input_token_details: { text_tokens: 0, audio_tokens: 500, cached_tokens: 300 },
        output_token_details: {},
      },
    });
    expect(parsed?.cachedAudioTokens).toBe(300);
    expect(parsed?.inputAudioTokens).toBe(200);
  });

  it("returns null for malformed or empty payloads instead of throwing", () => {
    expect(parseRealtimeUsage(null)).toBeNull();
    expect(parseRealtimeUsage({})).toBeNull();
    expect(parseRealtimeUsage({ usage: "nonsense" })).toBeNull();
    expect(parseRealtimeUsage({ usage: { input_token_details: {} } })).toBeNull();
  });
});

describe("pricing", () => {
  it("prices the flagship from its audio rates", () => {
    // 1M output audio tokens at $64/1M.
    const cost = estimateCostUsd("gpt-realtime-2", usage({ outputAudioTokens: 1_000_000 }));
    expect(cost).toBeCloseTo(64, 5);
  });

  it("picks the mini row over the flagship for a mini model", () => {
    // Longest-prefix wins, or every mini session is priced at 3x.
    expect(ratesForModel("gpt-realtime-2.1-mini")?.outputAudio).toBe(20);
    expect(ratesForModel("gpt-realtime-2")?.outputAudio).toBe(64);
  });

  it("reports no cost rather than a made-up one for an unknown model", () => {
    expect(estimateCostUsd("some-future-model", usage({ outputAudioTokens: 1_000 }))).toBeNull();
  });

  it("charges cached audio far below fresh audio", () => {
    const fresh = estimateCostUsd("gpt-realtime-2", usage({ inputAudioTokens: 1_000_000 })) ?? 0;
    const cached = estimateCostUsd("gpt-realtime-2", usage({ cachedAudioTokens: 1_000_000 })) ?? 0;
    expect(cached).toBeLessThan(fresh / 10);
  });
});

describe("rollups", () => {
  const days: ReadonlyArray<UsageDay> = [
    {
      date: "2026-08-16",
      model: "gpt-realtime-2",
      usage: usage({ outputAudioTokens: 1_000_000 }),
      sessions: 1,
    },
    {
      date: "2026-08-17",
      model: "gpt-realtime-2",
      usage: usage({ outputAudioTokens: 500_000 }),
      sessions: 1,
    },
    {
      date: "2026-07-02",
      model: "gpt-realtime-2",
      usage: usage({ outputAudioTokens: 250_000 }),
      sessions: 1,
    },
  ];

  it("buckets by day, newest first", () => {
    expect(dailyBuckets(days).map((bucket) => bucket.key)).toEqual([
      "2026-08-17",
      "2026-08-16",
      "2026-07-02",
    ]);
  });

  it("buckets by month, newest first", () => {
    const months = monthlyBuckets(days);
    expect(months.map((bucket) => bucket.key)).toEqual(["2026-08", "2026-07"]);
    expect(months[0]?.costUsd).toBeCloseTo(96, 5);
  });

  it("totals everything", () => {
    expect(totalBucket(days).costUsd).toBeCloseTo(112, 5);
  });

  it("refuses to total a bucket containing an unpriced model", () => {
    // A partial sum shown as the total would understate the bill.
    const mixed = [
      ...days,
      {
        date: "2026-08-17",
        model: "mystery",
        usage: usage({ outputAudioTokens: 10 }),
        sessions: 1,
      },
    ];
    expect(dailyBuckets(mixed).find((bucket) => bucket.key === "2026-08-17")?.costUsd).toBeNull();
  });

  it("keeps a day's models apart so each is priced at its own rate", () => {
    const recorded = recordUsage(
      recordUsage([], {
        date: "2026-08-17",
        model: "gpt-realtime-2",
        usage: usage({ outputAudioTokens: 10 }),
      }),
      { date: "2026-08-17", model: "gpt-realtime-2-mini", usage: usage({ outputAudioTokens: 10 }) },
    );
    expect(recorded).toHaveLength(2);
  });

  it("accumulates repeat responses into one row", () => {
    const entry = {
      date: "2026-08-17",
      model: "gpt-realtime-2",
      usage: usage({ outputAudioTokens: 10 }),
    };
    const recorded = recordUsage(recordUsage([], entry), entry);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.usage.outputAudioTokens).toBe(20);
    expect(recorded[0]?.sessions).toBe(2);
  });
});

describe("retention", () => {
  it("drops days past the retention window so the store stays bounded", () => {
    const now = new Date(2026, 7, 17);
    const kept = pruneUsage(
      [
        { date: "2026-08-16", model: "m", usage: usage(), sessions: 1 },
        { date: "2020-01-01", model: "m", usage: usage(), sessions: 1 },
      ],
      now,
    );
    expect(kept.map((day) => day.date)).toEqual(["2026-08-16"]);
  });
});

describe("presentation", () => {
  it("uses the local calendar day, not UTC", () => {
    // Late-evening sessions must not land on tomorrow.
    expect(localDayKey(new Date(2026, 7, 17, 23, 30))).toBe("2026-08-17");
  });

  it("does not round a real cost down to zero", () => {
    expect(formatUsd(0.0004)).toBe("<$0.01");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(12.345)).toBe("$12.35");
  });

  it("converts audio tokens to spoken minutes", () => {
    // User audio is 1 token / 100ms, assistant audio 1 token / 50ms.
    expect(estimateVoiceMinutes(usage({ inputAudioTokens: 600 }))).toBeCloseTo(1, 5);
    expect(estimateVoiceMinutes(usage({ outputAudioTokens: 1_200 }))).toBeCloseTo(1, 5);
  });
});
