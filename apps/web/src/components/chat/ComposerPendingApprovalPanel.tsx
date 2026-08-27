import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { ScrollArea } from "../ui/scroll-area";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
}: ComposerPendingApprovalPanelProps) {
  const approvalSummary =
    approval.requestKind === "command"
      ? "Command approval requested"
      : approval.requestKind === "file-read"
        ? "File-read approval requested"
        : "File-change approval requested";
  const detailLabel =
    approval.requestKind === "command"
      ? "Command"
      : approval.requestKind === "file-read"
        ? "File to read"
        : "File change";

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">PENDING APPROVAL</span>
        <span className="text-sm font-medium">{approvalSummary}</span>
        {pendingCount > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
        ) : null}
      </div>
      {approval.detail ? (
        <div className="mt-3 rounded-lg border border-border/65 bg-background/70 p-3">
          <p className="text-xs font-medium text-muted-foreground">{detailLabel}</p>
          {/* A bare `overflow-auto` here scrolled on a desktop wheel and
              nowhere else: no visible scrollbar to say it could, and on a
              touch screen the drag was claimed before it reached this box.
              Someone approving a long command could not read what they were
              approving, and on a phone could not get down to the buttons.
              ScrollArea is what the plan panel uses — real scrollbar,
              `overscroll-contain` so the gesture stops here, and `touch-pan-y`
              so a finger drag is unambiguously this element's to handle. */}
          <ScrollArea className="mt-2 max-h-40 touch-pan-y">
            <pre
              aria-label={detailLabel}
              className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground"
              data-approval-detail="complete"
            >
              {approval.detail}
            </pre>
          </ScrollArea>
        </div>
      ) : null}
    </div>
  );
});
