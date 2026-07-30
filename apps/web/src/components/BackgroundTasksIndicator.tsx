import { scopeThread } from "@t3tools/client-runtime/state/models";
import { CheckCircle2, CircleX, Download, FolderOpen, LoaderCircle, X } from "lucide-react";
import * as Option from "effect/Option";
import { memo, useEffect } from "react";

import {
  canCancelBackgroundTask,
  isBackgroundTaskActive,
  type ThreadExportBackgroundTask,
  useBackgroundTaskStore,
} from "../backgroundTasks";
import { readLocalApi } from "../localApi";
import { useEnvironmentThread } from "../state/threads";
import {
  countThreadTurns,
  LARGE_THREAD_EXPORT_TURN_THRESHOLD,
  serializeThreadHandoff,
  threadExportFilename,
} from "../threadExport";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "./ui/popover";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";

const processingTaskIds = new Set<string>();

function currentTask(id: string): ThreadExportBackgroundTask | undefined {
  return useBackgroundTaskStore.getState().tasks.find((task) => task.id === id);
}

function taskWasCancelled(id: string): boolean {
  return currentTask(id)?.status === "cancelled";
}

function downloadJsonInBrowser(filename: string, contents: string): string {
  const blob = new Blob([`${contents}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.download = filename;
  anchor.href = url;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return `Downloads/${filename}`;
}

const ThreadExportTaskRunner = memo(function ThreadExportTaskRunner({
  task,
}: {
  readonly task: ThreadExportBackgroundTask;
}) {
  const threadState = useEnvironmentThread(task.threadRef.environmentId, task.threadRef.threadId);

  useEffect(() => {
    if (task.status !== "queued" && task.status !== "loading") return;
    if (processingTaskIds.has(task.id)) return;

    if (Option.isNone(threadState.data)) {
      if (task.status !== "loading") {
        useBackgroundTaskStore.getState().updateTask(task.id, { status: "loading", progress: 10 });
      }
      if (threadState.status === "deleted" || Option.isSome(threadState.error)) {
        useBackgroundTaskStore.getState().updateTask(task.id, {
          status: "failed",
          error: Option.getOrElse(
            threadState.error,
            () => "Conversation data is unavailable for export.",
          ),
        });
      }
      return;
    }

    const threadData = Option.getOrThrow(threadState.data);
    processingTaskIds.add(task.id);
    const run = async () => {
      const thread = scopeThread(task.threadRef.environmentId, threadData);
      const turnCount = countThreadTurns(thread);
      const update = useBackgroundTaskStore.getState().updateTask;

      if (turnCount > LARGE_THREAD_EXPORT_TURN_THRESHOLD) {
        update(task.id, { status: "awaiting-confirmation", progress: 20 });
        const confirmed = await readLocalApi()?.dialogs.confirm(
          `This conversation contains ${turnCount} turns. The JSON handoff may be large and take longer to export. Continue?`,
        );
        if (taskWasCancelled(task.id)) return;
        if (!confirmed) {
          update(task.id, { status: "cancelled", progress: 20 });
          return;
        }
      }

      if (taskWasCancelled(task.id)) return;
      update(task.id, { status: "serializing", progress: 45 });
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      if (taskWasCancelled(task.id)) return;

      const filename = threadExportFilename(thread);
      const contents = serializeThreadHandoff(thread);
      update(task.id, { status: "writing", progress: 80 });
      const outputPath = window.desktopBridge
        ? await window.desktopBridge.saveThreadExportJson({ filename, contents })
        : downloadJsonInBrowser(filename, contents);
      update(task.id, {
        status: "completed",
        progress: 100,
        outputPath,
      });
    };

    void run()
      .catch((cause: unknown) => {
        useBackgroundTaskStore.getState().updateTask(task.id, {
          status: "failed",
          error: cause instanceof Error ? cause.message : "The export failed.",
        });
      })
      .finally(() => {
        processingTaskIds.delete(task.id);
      });
  }, [task.id, task.status, threadState]);

  return null;
});

export const BackgroundTaskRunners = memo(function BackgroundTaskRunners() {
  const tasks = useBackgroundTaskStore((state) => state.tasks);
  return tasks
    .filter((task) => isBackgroundTaskActive(task.status))
    .map((task) => <ThreadExportTaskRunner key={task.id} task={task} />);
});

function taskStatusLabel(task: ThreadExportBackgroundTask): string {
  switch (task.status) {
    case "queued":
      return "Queued";
    case "loading":
      return "Loading conversation";
    case "awaiting-confirmation":
      return "Awaiting confirmation";
    case "serializing":
      return "Preparing JSON";
    case "writing":
      return "Saving file";
    case "completed":
      return "Export complete";
    case "failed":
      return "Export failed";
    case "cancelled":
      return "Cancelled";
  }
}

export const BackgroundTasksIndicator = memo(function BackgroundTasksIndicator() {
  const tasks = useBackgroundTaskStore((state) => state.tasks);
  const activeCount = tasks.filter((task) => isBackgroundTaskActive(task.status)).length;
  const cancelTask = useBackgroundTaskStore((state) => state.cancelTask);
  const removeTask = useBackgroundTaskStore((state) => state.removeTask);
  const clearFinished = useBackgroundTaskStore((state) => state.clearFinished);

  return (
    <Popover>
      <SidebarMenu>
        <SidebarMenuItem>
          <PopoverTrigger
            render={<SidebarMenuButton aria-label={`Background tasks, ${activeCount} active`} />}
          >
            {activeCount > 0 ? (
              <LoaderCircle aria-hidden className="animate-spin" />
            ) : (
              <Download aria-hidden />
            )}
            <span>Background tasks</span>
            <span
              aria-label={`${activeCount} active`}
              className="ml-auto min-w-5 rounded-full bg-muted px-1 text-center text-[11px] tabular-nums"
            >
              {activeCount}
            </span>
          </PopoverTrigger>
        </SidebarMenuItem>
      </SidebarMenu>
      <PopoverContent align="start" className="w-80 p-0" side="right">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <PopoverTitle className="text-sm">Background tasks</PopoverTitle>
          {tasks.some((task) => !isBackgroundTaskActive(task.status)) ? (
            <Button className="h-7 px-2 text-xs" onClick={clearFinished} variant="ghost">
              Clear finished
            </Button>
          ) : null}
        </div>
        <div className="max-h-80 overflow-y-auto p-2">
          {tasks.length === 0 ? (
            <p className="px-2 py-5 text-center text-xs text-muted-foreground">
              No background tasks yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {[...tasks].reverse().map((task) => (
                <li className="rounded-md border bg-background/70 p-2" key={task.id}>
                  <div className="flex items-start gap-2">
                    {task.status === "completed" ? (
                      <CheckCircle2 aria-hidden className="mt-0.5 size-4 text-emerald-600" />
                    ) : task.status === "failed" ? (
                      <CircleX aria-hidden className="mt-0.5 size-4 text-destructive" />
                    ) : isBackgroundTaskActive(task.status) ? (
                      <LoaderCircle aria-hidden className="mt-0.5 size-4 animate-spin" />
                    ) : (
                      <X aria-hidden className="mt-0.5 size-4 text-muted-foreground" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{task.title}</p>
                      <p className="text-[11px] text-muted-foreground">{taskStatusLabel(task)}</p>
                    </div>
                    {canCancelBackgroundTask(task.status) ? (
                      <Button
                        aria-label={`Cancel export of ${task.title}`}
                        className="size-6"
                        onClick={() => cancelTask(task.id)}
                        size="icon"
                        variant="ghost"
                      >
                        <X />
                      </Button>
                    ) : !isBackgroundTaskActive(task.status) ? (
                      <Button
                        aria-label={`Remove ${task.title} task`}
                        className="size-6"
                        onClick={() => removeTask(task.id)}
                        size="icon"
                        variant="ghost"
                      >
                        <X />
                      </Button>
                    ) : null}
                  </div>
                  {isBackgroundTaskActive(task.status) ? (
                    <div
                      aria-label={`${task.progress}% complete`}
                      aria-valuemax={100}
                      aria-valuemin={0}
                      aria-valuenow={task.progress}
                      className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
                      role="progressbar"
                    >
                      <div
                        className="h-full rounded-full bg-primary transition-[width]"
                        style={{ width: `${task.progress}%` }}
                      />
                    </div>
                  ) : null}
                  {task.error ? (
                    <p className="mt-2 text-[11px] text-destructive">{task.error}</p>
                  ) : null}
                  {task.outputPath ? (
                    <button
                      className="mt-2 flex w-full cursor-grab items-center gap-1 rounded bg-muted/70 px-2 py-1 text-left text-[11px] hover:bg-muted"
                      draggable={Boolean(window.desktopBridge)}
                      onClick={() => void window.desktopBridge?.revealFile(task.outputPath!)}
                      onDragStart={(event) => {
                        if (!window.desktopBridge) return;
                        event.preventDefault();
                        void window.desktopBridge.startFileDrag(task.outputPath!);
                      }}
                      title="Show exported JSON in Finder. You can also drag it into another agent."
                      type="button"
                    >
                      <FolderOpen aria-hidden className="size-3 shrink-0" />
                      <span className="select-text break-all">{task.outputPath}</span>
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
});
