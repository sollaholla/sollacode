import { ArrowLeftRightIcon, XIcon } from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";

import { Button } from "../ui/button";
import { describeProviderFailover, type ProviderFailoverNotice } from "./providerFailoverNotice";

const DISMISSED_STORAGE_PREFIX = "solla:provider-failover-dismissed:";

function readDismissed(activityId: string): boolean {
  try {
    return window.localStorage.getItem(`${DISMISSED_STORAGE_PREFIX}${activityId}`) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(activityId: string): void {
  try {
    window.localStorage.setItem(`${DISMISSED_STORAGE_PREFIX}${activityId}`, "1");
  } catch {
    // Private mode or a full store: the banner simply comes back next load.
  }
}

/**
 * One line while the server has this thread on a different model than the
 * one the user chose: which model, why, and when it goes back. Dismissable,
 * and the dismissal sticks to this particular switch — a later switch shows
 * again.
 */
export const ProviderFailoverBanner = memo(function ProviderFailoverBanner({
  notice,
}: {
  readonly notice: ProviderFailoverNotice;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState(() => readDismissed(notice.activityId));
  useEffect(() => {
    setDismissed(readDismissed(notice.activityId));
  }, [notice.activityId]);
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const dismiss = useCallback(() => {
    writeDismissed(notice.activityId);
    setDismissed(true);
  }, [notice.activityId]);
  if (dismissed) return null;

  const to = notice.targetModel ?? notice.targetLabel ?? "another model";
  const from = notice.sourceModel ?? notice.sourceLabel ?? "the chosen model";
  const back =
    notice.resetsAt === null
      ? "back after the window resets"
      : notice.resetsAt <= nowMs
        ? "back on the next idle turn"
        : `back in ${formatRemaining(notice.resetsAt - nowMs)}`;

  return (
    <div
      className="pointer-events-auto mx-auto w-full max-w-3xl px-2 pt-2 pb-2"
      data-testid="provider-failover-banner"
    >
      <div
        className="alert-glass flex items-center gap-2 rounded-lg border border-warning/32 py-1.5 ps-2.5 pe-1 text-card-foreground text-xs [&_svg]:text-warning"
        data-variant="warning"
        role="status"
        title={describeProviderFailover(notice, nowMs)}
      >
        <ArrowLeftRightIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">Switched to {to}</span>
          <span className="text-muted-foreground">
            {" "}
            · {from} refused by its usage limit · {back}
          </span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={dismiss}
          aria-label="Dismiss the model switch notice"
        >
          <XIcon className="size-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  );
});

function formatRemaining(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}
