import { ApprovalRequestId } from "@t3tools/contracts";
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
      />,
    );

    expect(markup).toContain("Action approval");
    expect(markup).toContain(">Approve</span>");
    expect(markup).toContain("overflow-x-hidden");
    expect(markup).toContain("overflow-wrap:anywhere");
    expect(markup).toContain('type="button"');
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
      />,
    );

    expect(markup).toContain("Resolving…");
    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-live="polite"');
  });
});
