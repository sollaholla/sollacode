import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  CircleX,
  LoaderCircle,
  MinusCircle,
  X,
} from "lucide-react";
import { useState } from "react";

import {
  PROVIDER_TASK_PAGE_SIZE,
  countActiveProviderTasks,
  dismissableProviderTaskIds,
  hasDismissableProviderTasks,
  isProviderTaskActive,
  pageProviderTasks,
  providerTaskStatusLabel,
  providerTaskTypeLabel,
  type ProviderTask,
} from "../providerTasks";
import { useProviderTaskDismissalStore } from "../providerTaskDismissalStore";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

function TaskStatusIcon({ task }: { readonly task: ProviderTask }) {
  if (isProviderTaskActive(task)) {
    return <LoaderCircle aria-hidden className="mt-0.5 size-4 shrink-0 animate-spin" />;
  }
  if (task.status === "stale") {
    // Not a spinner: a spinner asserts liveness, and silence is exactly what we
    // cannot call live.
    return <CircleHelp aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-500" />;
  }
  if (task.status === "failed") {
    return <CircleX aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />;
  }
  if (task.status === "stopped") {
    return <MinusCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />;
  }
  return <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-emerald-600" />;
}

/**
 * Live view of the sub-agents and background work a provider started.
 *
 * Without this, a turn that fans out to sub-agents looks like a turn that has
 * simply gone quiet — there is no other signal that work is still in flight.
 *
 * Bound to the right panel and stacked below its active surface, so it never
 * overlays the transcript or competes with the surface for horizontal space.
 * On mobile the right panel itself owns the viewport, giving task rows the full
 * screen width while keeping the task list independently scrollable.
 */
export function ProviderTaskPanel(props: {
  readonly tasks: ReadonlyArray<ProviderTask>;
  /** Briefly ringed after the composer chip is clicked, to say "over here". */
  readonly highlighted: boolean;
}) {
  const activeCount = countActiveProviderTasks(props.tasks);
  const dismissTasks = useProviderTaskDismissalStore((state) => state.dismissTasks);
  const canClear = hasDismissableProviderTasks(props.tasks);
  const [requestedPage, setRequestedPage] = useState(0);
  // Clamped inside the helper, so the list ageing out from under a held page
  // index shows the last page rather than nothing.
  const { items, page, pageCount, total } = pageProviderTasks(props.tasks, requestedPage);

  return (
    <section
      aria-label="Agents and tasks"
      className={cn(
        "flex max-h-[45%] min-h-0 shrink-0 flex-col overflow-hidden border border-x-0 border-b-0 bg-background",
        props.highlighted && "ring-2 ring-primary/60 ring-inset transition-shadow",
      )}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {activeCount > 0 ? (
            <LoaderCircle
              aria-hidden
              className="size-3.5 shrink-0 animate-spin text-muted-foreground"
            />
          ) : null}
          <h2 className="truncate text-xs font-medium">
            {activeCount > 0 ? `Agents & tasks · ${activeCount} running` : "Agents & tasks"}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/*
           * Clears finished, failed, stopped and stale rows — never running
           * ones. A bulk control gets used without reading the list, so it must
           * not be able to hide work that is still going.
           */}
          {canClear ? (
            <button
              type="button"
              onClick={() => dismissTasks(dismissableProviderTaskIds(props.tasks))}
              className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Dismiss finished, failed and stale tasks. Running work is kept."
            >
              Clear
            </button>
          ) : null}
          <span className="text-[11px] text-muted-foreground tabular-nums">{total}</span>
        </div>
      </header>

      <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {items.map((task) => (
          <li className="rounded-md border bg-background/70 p-2" key={task.taskId}>
            <div className="flex items-start gap-2">
              <TaskStatusIcon task={task} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{task.title}</p>
                <p className="text-[11px] text-muted-foreground">
                  {providerTaskTypeLabel(task)} · {providerTaskStatusLabel(task)}
                  {task.toolUses !== null ? ` · ${task.toolUses} tool uses` : ""}
                </p>
                {task.summary && task.summary !== task.title ? (
                  <p className="mt-1 line-clamp-3 text-[11px] text-muted-foreground">
                    {task.summary}
                  </p>
                ) : null}
              </div>
              {/*
               * Hides the row; it does not stop the work, and is labelled that
               * way rather than "Cancel" because there is no cancel channel for
               * provider-side tasks and a button claiming otherwise would lie.
               * Safe on a live task: anything that reports again comes back.
               */}
              <button
                type="button"
                onClick={() => dismissTasks([task.taskId])}
                aria-label={`Dismiss ${task.title}`}
                title={
                  task.status === "running"
                    ? "Hide this row. It does not stop the task — if it is still alive it will reappear when it next reports."
                    : "Hide this row."
                }
                className="-me-0.5 -mt-0.5 shrink-0 rounded p-1 text-muted-foreground/60 hover:bg-muted hover:text-foreground"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </div>
          </li>
        ))}
      </ul>

      {pageCount > 1 ? (
        <nav
          aria-label="Task pages"
          className="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-2"
        >
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {page * PROVIDER_TASK_PAGE_SIZE + 1}–{page * PROVIDER_TASK_PAGE_SIZE + items.length} of{" "}
            {total}
          </span>
          <div className="flex items-center gap-1">
            <Button
              aria-label="Previous page"
              className="size-7"
              disabled={page === 0}
              onClick={() => setRequestedPage(page - 1)}
              size="icon"
              variant="ghost"
            >
              <ChevronLeft />
            </Button>
            <Button
              aria-label="Next page"
              className="size-7"
              disabled={page >= pageCount - 1}
              onClick={() => setRequestedPage(page + 1)}
              size="icon"
              variant="ghost"
            >
              <ChevronRight />
            </Button>
          </div>
        </nav>
      ) : null}
    </section>
  );
}
