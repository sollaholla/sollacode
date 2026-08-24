import type { VmAgentCollaborationAgentSummary } from "@t3tools/contracts";
import { MessageSquareIcon, SparklesIcon } from "lucide-react";

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
import { Radio, RadioGroup } from "~/components/ui/radio-group";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";

export const EPHEMERAL_DELEGATION_TARGET = "__ephemeral__";

export interface AgentCollaborationDraft {
  readonly targetId: string;
  readonly task: string;
}

export const EMPTY_AGENT_COLLABORATION_DRAFT: AgentCollaborationDraft = {
  targetId: EPHEMERAL_DELEGATION_TARGET,
  task: "",
};

const AVAILABILITY_LABEL: Readonly<Record<string, string>> = {
  available: "Available",
  busy: "Busy",
  offline: "Offline",
  failed: "Unavailable",
  "user-control": "In use",
};

const AVAILABILITY_DOT: Readonly<Record<string, string>> = {
  available: "bg-success",
  busy: "bg-warning",
  offline: "bg-muted-foreground/40",
  failed: "bg-destructive",
  "user-control": "bg-muted-foreground/40",
};

function TargetRow(props: {
  readonly value: string;
  readonly selected: boolean;
  readonly disabled?: boolean;
  readonly icon?: "sparkles";
  readonly name: string;
  readonly purpose: string;
  readonly availability?: string;
  readonly capabilities?: ReadonlyArray<string>;
}) {
  const capabilities = (props.capabilities ?? [])
    .map((capability) => {
      if (capability === "workspace.tasks") return "Tasks";
      if (capability === "workspace.consult") return "Consult";
      if (capability === "browser.preview") return "Browser";
      return null;
    })
    .filter((capability) => capability !== null)
    .slice(0, 3);

  return (
    <label
      className={cn(
        "flex min-w-0 items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
        "has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-offset-1 has-focus-visible:ring-offset-background",
        props.disabled
          ? "cursor-not-allowed opacity-55"
          : "cursor-pointer hover:border-foreground/20 hover:bg-muted/45",
        props.selected && !props.disabled && "border-primary bg-primary/5 ring-1 ring-primary/25",
      )}
    >
      <Radio value={props.value} disabled={props.disabled} className="mt-0.5" />
      {props.icon === "sparkles" ? (
        <SparklesIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{props.name}</span>
          {props.availability ? (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <span
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full",
                  AVAILABILITY_DOT[props.availability] ?? "bg-muted-foreground/40",
                )}
              />
              {AVAILABILITY_LABEL[props.availability] ?? props.availability}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block line-clamp-1 break-words text-xs text-muted-foreground">
          {props.purpose}
        </span>
        {capabilities.length > 0 ? (
          <span className="mt-1 block truncate text-[11px] text-muted-foreground/75">
            {capabilities.join(" · ")}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export function CreateDelegationDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly collaborators: ReadonlyArray<VmAgentCollaborationAgentSummary>;
  readonly draft: AgentCollaborationDraft;
  readonly onDraftChange: (draft: AgentCollaborationDraft) => void;
  readonly onReview: () => void;
  readonly threadAvailable: boolean;
  readonly hasMoreCollaborators: boolean;
}) {
  const selectedNamedAgent =
    props.draft.targetId === EPHEMERAL_DELEGATION_TARGET
      ? null
      : props.collaborators.find((agent) => agent.vmAgentId === props.draft.targetId);
  const selectedTargetMissing =
    props.draft.targetId !== EPHEMERAL_DELEGATION_TARGET && selectedNamedAgent === undefined;
  const selectedTargetUnavailable = selectedNamedAgent?.canReceiveDelegation === false;
  const canReview =
    props.threadAvailable &&
    props.draft.task.trim().length > 0 &&
    !selectedTargetMissing &&
    !selectedTargetUnavailable;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="w-full max-w-xl min-w-0">
        <DialogHeader>
          <DialogTitle>New handoff</DialogTitle>
          <DialogDescription>
            Choose a collaborator and prepare a bounded task for the root agent to review.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="flex flex-col gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            <span
              id="delegation-target-label"
              className="text-xs font-medium text-muted-foreground"
            >
              Delegate to
            </span>
            <RadioGroup
              aria-labelledby="delegation-target-label"
              value={props.draft.targetId}
              className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2"
              onValueChange={(targetId) => props.onDraftChange({ ...props.draft, targetId })}
            >
              <TargetRow
                value={EPHEMERAL_DELEGATION_TARGET}
                selected={props.draft.targetId === EPHEMERAL_DELEGATION_TARGET}
                icon="sparkles"
                name="One-off helper"
                purpose="A temporary worker dedicated to this handoff."
              />
              {props.collaborators.map((agent) => (
                <TargetRow
                  key={agent.vmAgentId}
                  value={agent.vmAgentId}
                  selected={props.draft.targetId === agent.vmAgentId}
                  disabled={!agent.canReceiveDelegation}
                  name={agent.name}
                  purpose={agent.purpose}
                  availability={agent.availability}
                  capabilities={agent.capabilities}
                />
              ))}
            </RadioGroup>
            {props.collaborators.length === 0 && !props.hasMoreCollaborators ? (
              <p className="text-[11px] text-muted-foreground">
                Other named agents will appear here when they are available on this host.
              </p>
            ) : null}
            {props.hasMoreCollaborators ? (
              <p className="rounded-md border bg-muted/25 px-2.5 py-2 text-[11px] text-muted-foreground">
                This host has additional agents outside the bounded live roster, so some targets are
                not shown here.
              </p>
            ) : null}
            {selectedTargetMissing ? (
              <p role="alert" className="text-xs text-destructive">
                The selected agent is no longer available. Choose another collaborator.
              </p>
            ) : selectedTargetUnavailable ? (
              <p role="alert" className="text-xs text-warning-foreground">
                This agent cannot receive delegated work right now.
              </p>
            ) : null}
          </div>

          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor="delegation-task" className="text-xs font-medium text-muted-foreground">
              Task
            </label>
            <Textarea
              id="delegation-task"
              rows={4}
              maxLength={50_000}
              value={props.draft.task}
              className="[&_[data-slot=textarea]]:max-h-48 [&_[data-slot=textarea]]:overflow-y-auto"
              placeholder="Describe the outcome, what done looks like, and anything they’ll need."
              onChange={(event) =>
                props.onDraftChange({ ...props.draft, task: event.target.value })
              }
            />
            <div className="flex min-w-0 items-center justify-between gap-3 text-[11px] text-muted-foreground">
              <span className="min-w-0">
                You can edit the generated request in chat before anything starts.
              </span>
              {props.draft.task.length > 40_000 ? (
                <span className="shrink-0 tabular-nums">
                  {props.draft.task.length.toLocaleString()} / 50,000
                </span>
              ) : null}
            </div>
          </div>
        </DialogPanel>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
            Keep draft
          </Button>
          <Button type="button" disabled={!canReview} onClick={props.onReview}>
            <MessageSquareIcon /> Review in chat
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
