import type {
  EnvironmentId,
  VmAgent,
  VmAgentArtifactDefinition,
  VmAgentTask,
  VmAgentTaskNotificationPolicy,
  VmAgentWorkspaceSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { BellIcon, CalendarClockIcon, PlayIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { vmAgentEnvironment } from "~/state/vmAgents";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";

type ScheduleKind = "none" | "once" | "interval";

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
  const [request, setRequest] = useState("");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [criteria, setCriteria] = useState("");
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>("none");
  const [runAt, setRunAt] = useState("");
  const [everyMinutes, setEveryMinutes] = useState("1440");
  const [notificationPolicy, setNotificationPolicy] =
    useState<VmAgentTaskNotificationPolicy>("always");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createTask = useAtomCommand(vmAgentEnvironment.createTask, { reportFailure: false });
  const updateTask = useAtomCommand(vmAgentEnvironment.updateTask, { reportFailure: false });
  const deleteTask = useAtomCommand(vmAgentEnvironment.deleteTask, { reportFailure: false });
  const runTaskNow = useAtomCommand(vmAgentEnvironment.runTaskNow, { reportFailure: false });
  const generateTaskPrompt = useAtomCommand(vmAgentEnvironment.generateTaskPrompt, {
    reportFailure: false,
  });

  const schedule = () => {
    if (scheduleKind === "none") return null;
    if (scheduleKind === "once") {
      if (!runAt) throw new Error("Choose when this task should run.");
      return { kind: "once" as const, runAt: new Date(runAt).toISOString() };
    }
    const parsed = Math.floor(Number(everyMinutes));
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 525_600) {
      throw new Error("The repeat interval must be between one minute and one year.");
    }
    return { kind: "interval" as const, everyMinutes: parsed };
  };

  const generate = async () => {
    if (!request.trim() || busy) return;
    setBusy(true);
    setError(null);
    const result = await generateTaskPrompt({
      environmentId: props.environmentId,
      input: { vmAgentId: props.agent.vmAgentId, request: request.trim() },
    });
    if (result._tag === "Success") {
      setTitle(result.value.title);
      setPrompt(result.value.prompt);
      setCriteria(result.value.completionCriteria.join("\n"));
      setNotificationPolicy(result.value.notificationPolicy);
      if (result.value.schedule?.kind === "once") {
        setScheduleKind("once");
        const date = new Date(result.value.schedule.runAt);
        setRunAt(
          new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16),
        );
      } else if (result.value.schedule?.kind === "interval") {
        setScheduleKind("interval");
        setEveryMinutes(String(result.value.schedule.everyMinutes));
      } else {
        setScheduleKind("none");
      }
    } else {
      setError(commandError(result.cause, "Could not generate the task prompt."));
    }
    setBusy(false);
  };

  const create = async () => {
    if (!title.trim() || !prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createTask({
        environmentId: props.environmentId,
        input: {
          vmAgentId: props.agent.vmAgentId,
          title: title.trim(),
          prompt: prompt.trim(),
          completionCriteria: criteria
            .split("\n")
            .map((value) => value.trim())
            .filter(Boolean),
          status: "active",
          schedule: schedule(),
          notificationPolicy,
        },
      });
      if (result._tag === "Failure") {
        setError(commandError(result.cause, "Could not create the task."));
      } else {
        setRequest("");
        setTitle("");
        setPrompt("");
        setCriteria("");
        setScheduleKind("none");
        setNotificationPolicy("always");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the task.");
    }
    setBusy(false);
  };

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
      title="Tasks"
      description="Durable work runs in this agent's own computer and conversation."
    >
      <section className="rounded-xl border bg-muted/20 p-3">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium">
          <SparklesIcon className="size-3.5" /> Build with AI
        </div>
        <div className="flex flex-col gap-2 min-[420px]:flex-row">
          <Input
            value={request}
            placeholder="Every morning, check the dashboard and summarize changes…"
            onChange={(event) => setRequest(event.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            disabled={!request.trim() || busy}
            onClick={() => void generate()}
          >
            {busy ? "Working…" : "Generate"}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2 rounded-xl border p-3">
        <Input
          value={title}
          maxLength={200}
          placeholder="Task title"
          onChange={(event) => setTitle(event.target.value)}
        />
        <Textarea
          value={prompt}
          rows={5}
          maxLength={50_000}
          placeholder="The complete prompt this agent will receive"
          onChange={(event) => setPrompt(event.target.value)}
        />
        <Textarea
          value={criteria}
          rows={2}
          placeholder="Completion criteria, one per line"
          onChange={(event) => setCriteria(event.target.value)}
        />
        <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <select
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={scheduleKind}
            onChange={(event) => setScheduleKind(event.target.value as ScheduleKind)}
          >
            <option value="none">No schedule</option>
            <option value="once">Run once</option>
            <option value="interval">Repeat</option>
          </select>
          {scheduleKind === "once" ? (
            <Input
              type="datetime-local"
              value={runAt}
              onChange={(event) => setRunAt(event.target.value)}
            />
          ) : scheduleKind === "interval" ? (
            <Input
              type="number"
              min={1}
              max={525_600}
              value={everyMinutes}
              aria-label="Repeat interval in minutes"
              onChange={(event) => setEveryMinutes(event.target.value)}
            />
          ) : (
            <div className="flex items-center px-2 text-xs text-muted-foreground">
              Save it now and run manually later.
            </div>
          )}
        </div>
        <select
          className="h-9 rounded-md border bg-background px-3 text-sm"
          value={notificationPolicy}
          aria-label="Task notification policy"
          onChange={(event) =>
            setNotificationPolicy(event.target.value as VmAgentTaskNotificationPolicy)
          }
        >
          <option value="always">Notify on completion or failure</option>
          <option value="failure">Notify only on failure</option>
          <option value="never">Do not notify</option>
        </select>
        <Button
          type="button"
          disabled={!title.trim() || !prompt.trim() || busy}
          onClick={() => void create()}
        >
          Create task
        </Button>
      </section>

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
          <Empty text="No tasks yet. Describe one above or ask the agent to create it." />
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
  return (
    <WorkspacePanel
      title={artifact?.title ?? "Artifact"}
      description="A live, structured surface this agent owns and updates."
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
    case "schedule":
      return null;
  }
}

export function AgentNotificationsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: VmAgent;
  readonly workspace: VmAgentWorkspaceSnapshot | null;
}) {
  const markRead = useAtomCommand(vmAgentEnvironment.markNotificationRead, {
    reportFailure: false,
  });
  const updatePreferences = useAtomCommand(vmAgentEnvironment.updateNotificationPreferences, {
    reportFailure: false,
  });
  const preferences = props.workspace?.notificationPreferences;
  const [systemPermission, setSystemPermission] = useState<NotificationPermission | "unsupported">(
    () => (typeof Notification === "undefined" ? "unsupported" : Notification.permission),
  );
  const requestSystemPermission = async () => {
    if (typeof Notification === "undefined") return "unsupported" as const;
    const permission = await Notification.requestPermission();
    setSystemPermission(permission);
    return permission;
  };
  const setPreference = async (patch: Partial<NonNullable<typeof preferences>>) => {
    if (!preferences) return;
    if (
      patch.enabled === true &&
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      await requestSystemPermission();
    }
    await updatePreferences({
      environmentId: props.environmentId,
      input: {
        vmAgentId: props.agent.vmAgentId,
        enabled: patch.enabled ?? preferences.enabled,
        taskCompletions: patch.taskCompletions ?? preferences.taskCompletions,
        taskFailures: patch.taskFailures ?? preferences.taskFailures,
        agentMessages: patch.agentMessages ?? preferences.agentMessages,
      },
    });
  };
  return (
    <WorkspacePanel
      title="Notifications"
      description="A durable inbox plus desktop notifications while Solla Code is running."
    >
      {preferences ? (
        <section className="flex flex-col gap-3 rounded-xl border p-3">
          <Preference
            label="Notifications"
            checked={preferences.enabled}
            onChange={(checked) => void setPreference({ enabled: checked })}
          />
          <Preference
            label="Task completions"
            checked={preferences.taskCompletions}
            onChange={(checked) => void setPreference({ taskCompletions: checked })}
          />
          <Preference
            label="Task failures"
            checked={preferences.taskFailures}
            onChange={(checked) => void setPreference({ taskFailures: checked })}
          />
          <Preference
            label="Agent messages"
            checked={preferences.agentMessages}
            onChange={(checked) => void setPreference({ agentMessages: checked })}
          />
        </section>
      ) : null}
      {systemPermission === "default" ? (
        <Button type="button" variant="outline" onClick={() => void requestSystemPermission()}>
          Enable desktop alerts
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          {systemPermission === "granted"
            ? "Desktop alerts are enabled."
            : systemPermission === "denied"
              ? "Desktop alerts are blocked by browser or system settings; the Inbox still works."
              : "Desktop alerts are unavailable in this client; the Inbox still works."}
        </p>
      )}
      <div className="flex flex-col gap-2">
        {(props.workspace?.notifications ?? []).map((notification) => (
          <button
            key={notification.notificationId}
            type="button"
            className="rounded-xl border p-3 text-left hover:bg-muted/40"
            onClick={() =>
              void markRead({
                environmentId: props.environmentId,
                input: {
                  vmAgentId: props.agent.vmAgentId,
                  notificationId: notification.notificationId,
                },
              })
            }
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">{notification.title}</p>
              {notification.readAt ? null : <span className="size-2 rounded-full bg-primary" />}
            </div>
            <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
              {notification.body}
            </p>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {formatTime(notification.createdAt)}
            </p>
          </button>
        ))}
        {props.workspace?.notifications.length === 0 ? (
          <Empty text="No notifications yet." icon={<BellIcon className="size-5" />} />
        ) : null}
      </div>
    </WorkspacePanel>
  );
}

