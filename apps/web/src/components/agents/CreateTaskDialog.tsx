import type {
  EnvironmentId,
  VmAgent,
  VmAgentTaskNotificationPolicy,
  VmAgentTaskSchedule,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { SparklesIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { useAtomCommand } from "~/state/use-atom-command";
import { vmAgentEnvironment } from "~/state/vmAgents";

type ScheduleKind = "none" | "once" | "interval";

const SCHEDULE_KINDS: ReadonlyArray<{ value: ScheduleKind; label: string }> = [
  { value: "none", label: "No schedule" },
  { value: "once", label: "Run once" },
  { value: "interval", label: "Repeat" },
];

const NOTIFICATION_POLICIES: ReadonlyArray<{
  value: VmAgentTaskNotificationPolicy;
  label: string;
}> = [
  { value: "always", label: "Completion or failure" },
  { value: "failure", label: "Only failure" },
  { value: "never", label: "Never" },
];

/** `datetime-local` wants local wall time; ISO strings carry UTC. */
const toLocalInputValue = (iso: string) => {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

const commandError = (cause: Cause.Cause<unknown>, fallback: string) => {
  const squashed = Cause.squash(cause);
  return squashed instanceof Error && squashed.message.trim().length > 0
    ? squashed.message
    : fallback;
};

/**
 * Creates a scheduled task for an agent.
 *
 * A dialog rather than a form embedded in the panel: the form is eight fields
 * tall, and inline it pushed the actual task list below the fold — on a phone
 * the panel opened onto a wall of empty inputs with the agent's real schedule
 * nowhere in sight. The dialog also puts the flow on the same footing as
 * creating or deleting an agent, which are its neighbours in this UI.
 */
export function CreateTaskDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly agent: VmAgent;
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
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createTask = useAtomCommand(vmAgentEnvironment.createTask, { reportFailure: false });
  const generateTaskPrompt = useAtomCommand(vmAgentEnvironment.generateTaskPrompt, {
    reportFailure: false,
  });

  const reset = () => {
    setRequest("");
    setTitle("");
    setPrompt("");
    setCriteria("");
    setScheduleKind("none");
    setRunAt("");
    setEveryMinutes("1440");
    setNotificationPolicy("always");
    setBusy(false);
    setGenerating(false);
    setError(null);
  };

  const schedule = (): VmAgentTaskSchedule | null => {
    if (scheduleKind === "none") return null;
    if (scheduleKind === "once") {
      if (!runAt) throw new Error("Choose when this task should run.");
      return { kind: "once", runAt: new Date(runAt).toISOString() };
    }
    const parsed = Math.floor(Number(everyMinutes));
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 525_600) {
      throw new Error("The repeat interval must be between one minute and one year.");
    }
    return { kind: "interval", everyMinutes: parsed };
  };

  const generate = async () => {
    if (!request.trim() || generating || busy) return;
    setGenerating(true);
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
        setRunAt(toLocalInputValue(result.value.schedule.runAt));
      } else if (result.value.schedule?.kind === "interval") {
        setScheduleKind("interval");
        setEveryMinutes(String(result.value.schedule.everyMinutes));
      } else {
        setScheduleKind("none");
      }
    } else {
      setError(commandError(result.cause, "Could not generate the task prompt."));
    }
    setGenerating(false);
  };

  const canSubmit = title.trim().length > 0 && prompt.trim().length > 0 && !busy && !generating;

  const submit = async () => {
    if (!canSubmit) return;
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
        setBusy(false);
        return;
      }
      reset();
      props.onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the task.");
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (!next) reset();
        props.onOpenChange(next);
      }}
    >
      <DialogPopup className="w-full max-w-lg min-w-0">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            Durable work {props.agent.name} runs in its own computer and conversation.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="flex flex-col gap-4">
          <section className="flex flex-col gap-2 rounded-xl border bg-muted/20 p-3">
            <div className="flex items-center gap-1.5 text-xs font-medium">
              <SparklesIcon className="size-3.5" /> Describe it, and the fields fill in
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={request}
                placeholder="Every morning, check the dashboard and summarize changes…"
                onChange={(event) => setRequest(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void generate();
                }}
              />
              <Button
                type="button"
                variant="outline"
                className="shrink-0"
                disabled={!request.trim() || generating || busy}
                onClick={() => void generate()}
              >
                {generating ? "Working…" : "Generate"}
              </Button>
            </div>
          </section>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="task-title">
              Title
            </label>
            <Input
              id="task-title"
              value={title}
              maxLength={200}
              placeholder="Morning dashboard check"
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="task-prompt">
              Prompt
            </label>
            <Textarea
              id="task-prompt"
              value={prompt}
              rows={5}
              maxLength={50_000}
              placeholder="The complete prompt this agent will receive"
              onChange={(event) => setPrompt(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="task-criteria">
              Completion criteria
            </label>
            <Textarea
              id="task-criteria"
              value={criteria}
              rows={2}
              placeholder="One per line"
              onChange={(event) => setCriteria(event.target.value)}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground" id="task-schedule-label">
                Schedule
              </label>
              <Select
                value={scheduleKind}
                onValueChange={(value) => setScheduleKind(value as ScheduleKind)}
                items={SCHEDULE_KINDS.map((kind) => ({ value: kind.value, label: kind.label }))}
              >
                <SelectTrigger aria-labelledby="task-schedule-label">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {SCHEDULE_KINDS.map((kind) => (
                    <SelectItem key={kind.value} value={kind.value}>
                      {kind.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>

            {scheduleKind === "once" ? (
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="task-run-at">
                  When
                </label>
                <Input
                  id="task-run-at"
                  type="datetime-local"
                  value={runAt}
                  onChange={(event) => setRunAt(event.target.value)}
                />
              </div>
            ) : scheduleKind === "interval" ? (
              <div className="flex flex-col gap-1.5">
                <label
                  className="text-xs font-medium text-muted-foreground"
                  htmlFor="task-interval"
                >
                  Every (minutes)
                </label>
                <Input
                  id="task-interval"
                  type="number"
                  min={1}
                  max={525_600}
                  value={everyMinutes}
                  onChange={(event) => setEveryMinutes(event.target.value)}
                />
              </div>
            ) : (
              <div className="flex items-end pb-2 text-xs text-muted-foreground max-sm:hidden">
                Save it now and run it manually later.
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground" id="task-notify-label">
              Notify
            </label>
            <Select
              value={notificationPolicy}
              onValueChange={(value) =>
                setNotificationPolicy(value as VmAgentTaskNotificationPolicy)
              }
              items={NOTIFICATION_POLICIES.map((policy) => ({
                value: policy.value,
                label: policy.label,
              }))}
            >
              <SelectTrigger aria-labelledby="task-notify-label">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {NOTIFICATION_POLICIES.map((policy) => (
                  <SelectItem key={policy.value} value={policy.value}>
                    {policy.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </DialogPanel>

        <DialogFooter>
          <Button variant="ghost" type="button" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? "Creating…" : "Create task"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
