import { type ApprovalRequestId, type ProviderApprovalDecision } from "@t3tools/contracts";
import { memo } from "react";
import { Button } from "../ui/button";

interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  isResponding: boolean;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  if (isResponding) {
    return (
      <div className="flex w-full min-w-0 justify-end" data-composer-approval-actions="resolving">
        <Button size="sm" variant="outline" disabled aria-live="polite">
          Resolving…
        </Button>
      </div>
    );
  }

  return (
    <div
      className="grid w-full min-w-0 grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-end"
      data-composer-approval-actions="ready"
    >
      <Button
        size="sm"
        variant="ghost"
        className="order-4 min-h-10 min-w-0 whitespace-normal px-2 text-center leading-tight sm:order-1 sm:min-h-8 sm:whitespace-nowrap"
        onClick={() => void onRespondToApproval(requestId, "cancel")}
      >
        Cancel turn
      </Button>
      <Button
        size="sm"
        variant="destructive-outline"
        className="order-3 min-h-10 min-w-0 whitespace-normal px-2 text-center leading-tight sm:order-2 sm:min-h-8 sm:whitespace-nowrap"
        onClick={() => void onRespondToApproval(requestId, "decline")}
      >
        Decline
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="order-2 min-h-10 min-w-0 whitespace-normal px-2 text-center leading-tight sm:order-3 sm:min-h-8 sm:whitespace-nowrap"
        onClick={() => void onRespondToApproval(requestId, "acceptForSession")}
      >
        Always allow this session
      </Button>
      <Button
        size="sm"
        variant="default"
        className="order-1 min-h-10 min-w-0 whitespace-normal px-2 text-center leading-tight sm:order-4 sm:min-h-8 sm:whitespace-nowrap"
        onClick={() => void onRespondToApproval(requestId, "accept")}
      >
        Approve once
      </Button>
    </div>
  );
});
