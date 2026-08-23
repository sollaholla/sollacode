import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  VmAgent,
  VmAgentCollaborationAvailability,
  VmAgentCollaborationSnapshot,
  VmAgentDelegation,
  VmAgentDelegationMessage,
  VmAgentDelegationStatus,
  VmAgentDelegationSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  InfoIcon,
  MessageSquareIcon,
  SendIcon,
  SparklesIcon,
  StopCircleIcon,
  UsersIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { cn } from "~/lib/utils";
import { vmAgentEnvironment } from "~/state/vmAgents";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

const EPHEMERAL_TARGET = "__ephemeral__";
const TERMINAL_DELEGATION_STATUSES = new Set<VmAgentDelegationStatus>([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

const DELEGATION_STATUS_DISPLAY: Record<
  VmAgentDelegationStatus,
  {
    readonly label: string;
    readonly variant: "secondary" | "success" | "warning" | "error" | "info";
  }
> = {
  "pending-approval": { label: "Needs approval", variant: "warning" },
  queued: { label: "Queued", variant: "secondary" },
  running: { label: "In progress", variant: "info" },
  "waiting-input": { label: "Needs your reply", variant: "warning" },
  completed: { label: "Done", variant: "success" },
  failed: { label: "Failed", variant: "error" },
  cancelled: { label: "Cancelled", variant: "secondary" },
  expired: { label: "Timed out", variant: "error" },
};

const AVAILABILITY_DISPLAY: Record<
  VmAgentCollaborationAvailability,
  { readonly label: string; readonly dot: string }
> = {
  available: { label: "Available", dot: "bg-success" },
  busy: { label: "Busy", dot: "bg-warning" },
  offline: { label: "Offline", dot: "bg-muted-foreground/40" },
  failed: { label: "Unavailable", dot: "bg-destructive" },
  "user-control": { label: "In use", dot: "bg-muted-foreground/40" },
};

const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  "browser.preview": "Browser",
  "workspace.consult": "Consult",
  "workspace.tasks": "Tasks",
};

/** Up to three friendly chips for known capability ids; unknown ids stay hidden. */
export function capabilityChips(capabilities: ReadonlyArray<string>): ReadonlyArray<string> {
  const labels: Array<string> = [];
  for (const capability of capabilities) {
    const label = CAPABILITY_LABELS[capability];
    if (label === undefined || labels.includes(label)) continue;
    labels.push(label);
    if (labels.length >= 3) break;
  }
  return labels;
}

const commandError = (cause: Cause.Cause<unknown>, fallback: string) => {
  const squashed = Cause.squash(cause);
  return squashed instanceof Error && squashed.message.trim().length > 0
    ? squashed.message
    : fallback;
};

export function agentDelegationsFor(
  snapshot: VmAgentCollaborationSnapshot | null,
  vmAgentId: string,
): ReadonlyArray<VmAgentDelegationSummary> {
  return (snapshot?.delegations ?? []).filter(
    ({ delegation }) =>
      delegation.rootVmAgentId === vmAgentId ||
      delegation.sourceVmAgentId === vmAgentId ||
      delegation.targetVmAgentId === vmAgentId,
  );
}

export function delegationRole(delegation: VmAgentDelegation, vmAgentId: string): string {
  if (delegation.rootVmAgentId === vmAgentId) return "Root agent";
  if (delegation.sourceVmAgentId === vmAgentId) return "Source agent";
  if (delegation.targetVmAgentId === vmAgentId) return "Target agent";
  return "Collaborator";
}

function targetLabel(summary: VmAgentDelegationSummary): string {
  if (summary.delegation.target.kind === "ephemeral") {
    return summary.delegation.target.label ?? "One-off helper";
  }
  return (
    summary.targetAgent?.name ??
    summary.delegation.targetAgentSnapshot?.name ??
    `Agent ${summary.delegation.target.vmAgentId}`
  );
}

/** "to Scout" when this agent handed the work off, "from Scout" when it received it. */
function delegationDirection(summary: VmAgentDelegationSummary, vmAgentId: string): string {
  if (summary.delegation.targetVmAgentId === vmAgentId) {
    return `from ${summary.sourceAgent?.name ?? summary.delegation.sourceAgentSnapshot.name}`;
  }
  return `to ${targetLabel(summary)}`;
}

function senderLabel(message: VmAgentDelegationMessage, summary: VmAgentDelegationSummary): string {
  switch (message.sender) {
    case "source-agent":
      return summary.sourceAgent?.name ?? summary.delegation.sourceAgentSnapshot.name;
    case "target-agent":
      return targetLabel(summary);
    case "user":
      return "You";
    case "system":
      return "System";
  }
}

function messageAlignment(sender: VmAgentDelegationMessage["sender"]): string {
  switch (sender) {
    case "user":
      return "self-end bg-primary text-primary-foreground";
    case "source-agent":
      return "self-end bg-sky-500/12 text-foreground ring-1 ring-sky-500/20";
    case "target-agent":
      return "self-start bg-muted";
    case "system":
      return "self-center border bg-background";
  }
}

export function AgentCollaborationPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: VmAgent;
  readonly onOpenChat: () => void;
}) {
  const [selectedDelegationId, setSelectedDelegationId] = useState<string | null>(null);
  const [selectedTargetId, setSelectedTargetId] = useState<string>(EPHEMERAL_TARGET);
  const [taskDraft, setTaskDraft] = useState("");
  const [messageDraft, setMessageDraft] = useState("");
  const [commandPending, setCommandPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setComposerPrompt = useComposerDraftStore((state) => state.setPrompt);
  const collaborationAtom = useMemo(
    () => vmAgentEnvironment.collaboration({ environmentId: props.environmentId, input: {} }),
    [props.environmentId],
  );
  const collaborationResult = useAtomValue(collaborationAtom);
  const latest = Option.getOrNull(AsyncResult.value(collaborationResult));
  const snapshot = latest?.type === "snapshot" ? latest : null;
  const delegations = agentDelegationsFor(snapshot, props.agent.vmAgentId);
  const collaborators = (snapshot?.agents ?? []).filter(
    (agent) => agent.vmAgentId !== props.agent.vmAgentId,
  );
  const selectedTarget =
    selectedTargetId === EPHEMERAL_TARGET
      ? null
      : (collaborators.find((agent) => agent.vmAgentId === selectedTargetId) ?? null);
  const selectedSummary =
    delegations.find(({ delegation }) => delegation.delegationId === selectedDelegationId) ??
    delegations[0] ??
    null;
  const selectedDelegationKey = selectedSummary?.delegation.delegationId ?? null;
  const detailAtom = useMemo(
    () =>
      selectedDelegationKey
        ? vmAgentEnvironment.delegation({
            environmentId: props.environmentId,
            input: { delegationId: selectedDelegationKey },
          })
        : null,
    [props.environmentId, selectedDelegationKey],
  );
  const detail = useEnvironmentQuery(detailAtom).data;
  const sendMessage = useAtomCommand(vmAgentEnvironment.sendDelegationMessage, {
    reportFailure: false,
  });
  const cancelDelegation = useAtomCommand(vmAgentEnvironment.cancelDelegation, {
    reportFailure: false,
  });

  const draftDelegationRequest = () => {
    if (!props.agent.threadId || !taskDraft.trim()) return;
    const threadRef = scopeThreadRef(props.environmentId, props.agent.threadId);
    const existing = useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt.trim();
    const target = selectedTarget
      ? `to @${selectedTarget.handle}`
      : "to a one-off ephemeral helper";
    const request = `Delegate this task ${target} and collaborate until the work is complete:\n\n${taskDraft.trim()}`;
    setComposerPrompt(threadRef, existing ? `${existing}\n\n${request}` : request);
    setTaskDraft("");
    props.onOpenChat();
  };

  const submitMessage = async () => {
    if (!selectedSummary || !messageDraft.trim() || commandPending) return;
    setCommandPending(true);
    setError(null);
    const result = await sendMessage({
      environmentId: props.environmentId,
      input: {
        delegationId: selectedSummary.delegation.delegationId,
        message: messageDraft.trim(),
        kind: selectedSummary.delegation.status === "waiting-input" ? "answer" : "note",
        waitForReply: false,
      },
    });
    setCommandPending(false);
    if (result._tag === "Success") {
      setMessageDraft("");
      return;
    }
    setError(commandError(result.cause, "Could not send the follow-up."));
  };

  const cancel = async () => {
    if (!selectedSummary || commandPending) return;
    setCommandPending(true);
    setError(null);
    const result = await cancelDelegation({
      environmentId: props.environmentId,
      input: { delegationId: selectedSummary.delegation.delegationId },
    });
    setCommandPending(false);
    if (result._tag === "Failure") {
      setError(commandError(result.cause, "Could not cancel delegated work."));
    }
  };

  const waitingQuestion =
    selectedSummary?.delegation.status === "waiting-input"
      ? ([...(detail?.messages ?? [])]
          .toReversed()
          .find((message) => message.kind === "question") ??
        (selectedSummary.latestMessage?.kind === "question" ? selectedSummary.latestMessage : null))
      : null;

  return (
    <div className="h-full min-w-0 overflow-x-hidden overflow-y-auto">
      <div className="mx-auto flex min-w-0 max-w-4xl flex-col gap-4 p-3 sm:p-4">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">Collaborate</h2>
          <p className="mt-1 break-words text-xs text-muted-foreground">
            Hand a task to another agent. It reports back here.
          </p>
        </div>

        <section className="min-w-0 rounded-xl border p-3">
          <p className="text-xs font-medium text-muted-foreground">To</p>
          <div className="mt-2 grid min-w-0 grid-cols-1 gap-2 min-[560px]:grid-cols-2">
            <button
              type="button"
              aria-pressed={selectedTargetId === EPHEMERAL_TARGET}
              className={cn(
                "min-h-11 min-w-0 rounded-lg border p-3 text-left transition-colors",
                selectedTargetId === EPHEMERAL_TARGET
                  ? "border-primary bg-primary/5"
                  : "hover:bg-muted/40",
              )}
              onClick={() => setSelectedTargetId(EPHEMERAL_TARGET)}
            >
              <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                <SparklesIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">One-off helper</span>
              </span>
              <span className="mt-1 block break-words text-xs text-muted-foreground">
                Created for this task, disappears when it’s done.
              </span>
            </button>
            {collaborators.map((agent) => {
              const availability = AVAILABILITY_DISPLAY[agent.availability];
              const chips = capabilityChips(agent.capabilities);
              return (
                <button
                  key={agent.vmAgentId}
                  type="button"
                  aria-pressed={selectedTarget?.vmAgentId === agent.vmAgentId}
                  className={cn(
                    "min-h-11 min-w-0 rounded-lg border p-3 text-left transition-colors",
                    selectedTarget?.vmAgentId === agent.vmAgentId
                      ? "border-primary bg-primary/5"
                      : "hover:bg-muted/40",
                  )}
                  onClick={() => setSelectedTargetId(agent.vmAgentId)}
                >
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {agent.name}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span aria-hidden className={cn("size-1.5 rounded-full", availability.dot)} />
                      {availability.label}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">
                    {agent.purpose}
                  </p>
                  {chips.length > 0 ? (
                    <span className="mt-2 flex flex-wrap gap-1">
                      {chips.map((chip) => (
                        <Badge key={chip} size="sm" variant="outline">
                          {chip}
                        </Badge>
                      ))}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          {collaborators.length === 0 ? (
            <p className="mt-2 break-words text-[11px] text-muted-foreground">
              Other agents you create will show up here too.
            </p>
          ) : null}

          <p className="mt-4 text-xs font-medium text-muted-foreground">Task</p>
          <Textarea
            rows={3}
            maxLength={50_000}
            value={taskDraft}
            className="mt-2"
            placeholder="Describe the task — what done looks like, and anything they’ll need"
            onChange={(event) => setTaskDraft(event.target.value)}
          />
          <div className="mt-3 flex min-w-0 flex-col gap-2 min-[480px]:flex-row min-[480px]:items-center min-[480px]:justify-between">
            <div className="flex min-w-0 items-center gap-1.5">
              <p className="min-w-0 break-words text-[11px] text-muted-foreground">
                Puts the request in this agent’s chat — it stays in charge and asks you before
                anything consequential.
              </p>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="More about how hand-offs work"
                      className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <InfoIcon className="size-3.5" />
                    </button>
                  }
                />
                <TooltipPopup className="max-w-64">
                  The request lands in the chat composer, so you can edit it before sending. This
                  agent hands the work off, tracks it here, and consequential actions still wait for
                  your approval.
                </TooltipPopup>
              </Tooltip>
            </div>
            <Button
              type="button"
              className="min-h-11 shrink-0"
              disabled={
                !props.agent.threadId ||
                !taskDraft.trim() ||
                (selectedTarget !== null && !selectedTarget.canReceiveDelegation)
              }
              onClick={draftDelegationRequest}
            >
              <MessageSquareIcon /> Add to chat
            </Button>
          </div>
        </section>

        {delegations.length === 0 ? (
          <section className="flex min-h-28 min-w-0 flex-col items-center justify-center gap-1 rounded-xl border border-dashed p-6 text-center">
            <UsersIcon className="size-5 text-muted-foreground" />
            <p className="mt-1 text-sm font-medium">Nothing handed off yet</p>
            <p className="break-words text-xs text-muted-foreground">
              Tasks you hand off show up here with their progress and replies.
            </p>
          </section>
        ) : (
          <section className="grid min-h-64 min-w-0 grid-cols-1 overflow-hidden rounded-xl border min-[680px]:grid-cols-[minmax(12rem,0.8fr)_minmax(0,1.4fr)]">
            <div className="min-w-0 border-b p-2 min-[680px]:border-b-0 min-[680px]:border-r">
              <p className="px-2 py-1 text-xs font-medium text-muted-foreground">Delegated work</p>
              <div className="flex max-h-56 min-w-0 flex-col gap-1 overflow-y-auto min-[680px]:max-h-none">
                {delegations.map((summary) => {
                  const delegation = summary.delegation;
                  const status = DELEGATION_STATUS_DISPLAY[delegation.status];
                  return (
                    <button
                      key={delegation.delegationId}
                      type="button"
                      className={cn(
                        "min-h-11 min-w-0 rounded-lg px-2 py-2 text-left",
                        selectedSummary?.delegation.delegationId === delegation.delegationId
                          ? "bg-accent"
                          : "hover:bg-muted/50",
                      )}
                      onClick={() => setSelectedDelegationId(delegation.delegationId)}
                    >
                      <span className="block truncate text-sm font-medium">{delegation.title}</span>
                      <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Badge variant={status.variant}>{status.label}</Badge>
                        <span className="truncate">
                          {delegationDirection(summary, props.agent.vmAgentId)}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex min-h-64 min-w-0 flex-col">
              {selectedSummary ? (
                <>
                  <div className="min-w-0 border-b p-3">
                    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <h3 className="break-words text-sm font-medium">
                          {selectedSummary.delegation.title}
                        </h3>
                        <p className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                          <Badge
                            variant={
                              DELEGATION_STATUS_DISPLAY[selectedSummary.delegation.status].variant
                            }
                          >
                            {DELEGATION_STATUS_DISPLAY[selectedSummary.delegation.status].label}
                          </Badge>
                          <span className="truncate">
                            {delegationDirection(selectedSummary, props.agent.vmAgentId)}
                          </span>
                        </p>
                        <p className="mt-2 break-words text-xs text-muted-foreground">
                          {selectedSummary.delegation.task}
                        </p>
                      </div>
                      {!TERMINAL_DELEGATION_STATUSES.has(selectedSummary.delegation.status) ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="min-h-11"
                          disabled={commandPending}
                          onClick={() => void cancel()}
                        >
                          <StopCircleIcon /> Cancel
                        </Button>
                      ) : null}
                    </div>
                    {waitingQuestion ? (
                      <div className="mt-3 min-w-0 rounded-lg border border-amber-500/35 bg-amber-500/8 p-3">
                        <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
                          Waiting for your answer
                        </p>
                        <p className="mt-1 whitespace-pre-wrap break-words text-xs">
                          {waitingQuestion.text}
                        </p>
                      </div>
                    ) : null}
                    {selectedSummary.delegation.status === "pending-approval" ? (
                      <div className="mt-3 min-w-0 rounded-lg border border-amber-500/35 bg-amber-500/8 p-3">
                        <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
                          Waiting for your approval
                        </p>
                        <p className="mt-1 break-words text-xs text-muted-foreground">
                          Nothing runs until you approve this in the chat.
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          className="mt-2 min-h-11"
                          onClick={props.onOpenChat}
                        >
                          Review in chat
                        </Button>
                      </div>
                    ) : null}
                    {selectedSummary.delegation.result ? (
                      <div className="mt-3 min-w-0 rounded-lg border border-emerald-500/30 bg-emerald-500/8 p-3">
                        <p className="text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                          Completed by {selectedSummary.delegation.result.completedBy}
                        </p>
                        <p className="mt-1 whitespace-pre-wrap break-words text-xs">
                          {selectedSummary.delegation.result.summary}
                        </p>
                      </div>
                    ) : null}
                    {selectedSummary.delegation.error ? (
                      <p className="mt-3 whitespace-pre-wrap break-words text-xs text-destructive">
                        {selectedSummary.delegation.error}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex min-h-32 min-w-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto p-3">
                    {(detail?.messages ?? []).map((message) => (
                      <div
                        key={message.messageId}
                        className={cn(
                          "max-w-[92%] min-w-0 rounded-lg px-3 py-2",
                          messageAlignment(message.sender),
                        )}
                      >
                        <p className="whitespace-pre-wrap break-words text-xs">{message.text}</p>
                        <p className="mt-1 flex min-w-0 flex-wrap gap-1 text-[10px] opacity-65">
                          <span>{senderLabel(message, selectedSummary)}</span>
                          {message.kind !== "note" ? <span>· {message.kind}</span> : null}
                          {message.delivery === "pending" ? <span>· sending…</span> : null}
                        </p>
                      </div>
                    ))}
                    {detail === null ? (
                      <p className="text-xs text-muted-foreground">Loading conversation…</p>
                    ) : detail.messages.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No messages yet.</p>
                    ) : null}
                  </div>
                  {!TERMINAL_DELEGATION_STATUSES.has(selectedSummary.delegation.status) ? (
                    <div className="flex min-w-0 flex-col gap-2 border-t p-3 min-[480px]:flex-row">
                      <Textarea
                        rows={2}
                        maxLength={20_000}
                        value={messageDraft}
                        className="min-w-0 flex-1"
                        placeholder={
                          selectedSummary.delegation.status === "waiting-input"
                            ? "Answer their question…"
                            : "Send a follow-up…"
                        }
                        onChange={(event) => setMessageDraft(event.target.value)}
                      />
                      <Button
                        type="button"
                        className="min-h-11 min-[480px]:self-end"
                        disabled={!messageDraft.trim() || commandPending}
                        onClick={() => void submitMessage()}
                      >
                        <SendIcon /> {commandPending ? "Sending…" : "Send"}
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="flex min-h-64 min-w-0 items-center justify-center p-6 text-center text-xs text-muted-foreground">
                  <span className="max-w-full break-words">
                    Select a hand-off to see its progress.
                  </span>
                </div>
              )}
            </div>
          </section>
        )}
        {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}