function Preference(props: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>{props.label}</span>
      <Switch
        checked={props.checked}
        onCheckedChange={(checked) => props.onChange(Boolean(checked))}
      />
    </label>
  );
}

export function useAgentSystemNotifications(
  agent: VmAgent | null,
  workspace: VmAgentWorkspaceSnapshot | null,
) {
  const known = useRef(new Set<string>());
  const initialized = useRef(false);
  const activeAgentId = useRef<string | null>(null);
  useEffect(() => {
    if (!workspace || !agent) return;
    if (activeAgentId.current !== agent.vmAgentId) {
      activeAgentId.current = agent.vmAgentId;
      known.current.clear();
      initialized.current = false;
    }
    if (!initialized.current) {
      for (const item of workspace.notifications) known.current.add(item.notificationId);
      initialized.current = true;
      return;
    }
    for (const item of workspace.notifications) {
      if (known.current.has(item.notificationId)) continue;
      known.current.add(item.notificationId);
      if (
        item.readAt ||
        !workspace.notificationPreferences.enabled ||
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
      ) {
        continue;
      }
      const notification = new Notification(`${agent.name}: ${item.title}`, {
        body: item.body,
        tag: item.notificationId,
      });
      notification.addEventListener("click", () => {
        window.focus();
        window.location.assign(item.deepLink);
        notification.close();
      });
    }
  }, [agent, workspace]);
}

function WorkspacePanel(props: {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="h-full min-w-0 overflow-x-hidden overflow-y-auto">
      <div className="mx-auto flex min-w-0 max-w-3xl flex-col gap-4 p-3 sm:p-4">
        <div>
          <h2 className="text-base font-semibold">{props.title}</h2>
          <p className="text-xs text-muted-foreground">{props.description}</p>
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
