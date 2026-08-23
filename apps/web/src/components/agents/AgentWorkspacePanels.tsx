import type {
  EnvironmentId,
  ScopedThreadRef,
  VmAgent,
  VmAgentArtifactDefinition,
  VmAgentBlocker,
  VmAgentNotification,
  VmAgentTask,
  VmAgentWorkspaceSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BellIcon,
  CalendarClockIcon,
  ChevronLeftIcon,
  ExternalLinkIcon,
  HandIcon,
  InboxIcon,
  MailIcon,
  MailOpenIcon,
  PlayIcon,
  PlusIcon,
  Settings2Icon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { previewEnvironment } from "~/state/preview";
import { vmAgentEnvironment } from "~/state/vmAgents";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { openUrlInThreadPreview } from "~/components/preview/openUrlInThreadPreview";
import ChatMarkdown from "~/components/ChatMarkdown";
import { cn } from "~/lib/utils";

import { CreateTaskDialog } from "./CreateTaskDialog";
import {
  agentNotificationPreview,
  type AgentInboxFolder,
  notificationsInFolder,
} from "./agentInbox";

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

/** Open blockers, newest first — the "waiting on you" work list. */
export function openAgentBlockers(
  workspace: VmAgentWorkspaceSnapshot | null,
): ReadonlyArray<VmAgentBlocker> {
  return (workspace?.blockers ?? []).filter((blocker) => blocker.resolvedAt === null);
}

/**
 * Standing requests the agent raised because its work is blocked on the user
 * — a login, a CAPTCHA, a permission. Pinned above the agent's chat (not a
 * message in it) so the request survives every turn until someone resolves
 * it, the same way plans and questions stay put until answered.
 */
export function AgentBlockerBanner(props: {
  readonly environmentId: EnvironmentId;
  readonly workspace: VmAgentWorkspaceSnapshot | null;
  /** The agent's chat thread — where its collaborative browser tabs live. */
  readonly threadRef?: ScopedThreadRef | null;
  /** Reveal the pane hosting the preview browser (the chat view) first. */
  readonly onRevealChat?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ blockerId: string; action: "resolve" | "dismiss" } | null>(
    null,
  );
  const resolveBlocker = useAtomCommand(vmAgentEnvironment.resolveBlocker, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const { threadRef, onRevealChat } = props;
  const blockers = openAgentBlockers(props.workspace);
  if (blockers.length === 0) return null;

  // Show the blocker's page in the agent's own preview browser: focus the tab
  // the agent already staged at that exact URL, or open a new one there. Only
  // when this surface has no preview (no thread, non-desktop runtime, odd URL)
  // does the link leave the app for the system browser.
  const openBlockerUrl = (url: string) => {
    const openExternally = () => window.open(url, "_blank", "noopener,noreferrer");
    if (!threadRef) {
      openExternally();
      return;
    }
    onRevealChat?.();
    void openUrlInThreadPreview({ threadRef, url, openPreview, openExternally });
  };

  const resolve = async (blocker: VmAgentBlocker, action: "resolve" | "dismiss") => {
    setError(null);
    setBusy({ blockerId: blocker.blockerId, action });
    const result = await resolveBlocker({
      environmentId: props.environmentId,
      input: {
        vmAgentId: blocker.vmAgentId,
        blockerId: blocker.blockerId,
        ...(action === "dismiss" ? { dismissed: true } : {}),
      },
    });
    setBusy(null);
    if (result._tag === "Failure") {
      setError(
        commandError(
          result.cause,
          action === "dismiss"
            ? "The request could not be dismissed."
            : "The blocker could not be resolved.",
        ),
      );
    }
  };

  return (
    <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
        <HandIcon className="size-3.5 shrink-0" />
        Waiting on you
      </div>
      <div className="mt-1.5 flex min-w-0 flex-col gap-1.5">
        {blockers.map((blocker) => (
          <BlockerItem
            key={blocker.blockerId}
            blocker={blocker}
            busyAction={busy?.blockerId === blocker.blockerId ? busy.action : null}
            onOpenUrl={openBlockerUrl}
            onResolve={() => void resolve(blocker, "resolve")}
            onDismiss={() => void resolve(blocker, "dismiss")}
          />
        ))}
      </div>
      {error ? <p className="mt-1.5 break-words text-[11px] text-destructive">{error}</p> : null}
    </div>
  );
}

function BlockerItem(props: {
  readonly blocker: VmAgentBlocker;
  readonly busyAction: "resolve" | "dismiss" | null;
  readonly onOpenUrl: (url: string) => void;
  readonly onResolve: () => void;
  readonly onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // Whether the collapsed three-line clamp actually cuts anything off depends
  // on the panel's current width, so measure the rendered element instead of
  // guessing from character count.
  const [clamped, setClamped] = useState(false);
  const detailRef = useRef<HTMLParagraphElement | null>(null);
  const { blocker, busyAction } = props;

  useEffect(() => {
    const element = detailRef.current;
    if (!element || expanded) return;
    const measure = () => setClamped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, blocker.detail]);

  const blockerUrl = blocker.url;
  return (
    <div className="flex min-w-0 items-start gap-2">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{blocker.title}</p>
        <p
          ref={detailRef}
          className={
            expanded
              ? "whitespace-pre-line break-words text-[11px] text-muted-foreground"
              : "line-clamp-3 whitespace-pre-line break-words text-[11px] text-muted-foreground"
          }
        >
          {blocker.detail}
        </p>
        {expanded || clamped ? (
          <button
            type="button"
            className="text-[11px] font-medium text-amber-600 hover:underline dark:text-amber-400"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        ) : null}
      </div>
      {blockerUrl ? (
        <Button size="xs" variant="outline" onClick={() => props.onOpenUrl(blockerUrl)}>
          <ExternalLinkIcon /> Open
        </Button>
      ) : null}
      <Button size="xs" variant="outline" disabled={busyAction !== null} onClick={props.onResolve}>
        {busyAction === "resolve" ? "Resolving…" : "Mark resolved"}
      </Button>
      <Button
        size="xs"
        variant="ghost"
        aria-label="Dismiss"
        title="Dismiss without marking it done"
        disabled={busyAction !== null}
        onClick={props.onDismiss}
      >
        <XIcon />
      </Button>
    </div>
  );
}

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
      title="Tasks"
      description="Durable work runs in this agent's own conversation and browser."
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
  const updateNotification = useAtomCommand(vmAgentEnvironment.updateNotification, {
    reportFailure: false,
  });
  const updatePreferences = useAtomCommand(vmAgentEnvironment.updateNotificationPreferences, {
    reportFailure: false,
  });
  const preferences = props.workspace?.notificationPreferences;
  const notifications = props.workspace?.notifications ?? [];
  const [folder, setFolder] = useState<AgentInboxFolder>("inbox");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visible = useMemo(
    () => notificationsInFolder(notifications, folder),
    [folder, notifications],
  );
  const selected =
    visible.find((notification) => notification.notificationId === selectedId) ?? null;
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

  const mutateNotification = async (
    notification: VmAgentNotification,
    patch: { readonly read?: boolean; readonly archived?: boolean },
  ) => {
    setBusyId(notification.notificationId);
    setError(null);
    const result = await updateNotification({
      environmentId: props.environmentId,
      input: {
        vmAgentId: props.agent.vmAgentId,
        notificationId: notification.notificationId,
        ...patch,
      },
    });
    setBusyId(null);
    if (result._tag === "Failure") {
      setError(commandError(result.cause, "The inbox item could not be updated."));
      return;
    }
    if (patch.archived !== undefined) {
      setSelectedId(null);
      setMobileDetailOpen(false);
    }
  };

  const openNotification = (notification: VmAgentNotification) => {
    setSelectedId(notification.notificationId);
    setMobileDetailOpen(true);
    if (notification.readAt === null) {
      void mutateNotification(notification, { read: true });
    }
  };

  const chooseFolder = (next: AgentInboxFolder) => {
    setFolder(next);
    setSelectedId(null);
    setMobileDetailOpen(false);
  };

  const inboxCount = notifications.filter(
    (notification) => notification.archivedAt === null,
  ).length;
  const archiveCount = notifications.length - inboxCount;
  return (
    <WorkspacePanel
      title="Inbox"
      description="A durable inbox plus desktop notifications while Solla Code is running."
      wide
      action={
        <Button
          type="button"
          size="sm"
          variant={preferencesOpen ? "secondary" : "outline"}
          aria-expanded={preferencesOpen}
          onClick={() => setPreferencesOpen((open) => !open)}
        >
          <Settings2Icon /> Preferences
        </Button>
      }
    >
      {preferencesOpen ? (
        <section className="grid gap-3 rounded-xl border p-3 sm:grid-cols-2">
          {preferences ? (
            <>
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
            </>
          ) : null}
          <div className="sm:col-span-2">
            {systemPermission === "default" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void requestSystemPermission()}
              >
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
          </div>
        </section>
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <div className="grid h-[min(42rem,calc(100vh-12rem))] min-h-[28rem] min-w-0 overflow-hidden rounded-xl border md:grid-cols-[minmax(15rem,22rem)_minmax(0,1fr)]">
        <section
          className={cn(
            "min-h-0 min-w-0 flex-col bg-muted/15 md:flex md:border-r",
            mobileDetailOpen ? "hidden" : "flex",
          )}
        >
          <div className="flex shrink-0 items-center gap-1 border-b p-2">
            <InboxFolderButton
              active={folder === "inbox"}
              label="Inbox"
              count={inboxCount}
              icon={<InboxIcon />}
              onClick={() => chooseFolder("inbox")}
            />
            <InboxFolderButton
              active={folder === "archive"}
              label="Archive"
              count={archiveCount}
              icon={<ArchiveIcon />}
              onClick={() => chooseFolder("archive")}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {visible.map((notification) => (
              <button
                key={notification.notificationId}
                type="button"
                className={cn(
                  "flex w-full min-w-0 flex-col gap-1 border-b px-3 py-3 text-left transition-colors hover:bg-muted/50",
                  selected?.notificationId === notification.notificationId &&
                    "bg-muted/60 md:bg-muted/40",
                  notification.readAt === null && "bg-primary/[0.04]",
                )}
                onClick={() => openNotification(notification)}
              >
                <span className="flex w-full min-w-0 items-center gap-2">
                  {notification.readAt === null ? (
                    <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />
                  ) : null}
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-sm",
                      notification.readAt === null ? "font-semibold" : "font-medium",
                    )}
                  >
                    {notification.title}
                  </span>
                </span>
                <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                  {agentNotificationPreview(notification.body)}
                </span>
                <span className="text-[11px] text-muted-foreground/80">
                  {formatTime(notification.createdAt)}
                </span>
              </button>
            ))}
            {visible.length === 0 ? (
              <div className="p-3">
                <Empty
                  text={folder === "archive" ? "No archived messages." : "Your inbox is clear."}
                  icon={
                    folder === "archive" ? (
                      <ArchiveIcon className="size-5" />
                    ) : (
                      <BellIcon className="size-5" />
                    )
                  }
                />
              </div>
            ) : null}
          </div>
        </section>

        <section
          className={cn(
            "min-h-0 min-w-0 flex-col bg-background md:flex",
            mobileDetailOpen ? "flex" : "hidden",
          )}
        >
          {selected ? (
            <>
              <header className="shrink-0 border-b px-3 py-3 sm:px-4">
                <div className="flex min-w-0 items-start gap-2">
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="md:hidden"
                    aria-label="Back to messages"
                    onClick={() => setMobileDetailOpen(false)}
                  >
                    <ChevronLeftIcon />
                  </Button>
                  <div className="min-w-0 flex-1">
                    <h3 className="break-words text-base font-semibold">{selected.title}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatTime(selected.createdAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="outline"
                      disabled={busyId === selected.notificationId}
                      aria-label={selected.readAt === null ? "Mark as read" : "Mark as unread"}
                      title={selected.readAt === null ? "Mark as read" : "Mark as unread"}
                      onClick={() =>
                        void mutateNotification(selected, { read: selected.readAt === null })
                      }
                    >
                      {selected.readAt === null ? <MailOpenIcon /> : <MailIcon />}
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="outline"
                      disabled={busyId === selected.notificationId}
                      aria-label={folder === "archive" ? "Restore to inbox" : "Archive message"}
                      title={folder === "archive" ? "Restore to inbox" : "Archive message"}
                      onClick={() =>
                        void mutateNotification(selected, {
                          archived: folder !== "archive",
                          ...(folder === "archive" ? {} : { read: true }),
                        })
                      }
                    >
                      {folder === "archive" ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                    </Button>
                  </div>
                </div>
              </header>
              <article className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
                <div className="mx-auto min-w-0 max-w-3xl rounded-xl border bg-card p-4 shadow-sm sm:p-5">
                  <ChatMarkdown
                    text={selected.body}
                    cwd={undefined}
                    threadRef={
                      props.agent.threadId
                        ? { environmentId: props.environmentId, threadId: props.agent.threadId }
                        : undefined
                    }
                    lineBreaks
                  />
                </div>
              </article>
            </>
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
              Select a message to read it.
            </div>
          )}
        </section>
      </div>
    </WorkspacePanel>
  );
}

function InboxFolderButton(props: {
  readonly active: boolean;
  readonly label: string;
  readonly count: number;
  readonly icon: ReactNode;
  readonly onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={props.active ? "secondary" : "ghost"}
      className="min-w-0 flex-1 justify-start"
      aria-pressed={props.active}
      onClick={props.onClick}
    >
      {props.icon}
      <span className="truncate">{props.label}</span>
      <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{props.count}</span>
    </Button>
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
  readonly action?: ReactNode;
  readonly wide?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="h-full min-w-0 overflow-x-hidden overflow-y-auto">
      <div
        className={cn(
          "mx-auto flex min-w-0 flex-col gap-4 p-3 sm:p-4",
          props.wide ? "max-w-6xl" : "max-w-3xl",
        )}
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
