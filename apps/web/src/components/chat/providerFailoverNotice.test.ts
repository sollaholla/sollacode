import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeProviderFailover,
  findProviderFailoverNotice,
  isProviderFailoverActive,
} from "./providerFailoverNotice";

function activity(
  kind: string,
  createdAt: string,
  payload: Record<string, unknown> = {},
): OrchestrationThreadActivity {
  return {
    id: `${kind}:${createdAt}`,
    kind,
    tone: "info",
    summary: kind,
    payload,
    turnId: null,
    createdAt,
  } as OrchestrationThreadActivity;
}

describe("findProviderFailoverNotice", () => {
  it("returns the newest failover that nothing has ended", () => {
    const notice = findProviderFailoverNotice([
      activity("provider.failover.completed", "2026-09-06T04:00:00.000Z", {
        sourceModel: "claude-fable-5-1",
        targetModel: "claude-opus-5",
        sourceLabel: "Claude",
        targetLabel: "Claude",
        reason: "rate_limit_rejected:seven_day_fable",
        resetsAt: 1788832800,
      }),
    ]);
    expect(notice?.sourceModel).toBe("claude-fable-5-1");
    expect(notice?.targetModel).toBe("claude-opus-5");
    expect(notice?.resetsAt).toBe(1788832800_000);
  });

  it("is cleared by a later restore or a deliberate provider change", () => {
    expect(
      findProviderFailoverNotice([
        activity("provider.failover.completed", "2026-09-06T04:00:00.000Z"),
        activity("provider.failover.restored", "2026-09-06T05:00:00.000Z"),
      ]),
    ).toBeNull();
    expect(
      findProviderFailoverNotice([
        activity("provider.failover.completed", "2026-09-06T04:00:00.000Z"),
        activity("provider.handoff.completed", "2026-09-06T05:00:00.000Z"),
      ]),
    ).toBeNull();
    expect(
      findProviderFailoverNotice([
        activity("provider.failover.restored", "2026-09-06T03:00:00.000Z"),
        activity("provider.failover.completed", "2026-09-06T04:00:00.000Z"),
      ]),
    ).not.toBeNull();
  });

  it("stops showing once the thread is no longer on the failover target", () => {
    const notice = findProviderFailoverNotice([
      activity("provider.failover.completed", "2026-09-06T04:00:00.000Z", {
        targetModel: "claude-opus-5",
      }),
    ]);
    expect(isProviderFailoverActive({ notice, currentModel: "claude-opus-5" })).toBe(true);
    expect(isProviderFailoverActive({ notice, currentModel: "claude-fable-5-1" })).toBe(false);
    expect(isProviderFailoverActive({ notice: null, currentModel: "claude-opus-5" })).toBe(false);
  });

  it("explains the switch in one sentence with the way back", () => {
    const notice = findProviderFailoverNotice([
      activity("provider.failover.completed", "2026-09-06T04:00:00.000Z", {
        sourceModel: "claude-fable-5-1",
        targetModel: "claude-opus-5",
        reason: "rate_limit_rejected:seven_day_fable",
        resetsAt: 1788832800,
      }),
    ])!;
    const text = describeProviderFailover(notice, 1788832800_000 - 46 * 3_600_000);
    expect(text).toContain("Running on claude-opus-5 instead of claude-fable-5-1");
    expect(text).toContain("refused a request for it (usage limit)");
    expect(text).toContain("resets in 46 h");
  });
});
