import {
  REMOTE_CONTROL_ACCESSIBILITY_PERMISSION_HELP,
  REMOTE_CONTROL_SCREEN_PERMISSION_HELP,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  classifyCaptureFailure,
  classifyInputFailure,
  describeHostStatus,
  isSameHostStatus,
  recoveryDelayMs,
  REMOTE_CONTROL_RECOVERY_MAX_DELAY_MS,
} from "./remoteControlHostStatus.ts";

describe("remote control failure classification", () => {
  it("treats a lost screen capture as recoverable rather than fatal", () => {
    // The regression this exists for: a Windows UAC prompt moves the desktop,
    // which invalidates the capture surface and ends the track. That used to
    // arrive as a fatal encoder error and ended the whole session.
    const failure = classifyCaptureFailure(new Error("The remote screen capture stopped."));
    expect(failure.kind).toBe("transient");
    expect(failure.reason).toBe("capture-interrupted");
  });

  it.each([
    ["The screen encoder stopped unexpectedly."],
    ["No capturable display was found on this computer."],
    ["Solla Code could not capture the selected display."],
  ])("keeps the session alive for %s", (message) => {
    expect(classifyCaptureFailure(new Error(message)).kind).toBe("transient");
  });

  it("still fails outright when the user has withheld an OS permission", () => {
    // Retrying cannot fix this one — someone has to change a system setting —
    // so hiding it behind a reconnect loop would just look like a hang.
    expect(classifyCaptureFailure(new Error(REMOTE_CONTROL_SCREEN_PERMISSION_HELP)).kind).toBe(
      "fatal",
    );
    expect(
      classifyCaptureFailure(new Error(REMOTE_CONTROL_ACCESSIBILITY_PERMISSION_HELP)).kind,
    ).toBe("fatal");
  });

  it("never ends a session over a rejected input event", () => {
    expect(classifyInputFailure(new Error("The host rejected remote input.")).kind).toBe(
      "transient",
    );
    expect(
      classifyInputFailure(new Error("The host did not acknowledge remote input in time.")).kind,
    ).toBe("transient");
  });

  it("fails input only for the macOS permission that will not self-heal", () => {
    expect(classifyInputFailure(new Error(REMOTE_CONTROL_ACCESSIBILITY_PERMISSION_HELP)).kind).toBe(
      "fatal",
    );
  });

  it("falls back to a readable message for a non-Error cause", () => {
    expect(classifyCaptureFailure(undefined).message).toMatch(/could not capture/u);
    expect(classifyCaptureFailure("  ").message).toMatch(/could not capture/u);
  });
});

describe("recovery backoff", () => {
  it("grows from the first retry and settles at the cap", () => {
    expect(recoveryDelayMs(0)).toBe(750);
    expect(recoveryDelayMs(1)).toBe(1_500);
    expect(recoveryDelayMs(2)).toBe(3_000);
    expect(recoveryDelayMs(3)).toBe(REMOTE_CONTROL_RECOVERY_MAX_DELAY_MS);
    // A long outage must settle into a slow poll, not run away.
    expect(recoveryDelayMs(50)).toBe(REMOTE_CONTROL_RECOVERY_MAX_DELAY_MS);
  });

  it("survives a nonsense attempt count", () => {
    expect(recoveryDelayMs(-3)).toBe(750);
    expect(recoveryDelayMs(Number.NaN)).toBe(750);
  });
});

describe("host status text", () => {
  it("explains a UAC prompt as something to answer at the machine", () => {
    const text = describeHostStatus({ state: "interrupted", reason: "secure-desktop" });
    expect(text).toMatch(/User Account Control/u);
    expect(text).toMatch(/resumes on its own/u);
  });

  it("says nothing when the host is healthy", () => {
    expect(describeHostStatus({ state: "ok" })).toBeNull();
  });

  it("names every reason so a new one cannot ship without text", () => {
    for (const reason of [
      "secure-desktop",
      "elevated-window",
      "secure-input",
      "capture-interrupted",
    ] as const) {
      expect(describeHostStatus({ state: "interrupted", reason })).toBeTruthy();
    }
  });

  it("collapses a repeated condition so a held prompt is reported once", () => {
    const status = { state: "interrupted", reason: "secure-desktop" } as const;
    expect(isSameHostStatus(status, status)).toBe(true);
    expect(isSameHostStatus(null, status)).toBe(false);
    expect(isSameHostStatus({ state: "ok" }, status)).toBe(false);
    expect(isSameHostStatus(status, { state: "interrupted", reason: "capture-interrupted" })).toBe(
      false,
    );
  });
});
