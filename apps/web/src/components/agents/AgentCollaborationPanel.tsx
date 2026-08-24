import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  VmAgent,
  VmAgentCollaborationSnapshot,
  VmAgentDelegationListItem,
  VmAgentDelegationId,
  VmAgentDelegationMessage,
  VmAgentDelegationStatus,
  VmAgentDelegationSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import {
  ChevronLeftIcon,
  PlusIcon,
  RotateCwIcon,
  SendIcon,
  StopCircleIcon,
  UsersIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { cn } from "~/lib/utils";
import { vmAgentEnvironment } from "~/state/vmAgents";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";

import { BoundedCollaborationText } from "./BoundedCollaborationText";
import {
  CreateDelegationDialog,
  EPHEMERAL_DELEGATION_TARGET,
  type AgentCollaborationDraft,
} from "./CreateDelegationDialog";

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

const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  "browser.preview": "Browser",
  "workspace.consult": "Consult",
  "workspace.tasks": "Tasks",
};

/** Up to three friendly labels for known capability ids; unknown ids stay hidden. */
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

export type DelegationCancellationTarget = Readonly<{
  delegationId: VmAgentDelegationId;
  title: string;
}>;

/** Snapshot the work item the user chose before the confirmation dialog opens. */
export function captureDelegationCancellation(
  summary: Pick<VmAgentDelegationSummary, "delegation">,
): DelegationCancellationTarget {
  return {
    delegationId: summary.delegation.delegationId,
    title: summary.delegation.title,
  };
}

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

