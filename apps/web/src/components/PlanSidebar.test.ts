import { describe, expect, it } from "vite-plus/test";

import {
  PLAN_REFRESH_INITIATION_TIMEOUT_MS,
  PLAN_REFRESH_MINIMUM_FEEDBACK_MS,
  remainingPlanRefreshFeedbackMs,
} from "./PlanSidebar";

describe("plan refresh feedback", () => {
  it("keeps the refresh affordance busy for at least one second", () => {
    expect(remainingPlanRefreshFeedbackMs(0)).toBe(PLAN_REFRESH_MINIMUM_FEEDBACK_MS);
    expect(remainingPlanRefreshFeedbackMs(250)).toBe(750);
    expect(remainingPlanRefreshFeedbackMs(999)).toBe(1);
    expect(remainingPlanRefreshFeedbackMs(1_000)).toBe(0);
    expect(remainingPlanRefreshFeedbackMs(10_000)).toBe(0);
  });

  it("allows twenty seconds for background initiation", () => {
    expect(PLAN_REFRESH_INITIATION_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
  });
});
