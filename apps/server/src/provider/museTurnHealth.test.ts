import { describe, expect, it } from "vite-plus/test";

import { museTurnHealthAction } from "./museTurnHealth.ts";

const idle = {
  lastProgressAtMs: 0,
  lastReconcileAtMs: 0,
  pendingApproval: false,
  openToolCount: 0,
  retrySinceMs: null,
};

describe("Muse turn health", () => {
  it("repairs a silent stream before stopping, without treating repairs as progress", () => {
    expect(museTurnHealthAction({ ...idle, nowMs: 59_999 })).toEqual({ action: "wait" });
    expect(museTurnHealthAction({ ...idle, nowMs: 60_000 })).toEqual({ action: "reconcile" });
    expect(museTurnHealthAction({ ...idle, lastReconcileAtMs: 60_000, nowMs: 70_000 })).toEqual({
      action: "wait",
    });
    expect(museTurnHealthAction({ ...idle, lastReconcileAtMs: 899_999, nowMs: 900_000 })).toEqual({
      action: "stop",
      reason: "model-silence",
    });
  });

  it("keeps streaming work alive regardless of the total turn age", () => {
    expect(
      museTurnHealthAction({ ...idle, lastProgressAtMs: 3_590_000, nowMs: 3_600_000 }),
    ).toEqual({ action: "wait" });
  });

  it("allows silent tools a longer bounded interval and exempts user approval waits", () => {
    expect(museTurnHealthAction({ ...idle, openToolCount: 1, nowMs: 300_000 })).toEqual({
      action: "reconcile",
    });
    expect(museTurnHealthAction({ ...idle, openToolCount: 1, nowMs: 1_800_000 })).toEqual({
      action: "stop",
      reason: "tool-silence",
    });
    expect(
      museTurnHealthAction({ ...idle, pendingApproval: true, retrySinceMs: 0, nowMs: 3_600_000 }),
    ).toEqual({ action: "wait" });
  });

  it("bounds repeated retry announcements even when observations continue", () => {
    expect(
      museTurnHealthAction({
        ...idle,
        retrySinceMs: 0,
        lastReconcileAtMs: 299_000,
        nowMs: 300_000,
      }),
    ).toEqual({ action: "stop", reason: "retry-budget" });
    expect(
      museTurnHealthAction({
        ...idle,
        retrySinceMs: null,
        lastProgressAtMs: 300_000,
        nowMs: 300_001,
      }),
    ).toEqual({ action: "wait" });
  });
});
