import { ApprovalRequestId, EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

describe("ComposerPendingUserInputPanel", () => {
  it("renders the action approval as a phone-safe in-chat button", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[
          {
            requestId: ApprovalRequestId.make("action-approval-1"),
            createdAt: "2026-08-21T22:45:52.000Z",
            turnId: null,
            questions: [
              {
                id: "t3_action_approval",
                header: "Approval",
                question: `Review this proposed publish:\n\n${"https://example.com/very-long-path/".repeat(12)}`,
                options: [{ label: "Approve", description: "Select Approve." }],
                multiSelect: false,
              },
            ],
          },
        ]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onToggleOption={vi.fn()}
        onAdvance={vi.fn()}
        environmentId={EnvironmentId.make("environment-1")}
        onRespond={vi.fn()}
      />,
    );

    expect(markup).toContain("Action approval");
    expect(markup).toContain(">Approve</span>");
    expect(markup).toContain("overflow-x-hidden");
    expect(markup).toContain("overflow-wrap:anywhere");
    expect(markup).toContain('type="button"');
  });

  const credentialPanel = (mode: "password" | "code" | "person") =>
    renderToStaticMarkup(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[
          {
            requestId: ApprovalRequestId.make("credential-request:1"),
            createdAt: "2026-11-03T10:00:00.000Z",
            turnId: null,
            credentialRequest: {
              origin: "https://app.example.com",
              mode,
              reason: "Acme billing needs a login",
              usernameHint: "work@example.com",
            },
            questions: [
              {
                id: "t3_credential_request",
                header: "Sign-in needed",
                question: "The agent needs a login.",
                options:
                  mode === "person"
                    ? [
                        { label: "I've signed in", description: "Carry on." },
                        { label: "Not now", description: "Carry on without." },
                      ]
                    : [{ label: "Not now", description: "Carry on without." }],
                multiSelect: false,
              },
            ],
          },
        ]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onToggleOption={vi.fn()}
        onAdvance={vi.fn()}
        environmentId={EnvironmentId.make("environment-1")}
        onRespond={vi.fn()}
      />,
    );

  it("asks for a login under the tab's own site and offers to save it", () => {
    const markup = credentialPanel("password");
    expect(markup).toContain("app.example.com");
    expect(markup).toContain("The agent says: Acme billing needs a login");
    expect(markup).toContain('type="password"');
    expect(markup).toContain("Username or email");
    expect(markup).toContain('value="work@example.com"');
    expect(markup).toContain("Save for app.example.com");
    expect(markup).toContain("Not now");
  });

  it("asks for only the code when a site wants one", () => {
    const markup = credentialPanel("code");
    expect(markup).toContain("PIN or code");
    expect(markup).not.toContain("Username or email");
  });

  it("sends the person to the page when there is nothing to type", () => {
    const markup = credentialPanel("person");
    expect(markup).toContain("Sign in on its browser tab");
    expect(markup).toContain("I&#x27;ve signed in");
    expect(markup).not.toContain('type="password"');
  });

  it("shows and disables the response while provider resolution is pending", () => {
    const requestId = ApprovalRequestId.make("action-approval-resolving");
    const markup = renderToStaticMarkup(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[
          {
            requestId,
            createdAt: "2026-08-21T22:45:52.000Z",
            turnId: null,
            questions: [
              {
                id: "t3_action_approval",
                header: "Approval",
                question: "Review this proposed publish.",
                options: [{ label: "Approve", description: "Select Approve." }],
                multiSelect: false,
              },
            ],
          },
        ]}
        respondingRequestIds={[requestId]}
        answers={{}}
        questionIndex={0}
        onToggleOption={vi.fn()}
        onAdvance={vi.fn()}
        environmentId={EnvironmentId.make("environment-1")}
        onRespond={vi.fn()}
      />,
    );

    expect(markup).toContain("Resolving…");
    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-live="polite"');
  });
});
