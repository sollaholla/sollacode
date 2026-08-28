import type {
  EnvironmentId,
  VmAgent,
  VmAgentArtifactDefinition,
  VmAgentTask,
  VmAgentWorkspaceSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { CalendarClockIcon, CheckIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { vmAgentEnvironment } from "~/state/vmAgents";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";

import { CreateTaskDialog } from "./CreateTaskDialog";
import { buildWorkspaceHtmlDocument } from "./workspaceHtmlArtifact";

const commandError = (cause: Cause.Cause<unknown>, fallback: string) => {
  const squashed = Cause.squash(cause);
  return squashed instanceof Error && squashed.message.trim().length > 0
    ? squashed.message
    : fallback;
};

const formatTime = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "Not scheduled";

const keyedByContent = <T,>(values: ReadonlyArray<T>) => {
  const occurrences = new Map<string, number>();
  return values.map((value) => {
    const content = JSON.stringify(value);
    const occurrence = occurrences.get(content) ?? 0;
    occurrences.set(content, occurrence + 1);
    return { key: `${content}:${occurrence}`, value };
  });
};

export function AgentTasksPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: VmAgent;
  readonly workspace: VmAgentWorkspaceSnapshot | null;
}) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updateTask = useAtomCommand(vmAgentEnvironment.updateTask, { reportFailure: false });
  const deleteTask = useAtomCommand(vmAgentEnvironment.deleteTask, { reportFailure: false });
  const runTaskNow = useAtomCommand(vmAgentEnvironment.runTaskNow, { reportFailure: false });

  const mutate = async (
    operation: "approve" | "pause" | "resume" | "run" | "delete",
    task: VmAgentTask,
  ) => {
    setError(null);
    const commandInput = {
      environmentId: props.environmentId,
      input: { vmAgentId: task.vmAgentId, taskId: task.taskId },
    };
    const result =
      operation === "run"
        ? await runTaskNow(commandInput)
        : operation === "delete"
          ? await deleteTask(commandInput)
          : await updateTask({
              ...commandInput,
              input: {
                ...commandInput.input,
                ...(operation === "approve"
                  ? { approvalState: "approved" as const, status: "active" as const }
                  : { status: operation === "pause" ? ("paused" as const) : ("active" as const) }),
              },
            });
    if (result._tag === "Failure") {
      setError(commandError(result.cause, `Could not ${operation} the task.`));
    }
  };

  return (
    <WorkspacePanel
      title="Scheduled work"
      description="Manage recurring and one-off work that runs in this agent's conversation."
      action={
        <Button type="button" size="sm" onClick={() => setCreating(true)}>
          <PlusIcon /> New task
        </Button>
      }
    >
      <CreateTaskDialog
        open={creating}
        onOpenChange={setCreating}
        environmentId={props.environmentId}
        agent={props.agent}
      />

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <div className="flex flex-col gap-2">
        {(props.workspace?.tasks ?? []).map((task) => {
          const latestRun = props.workspace?.runs.find((run) => run.taskId === task.taskId);
          return (
            <article key={task.taskId} className="rounded-xl border p-3">
              <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <h3 className="truncate text-sm font-medium">{task.title}</h3>
                    <Badge variant={task.status === "active" ? "success" : "secondary"}>
                      {task.status}
                    </Badge>
                    {task.approvalState === "pending" ? (
                      <Badge variant="warning">approval needed</Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{task.prompt}</p>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    {task.schedule?.kind === "interval"
                      ? `Every ${task.schedule.everyMinutes} minutes · next ${formatTime(task.nextRunAt)}`
                      : task.schedule?.kind === "once"
                        ? `Once · ${formatTime(task.schedule.runAt)}`
                        : "Manual"}
                    {latestRun ? ` · latest run ${latestRun.status}` : ""}
                  </p>
                </div>
                <div className="flex w-full shrink-0 flex-wrap justify-end gap-1 sm:w-auto">
                  {task.approvalState === "pending" ? (
                    <Button size="sm" type="button" onClick={() => void mutate("approve", task)}>
                      Approve
                    </Button>
                  ) : (
                    <>
                      <Button
                        size="icon-sm"
                        variant="outline"
                        title="Run now"
                        type="button"
                        onClick={() => void mutate("run", task)}
                      >
                        <PlayIcon />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        type="button"
                        onClick={() =>
                          void mutate(task.status === "paused" ? "resume" : "pause", task)
                        }
                      >
                        {task.status === "paused" ? "Resume" : "Pause"}
                      </Button>
                    </>
                  )}
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    title="Delete task"
                    type="button"
                    onClick={() => void mutate("delete", task)}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              </div>
            </article>
          );
        })}
        {props.workspace?.tasks.length === 0 ? (
          <Empty text="No tasks yet. Create one, or ask the agent to schedule its own." />
        ) : null}
      </div>
    </WorkspacePanel>
  );
}

export function AgentArtifactPanel(props: { readonly workspace: VmAgentWorkspaceSnapshot | null }) {
  const artifact = props.workspace?.artifact;
  const latestRunStatusByTask = new Map<string, string>();
  for (const run of props.workspace?.runs ?? []) {
    if (!latestRunStatusByTask.has(run.taskId)) {
      latestRunStatusByTask.set(run.taskId, run.status);
    }
  }
  const isHtmlDashboard = artifact?.definition.kind === "html";
  return (
    <WorkspacePanel
      title={artifact?.title ?? "Dashboard"}
      description={
        isHtmlDashboard
          ? "A live web view this agent owns and updates."
          : "A live structured view this agent owns and updates."
      }
      fill={isHtmlDashboard}
    >
      {!artifact ? (
        <Empty text="This agent has not created an artifact yet." />
      ) : artifact.definition.kind === "schedule" ? (
        <div className="flex flex-col gap-2">
          {(props.workspace?.tasks ?? []).map((task) => {
            const latestRunStatus = latestRunStatusByTask.get(task.taskId);
            return (
              <div
                key={task.taskId}
                className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-xl border p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
              >
                <CalendarClockIcon className="size-4 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{task.title}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {task.schedule?.kind === "interval"
                      ? `Every ${task.schedule.everyMinutes} minutes`
                      : formatTime(task.nextRunAt)}
                    {latestRunStatus ? ` · latest ${latestRunStatus}` : ""}
                  </p>
                </div>
                <Badge
                  className="col-start-2 justify-self-start sm:col-start-auto sm:justify-self-auto"
                  variant={task.status === "active" ? "success" : "secondary"}
                >
                  {task.status}
                </Badge>
              </div>
            );
          })}
          {props.workspace?.tasks.length === 0 ? (
            <Empty text="The schedule will update automatically when tasks are added." />
          ) : null}
        </div>
      ) : (
        <ArtifactDefinition definition={artifact.definition} />
      )}
      {artifact ? (
        <p className="text-[11px] text-muted-foreground">
          Revision {artifact.revision} · updated {formatTime(artifact.updatedAt)}
        </p>
      ) : null}
    </WorkspacePanel>
  );
}

