import { ApprovalRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

describe("ComposerPendingApprovalActions", () => {
  it("replaces approval choices with a disabled resolving state", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-request-1")}
        isResponding
        onRespondToApproval={vi.fn()}
      />,
    );

    expect(markup).toContain("Resolving…");
    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-live="polite"');
    expect(markup).not.toContain("Approve once");
  });
});
