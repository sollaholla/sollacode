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
  BotIcon,
  CheckCircle2Icon,
  ChevronLeftIcon,
  CircleDashedIcon,
  CircleDotIcon,
  Clock3Icon,
  FileTextIcon,
  MessageSquareIcon,
  RotateCwIcon,
  SendIcon,
  SparklesIcon,
  StopCircleIcon,
  UsersIcon,
} from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
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

const normalizedCollaborationText = (value: string): string =>
  value.replaceAll(/\s+/gu, " ").trim();

/** The durable brief is already rendered above the activity stream. */
export function delegationActivityMessages(
  messages: ReadonlyArray<VmAgentDelegationMessage>,
  brief: string,
): ReadonlyArray<VmAgentDelegationMessage> {
  const normalizedBrief = normalizedCollaborationText(brief);
  return messages.filter(
    (message, index) =>
      !(
        index === 0 &&
        message.sender === "source-agent" &&
        normalizedCollaborationText(message.text) === normalizedBrief
      ),
  );
}

export function delegationStatusActivity(status: VmAgentDelegationStatus): {
  readonly title: string;
  readonly detail: string;
  readonly tone: "neutral" | "info" | "warning" | "success" | "error";
} {
  switch (status) {
    case "pending-approval":
      return {
        title: "Waiting for approval",
        detail: "This handoff will start after it is approved in the root chat.",
        tone: "warning",
      };
    case "queued":
      return {
        title: "Waiting for collaborator",
        detail: "The task is queued and will start when capacity is available.",
        tone: "neutral",
      };
    case "running":
      return {
        title: "Work in progress",
        detail: "The collaborator is actively working through the brief.",
        tone: "info",
      };
    case "waiting-input":
      return {
        title: "Waiting for your reply",
        detail: "The collaborator needs an answer before work can continue.",
        tone: "warning",
      };
    case "completed":
      return {
        title: "Handoff completed",
        detail: "The collaborator finished this bounded task.",
        tone: "success",
      };
    case "failed":
      return {
        title: "Handoff failed",
        detail: "The collaborator could not complete this task.",
        tone: "error",
      };
    case "cancelled":
      return {
        title: "Handoff stopped",
        detail: "This delegated task was cancelled.",
        tone: "neutral",
      };
    case "expired":
      return {
        title: "Handoff timed out",
        detail: "The delegated task reached its time limit.",
        tone: "error",
      };
  }
}

function ActivityTimelineRow(props: {
  readonly icon: typeof SparklesIcon;
  readonly title: string;
  readonly timestamp: string;
  readonly detail?: string;
  readonly children?: ReactNode;
  readonly emphasized?: boolean;
}) {
  const Icon = props.icon;
  return (
    <article className="relative grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] gap-3 pb-5 last:pb-0">
      <span className="relative z-10 flex size-8 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-xs">
        <Icon className="size-3.5" aria-hidden />
      </span>
      <div
        className={cn(
          "min-w-0 pt-1",
          props.emphasized && "rounded-xl border bg-muted/15 px-3 py-2.5",
        )}
      >
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
          <span className="font-medium text-foreground">{props.title}</span>
          <span className="text-[11px] text-muted-foreground">{props.timestamp}</span>
        </p>
        {props.detail ? (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{props.detail}</p>
        ) : null}
        {props.children}
      </div>
    </article>
  );
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
        detail: "Delegated work, questions, and results will appear here.",
      };
}

const DelegationList = memo(function DelegationList(props: {
  readonly delegations: ReadonlyArray<VmAgentDelegationSummary>;
  readonly hasMoreDelegations: boolean;
  readonly selectedId: string | null;
  readonly vmAgentId: string;
  readonly onSelect: (delegationId: string) => void;
  readonly onButtonRef: (delegationId: string, element: HTMLButtonElement | null) => void;
  readonly onOpenChat: () => void;
}) {
  const emptyCopy = emptyDelegationListCopy(props.hasMoreDelegations);
  return (
    <section className="flex min-h-0 min-w-0 flex-col bg-muted/8 @3xl/collaboration:border-r">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
        <span className="text-sm font-medium text-foreground">Handoffs</span>
        <span className="rounded-md border bg-background/60 px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
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
                    "group flex w-full min-w-0 gap-3 border-b border-border/60 px-3 py-3 text-left outline-none transition-colors",
                    "focus-visible:relative focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    selected ? "bg-sky-500/8" : "hover:bg-muted/35",
                  )}
                  onClick={() => props.onSelect(delegation.delegationId)}
                >
                  <span
                    className={cn(
                      "mt-1 size-2 shrink-0 rounded-full",
                      delegation.status === "running"
                        ? "bg-sky-400"
                        : delegation.status === "waiting-input" ||
                            delegation.status === "pending-approval"
                          ? "bg-amber-400"
                          : delegation.status === "completed"
                            ? "bg-emerald-400"
                            : delegation.status === "failed" || delegation.status === "expired"
                              ? "bg-destructive"
                              : "bg-muted-foreground/45",
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 break-words text-sm font-medium leading-snug">
                      {delegation.title}
                    </span>
                    <span className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                      <BotIcon className="size-3 shrink-0" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">
                        {delegationDirection(summary, props.vmAgentId)}
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {formatRelativeTimeLabel(delegation.updatedAt)}
                      </span>
                    </span>
                  </span>
                  <span className="sr-only">{status.label}</span>
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
          <Button type="button" size="sm" variant="outline" onClick={props.onOpenChat}>
            Open chat
          </Button>
        </div>
      )}
    </section>
  );
});

