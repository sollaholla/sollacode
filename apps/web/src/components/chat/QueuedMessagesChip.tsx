import { ClockIcon, TriangleAlertIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  COMPOSER_FAILED_CHIP_CLASS_NAME,
  COMPOSER_STATUS_COUNT_CHIP_CLASS_NAME,
  COMPOSER_WAITING_CHIP_CLASS_NAME,
} from "./composerStatusIconChip";

function queuedMessagesSummary(count: number, failedCount: number): string {
  if (failedCount > 0) {
    return failedCount === 1
      ? "A queued message couldn't be sent"
      : `${failedCount} queued messages couldn't be sent`;
  }
  return count === 1 ? "1 queued message" : `${count} queued messages`;
}

/**
 * The composer rail's chip for messages waiting to send on this thread. The
 * chip shows how many; tapping it lists them with Send now, Edit and Cancel.
 */
export function QueuedMessagesChip(props: {
  readonly count: number;
  readonly failedCount: number;
  /** Why the queue is waiting, such as "Sends when the current work finishes". */
  readonly status: string;
  /**
   * The message rows. `close` shuts the popup, for actions that send the reader
   * back to the composer, such as Edit.
   */
  readonly children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const failed = props.failedCount > 0;
  const summary = queuedMessagesSummary(props.count, props.failedCount);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`${summary}. Show queued messages.`}
        title={`${summary} · ${props.status}`}
        className={cn(
          COMPOSER_STATUS_COUNT_CHIP_CLASS_NAME,
          failed ? COMPOSER_FAILED_CHIP_CLASS_NAME : COMPOSER_WAITING_CHIP_CLASS_NAME,
        )}
        data-chat-composer-status-chip="queued-messages"
      >
        {failed ? (
          <TriangleAlertIcon aria-hidden className="size-3 shrink-0" />
        ) : (
          <ClockIcon aria-hidden className="size-3 shrink-0" />
        )}
        <span aria-hidden className="tabular-nums">
          {props.count}
        </span>
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="end"
        className="w-[min(28rem,calc(100vw-2rem))]"
        viewportClassName="py-3 [--viewport-inline-padding:--spacing(3)]"
      >
        <QueuedMessagesDetails summary={summary} status={props.status}>
          {props.children(() => setOpen(false))}
        </QueuedMessagesDetails>
      </PopoverPopup>
    </Popover>
  );
}

/** The chip's popup: what is waiting and why, then the messages in send order. */
export function QueuedMessagesDetails(props: {
  readonly summary: string;
  readonly status: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label="Queued messages" className="space-y-2.5">
      <header className="px-1">
        <p className="text-[13px] font-medium leading-snug text-foreground">{props.summary}</p>
        <p className="text-[11px] leading-snug text-muted-foreground">{props.status}</p>
      </header>
      <div className="max-h-[min(50dvh,22rem)] space-y-1.5 overflow-y-auto overscroll-contain">
        {props.children}
      </div>
    </section>
  );
}
