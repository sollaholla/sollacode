import { CircleHelp, LoaderCircle } from "lucide-react";
import { cn } from "~/lib/utils";

import {
  countActiveProviderTasks,
  providerTaskChipLabel,
  type ProviderTask,
} from "../providerTasks";

/**
 * Composer chip announcing background work.
 *
 * The agents & tasks panel lives in the right panel, so when that panel is
 * collapsed there is otherwise no sign that anything is running. This mirrors
 * the "Listening…" chip on the opposite side of the composer: same shape, same
 * offset, so the two read as one family and never collide.
 *
 * Clicking it opens the right panel and flashes the panel, rather than opening
 * a second surface — there is one place tasks live, and this points at it.
 */
export function ProviderTaskChip(props: {
  readonly tasks: ReadonlyArray<ProviderTask>;
  readonly onOpen: () => void;
  readonly positioned?: boolean;
}) {
  const label = providerTaskChipLabel(props.tasks);
  if (label === null) return null;
  const running = countActiveProviderTasks(props.tasks);
  const stalled = props.tasks.filter((task) => task.status === "stale").length;
  const compactLabel =
    running > 0
      ? `${running} running${stalled > 0 ? ` · ${stalled} stalled` : ""}`
      : `${stalled} stalled`;
  const minimalLabel = String(running + stalled);

  return (
    <button
      aria-label={`${label}. Show agents and tasks.`}
      data-chat-composer-status-chip="provider-tasks"
      className={cn(
        "chat-composer-status-chip flex items-center gap-1.5 rounded-full border border-border/70 bg-background/95 px-2.5 py-1 text-xs font-medium text-muted-foreground shadow-sm transition-colors hover:text-foreground",
        props.positioned !== false && "absolute -top-8 right-3",
      )}
      onClick={props.onOpen}
      title="Show agents and tasks"
      type="button"
    >
      {running > 0 ? (
        <LoaderCircle aria-hidden className="size-3 animate-spin" />
      ) : (
        // Stalled-only: a spinner here would assert liveness we do not have.
        <CircleHelp aria-hidden className="size-3 text-amber-500" />
      )}
      <span aria-hidden className="chat-composer-status-label-full">
        {label}
      </span>
      <span aria-hidden className="chat-composer-status-label-compact">
        {compactLabel}
      </span>
      <span aria-hidden className="chat-composer-status-label-minimal">
        {minimalLabel}
      </span>
    </button>
  );
}
