import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useUiStateStore } from "../../uiStateStore";
import { ComposerStackPanelHeader } from "./ComposerStackPanelHeader";
import { COMPOSER_STACK_SURFACE_CLASS_NAME } from "./composerStackSurface";

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
  const collapsed = !expanded;
  return (
    <section
      aria-label="Queued messages"
      className={cn(
        COMPOSER_STACK_SURFACE_CLASS_NAME,
        "mt-3 mb-2 flex min-h-0 shrink-0 flex-col-reverse",
        collapsed ? "max-h-none" : "max-h-[min(38dvh,22rem)]",
      )}
    >
      <ComposerStackPanelHeader
        label="queued messages"
        // Matches the task panel's "Background tasks · 1 running": the noun,
        // then what the count actually means. The status sentence rides along
        // because it is the one thing a reader needs while the card is shut —
        // "Waiting for usage budget" and "Sends when the current work
        // finishes" are different situations.
        title={`Queued messages · ${count} waiting · ${status}`}
        // Blue dot for the same reason the task panel uses one: something on
        // this card is in flight rather than merely parked.
        active={failedCount === 0}
        collapsed={collapsed}
        onToggle={(next) => setThreadPanelExpanded(threadKey, "queued-messages", !next)}
        actions={
          failedCount > 0 ? (
            <span className="text-[11px] text-destructive" role="status">
              {failedCount} failed
            </span>
          ) : null
        }
        count={count}
      />
      {collapsed ? null : (
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain border-b border-border/60 p-2">
          {children}
        </div>
      )}
    </section>
  );
}
