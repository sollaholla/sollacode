// @vitest-environment happy-dom
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAccountSwitchState,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ProviderAccountSwitchOverlay } from "./ProviderAccountSwitchOverlay";
import { isProviderAccountSwitchActive } from "./providerAccountSwitchState";

const baseState: ProviderAccountSwitchState = {
  id: "switch-1",
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  status: "waiting_for_authentication",
  startedAt: "2026-07-30T12:00:00.000Z",
  updatedAt: "2026-07-30T12:00:01.000Z",
  authUrl: "https://auth.openai.com/example",
  previousAccountLabel: "old@example.com",
  currentAccountLabel: null,
  message: "Complete sign-in in your browser.",
};

describe("ProviderAccountSwitchOverlay", () => {
  it("shows a polling spinner and cancel action while login is active", () => {
    const markup = renderToStaticMarkup(
      <ProviderAccountSwitchOverlay
        state={baseState}
        provider={null}
        cancelling={false}
        submittingCode={false}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
        onOpenAuthLink={vi.fn()}
        onRetry={vi.fn()}
        onSubmitAuthCode={vi.fn(async () => true)}
      />,
    );

    expect(isProviderAccountSwitchActive(baseState)).toBe(true);
    expect(markup).toContain("Waiting for authentication");
    expect(markup).toContain("animate-spin");
    expect(markup).toContain('data-provider-login-spinner="true"');
    expect(markup).toContain(">Cancel</button>");
    expect(markup).toContain("Don’t see the browser? Open sign-in link");
  });

  it.each(["claudeAgent", "antigravity"])(
    "shows a paste field when %s requests an authentication code",
    (driver) => {
      const waitingForCode = {
        ...baseState,
        driver: ProviderDriverKind.make(driver),
        status: "waiting_for_code",
        message: "Paste the authentication code shown in your browser.",
      } satisfies ProviderAccountSwitchState;
      const markup = renderToStaticMarkup(
        <ProviderAccountSwitchOverlay
          state={waitingForCode}
          provider={null}
          cancelling={false}
          submittingCode={false}
          onCancel={vi.fn()}
          onDismiss={vi.fn()}
          onOpenAuthLink={vi.fn()}
          onRetry={vi.fn()}
          onSubmitAuthCode={vi.fn(async () => true)}
        />,
      );

      expect(isProviderAccountSwitchActive(waitingForCode)).toBe(true);
      expect(markup).toContain("max-w-xl");
      expect(markup).toContain("Enter authentication code");
      expect(markup).toContain('name="authenticationCode"');
      expect(markup).toContain("Paste authentication code");
      expect(markup).toContain("Continue sign-in");
    },
  );

  it("shows success without leaving an active cancel action", () => {
    const succeeded = {
      ...baseState,
      status: "succeeded",
      currentAccountLabel: "new@example.com",
      message: "Signed in as new@example.com.",
    } satisfies ProviderAccountSwitchState;
    const markup = renderToStaticMarkup(
      <ProviderAccountSwitchOverlay
        state={succeeded}
        provider={null}
        cancelling={false}
        submittingCode={false}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
        onOpenAuthLink={vi.fn()}
        onRetry={vi.fn()}
        onSubmitAuthCode={vi.fn(async () => true)}
      />,
    );

    expect(isProviderAccountSwitchActive(succeeded)).toBe(false);
    expect(markup).toContain("Account switched");
    expect(markup).toContain("new@example.com");
    expect(markup).not.toContain(">Cancel</button>");
  });
});

it("allows closing the panel even while cancellation is waiting on the host", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const dismiss = vi.fn();
  const cancel = vi.fn();
  try {
    await act(async () =>
      root.render(
        <ProviderAccountSwitchOverlay
          state={baseState}
          provider={null}
          cancelling
          submittingCode={false}
          onCancel={cancel}
          onDismiss={dismiss}
          onOpenAuthLink={vi.fn()}
          onRetry={vi.fn()}
          onSubmitAuthCode={vi.fn(async () => true)}
        />,
      ),
    );
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.find((button) => button.textContent === "Cancelling…")?.disabled).toBe(true);
    const close = buttons.find((button) => button.textContent === "Close")!;
    expect(close.disabled).toBe(false);
    await act(async () => close.click());
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
