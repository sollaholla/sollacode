import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  GaugeIcon,
  LoaderCircleIcon,
  PlayIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { memo, useEffect, useState } from "react";

import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { UsageGuardEffortSlider } from "./UsageGuardEffortSlider";
import {
  formatCooldownDuration,
  formatUsageGuardResetsAt,
  type UsageGuardPauseNotice,
} from "./usageGuardPause";

/** "just now", "3m ago", "2h ago" for the reading's age. */
export function formatReadingAge(reportedAt: string | null, nowMs: number): string | null {
  if (reportedAt === null) return null;
  const ms = Date.parse(reportedAt);
  if (!Number.isFinite(ms)) return null;
  const seconds = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/**
 * The hold card. Shown while the usage guard holds this thread's queued work.
 *
 * Collapsed, one line says what is happening and when it resumes. Expanded,
 * it shows the reading the hold rests on (with its age and a refresh), the
 * plan for the applied model and effort, previews of other efforts and
 * models, and the two actions: Cancel the held work, or Resume it now.
 *
 * Resume runs the *applied* setting. Moving the slider only previews; the
 * person applies a change explicitly if they want the shorter wait.
 */
export const UsageGuardPausedBanner = memo(function UsageGuardPausedBanner({
  notice,
  onResume,
  onCancel,
  onRefresh,
  refreshing = false,
  resuming,
  selection,
  provider,
  onApplyEffort,
}: {
  readonly notice: UsageGuardPauseNotice;
  readonly onCancel?: () => void;
  readonly onResume: (selection?: ModelSelection) => void;
  readonly onRefresh?: (() => void) | undefined;
  readonly refreshing?: boolean;
  readonly resuming: boolean;
  readonly selection?: ModelSelection | null;
  readonly provider?: ServerProvider | undefined;
  readonly onApplyEffort?: (selection: ModelSelection) => void;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<ModelSelection | null>(null);
  const [cancelConfirmationOpen, setCancelConfirmationOpen] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const dueMs = notice.retryAt === null ? NaN : Date.parse(notice.retryAt);
  const remainingSeconds = Math.max(0, Math.ceil((dueMs - nowMs) / 1000));
  const startedMs = Date.parse(notice.createdAt);
  const progress = Number.isFinite(dueMs)
    ? Math.min(100, Math.max(0, (100 * (nowMs - startedMs)) / Math.max(1, dueMs - startedMs)))
    : null;
  const waitingForRoom = notice.tier !== null && notice.tier !== "pause";
  // On a pacing hold the countdown really is when work resumes. On a hard hold
  // it is only when the guard looks again, and the window it is waiting on can
  // be an hour out — "resumes in 17s" next to "at ~100%" promised something the
  // guard had no intention of doing, and read as nonsense.
  const timing =
    progress === null
      ? null
      : remainingSeconds > 0
        ? `${waitingForRoom ? "resumes" : "rechecks"} in ${formatCooldownDuration(remainingSeconds)}`
        : "rechecking usage…";
  const heading = waitingForRoom ? "Waiting for usage room" : "Held by the usage guard";
  // The live provider reading beats the one frozen into the notice when it is
  // newer: a refresh, or a report from another thread, updates it.
  const live = provider?.usageGuard;
  const liveNewer =
    live !== undefined &&
    live.enabled &&
    (notice.reportedAt === null || Date.parse(live.updatedAt) > Date.parse(notice.reportedAt));
  const reading = liveNewer ? live.summary : (notice.detail ?? notice.summary);
  const readingAt = liveNewer ? live.updatedAt : notice.reportedAt;
  const readingAge = formatReadingAge(readingAt, nowMs);
  const resets = formatUsageGuardResetsAt(notice.resetsAt, nowMs);
  const capacity =
    waitingForRoom &&
    notice.backgroundBudget !== null &&
    notice.backgroundBudget > 0 &&
    notice.activeThreads !== null
      ? `${notice.activeThreads} of ${notice.backgroundBudget} thread${notice.backgroundBudget === 1 ? "" : "s"} the window can carry are busy`
      : null;
  const detail = [reading, capacity, resets]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" · ");
  const busy = resuming || refreshing;

  return (
    <>
      <div
        className="pointer-events-auto mx-auto w-full max-w-3xl @container px-2 py-2"
        data-testid="usage-guard-paused-banner"
      >
        <div
          className="relative overflow-hidden alert-glass rounded-lg border border-warning/32 text-card-foreground text-xs"
          data-variant="warning"
          role="status"
          title={detail.length > 0 ? detail : notice.summary}
        >
          <div className="flex min-h-10 items-center gap-1 px-2 py-1.5">
            <GaugeIcon className="mx-1 size-3.5 shrink-0 text-warning" aria-hidden />
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch text-left outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{heading}</span>
                {timing && <span className="text-muted-foreground"> · {timing}</span>}
                {!expanded && (
                  <span className="text-muted-foreground">
                    {" "}
                    · {detail.length > 0 ? detail : notice.summary}
                  </span>
                )}
              </span>
              <ChevronDownIcon
                className={`ml-auto size-3.5 shrink-0 self-center text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
                aria-hidden
              />
            </button>
            <Button
              type="button"
              size="icon-xs"
              variant="outline"
              disabled={resuming}
              onClick={() => onResume()}
              aria-label={`Resume now despite ${notice.providerLabel} usage`}
              title="Resume now"
            >
              {resuming ? (
                <LoaderCircleIcon className="animate-spin" aria-hidden />
              ) : (
                <PlayIcon aria-hidden />
              )}
            </Button>
            {onCancel && (
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="text-destructive hover:bg-destructive/8"
                disabled={resuming}
                onClick={() => setCancelConfirmationOpen(true)}
                aria-label="Cancel the held work"
                title="Cancel held work"
              >
                <XIcon aria-hidden />
              </Button>
            )}
          </div>
          {expanded && (
            <div className="space-y-3 border-t border-border/50 px-2.5 pt-2.5 pb-2.5">
              <p className="break-words whitespace-pre-wrap leading-relaxed text-muted-foreground">
                {detail.length > 0 ? detail : notice.summary}
              </p>
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span>
                  Reading {readingAge === null ? "age unknown" : readingAge}
                  {liveNewer ? "" : " · from when the hold began"}
                </span>
                {onRefresh && (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="h-6 gap-1 px-2"
                    disabled={busy}
                    onClick={onRefresh}
                    aria-label="Refresh usage reading"
                  >
                    <RefreshCwIcon
                      className={`size-3 ${refreshing ? "animate-spin" : ""}`}
                      aria-hidden
                    />
                    {refreshing ? "Refreshing…" : "Refresh"}
                  </Button>
                )}
              </div>
              {selection && onApplyEffort && (
                <UsageGuardEffortSlider
                  key={JSON.stringify(selection)}
                  selection={selection}
                  provider={provider}
                  estimates={notice.effortEstimates}
                  nowMs={nowMs}
                  waitSeconds={Number.isFinite(dueMs) ? remainingSeconds : null}
                  onApply={onApplyEffort}
                  onDraftChange={setDraft}
                  busy={resuming}
                />
              )}
              {draft !== null && (
                <p className="text-[11px] text-muted-foreground">
                  Resume uses the applied setting. Apply the previewed effort first to use it.
                </p>
              )}
            </div>
          )}
          {progress !== null && (
            <div
              role="progressbar"
              aria-label="Cooldown progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress)}
              className="absolute bottom-0 left-0 h-0.5 bg-warning/60"
              style={{ width: `${progress}%` }}
            />
          )}
        </div>
      </div>

      <AlertDialog open={cancelConfirmationOpen} onOpenChange={setCancelConfirmationOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this held work?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the queued turn. It will not resume automatically when usage room is
              available.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep waiting</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setCancelConfirmationOpen(false);
                onCancel?.();
              }}
            >
              Cancel held work
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
});