function ArtifactDefinition({ definition }: { readonly definition: VmAgentArtifactDefinition }) {
  switch (definition.kind) {
    case "metrics":
      return (
        <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
          {keyedByContent(definition.metrics).map(({ key, value: metric }) => (
            <div key={key} className="rounded-xl border p-3">
              <p className="text-xs text-muted-foreground">{metric.label}</p>
              <p className="mt-1 text-xl font-semibold">{metric.value}</p>
            </div>
          ))}
        </div>
      );
    case "checklist":
      return (
        <div className="flex flex-col gap-2">
          {keyedByContent(definition.items).map(({ key, value: item }) => (
            <div key={key} className="flex items-center gap-2 rounded-xl border p-3 text-sm">
              <span className={item.checked ? "text-success" : "text-muted-foreground"}>
                {item.checked ? "✓" : "○"}
              </span>
              {item.label}
            </div>
          ))}
        </div>
      );
    case "table":
      return (
        <div className="max-w-full overflow-x-auto overflow-y-hidden rounded-xl border">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/50">
              <tr>
                {keyedByContent(definition.columns).map(({ key, value: column }) => (
                  <th key={key} className="px-3 py-2 font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {keyedByContent(definition.rows).map(({ key, value: row }) => (
                <tr key={key} className="border-t">
                  {keyedByContent(row).map(({ key: cellKey, value: cell }) => (
                    <td key={cellKey} className="px-3 py-2">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "timeline":
      return (
        <div className="flex flex-col gap-2">
          {keyedByContent(definition.items).map(({ key, value: item }) => (
            <div key={key} className="border-l-2 pl-3">
              <p className="text-sm font-medium">{item.title}</p>
              {item.at ? (
                <p className="text-[11px] text-muted-foreground">{formatTime(item.at)}</p>
              ) : null}
              {item.detail ? <p className="text-xs text-muted-foreground">{item.detail}</p> : null}
            </div>
          ))}
        </div>
      );
    case "cards":
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          {keyedByContent(definition.cards).map(({ key, value: card }) => (
            <div key={key} className="rounded-xl border p-3">
              <p className="text-sm font-medium">{card.title}</p>
              <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{card.body}</p>
            </div>
          ))}
        </div>
      );
    case "html":
      return <WorkspaceHtmlPreview html={definition.html} css={definition.css} />;
    case "schedule":
      return null;
  }
}

function WorkspaceHtmlPreview(props: { readonly html: string; readonly css?: string | undefined }) {
  const documentHtml = buildWorkspaceHtmlDocument(props);
  return (
    <iframe
      title="Agent dashboard"
      srcDoc={documentHtml}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="min-h-[28rem] min-w-0 w-full flex-1 rounded-xl border-0 bg-background"
    />
  );
}

export function WorkspacePanel(props: {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
  /** Fill the pane instead of the narrow structured-view column (HTML dashboards). */
  readonly fill?: boolean;
}) {
  return (
    <div
      className={
        props.fill
          ? "flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
          : "flex h-full min-h-0 min-w-0 flex-col overflow-x-hidden overflow-y-auto"
      }
    >
      <div
        className={
          props.fill
            ? "flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-3 sm:p-4"
            : "mx-auto flex min-w-0 max-w-3xl flex-col gap-4 p-3 sm:p-4"
        }
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{props.title}</h2>
            <p className="text-xs text-muted-foreground">{props.description}</p>
          </div>
          {props.action ? <div className="shrink-0">{props.action}</div> : null}
        </div>
        {props.children}
      </div>
    </div>
  );
}

function Empty(props: { readonly text: string; readonly icon?: ReactNode }) {
  return (
    <div className="flex min-h-28 flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-center text-xs text-muted-foreground">
      {props.icon}
      {props.text}
    </div>
  );
}
