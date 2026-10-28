import {
  CheckCircle2,
  CircleHelp,
  CircleStop,
  CircleX,
  LayersIcon,
  MinusCircle,
  X,
} from "lucide-react";

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
import { TERMINAL_WORKING_DOT_CLASS } from "./chat/TerminalSessionIcon";
import {
  COMPOSER_IDLE_CHIP_CLASS_NAME,
  COMPOSER_STATUS_COUNT_CHIP_CLASS_NAME,
  COMPOSER_WORKING_CHIP_CLASS_NAME,
} from "./chat/composerStatusIconChip";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";

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

function tasksNoun(count: number): string {
  return count === 1 ? "background task" : "background tasks";
}

/**
 * The composer rail's chip for the sub-agents and background work a provider
 * started. Without it, a turn that fans out to sub-agents looks like a turn
 * that has simply gone quiet. The chip counts running tasks. Completed work
 * clears itself, so once nothing runs it counts what is left: failures and
 * tasks that went silent. Tapping it lists every task.
 */
export function ProviderTasksChip(props: {
  readonly tasks: ReadonlyArray<ProviderTask>;
  /** Sends the per-task stop. Omitted where no stop channel is wired. */
  readonly onStopTask?: (taskId: string) => void;
}) {
  const activeCount = countActiveProviderTasks(props.tasks);
  const working = activeCount > 0;
  const count = working ? activeCount : props.tasks.length;
  const summary = working
    ? `${activeCount} ${tasksNoun(activeCount)} active`
    : `${count} ${tasksNoun(count)} need a look`;
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`${summary}. Show background tasks.`}
        title={summary}
        className={cn(
          COMPOSER_STATUS_COUNT_CHIP_CLASS_NAME,
          working ? COMPOSER_WORKING_CHIP_CLASS_NAME : COMPOSER_IDLE_CHIP_CLASS_NAME,
        )}
        data-chat-composer-status-chip="background-tasks"
      >
        <span className="relative inline-flex size-3 shrink-0 items-center justify-center">
          <LayersIcon aria-hidden className="size-full" />
          {working ? <span aria-hidden className={TERMINAL_WORKING_DOT_CLASS} /> : null}
        </span>
        <span aria-hidden className="tabular-nums">
          {count}
        </span>
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="end"
        className="w-[min(26rem,calc(100vw-2rem))]"
        viewportClassName="py-3 [--viewport-inline-padding:--spacing(3)]"
      >
        <ProviderTaskDetails
          tasks={props.tasks}
          {...(props.onStopTask ? { onStopTask: props.onStopTask } : {})}
        />
      </PopoverPopup>
    </Popover>
  );
}

/** The chip's popup: every task with its status, usage, Stop and Dismiss. */
export function ProviderTaskDetails(props: {
  readonly tasks: ReadonlyArray<ProviderTask>;
  readonly onStopTask?: (taskId: string) => void;
}) {
  const activeCount = countActiveProviderTasks(props.tasks);
  const dismissTasks = useProviderTaskDismissalStore((state) => state.dismissTasks);
  const onStopTask = props.onStopTask;
  const canStop = (task: ProviderTask) => onStopTask !== undefined && canStopProviderTask({ task });

  return (
    <section aria-label="Background tasks" className="space-y-2.5">
      <header className="flex items-start gap-2 px-1">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-snug text-foreground">Background tasks</p>
          <p className="text-[11px] leading-snug text-muted-foreground">
            {activeCount > 0 ? `${activeCount} active` : "Nothing running"}
          </p>
        </div>
        {/*
         * Clears failed and stale rows — never running ones.
         * A bulk control gets used without reading the list, so it must not be
         * able to hide work that is still going.
         */}
        {hasDismissableProviderTasks(props.tasks) ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => dismissTasks(dismissableProviderTaskIds(props.tasks))}
            title="Dismiss failed and stale tasks. Running work is kept."
          >
            Clear
          </Button>
        ) : null}
      </header>
      <ul className="max-h-[min(50dvh,22rem)] space-y-1.5 overflow-y-auto overscroll-contain">
        {props.tasks.map((task) => (
          <li className="rounded-lg border border-border/60 bg-card/60 p-2" key={task.taskId}>
            <div className="flex items-start gap-2">
              <TaskStatusIcon task={task} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{task.title}</p>
                <p className="text-[11px] text-muted-foreground">
                  {providerTaskTypeLabel(task)} · {providerTaskStatusLabel(task)}
                  {task.taskType !== "local_bash" && task.taskType !== "local_monitor" ? (
                    <>
                      {task.toolUses !== null ? ` · ${task.toolUses} tool uses` : ""}
                      {task.totalTokens != null
                        ? ` · ${task.totalTokens.toLocaleString()} tokens`
                        : task.taskType === "local_agent" || task.taskType === "remote_agent"
                          ? " · tokens unknown"
                          : ""}
                    </>
                  ) : null}
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
                    title="Stop this task. It leaves the list once it stops."
                    className="rounded p-1 text-muted-foreground/60 hover:bg-muted hover:text-foreground"
                  >
                    <CircleStop aria-hidden className="size-3.5" />
                  </button>
                ) : null}
                {/*
                 * Never offered for running work, matching bulk Clear. Hiding a
                 * live task made the list read as empty while that task still
                 * held the turn with the user's messages queued behind it, so
                 * the user concluded nothing was running. A dead runtime is
                 * still reachable: silence past PROVIDER_TASK_STALE_AFTER_MS
                 * downgrades it to `stale`, and stale rows are dismissable here
                 * and by Clear.
                 */}
                {task.status !== "running" ? (
                  <button
                    type="button"
                    onClick={() => dismissTasks([task.taskId])}
                    aria-label={`Dismiss ${task.title}`}
                    title="Hide this row."
                    className="rounded p-1 text-muted-foreground/60 hover:bg-muted hover:text-foreground"
                  >
                    <X aria-hidden className="size-3.5" />
                  </button>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
