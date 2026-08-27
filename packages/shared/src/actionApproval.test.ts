import { describe, expect, it } from "vite-plus/test";

import { actionApprovalAnswerFromUnknown, isActionApprovalRequestId } from "./actionApproval.ts";

describe("durable action approvals", () => {
  it("recognizes only the reserved request namespace", () => {
    expect(isActionApprovalRequestId("action-approval:abc")).toBe(true);
    expect(isActionApprovalRequestId("provider-user-input:abc")).toBe(false);
  });

  it("distinguishes approval, corrections, and cancellation", () => {
    expect(actionApprovalAnswerFromUnknown({ t3_action_approval: "Approve" })).toEqual({
      status: "approved",
    });
    expect(
      actionApprovalAnswerFromUnknown({
        t3_action_approval: "Use the VeeraMedical account instead.",
      }),
    ).toEqual({
      status: "changes_requested",
      feedback: "Use the VeeraMedical account instead.",
    });
    expect(actionApprovalAnswerFromUnknown({})).toEqual({ status: "cancelled" });
  });
});
