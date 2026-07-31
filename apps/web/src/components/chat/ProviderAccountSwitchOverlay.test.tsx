import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAccountSwitchState,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  isProviderAccountSwitchActive,
  ProviderAccountSwitchOverlay,
} from "./ProviderAccountSwitchOverlay";

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

  it("shows a paste field when Claude Code requests an authentication code", () => {
    const waitingForCode = {
      ...baseState,
      driver: ProviderDriverKind.make("claudeAgent"),
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
    expect(markup).toContain("Enter authentication code");
    expect(markup).toContain('name="authenticationCode"');
    expect(markup).toContain("Paste authentication code");
    expect(markup).toContain("Continue sign-in");
  });

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