export function delegationRole(
  delegation: Pick<
    VmAgentDelegationListItem,
    "rootVmAgentId" | "sourceVmAgentId" | "targetVmAgentId"
  >,
  vmAgentId: string,
): string {
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

/** "to Scout" when this agent handed work off, "from Scout" when it received it. */
function delegationDirection(summary: VmAgentDelegationSummary, vmAgentId: string): string {
  if (summary.delegation.targetVmAgentId === vmAgentId) {
    return `from ${summary.sourceAgent?.name ?? summary.delegation.sourceAgentSnapshot.name}`;
  }
  return `to ${targetLabel(summary)}`;
}

function senderLabel(
  message: Pick<VmAgentDelegationMessage, "sender">,
  summary: VmAgentDelegationSummary,
): string {
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

export function mergeDelegationMessages(
  ...pages: ReadonlyArray<ReadonlyArray<VmAgentDelegationMessage>>
): ReadonlyArray<VmAgentDelegationMessage> {
  const bySequence = new Map<number, VmAgentDelegationMessage>();
  for (const page of pages) {
    for (const message of page) bySequence.set(message.sequence, message);
  }
  return Array.from(bySequence.values()).sort((left, right) => left.sequence - right.sequence);
}

export function hasEarlierAfterDelegationPage(input: {
  readonly beforeSequence: number;
  readonly page: ReadonlyArray<VmAgentDelegationMessage>;
  readonly mergedMessageCount: number;
  readonly totalMessageCount: number;
  readonly serverValue: boolean | undefined;
}): boolean {
  // Pre-pagination hosts strip `beforeSequence` and return the newest page
  // again. Treat a page with no sequence below the requested cursor as terminal
  // so the UI cannot offer a permanently ineffective "Show earlier" action.
  const cursorAdvanced = input.page.some((message) => message.sequence < input.beforeSequence);
  if (!cursorAdvanced) return false;
  return input.serverValue ?? input.totalMessageCount > input.mergedMessageCount;
}

interface LoadedDelegationHistory {
  readonly messages: ReadonlyArray<VmAgentDelegationMessage>;
  readonly hasEarlierMessages: boolean;
}

interface DelegationHistoryRequest {
  readonly delegationId: VmAgentDelegationId;
  readonly beforeSequence: number;
}

export function delegationHistoryLoadState(
  request: Pick<DelegationHistoryRequest, "delegationId"> | null,
  selectedDelegationId: string | null,
  query: { readonly isPending: boolean; readonly hasError: boolean },
): { readonly selectedRequest: boolean; readonly isLoading: boolean; readonly hasError: boolean } {
  const selectedRequest = request?.delegationId === selectedDelegationId;
  return {
    selectedRequest,
    isLoading: selectedRequest && query.isPending,
    hasError: selectedRequest && query.hasError,
  };
}

export function emptyDelegationListCopy(hasMoreDelegations: boolean): {
  readonly title: string;
  readonly detail: string;
} {
  return hasMoreDelegations
    ? {
        title: "Handoff history is bounded",
        detail: "Some older handoffs are outside this live view.",
      }
    : {
        title: "No handoffs yet",
        detail: "Give a bounded task to a named agent or a one-off helper.",
      };
}

const DelegationList = memo(function DelegationList(props: {
  readonly delegations: ReadonlyArray<VmAgentDelegationSummary>;
  readonly hasMoreDelegations: boolean;
  readonly selectedId: string | null;
  readonly vmAgentId: string;
  readonly onSelect: (delegationId: string) => void;
  readonly onButtonRef: (delegationId: string, element: HTMLButtonElement | null) => void;
  readonly onCreate: () => void;
}) {
  const emptyCopy = emptyDelegationListCopy(props.hasMoreDelegations);
  return (
    <section className="flex min-h-0 min-w-0 flex-col bg-muted/15 @3xl/collaboration:border-r">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b px-3">
        <span className="text-xs font-medium text-muted-foreground">Handoffs</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {props.delegations.length}
        </span>
      </div>
      {props.delegations.length > 0 ? (
        <>
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
            {props.delegations.map((summary) => {
              const delegation = summary.delegation;
              const status = DELEGATION_STATUS_DISPLAY[delegation.status];
              const selected = props.selectedId === delegation.delegationId;
              return (
                <button
                  key={delegation.delegationId}
                  ref={(element) => props.onButtonRef(delegation.delegationId, element)}
                  type="button"
                  aria-current={selected ? "true" : undefined}
                  className={cn(
                    "flex w-full min-w-0 flex-col gap-1 border-b px-3 py-2.5 text-left outline-none transition-colors",
                    "focus-visible:relative focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    selected ? "bg-muted/65" : "hover:bg-muted/45",
                  )}
                  onClick={() => props.onSelect(delegation.delegationId)}
                >
                  <span className="line-clamp-2 break-words text-sm font-medium leading-snug">
                    {delegation.title}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Badge size="sm" variant={status.variant}>
                      {status.label}
                    </Badge>
                    <span className="truncate">
                      {delegationDirection(summary, props.vmAgentId)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {props.hasMoreDelegations ? (
            <p className="shrink-0 border-t px-3 py-2 text-[11px] text-muted-foreground">
              Showing the most recent handoffs. Older history is outside this bounded live view.
            </p>
          ) : null}
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <UsersIcon className="size-5 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">{emptyCopy.title}</p>
            <p className="mt-1 max-w-64 text-xs text-muted-foreground">{emptyCopy.detail}</p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={props.onCreate}>
            <PlusIcon /> New handoff
          </Button>
        </div>
      )}
    </section>
  );
});

export function AgentCollaborationPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: VmAgent;
  readonly draft: AgentCollaborationDraft;
  readonly onDraftChange: (draft: AgentCollaborationDraft) => void;
  readonly onOpenChat: () => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedDelegationId, setSelectedDelegationId] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [messageDrafts, setMessageDrafts] = useState<Readonly<Record<string, string>>>({});
  const [messageHistory, setMessageHistory] = useState<
    Readonly<Record<string, LoadedDelegationHistory>>
  >({});
  const [historyRequest, setHistoryRequest] = useState<DelegationHistoryRequest | null>(null);
  const [pendingOperation, setPendingOperation] = useState<{
    readonly kind: "send" | "cancel";
    readonly delegationId: string;
  } | null>(null);
  const [cancelConfirmation, setCancelConfirmation] = useState<DelegationCancellationTarget | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const detailBackButtonRef = useRef<HTMLButtonElement | null>(null);
  const delegationButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingResponsiveFocus = useRef<"detail" | "list" | null>(null);
  const setComposerPrompt = useComposerDraftStore((state) => state.setPrompt);
  const collaborationAtom = useMemo(
    () => vmAgentEnvironment.collaboration({ environmentId: props.environmentId, input: {} }),
    [props.environmentId],
  );
  const collaborationQuery = useEnvironmentQuery(collaborationAtom);
  const snapshot = collaborationQuery.data?.type === "snapshot" ? collaborationQuery.data : null;
  const delegations = useMemo(
    () => agentDelegationsFor(snapshot, props.agent.vmAgentId),
    [props.agent.vmAgentId, snapshot],
  );
  const collaborators = useMemo(
    () => (snapshot?.agents ?? []).filter((agent) => agent.vmAgentId !== props.agent.vmAgentId),
    [props.agent.vmAgentId, snapshot],
  );
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
  const detailQuery = useEnvironmentQuery(detailAtom);
  const detail =
    detailQuery.data?.delegation.delegationId === selectedDelegationKey ? detailQuery.data : null;
  const historyAtom = useMemo(
    () =>
      historyRequest
        ? vmAgentEnvironment.delegation({
            environmentId: props.environmentId,
            input: {
              delegationId: historyRequest.delegationId,
              beforeSequence: historyRequest.beforeSequence,
            },
          })
        : null,
    [historyRequest, props.environmentId],
  );
  const historyQuery = useEnvironmentQuery(historyAtom);
  const observedRevisions = useRef(new Map<string, number>());
  const sendMessage = useAtomCommand(vmAgentEnvironment.sendDelegationMessage, {
    reportFailure: false,
  });
  const cancelDelegation = useAtomCommand(vmAgentEnvironment.cancelDelegation, {
    reportFailure: false,
  });
  const currentMessageDraft = selectedDelegationKey
    ? (messageDrafts[selectedDelegationKey] ?? "")
    : "";
  const openCreate = useCallback(() => setCreateOpen(true), []);

  const setDelegationButtonRef = useCallback(
    (delegationId: string, element: HTMLButtonElement | null) => {
      if (element === null) {
        delegationButtonRefs.current.delete(delegationId);
        return;
      }
      delegationButtonRefs.current.set(delegationId, element);
    },
    [],
  );

  const chooseDelegation = useCallback((delegationId: string) => {
    pendingResponsiveFocus.current = "detail";
    setSelectedDelegationId(delegationId);
    setMobileDetailOpen(true);
    setHistoryRequest(null);
    setError(null);
  }, []);

  const draftDelegationRequest = () => {
    if (!props.agent.threadId || !props.draft.task.trim()) return;
    const selectedTarget =
      props.draft.targetId === EPHEMERAL_DELEGATION_TARGET
        ? null
        : collaborators.find((agent) => agent.vmAgentId === props.draft.targetId);
    if (
      props.draft.targetId !== EPHEMERAL_DELEGATION_TARGET &&
      (!selectedTarget || !selectedTarget.canReceiveDelegation)
    ) {
      return;
    }
    const threadRef = scopeThreadRef(props.environmentId, props.agent.threadId);
    const existing = useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt.trim();
    const target = selectedTarget
      ? `to @${selectedTarget.handle}`
      : "to a one-off ephemeral helper";
    const request = `Delegate this task ${target} and collaborate until the work is complete:\n\n${props.draft.task.trim()}`;
    setComposerPrompt(threadRef, existing ? `${existing}\n\n${request}` : request);
    props.onDraftChange({ ...props.draft, task: "" });
    setCreateOpen(false);
    props.onOpenChat();
  };

  const submitMessage = async () => {
    if (!selectedSummary || !currentMessageDraft.trim() || pendingOperation) return;
    const delegationId = selectedSummary.delegation.delegationId;
    setPendingOperation({ kind: "send", delegationId });
    setError(null);
    const result = await sendMessage({
      environmentId: props.environmentId,
      input: {
        delegationId,
        message: currentMessageDraft.trim(),
        kind: selectedSummary.delegation.status === "waiting-input" ? "answer" : "note",
        waitForReply: false,
      },
    });
    setPendingOperation(null);
    if (result._tag === "Success") {
      setMessageDrafts((current) => ({ ...current, [delegationId]: "" }));
      detailQuery.refresh();
      return;
    }
    setError(commandError(result.cause, "Could not send the follow-up."));
  };

  const cancel = async (delegationId: VmAgentDelegationId) => {
    if (pendingOperation) return;
    setPendingOperation({ kind: "cancel", delegationId });
    setError(null);
    const result = await cancelDelegation({
      environmentId: props.environmentId,
      input: { delegationId },
    });
    setPendingOperation(null);
    if (result._tag === "Failure") {
      setError(commandError(result.cause, "Could not stop the delegated work."));
    }
  };

  useEffect(() => {
    if (selectedSummary === null || selectedDelegationKey === null) return;
    const revision = selectedSummary.delegation.revision;
    const previous = observedRevisions.current.get(selectedDelegationKey);
    observedRevisions.current.set(selectedDelegationKey, revision);
    if (previous !== undefined && previous !== revision) {
      detailQuery.refresh();
    }
  }, [detailQuery.refresh, selectedDelegationKey, selectedSummary]);

  useEffect(() => {
    const target = pendingResponsiveFocus.current;
    if (target === null) return;
    pendingResponsiveFocus.current = null;
    if (target === "detail") {
      const backButton = detailBackButtonRef.current;
      // The Back control is display:none in the wide two-pane layout. Keep
      // focus on the clicked row there, and move it only when the narrow view
      // replaces the list with the detail pane.
      if (backButton && backButton.getClientRects().length > 0) backButton.focus();
      return;
    }
    if (selectedDelegationKey !== null) {
      delegationButtonRefs.current.get(selectedDelegationKey)?.focus();
    }
  }, [mobileDetailOpen, selectedDelegationKey]);

  useEffect(() => {
    if (selectedDelegationKey === null || detail === null) return;
    setMessageHistory((current) => {
      const existing = current[selectedDelegationKey];
      const messages = mergeDelegationMessages(existing?.messages ?? [], detail.messages);
      const hasEarlierMessages =
        existing?.hasEarlierMessages ??
        detail.hasEarlierMessages ??
        detail.delegation.messageCount > messages.length;
      if (
        existing !== undefined &&
        existing.hasEarlierMessages === hasEarlierMessages &&
        existing.messages.length === messages.length &&
        existing.messages.every((message, index) => message === messages[index])
      ) {
        return current;
      }
      return { ...current, [selectedDelegationKey]: { messages, hasEarlierMessages } };
    });
  }, [detail, selectedDelegationKey]);

  useEffect(() => {
    const historyPage = historyQuery.data;
    if (historyRequest === null || historyPage === null) return;
    const delegationId = historyRequest.delegationId;
    if (historyPage.delegation.delegationId !== delegationId) return;
    setMessageHistory((current) => {
      const existing = current[delegationId];
      const messages = mergeDelegationMessages(existing?.messages ?? [], historyPage.messages);
      return {
        ...current,
        [delegationId]: {
          messages,
          hasEarlierMessages: hasEarlierAfterDelegationPage({
            beforeSequence: historyRequest.beforeSequence,
            page: historyPage.messages,
            mergedMessageCount: messages.length,
            totalMessageCount: historyPage.delegation.messageCount,
            serverValue: historyPage.hasEarlierMessages,
          }),
        },
      };
    });
    setHistoryRequest((current) =>
      current?.delegationId === delegationId &&
      current.beforeSequence === historyRequest.beforeSequence
        ? null
        : current,
    );
  }, [historyQuery.data, historyRequest]);

  const loadedHistory = selectedDelegationKey ? messageHistory[selectedDelegationKey] : undefined;
  const messages = loadedHistory?.messages ?? detail?.messages ?? [];
  const hasEarlierMessages =
    loadedHistory?.hasEarlierMessages ??
    detail?.hasEarlierMessages ??
    (detail === null ? false : detail.delegation.messageCount > messages.length);
  const waitingQuestion =
    selectedSummary?.delegation.status === "waiting-input"
      ? ([...messages].toReversed().find((message) => message.kind === "question") ??
        (selectedSummary.latestMessage?.kind === "question" ? selectedSummary.latestMessage : null))
      : null;
  const selectedStatus = selectedSummary
    ? DELEGATION_STATUS_DISPLAY[selectedSummary.delegation.status]
    : null;
  const isSending =
    pendingOperation?.kind === "send" && pendingOperation.delegationId === selectedDelegationKey;
  const isCancelling =
    pendingOperation?.kind === "cancel" && pendingOperation.delegationId === selectedDelegationKey;
  const historyLoadState = delegationHistoryLoadState(historyRequest, selectedDelegationKey, {
    isPending: historyQuery.isPending,
    hasError: historyQuery.error !== null,
  });

  return (
    <div className="@container/collaboration flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2 sm:px-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Collaborate</h2>
          <p className="hidden truncate text-xs text-muted-foreground sm:block">
            Delegate bounded work and keep the conversation in one place.
          </p>
        </div>
        <Button type="button" size="sm" className="shrink-0" onClick={openCreate}>
          <PlusIcon /> {props.draft.task.trim() ? "Continue draft" : "New handoff"}
        </Button>
      </header>

      {collaborationQuery.error ? (
        <div role="alert" className="flex min-w-0 items-center gap-3 border-b px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 break-words text-destructive">
            {collaborationQuery.error}
          </span>
          <Button type="button" size="xs" variant="outline" onClick={collaborationQuery.refresh}>
            <RotateCwIcon /> Retry
          </Button>
        </div>
      ) : null}

      <div className="grid min-h-0 min-w-0 flex-1 overflow-hidden @3xl/collaboration:grid-cols-[minmax(14rem,21rem)_minmax(0,1fr)]">
        <div
          className={cn(
            "min-h-0 min-w-0 @3xl/collaboration:flex",
            mobileDetailOpen ? "hidden" : "flex",
          )}
        >
          {snapshot === null && !collaborationQuery.error ? (
            <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
              Loading handoffs…
            </div>
          ) : (
            <DelegationList
              delegations={delegations}
              hasMoreDelegations={snapshot?.hasMoreDelegations === true}
              selectedId={selectedDelegationKey}
              vmAgentId={props.agent.vmAgentId}
              onSelect={chooseDelegation}
              onButtonRef={setDelegationButtonRef}
              onCreate={openCreate}
            />
          )}
        </div>

        <section
          className={cn(
            "min-h-0 min-w-0 flex-col bg-background @3xl/collaboration:flex",
            mobileDetailOpen ? "flex" : "hidden",
          )}
        >
          {selectedSummary && selectedStatus ? (
            <>
              <header className="flex min-w-0 shrink-0 items-start gap-2 border-b px-3 py-2.5 sm:px-4">
                <Button
                  ref={detailBackButtonRef}
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="shrink-0 @3xl/collaboration:hidden"
                  aria-label="Back to handoffs"
                  onClick={() => {
                    pendingResponsiveFocus.current = "list";
                    setMobileDetailOpen(false);
                  }}
                >
                  <ChevronLeftIcon />
                </Button>
                <div className="min-w-0 flex-1">
                  <h3 className="line-clamp-2 break-words text-sm font-medium leading-snug">
                    {selectedSummary.delegation.title}
                  </h3>
                  <p className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Badge size="sm" variant={selectedStatus.variant}>
                      {selectedStatus.label}
                    </Badge>
                    <span className="truncate">
                      {delegationDirection(selectedSummary, props.agent.vmAgentId)}
                    </span>
                  </p>
                </div>
                {!TERMINAL_DELEGATION_STATUSES.has(selectedSummary.delegation.status) ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="shrink-0 text-muted-foreground"
                    disabled={pendingOperation !== null}
                    onClick={() =>
                      setCancelConfirmation(captureDelegationCancellation(selectedSummary))
                    }
                  >
                    <StopCircleIcon /> {isCancelling ? "Stopping…" : "Stop"}
                  </Button>
                ) : null}
              </header>

              <p className="sr-only" aria-live="polite">
                {selectedSummary.delegation.title}: {selectedStatus.label}
              </p>

              <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto p-3 sm:p-4">
                <section className="min-w-0 rounded-lg border bg-muted/20 px-3 py-2.5">
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Brief
                  </p>
                  <BoundedCollaborationText
                    key={`brief:${selectedDelegationKey}`}
                    text={detail?.delegation.task ?? selectedSummary.delegation.taskPreview.text}
                    maxCharacters={420}
                    maxLines={5}
                    collapsedLabel="Show full brief"
                  />
                </section>

                {waitingQuestion ? (
                  <section className="min-w-0 rounded-lg border border-amber-500/35 bg-amber-500/8 p-3">
                    <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
                      Waiting for your answer
                    </p>
                    <BoundedCollaborationText
                      key={`question:${waitingQuestion.messageId}`}
                      text={waitingQuestion.text}
                      className="mt-1"
                      maxCharacters={600}
                      maxLines={6}
                      collapsedLabel="Show full question"
                    />
                  </section>
                ) : null}

                {selectedSummary.delegation.status === "pending-approval" ? (
                  <section className="min-w-0 rounded-lg border border-amber-500/35 bg-amber-500/8 p-3">
                    <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
                      Waiting for your approval
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Nothing runs until you approve this request in the root chat.
                    </p>
                    <Button type="button" size="xs" className="mt-2" onClick={props.onOpenChat}>
                      Review in chat
                    </Button>
                  </section>
                ) : null}

                {(detail?.delegation.result ?? selectedSummary.delegation.resultPreview) ? (
                  <section className="min-w-0 rounded-lg border border-emerald-500/30 bg-emerald-500/8 p-3">
                    <p className="text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                      Completed result
                    </p>
                    <BoundedCollaborationText
                      key={`result:${selectedDelegationKey}`}
                      text={
                        detail?.delegation.result?.summary ??
                        selectedSummary.delegation.resultPreview?.text ??
                        ""
                      }
                      className="mt-1"
                      maxCharacters={700}
                      maxLines={7}
                      collapsedLabel="Show full result"
                      expandedMaxHeightClassName="max-h-64"
                    />
                  </section>
                ) : null}

                {(detail?.delegation.error ?? selectedSummary.delegation.errorPreview) ? (
                  <section className="min-w-0 rounded-lg border border-destructive/30 bg-destructive/7 p-3">
                    <p className="text-[11px] font-medium text-destructive">Error</p>
                    <BoundedCollaborationText
                      key={`error:${selectedDelegationKey}`}
                      text={
                        detail?.delegation.error ??
                        selectedSummary.delegation.errorPreview?.text ??
                        ""
                      }
                      className="mt-1 text-destructive"
                      maxCharacters={500}
                      maxLines={6}
                      collapsedLabel="Show full error"
                    />
                  </section>
                ) : null}

                {detailQuery.error ? (
                  <div
                    role="alert"
                    className="flex min-w-0 items-center gap-3 rounded-lg border p-3"
                  >
                    <span className="min-w-0 flex-1 break-words text-xs text-destructive">
                      {detailQuery.error}
                    </span>
                    <Button type="button" size="xs" variant="outline" onClick={detailQuery.refresh}>
                      <RotateCwIcon /> Retry
                    </Button>
                  </div>
                ) : null}

                {historyQuery.error && historyLoadState.selectedRequest ? (
                  <div
                    role="alert"
                    className="flex min-w-0 items-center gap-3 rounded-lg border p-3"
                  >
                    <span className="min-w-0 flex-1 break-words text-xs text-destructive">
                      Earlier messages could not be loaded. {historyQuery.error}
                    </span>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={historyQuery.refresh}
                    >
                      <RotateCwIcon /> Retry
                    </Button>
                  </div>
                ) : null}

                {hasEarlierMessages && messages.length > 0 && !historyLoadState.hasError ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="self-center text-muted-foreground"
                    disabled={historyLoadState.isLoading}
                    onClick={() => {
                      const oldest = messages[0];
                      if (oldest === undefined) return;
                      setHistoryRequest({
                        delegationId: oldest.delegationId,
                        beforeSequence: oldest.sequence,
                      });
                    }}
                  >
                    {historyLoadState.isLoading
                      ? "Loading earlier messages…"
                      : "Show earlier messages"}
                  </Button>
                ) : null}

                <div className="flex min-w-0 flex-col gap-2">
                  {messages.map((message) => (
                    <article
                      key={message.messageId}
                      className={cn(
                        "max-w-[92%] min-w-0 rounded-lg px-3 py-2",
                        messageAlignment(message.sender),
                      )}
                    >
                      <BoundedCollaborationText
                        text={message.text}
                        maxCharacters={800}
                        maxLines={8}
                        collapsedLabel="Show full message"
                        expandedMaxHeightClassName="max-h-64"
                      />
                      <p className="mt-1 flex min-w-0 flex-wrap gap-1 text-[10px] opacity-65">
                        <span>{senderLabel(message, selectedSummary)}</span>
                        {message.kind !== "note" ? <span>· {message.kind}</span> : null}
                        {message.delivery === "pending" ? <span>· sending…</span> : null}
                      </p>
                    </article>
                  ))}
                  {detail === null && !detailQuery.error ? (
                    <p className="text-xs text-muted-foreground">Loading conversation…</p>
                  ) : messages.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No messages yet.</p>
                  ) : null}
                </div>
              </div>

              {!TERMINAL_DELEGATION_STATUSES.has(selectedSummary.delegation.status) ? (
                <div className="flex min-w-0 shrink-0 flex-col gap-2 border-t p-3 @md/collaboration:flex-row">
                  <div className="min-w-0 flex-1">
                    <label
                      htmlFor={`delegation-reply-${selectedDelegationKey}`}
                      className="sr-only"
                    >
                      {selectedSummary.delegation.status === "waiting-input"
                        ? "Answer the collaborator’s question"
                        : "Send a follow-up to the collaborator"}
                    </label>
                    <Textarea
                      id={`delegation-reply-${selectedDelegationKey}`}
                      rows={2}
                      maxLength={20_000}
                      value={currentMessageDraft}
                      className="[&_[data-slot=textarea]]:max-h-32 [&_[data-slot=textarea]]:overflow-y-auto"
                      placeholder={
                        selectedSummary.delegation.status === "waiting-input"
                          ? "Answer their question…"
                          : "Send a follow-up…"
                      }
                      onChange={(event) =>
                        setMessageDrafts((current) => ({
                          ...current,
                          [selectedSummary.delegation.delegationId]: event.target.value,
                        }))
                      }
                    />
                  </div>
                  <Button
                    type="button"
                    className="shrink-0 @md/collaboration:self-end"
                    disabled={!currentMessageDraft.trim() || pendingOperation !== null}
                    onClick={() => void submitMessage()}
                  >
                    <SendIcon /> {isSending ? "Sending…" : "Send"}
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
              Select a handoff to see its conversation.
            </div>
          )}
        </section>
      </div>

      <CreateDelegationDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        collaborators={collaborators}
        draft={props.draft}
        onDraftChange={props.onDraftChange}
        onReview={draftDelegationRequest}
        threadAvailable={props.agent.threadId !== null}
        hasMoreCollaborators={snapshot?.hasMoreAgents === true}
      />

      <AlertDialog
        open={cancelConfirmation !== null}
        onOpenChange={(open) => {
          if (!open) setCancelConfirmation(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Stop “{cancelConfirmation?.title ?? "this handoff"}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The collaborator will be interrupted and this bounded work item will be cancelled.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep running</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (!cancelConfirmation) return;
                const { delegationId } = cancelConfirmation;
                setCancelConfirmation(null);
                void cancel(delegationId);
              }}
            >
              Stop handoff
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      {error ? (
        <p role="alert" className="shrink-0 border-t px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
