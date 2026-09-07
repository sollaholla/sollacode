import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useUiStateStore } from "../../uiStateStore";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

export function QueuedMessagesPanel({
  count,
  failedCount,
  status,
  threadKey,
  children,
}: {
  count: number;
  failedCount: number;
  status: string;
  threadKey: string;
  children: ReactNode;
}) {
  const expanded = useUiStateStore(
    (state) => state.threadPanelExpandedById[threadKey]?.["queued-messages"] === true,
  );
  const setThreadPanelExpanded = useUiStateStore((state) => state.setThreadPanelExpanded);
  return (
    <Collapsible
      open={expanded}
      onOpenChange={(open) => setThreadPanelExpanded(threadKey, "queued-messages", open)}
      className="mx-auto mt-3 mb-2 w-full max-w-3xl overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm"
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium">
            <span>
              {count} queued message{count === 1 ? "" : "s"}
            </span>
            {failedCount > 0 && (
              <span className="text-destructive" role="status">
                {failedCount} failed
              </span>
            )}
          </span>
          <span className="mt-0.5 block text-[11px] text-muted-foreground">{status}</span>
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground group-data-panel-open:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsiblePanel className="motion-reduce:transition-none">
        <div className="max-h-56 overflow-y-auto overscroll-contain px-4 pb-1">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
