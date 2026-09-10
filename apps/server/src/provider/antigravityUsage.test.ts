import { describe, expect, it } from "vite-plus/test";

import {
  antigravityUsageWindowsFromAccountUsage,
  parseAntigravityAccountUsage,
} from "./antigravityUsage.ts";

const WEEK = 7 * 24 * 60 * 60_000;

describe("Antigravity account usage", () => {
  it("parses remaining-percent family windows from native /usage TSV", () => {
    const usage = parseAntigravityAccountUsage(
      "Gemini Models\tWeekly Limit Remaining\t0%\t2026-09-11T18:30:48Z\nClaude and GPT models\tWeekly Limit Remaining\t100%\t2026-09-17T14:30:07Z\n",
    );
    expect(usage?.windows).toEqual([
      {
        key: "gemini",
        family: "gemini",
        label: "Gemini",
        remainingPercent: 0,
        usedPercent: 100,
        resetsAt: "2026-09-11T18:30:48.000Z",
        windowDurationMs: WEEK,
      },
      {
        key: "claude-gpt",
        family: "claude-gpt",
        label: "Claude and GPT",
        remainingPercent: 100,
        usedPercent: 0,
        resetsAt: "2026-09-17T14:30:07.000Z",
        windowDurationMs: WEEK,
      },
    ]);
  });

  it("does not treat a model listing as usage", () => {
    expect(
      parseAntigravityAccountUsage("gemini-3.8-flash-high\tGemini 3.8 Flash (High)"),
    ).toBeNull();
    expect(parseAntigravityAccountUsage("Authentication required")).toBeNull();
  });

  it("reads a structured snapshot the usage bar and guard already understand", () => {
    expect(
      antigravityUsageWindowsFromAccountUsage({
        windows: [
          {
            key: "gemini",
            family: "gemini",
            label: "Gemini",
            remainingPercent: 12.5,
            usedPercent: 87.5,
            resetsAt: "2026-09-11T18:30:48Z",
            windowDurationMs: WEEK,
          },
        ],
      }),
    ).toEqual([
      {
        key: "gemini",
        family: "gemini",
        label: "Gemini",
        remainingPercent: 12.5,
        usedPercent: 87.5,
        resetsAt: "2026-09-11T18:30:48.000Z",
        windowDurationMs: WEEK,
      },
    ]);
  });
});
