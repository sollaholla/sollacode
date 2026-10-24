import type { ScopedThreadRef } from "@t3tools/contracts";
import { memo } from "react";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";

/**
 * Names the plan an empty Send would implement. The title opens the plan panel
 * so the plan being approved is one tap away, never a guess. Close sets the
 * plan aside without sending anything; the plan's card can reopen it.
 */
export const ComposerPlanFollowUpBanner = memo(function ComposerPlanFollowUpBanner({
  planTitle,
  onOpenPlan,
  closeTarget,
}: {
  planTitle: string | null;
  onOpenPlan?: (() => void) | undefined;
  closeTarget?: { readonly threadRef: ScopedThreadRef; readonly planId: string } | undefined;
}) {
  const title = planTitle ?? "Proposed plan";
  const closePlan = useAtomCommand(threadEnvironment.closeProposedPlan, "plan close");
  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="info"
          size="sm"
          className="rounded-md px-1.5 py-0 font-semibold tracking-wide uppercase"
        >
          Plan Ready
        </Badge>
        {onOpenPlan ? (
          <button
            type="button"
            onClick={onOpenPlan}
            className="min-w-0 flex-1 truncate text-left text-sm font-medium underline-offset-2 hover:underline"
            title="Open this plan"
          >
            {title}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        )}
        {closeTarget ? (
          <button
            type="button"
            onClick={() =>
              void closePlan({
                environmentId: closeTarget.threadRef.environmentId,
                input: { threadId: closeTarget.threadRef.threadId, planId: closeTarget.planId },
              })
            }
            className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            title="Stop waiting on this plan without sending anything"
          >
            Close plan
          </button>
        ) : null}
      </div>
    </div>
  );
});
