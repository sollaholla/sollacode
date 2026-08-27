// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ProviderUsageDetails } from "./ProviderUsageBar";

let container: HTMLDivElement;
let root: Root;

function buttonNamed(name: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Could not find button named ${name}.`);
  }
  return button;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ProviderUsageDetails reset redemption", () => {
  it("confirms before redeeming and reuses the attempt id after an unconfirmed response", async () => {
    const onUseReset = vi
      .fn<(creditId: string | undefined, idempotencyKey: string) => Promise<"reset">>()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce("reset");
    const onDismissResetCredit = vi.fn();

    await act(async () => {
      root.render(
        <ProviderUsageDetails
          name="Codex"
          state="available"
          reportedAt="2026-08-25T20:00:00.000Z"
          windows={[]}
          resetCredits={{
            availableCount: 1,
            credits: [
              {
                id: "reset-credit-1",
                title: "Full reset",
                description: null,
                expiresAt: null,
              },
            ],
          }}
          onUseReset={onUseReset}
          onDismissResetCredit={onDismissResetCredit}
        />,
      );
    });

    expect(onUseReset).not.toHaveBeenCalled();
    act(() => buttonNamed("Use reset").click());
    expect(onUseReset).not.toHaveBeenCalled();

    await act(async () => {
      buttonNamed("Confirm").click();
      await Promise.resolve();
    });

    expect(onUseReset).toHaveBeenCalledTimes(1);
    const firstAttemptId = onUseReset.mock.calls[0]?.[1];
    expect(onUseReset.mock.calls[0]?.[0]).toBe("reset-credit-1");
    expect(firstAttemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(container.textContent).toContain(
      "Usage reset was not confirmed. Retry to safely check the same request.",
    );
    expect(onDismissResetCredit).not.toHaveBeenCalled();

    await act(async () => {
      buttonNamed("Confirm").click();
      await Promise.resolve();
    });

    expect(onUseReset).toHaveBeenCalledTimes(2);
    expect(onUseReset.mock.calls[1]).toEqual(["reset-credit-1", firstAttemptId]);
    expect(onDismissResetCredit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "reset-credit-1" }),
    );
    expect(container.textContent).toContain("Usage limits reset successfully.");
  });
});
