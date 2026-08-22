import { HammerIcon } from "lucide-react";
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

  return (
    <button
      // The full sentence lives in the accessible name; the visible chip is
      // icon + count only, matching the terminal and side-chat chips.
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
      <HammerIcon
        aria-hidden
        // Stalled-only work is a question, not progress; keep the amber tell.
        className={cn("size-3", running === 0 && stalled > 0 && "text-amber-500")}
      />
      <span aria-hidden className="tabular-nums">
        {running + stalled}
      </span>
    </button>
  );
}
