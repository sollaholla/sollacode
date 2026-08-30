import { LoaderCircleIcon } from "lucide-react";

import { threadSyncLabel, threadSyncOverlayCopy, type ThreadSyncPhase } from "../../threadSync";

export function ThreadSyncStatusPill({ phase }: { readonly phase: ThreadSyncPhase }) {
  const label = threadSyncLabel(phase);

  return (
    <div
      aria-label={label}
      className="pointer-events-none mx-auto mb-2 flex w-fit max-w-full items-center gap-2 rounded-full border border-border/60 bg-card/95 px-3 py-1.5 text-foreground text-xs font-medium shadow-sm"
      role="status"
    >
      <LoaderCircleIcon
        aria-hidden
        className="size-3.5 shrink-0 animate-spin text-muted-foreground"
      />
      <span className="truncate">{label}</span>
    </div>
  );
}

export function ThreadSyncOverlay({ phase }: { readonly phase: ThreadSyncPhase }) {
  const copy = threadSyncOverlayCopy(phase);

  return (
    // Catching up is a status, not a modal. Keep its composited box bounded to
    // the card itself: Mobile Safari can retarget the first tap through a
    // full-viewport overlay even when that overlay has pointer-events:none,
    // producing the observed "every control needs two taps" state.
    <div
      aria-busy="true"
      aria-label={`${copy.title} ${copy.detail}`}
      aria-live="polite"
      className="pointer-events-none absolute left-1/2 top-1/2 z-30 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2"
      data-thread-sync-overlay={phase}
      role="status"
    >
      <div className="flex w-full items-center gap-3 rounded-2xl border border-border/70 bg-card px-4 py-3 text-foreground shadow-lg">
        <LoaderCircleIcon
          aria-hidden
          className="size-5 shrink-0 animate-spin text-muted-foreground"
        />
        <div className="min-w-0">
          <div className="text-sm font-semibold">{copy.title}</div>
          <div className="mt-0.5 text-pretty text-muted-foreground text-xs leading-relaxed">
            {copy.detail}
          </div>
        </div>
      </div>
    </div>
  );
}
