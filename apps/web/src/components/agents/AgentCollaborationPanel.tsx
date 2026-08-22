import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  VmAgent,
  VmAgentCollaborationSnapshot,
  VmAgentDelegation,
  VmAgentDelegationMessage,
  VmAgentDelegationStatus,
  VmAgentDelegationSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { MessageSquareIcon, SendIcon, SparklesIcon, StopCircleIcon, UsersIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { cn } from "~/lib/utils";
import { vmAgentEnvironment } from "~/state/vmAgents";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";

const EPHEMERAL_TARGET = "__ephemeral__";
const TERMINAL_DELEGATION_STATUSES = new Set<VmAgentDelegationStatus>([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

const statusVariant = (status: VmAgentDelegationStatus) => {
  if (status === "completed") return "success" as const;
  if (status === "failed" || status === "expired") return "destructive" as const;
  if (status === "pending-approval" || status === "waiting-input") return "warning" as const;
  return "secondary" as const;
};

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
    return summary.delegation.target.label ?? "Ephemeral worker";
  }
  return (
    summary.targetAgent?.name ??
    summary.delegation.targetAgentSnapshot?.name ??
    `Agent ${summary.delegation.target.vmAgentId}`
  );
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
      : "to a bounded ephemeral sub-agent";
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
      ? ([...(detail?.messages ?? [])].reverse().find((message) => message.kind === "question") ??
        (selectedSummary.latestMessage?.kind === "question" ? selectedSummary.latestMessage : null))
      : null;

  return (
    <div className="h-full min-w-0 overflow-x-hidden overflow-y-auto">
      <div className="mx-auto flex min-w-0 max-w-4xl flex-col gap-4 p-3 sm:p-4">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold">Collaborate</h2>
            <Badge variant="secondary">Persistent root agent</Badge>
          </div>
          <p className="mt-1 break-words text-xs text-muted-foreground">
            This named root stays durable. Each delegation is a bounded work item for another named
            agent or a short-lived ephemeral worker on this host.
          </p>
        </div>

        <section className="min-w-0 rounded-xl border p-3">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium">
            <UsersIcon className="size-4" /> Choose a collaborator
          </div>
          <div className="grid min-w-0 grid-cols-1 gap-2 min-[560px]:grid-cols-2">
            <button
              type="button"
              className={cn(
                "min-h-11 min-w-0 rounded-lg border p-3 text-left",
                selectedTargetId === EPHEMERAL_TARGET
                  ? "border-primary bg-primary/5"
                  : "hover:bg-muted/40",
              )}
              onClick={() => setSelectedTargetId(EPHEMERAL_TARGET)}
            >
              <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                <SparklesIcon className="size-4 shrink-0" />
                <span className="truncate">Ephemeral sub-agent</span>
              </span>
              <span className="mt-1 block break-words text-xs text-muted-foreground">
                Created for this bounded task, then released.
              </span>
            </button>
            {collaborators.map((agent) => (
              <button
                key={agent.vmAgentId}
                type="button"
                className={cn(
                  "min-h-11 min-w-0 rounded-lg border p-3 text-left",
                  selectedTarget?.vmAgentId === agent.vmAgentId
                    ? "border-primary bg-primary/5"
                    : "hover:bg-muted/40",
                )}
                onClick={() => setSelectedTargetId(agent.vmAgentId)}
              >
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{agent.name}</span>
                  <Badge variant={agent.canReceiveDelegation ? "success" : "secondary"}>
                    {agent.availability}
                  </Badge>
                </div>
                <p className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">
                  {agent.purpose}
                </p>
                <p className="mt-2 truncate text-[11px] text-muted-foreground">
                  {agent.capabilities.join(" · ") || "No advertised capabilities"}
                </p>
              </button>
            ))}
          </div>
          {collaborators.length === 0 ? (
            <p className="mt-2 break-words text-xs text-muted-foreground">
              No other named agent is available. The root can still create a bounded ephemeral
              sub-agent through chat.
            </p>
          ) : null}
          <div className="mt-3 flex min-w-0 flex-col gap-2">
            <Textarea
              rows={3}
              maxLength={50_000}
              value={taskDraft}
              placeholder={
                selectedTarget
                  ? `What should @${selectedTarget.handle} help with?`
                  : "What should the ephemeral sub-agent help with?"
              }
              onChange={(event) => setTaskDraft(event.target.value)}
            />
            <Button
              type="button"
              className="min-h-11 self-stretch min-[420px]:self-end"
              disabled={
                !props.agent.threadId ||
                !taskDraft.trim() ||
                (selectedTarget !== null && !selectedTarget.canReceiveDelegation)
              }
              onClick={draftDelegationRequest}
            >
              <MessageSquareIcon /> Add delegation request to chat
            </Button>
            <p className="break-words text-[11px] text-muted-foreground">
              Chat keeps the root agent in control and preserves the normal approval boundary.
            </p>
          </div>
        </section>

        <section className="grid min-h-64 min-w-0 grid-cols-1 overflow-hidden rounded-xl border min-[680px]:grid-cols-[minmax(12rem,0.8fr)_minmax(0,1.4fr)]">
          <div className="min-w-0 border-b p-2 min-[680px]:border-b-0 min-[680px]:border-r">
            <p className="px-2 py-1 text-xs font-medium text-muted-foreground">Delegated work</p>
            <div className="flex max-h-56 min-w-0 flex-col gap-1 overflow-y-auto min-[680px]:max-h-none">
              {delegations.map((summary) => {
                const delegation = summary.delegation;
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
                    <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                      <Badge variant={statusVariant(delegation.status)}>{delegation.status}</Badge>
                      <span>{delegationRole(delegation, props.agent.vmAgentId)}</span>
                      <span>→ {targetLabel(summary)}</span>
                    </span>
                  </button>
                );
              })}
              {delegations.length === 0 ? (
                <p className="break-words px-2 py-4 text-xs text-muted-foreground">
                  No delegated work yet.
                </p>
              ) : null}
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
                      <p className="mt-1 break-words text-xs text-muted-foreground">
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
                        Human approval required
                      </p>
                      <p className="mt-1 break-words text-xs text-muted-foreground">
                        Review this request in the root agent chat. It is never approved
                        automatically.
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        className="mt-2 min-h-11"
                        onClick={props.onOpenChat}
                      >
                        Open approval
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
                        <span>· {message.kind}</span>
                        {message.delivery === "pending" ? <span>· sending</span> : null}
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
                          ? "Answer the worker’s question…"
                          : "Send a bounded follow-up…"
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
                  Delegated work and agent-to-agent messages will appear here.
                </span>
              </div>
            )}
          </div>
        </section>
        {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}
