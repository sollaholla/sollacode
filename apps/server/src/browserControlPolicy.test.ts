import { describe, expect, it } from "vite-plus/test";

import { T3_BROWSER_CONTROL_POLICY } from "./browserControlPolicy.ts";

describe("T3 browser control policy", () => {
  it("makes preview control exclusive and fails closed when it is unavailable", () => {
    expect(T3_BROWSER_CONTROL_POLICY).toContain("required and exclusive browser-control surface");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("computer-control or computer-use tools");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("browser-extension control");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("global browser skills");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("standalone Playwright");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("agent-browser");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("preview_status");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("preview_open");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("Authentication, login, CAPTCHA");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("browser-profile mismatch");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("blocker or user-input flow");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("unsupported or unavailable");
    expect(T3_BROWSER_CONTROL_POLICY).toContain(
      "do not substitute another browser-control surface",
    );
    expect(T3_BROWSER_CONTROL_POLICY).toContain("another named agent's dedicated browser");
    expect(T3_BROWSER_CONTROL_POLICY).not.toContain("user explicitly requests");
    expect(T3_BROWSER_CONTROL_POLICY).not.toContain("Only consider another");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("downloadApprovalRequired");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("preview_wait_for_download");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("PDF viewers");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("preview_resize");
    expect(T3_BROWSER_CONTROL_POLICY).toContain("320×200");
  });
});
