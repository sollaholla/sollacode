import {
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  CircleStop,
  CircleX,
  MinusCircle,
  X,
} from "lucide-react";
import { useState } from "react";

import { THREAD_PANEL_AGENTS_TASKS, useUiStateStore } from "../uiStateStore";

import {
  canStopProviderTask,
  countActiveProviderTasks,
  dismissableProviderTaskIds,
  hasDismissableProviderTasks,
  isProviderTaskActive,
  providerTaskStatusLabel,
  providerTaskTypeLabel,
  type ProviderTask,
} from "../providerTasks";
import { useProviderTaskDismissalStore } from "../providerTaskDismissalStore";
import { cn } from "~/lib/utils";

function TaskStatusIcon({ task }: { readonly task: ProviderTask }) {
  if (isProviderTaskActive(task)) {
    return (
      <span
        aria-hidden
        className="mt-1.5 size-2 shrink-0 rounded-full bg-sky-500 ring-2 ring-sky-500/15"
      />
    );
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
 * This is a thread-scoped bottom drawer: its handle stays below the composer
 * and its bounded list grows upward with the rest of the chat footer.
 */
export function ProviderTaskPanel(props: {
  readonly tasks: ReadonlyArray<ProviderTask>;
  /**
   * Driver behind the thread's session, used to decide whether a running row
   * can actually be killed. `null` when no session is bound yet.
   */
  readonly driverKind?: string | null;
  /** Sends the per-task stop. Omitted where no stop channel is wired. */
  readonly onStopTask?: (taskId: string) => void;
  /**
   * Scoped key of the owning thread. When given, the open/closed state is
   * remembered against that thread instead of resetting on every remount.
   */
  readonly threadKey?: string | null;
}) {
  const activeCount = countActiveProviderTasks(props.tasks);
  const dismissTasks = useProviderTaskDismissalStore((state) => state.dismissTasks);
  const canClear = hasDismissableProviderTasks(props.tasks);
  const driverKind = props.driverKind ?? null;
  const onStopTask = props.onStopTask;
  const canStop = (task: ProviderTask) =>
    onStopTask !== undefined && canStopProviderTask({ task, driverKind });
  const [collapsedOverride, setCollapsedOverride] = useState<boolean | null>(null);
  // Remembered per thread, and collapsed until this thread says otherwise —
  // the local override alone was forgotten on every remount, so a reader who
  // folded it away got it back on the next visit. Threadless callers (the
  // markup test, any surface with no thread bound) keep an ephemeral override.
  const threadKey = props.threadKey ?? null;
  const persistedExpanded = useUiStateStore((state) =>
    threadKey === null
      ? undefined
      : state.threadPanelExpandedById[threadKey]?.[THREAD_PANEL_AGENTS_TASKS],
  );
  const setThreadPanelExpanded = useUiStateStore((state) => state.setThreadPanelExpanded);
  const collapsed = threadKey === null ? (collapsedOverride ?? false) : persistedExpanded !== true;
  const setCollapsed = (next: boolean) => {
    if (threadKey === null) {
      setCollapsedOverride(next);
      return;
    }
    setThreadPanelExpanded(threadKey, THREAD_PANEL_AGENTS_TASKS, !next);
  };

  return (
    <section
      aria-label="Background tasks"
      data-provider-task-placement="composer"
      className={cn(
        "mx-auto mt-1 flex min-h-0 w-[calc(100%-2.75rem)] max-w-[calc(48rem-2.75rem)] shrink-0 flex-col-reverse overflow-hidden rounded-xl border border-border/70 bg-background/95 shadow-sm backdrop-blur",
        collapsed ? "max-h-none" : "max-h-[min(38dvh,22rem)]",
      )}
    >
      <header className="relative flex min-h-9 shrink-0 items-center gap-2 bg-muted/20 px-3">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} background tasks`}
          onClick={() => setCollapsed(!collapsed)}
          className="peer absolute inset-0 cursor-pointer text-left text-xs font-medium text-muted-foreground hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
        <div className="pointer-events-none z-10 flex min-w-0 flex-1 items-center gap-2 text-left text-xs font-medium text-muted-foreground peer-hover:text-foreground peer-focus-visible:text-foreground">
          <ChevronDown
            aria-hidden
            className={cn("size-3.5 shrink-0 transition-transform", collapsed && "rotate-180")}
          />
          {activeCount > 0 ? (
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full bg-sky-500 ring-2 ring-sky-500/15"
            />
          ) : null}
          <h2 className="truncate">
            {activeCount > 0 ? `Background tasks · ${activeCount} running` : "Background tasks"}
          </h2>
        </div>
        <div className="z-10 flex shrink-0 items-center gap-1.5">
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
          <span className="pointer-events-none rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums peer-hover:text-foreground peer-focus-visible:text-foreground">
            {props.tasks.length}
          </span>
        </div>
      </header>

      {collapsed ? null : (
        <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain border-b border-border/60 p-2">
          {props.tasks.map((task) => (
            <li className="rounded-lg border border-border/60 bg-card/60 p-2" key={task.taskId}>
              <div className="flex items-start gap-2">
                <TaskStatusIcon task={task} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">{task.title}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {providerTaskTypeLabel(task)} · {providerTaskStatusLabel(task)}
                    {task.toolUses !== null ? ` · ${task.toolUses} tool uses` : ""}
                  </p>
                  {task.summary && task.summary !== task.title ? (
                    <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                      {task.summary}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  {canStop(task) ? (
                    <button
                      type="button"
                      onClick={() => props.onStopTask?.(task.taskId)}
                      aria-label={`Stop ${task.title}`}
                      title="Stop this task. The row reports the outcome, then clears itself."
                      className="rounded p-1 text-muted-foreground/60 hover:bg-muted hover:text-foreground"
                    >
                      <CircleStop aria-hidden className="size-3.5" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => dismissTasks([task.taskId])}
                    aria-label={`Dismiss ${task.title}`}
                    title={
                      task.status === "running"
                        ? "Hide this row. If the task is still alive it will reappear when it next reports."
                        : "Hide this row."
                    }
                    className="rounded p-1 text-muted-foreground/60 hover:bg-muted hover:text-foreground"
                  >
                    <X aria-hidden className="size-3.5" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
