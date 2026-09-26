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

  it("offers the secure-desktop remedy only when it would actually help", () => {
    // UAC still on its own desktop: this machine is one setting away from at
    // least showing the prompt, and the bare copy reads as "nothing can be
    // done", so the remedy is worth naming.
    const fixable = describeHostStatus({
      state: "interrupted",
      reason: "secure-desktop",
      secureDesktopPrompt: true,
    });
    expect(fixable).toMatch(/PromptOnSecureDesktop/u);
    // Never oversold: it weakens UAC and may still not accept clicks.
    expect(fixable).toMatch(/weaken/u);
    expect(fixable).toMatch(/may still refuse/u);

    // Already off, so the block is the lock screen, Ctrl+Alt+Del, or UIPI.
    // Pointing at the setting here would send someone down a dead end.
    expect(
      describeHostStatus({
        state: "interrupted",
        reason: "secure-desktop",
        secureDesktopPrompt: false,
      }),
    ).not.toMatch(/PromptOnSecureDesktop/u);

    // macOS, or a host predating the field: say nothing extra rather than guess.
    expect(describeHostStatus({ state: "interrupted", reason: "secure-desktop" })).not.toMatch(
      /PromptOnSecureDesktop/u,
    );

    // The remedy is explanation, not a control: the elevation it needs prompts
    // on the very desktop this session cannot reach.
    expect(fixable).not.toMatch(/click here|press the button/iu);
  });

  it("says nothing when the host is healthy", () => {
    expect(describeHostStatus({ state: "ok" })).toBeNull();
  });

  it("names every reason worth reporting so a new one cannot ship without text", () => {
    for (const reason of ["secure-desktop", "elevated-window", "capture-interrupted"] as const) {
      expect(describeHostStatus({ state: "interrupted", reason })).toBeTruthy();
    }
  });

  it("says nothing about a macOS password field", () => {
    // Disabled at the owner's request. The host no longer reports it at all;
    // the literal survives only so an older host can still send it without
    // failing to decode, and it must stay silent when it does.
    expect(describeHostStatus({ state: "interrupted", reason: "secure-input" })).toBeNull();
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
