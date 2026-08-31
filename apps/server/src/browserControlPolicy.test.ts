import { describe, expect, it } from "vite-plus/test";

import { T3_BROWSER_CONTROL_POLICY } from "./browserControlPolicy.ts";

describe("T3 browser control policy", () => {
  it("prefers preview strongly but allows a fallback when preview genuinely cannot do the task", () => {
    // Preview is the default and strongly preferred surface, not an absolute
    // prohibition on everything else.
    expect(T3_BROWSER_CONTROL_POLICY).toContain(
      "default and strongly preferred browser-control surface",
    );
    expect(T3_BROWSER_CONTROL_POLICY).not.toContain(
      "required and exclusive browser-control surface",
    );
    // A failed/awkward preview call is NOT license to switch surfaces...
    expect(T3_BROWSER_CONTROL_POLICY).toContain("Do not reach for computer-control tools");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("preview_status");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("preview_open");
    // ...but a genuinely impossible-in-preview task may use other tools,
    // including computer use and local tools, without disrupting the user.
    expect(T3_BROWSER_CONTROL_POLICY).toContain("GENUINELY impossible in the preview browser");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("computer-use tools and tools that run locally");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("take care not to disrupt the user");
    expect(T3_BROWSER_CONTROL_POLICY).not.toContain(
      "do not substitute another browser-control surface",
    );
    expect(T3_BROWSER_CONTROL_POLICY).not.toContain("Never use computer-control or computer-use");
    // Sign-in still stays inside preview rather than switching surfaces.
    expect(T3_BROWSER_CONTROL_POLICY).toContain("Authentication, login");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("blocker or user-input flow");
    // Unchanged operational guidance survives.
    expect(T3_BROWSER_CONTROL_POLICY).toContain("another named agent's dedicated browser");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("downloadApprovalRequired");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("preview_wait_for_download");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("PDF viewers");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("preview_resize");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("320×200");
    // `visible` is presentation, not permission. A Suno session stalled on
    // 2026-08-31 because the agent read `visible: false` on an available tab as
    // a blocker and abandoned work the user had already approved.
    expect(T3_BROWSER_CONTROL_POLICY).toContain("`visible` is presentation only");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("`visible: false` is an ordinary background tab");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("never blocks anything");
    expect(T3_BROWSER_CONTROL_POLICY).toContain(
      "Driving a reused, background, or not-presented tab is expected and safe",
    );
    expect(T3_BROWSER_CONTROL_POLICY).toContain("Never stall approved work");
    // Anti-abuse guardrail is retained regardless of surface.
    expect(T3_BROWSER_CONTROL_POLICY).toContain("Never try to defeat anti-bot checks");
  });
});