export function AgentCollaborationPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: VmAgent;
  readonly onOpenChat: () => void;
}) {
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
  const briefText = selectedSummary
    ? (detail?.delegation.task ?? selectedSummary.delegation.taskPreview.text)
    : "";
  const activityMessages = delegationActivityMessages(messages, briefText);
  const waitingQuestion =
    selectedSummary?.delegation.status === "waiting-input"
      ? ([...messages].toReversed().find((message) => message.kind === "question") ??
        (selectedSummary.latestMessage?.kind === "question" ? selectedSummary.latestMessage : null))
      : null;
  const selectedStatus = selectedSummary
    ? DELEGATION_STATUS_DISPLAY[selectedSummary.delegation.status]
    : null;
  const statusActivity = selectedSummary
    ? delegationStatusActivity(selectedSummary.delegation.status)
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
      <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">Activity</h2>
          <p className="hidden truncate text-xs text-muted-foreground sm:block">
            Delegated work, questions, and results. Start new work in chat.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={props.onOpenChat}
        >
          Open chat
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

      <div className="grid min-h-0 min-w-0 flex-1 overflow-hidden @3xl/collaboration:grid-cols-[minmax(15rem,22.5rem)_minmax(0,1fr)]">
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
              onOpenChat={props.onOpenChat}
            />
          )}
        </div>

        <section
          className={cn(
            "min-h-0 min-w-0 flex-col bg-background @3xl/collaboration:flex",
            mobileDetailOpen ? "flex" : "hidden",
          )}
        >
          {selectedSummary && selectedStatus && statusActivity ? (
            <>
              <header className="flex min-w-0 shrink-0 items-start gap-3 border-b px-4 py-3.5">
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
                  <h3 className="line-clamp-2 break-words text-base font-semibold leading-snug tracking-tight">
                    {selectedSummary.delegation.title}
                  </h3>
                  <p className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge size="sm" variant={selectedStatus.variant}>
                      {selectedStatus.label}
                    </Badge>
                    <span className="truncate">
                      {delegationDirection(selectedSummary, props.agent.vmAgentId)}
                    </span>
                    <span aria-hidden>·</span>
                    <span className="inline-flex items-center gap-1 tabular-nums">
                      <Clock3Icon className="size-3" aria-hidden />
                      {formatRelativeTimeLabel(selectedSummary.delegation.updatedAt)}
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

              <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-3.5">
                <section className="min-w-0 rounded-xl border bg-muted/10 p-4 shadow-xs">
                  <div className="flex items-center gap-2 text-xs font-medium">
                    <FileTextIcon className="size-3.5 text-muted-foreground" aria-hidden />
                    <span>Brief</span>
                  </div>
                  <BoundedCollaborationText
                    key={`brief:${selectedDelegationKey}`}
                    text={briefText}
                    className="mt-2 text-xs leading-relaxed"
                    maxCharacters={340}
                    maxLines={2}
                    collapsedLabel="View full brief"
                    expandedMaxHeightClassName="max-h-64"
                  />
                  <div className="mt-3 flex min-w-0 flex-wrap gap-2 border-t pt-3 text-[11px] text-muted-foreground">
                    <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md border bg-background/55 px-2 py-1">
                      <BotIcon className="size-3 shrink-0" aria-hidden />
                      <span className="truncate">{targetLabel(selectedSummary)}</span>
                    </span>
                    <span className="inline-flex items-center gap-1.5 rounded-md border bg-background/55 px-2 py-1 tabular-nums">
                      <MessageSquareIcon className="size-3" aria-hidden />
                      {selectedSummary.delegation.messageCount}{" "}
                      {selectedSummary.delegation.messageCount === 1 ? "update" : "updates"}
                    </span>
                  </div>
                </section>

                {detailQuery.error ? (
                  <div
                    role="alert"
                    className="mt-3 flex min-w-0 items-center gap-3 rounded-lg border p-3"
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
                    className="mt-3 flex min-w-0 items-center gap-3 rounded-lg border p-3"
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

                <section className="mt-5 min-w-0" aria-label="Handoff activity">
                  {hasEarlierMessages && messages.length > 0 && !historyLoadState.hasError ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      className="mb-3 ml-11 text-muted-foreground"
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
                        ? "Loading earlier activity…"
                        : "Show earlier activity"}
                    </Button>
                  ) : null}

                  <div className="relative min-w-0 before:absolute before:bottom-4 before:left-[0.975rem] before:top-4 before:w-px before:bg-border">
                    <ActivityTimelineRow
                      icon={SparklesIcon}
                      title="Task delegated"
                      timestamp={formatRelativeTimeLabel(selectedSummary.delegation.createdAt)}
                      detail={`This bounded task was delegated ${delegationDirection(selectedSummary, props.agent.vmAgentId)}.`}
                    />
                    <ActivityTimelineRow
                      icon={FileTextIcon}
                      title="Brief received"
                      timestamp={formatRelativeTimeLabel(
                        selectedSummary.delegation.startedAt ??
                          selectedSummary.delegation.createdAt,
                      )}
                      detail={`${targetLabel(selectedSummary)} received the task details and constraints.`}
                    />

                    {activityMessages.map((message) => (
                      <ActivityTimelineRow
                        key={message.messageId}
                        icon={message.kind === "question" ? CircleDotIcon : MessageSquareIcon}
                        title={`${
                          message.kind === "question"
                            ? "Question from"
                            : message.kind === "answer"
                              ? "Answer from"
                              : "Update from"
                        } ${senderLabel(message, selectedSummary)}`}
                        timestamp={formatRelativeTimeLabel(message.createdAt)}
                      >
                        <div className="mt-2 min-w-0 rounded-lg border bg-muted/10 px-3 py-2.5">
                          <BoundedCollaborationText
                            text={message.text}
                            maxCharacters={700}
                            maxLines={6}
                            collapsedLabel="Show full update"
                            expandedMaxHeightClassName="max-h-64"
                          />
                          {message.delivery === "pending" ? (
                            <p className="mt-1 text-[10px] text-muted-foreground">Sending…</p>
                          ) : null}
                        </div>
                      </ActivityTimelineRow>
                    ))}

                    <ActivityTimelineRow
                      icon={
                        statusActivity.tone === "success"
                          ? CheckCircle2Icon
                          : statusActivity.tone === "error"
                            ? StopCircleIcon
                            : statusActivity.tone === "info"
                              ? CircleDotIcon
                              : CircleDashedIcon
                      }
                      title={statusActivity.title}
                      timestamp={formatRelativeTimeLabel(selectedSummary.delegation.updatedAt)}
                      detail={statusActivity.detail}
                      emphasized
                    >
                      {waitingQuestion ? (
                        <div className="mt-2 rounded-lg border border-amber-500/35 bg-amber-500/8 p-3">
                          <BoundedCollaborationText
                            key={`question:${waitingQuestion.messageId}`}
                            text={waitingQuestion.text}
                            maxCharacters={600}
                            maxLines={5}
                            collapsedLabel="Show full question"
                          />
                        </div>
                      ) : null}

                      {selectedSummary.delegation.status === "pending-approval" ? (
                        <Button type="button" size="xs" className="mt-2" onClick={props.onOpenChat}>
                          Review in chat
                        </Button>
                      ) : null}

                      {(detail?.delegation.result ?? selectedSummary.delegation.resultPreview) ? (
                        <div className="mt-2 rounded-lg border border-emerald-500/30 bg-emerald-500/8 p-3">
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
                        </div>
                      ) : null}

                      {(detail?.delegation.error ?? selectedSummary.delegation.errorPreview) ? (
                        <div className="mt-2 rounded-lg border border-destructive/30 bg-destructive/7 p-3">
                          <BoundedCollaborationText
                            key={`error:${selectedDelegationKey}`}
                            text={
                              detail?.delegation.error ??
                              selectedSummary.delegation.errorPreview?.text ??
                              ""
                            }
                            className="text-destructive"
                            maxCharacters={500}
                            maxLines={6}
                            collapsedLabel="Show full error"
                          />
                        </div>
                      ) : null}
                    </ActivityTimelineRow>
                  </div>

                  {detail === null && !detailQuery.error ? (
                    <p className="ml-11 mt-3 text-xs text-muted-foreground">
                      Loading recent activity…
                    </p>
                  ) : null}
                </section>
              </div>

              {!TERMINAL_DELEGATION_STATUSES.has(selectedSummary.delegation.status) ? (
                <div className="min-w-0 shrink-0 border-t bg-background p-3">
                  <div className="flex min-w-0 items-end gap-2 rounded-xl border bg-muted/10 p-1.5 shadow-xs">
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
                      rows={1}
                      maxLength={20_000}
                      value={currentMessageDraft}
                      unstyled
                      className="min-w-0 flex-1 [&_[data-slot=textarea]]:!min-h-9 [&_[data-slot=textarea]]:max-h-24 [&_[data-slot=textarea]]:resize-none [&_[data-slot=textarea]]:overflow-y-auto [&_[data-slot=textarea]]:px-2 [&_[data-slot=textarea]]:py-2"
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
                      onKeyDown={(event) => {
                        if (
                          event.key !== "Enter" ||
                          event.shiftKey ||
                          event.nativeEvent.isComposing
                        ) {
                          return;
                        }
                        event.preventDefault();
                        void submitMessage();
                      }}
                    />
                    <Button
                      type="button"
                      size="sm"
                      className="shrink-0"
                      disabled={!currentMessageDraft.trim() || pendingOperation !== null}
                      onClick={() => void submitMessage()}
                    >
                      <SendIcon /> {isSending ? "Sending…" : "Send"}
                    </Button>
                  </div>
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
