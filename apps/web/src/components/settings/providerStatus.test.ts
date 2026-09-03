import type { ServerProviderUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeProviderStatus,
  describeProviderUpdateOutcome,
  PROVIDER_STATUS_STYLES,
} from "./providerStatus";

const updateState = (
  status: ServerProviderUpdateState["status"],
  message: string | null = null,
): ServerProviderUpdateState => ({
  status,
  startedAt: null,
  finishedAt: null,
  message,
  output: null,
});

describe("describeProviderStatus", () => {
  it("names every status the card can show, including Off for a disabled instance", () => {
    expect(describeProviderStatus("ready")).toBe("Ready");
    expect(describeProviderStatus("warning")).toBe("Needs attention");
    expect(describeProviderStatus("error")).toBe("Unavailable");
    expect(describeProviderStatus("disabled")).toBe("Off");
    expect(PROVIDER_STATUS_STYLES.disabled.dot).not.toBe(PROVIDER_STATUS_STYLES.warning.dot);
  });
});

describe("describeProviderUpdateOutcome", () => {
  it("is silent when the provider has never been updated in-app", () => {
    expect(describeProviderUpdateOutcome(undefined)).toBeNull();
    expect(describeProviderUpdateOutcome(updateState("idle"))).toBeNull();
    expect(describeProviderUpdateOutcome(updateState("running"))).toBeNull();
  });

  it("surfaces a failed update on the card that offered it", () => {
    expect(describeProviderUpdateOutcome(updateState("failed", "npm ERR! EACCES"))).toEqual({
      tone: "error",
      text: "npm ERR! EACCES",
    });
    expect(describeProviderUpdateOutcome(updateState("failed"))).toEqual({
      tone: "error",
      text: "The last update attempt failed.",
    });
  });

  it("confirms a finished update so the button is not the only signal", () => {
    expect(describeProviderUpdateOutcome(updateState("succeeded"))).toEqual({
      tone: "neutral",
      text: "Updated. Refresh provider status to confirm the new version.",
    });
    expect(
      describeProviderUpdateOutcome(updateState("unchanged", "claude is already 2.1.0")),
    ).toEqual({ tone: "neutral", text: "claude is already 2.1.0" });
  });
});
