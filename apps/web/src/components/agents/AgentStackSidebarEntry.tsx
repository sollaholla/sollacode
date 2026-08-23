import { useAtomValue } from "@effect/atom-react";
import { useParams, useRouter } from "@tanstack/react-router";
import type {
  EnvironmentId,
  VmAgent,
  VmAgentCollaborationAgentSummary,
  VmAgentStatus,
} from "@t3tools/contracts";
import { BotIcon, ChevronDownIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useUiStateStore } from "../../uiStateStore";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { vmAgentEnvironment } from "../../state/vmAgents";
import { cn } from "../../lib/utils";
import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useOnScreenKeyboard } from "../../hooks/useOnScreenKeyboard";
import { useSidebarRowSwipe } from "../useSidebarRowSwipe";
import type { SidebarSwipeDirection } from "../sidebarRowSwipe";
import { CreateAgentDialog } from "./CreateAgentDialog";
import { DeleteAgentDialog } from "./DeleteAgentDialog";
import {
  agentRegistryNoticeCopy,
  environmentIdFromUnknown,
  resolveAgentRegistryNotice,
  sortAgentEnvironments,
} from "./agentRegistryState";

const STATUS_DOT: Record<VmAgentStatus, string> = {
  provisioning: "bg-amber-500",
  starting: "bg-amber-500",
  running: "bg-emerald-500",
  stopping: "bg-amber-500",
  stopped: "bg-muted-foreground/40",
  failed: "bg-destructive",
};

const AGENT_SECTION_BODY_ID = "agent-stack-sections";

export function activeDelegationsForAgent(
  agents: ReadonlyArray<Pick<VmAgentCollaborationAgentSummary, "vmAgentId" | "activeDelegations">>,
  vmAgentId: string,
): number {
  return agents.find((agent) => agent.vmAgentId === vmAgentId)?.activeDelegations ?? 0;
}

/**
 * The Agent Stack's sidebar section, rendered directly below the orchestrator
 * entry. Lists the user's named VM agents; clicking one opens its dedicated
 * chat (with its VM as a floating window). Hidden when `agentStackEnabled` is off.
 */
export function AgentStackSidebarEntry() {
  const enabled = useClientSettings((settings) => settings.agentStackEnabled);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const expanded = useUiStateStore((state) => state.agentsSectionExpanded);
  const setExpanded = useUiStateStore((state) => state.setAgentsSectionExpanded);
  const [createForEnvironmentId, setCreateForEnvironmentId] = useState<EnvironmentId | null>(null);
  const orderedEnvironments = useMemo(() => {
    const entries = environments.map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
    }));
    if (
      primaryEnvironmentId !== null &&
      !entries.some((entry) => entry.environmentId === primaryEnvironmentId)
    ) {
      entries.push({ environmentId: primaryEnvironmentId, label: "Local host" });
    }
    return sortAgentEnvironments(entries, primaryEnvironmentId);
  }, [environments, primaryEnvironmentId]);

  // Which host's create dialog is open, hoisted so the section header can
  // raise it for the single-host case without owning a dialog per host.
  const singleEnvironmentId =
    orderedEnvironments.length === 1 ? (orderedEnvironments[0]?.environmentId ?? null) : null;

  if (!enabled || orderedEnvironments.length === 0) return null;

  return (
    <div className="mt-1 flex min-w-0 flex-col gap-1" data-agent-environment-list>
      {/* The add control belongs on this row, beside the section it adds to —
          not on a row of its own below it. It cannot go inside the toggle
          (nesting a button in a button), so the two share a flex row. */}
      <div className="flex min-w-0 items-center gap-1 pr-1">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          // Only while the body is mounted: collapsed unmounts it, and pointing
          // aria-controls at an id that is not in the document is worse than omitting it.
          aria-controls={expanded ? AGENT_SECTION_BODY_ID : undefined}
          data-testid="agents-section-toggle"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-2.5 text-left text-sm font-semibold text-sidebar-foreground/75 transition-colors hover:text-sidebar-foreground"
        >
          <span className="min-w-0 truncate">Agents</span>
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3.5 shrink-0 transition-transform", !expanded && "-rotate-90")}
          />
        </button>
        {singleEnvironmentId ? (
          <NewAgentButton onClick={() => setCreateForEnvironmentId(singleEnvironmentId)} />
        ) : null}
      </div>
      {/* Collapsed drops the sections entirely rather than hiding them: each one
          holds a live agent-registry subscription per host, and a closed section
          has no reason to keep streaming. */}
      {expanded ? (
        <div id={AGENT_SECTION_BODY_ID} className="flex min-w-0 flex-col gap-1">
          {orderedEnvironments.map((environment) => (
            <AgentEnvironmentSection
              key={environment.environmentId}
              environmentId={environment.environmentId}
              environmentLabel={environment.label}
              showEnvironmentLabel={orderedEnvironments.length > 1}
              createOpen={createForEnvironmentId === environment.environmentId}
              onCreateOpenChange={(open) =>
                setCreateForEnvironmentId(open ? environment.environmentId : null)
              }
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One agent in the sidebar, with the two ways to delete it.
 *
 * A pointer device gets an X beside the name, revealed on hover like every
 * other row action. Touch gets a slide to the right, because there is no hover
 * to reveal anything and a permanent X next to a navigation target is a
 * mis-tap waiting to happen. Both only *open* the confirmation — neither
 * deletes on its own.
 */
function AgentSidebarRow(props: {
  readonly agent: VmAgent;
  readonly activeWork: number;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly isActive: boolean;
  readonly onOpen: () => void;
  readonly onRequestDelete: () => void;
}) {
  const { agent, onRequestDelete } = props;
  const usesTouch = useOnScreenKeyboard();
  const resolveAction = useCallback(
    (direction: SidebarSwipeDirection) => (direction === "right" ? "delete" : null),
    [],
  );
  const swipe = useSidebarRowSwipe<"delete">({
    enabled: usesTouch,
    resolveAction,
    onCommit: onRequestDelete,
  });
  const { consumeSuppressedClick } = swipe;
  const handleOpen = useCallback(() => {
    // A row that slid must not also open the agent it slid.
    if (consumeSuppressedClick()) return;
    props.onOpen();
  }, [consumeSuppressedClick, props]);

  return (
    <div className="relative overflow-hidden">
      {swipe.state.offset !== 0 ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 flex items-center gap-1.5 rounded-md bg-destructive/15 px-3 text-xs font-medium text-destructive"
          style={{
            width: `${Math.abs(swipe.state.offset)}px`,
            opacity: swipe.state.armed ? 1 : 0.45 + swipe.state.progress * 0.4,
          }}
        >
          <Trash2Icon className="size-3.5 shrink-0" />
          <span className="truncate">Delete</span>
        </div>
      ) : null}
      <SidebarMenuButton
        type="button"
        isActive={props.isActive}
        onClick={handleOpen}
        aria-label={`Open ${agent.name} on ${props.environmentLabel}`}
        data-testid="agent-sidebar-entry"
        className={cn(
          "group/agent-row",
          usesTouch && "touch-pan-y",
          !swipe.state.dragging && swipe.state.offset === 0 && "transition-transform duration-200",
        )}
        style={
          swipe.state.offset === 0
            ? undefined
            : { transform: `translateX(${swipe.state.offset}px)` }
        }
        {...swipe.handlers}
      >
        <BotIcon />
        <span className="flex-1 truncate text-left">{agent.name}</span>
        {props.activeWork > 0 ? (
          <span
            className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-primary/12 px-1.5 text-[10px] font-medium tabular-nums text-primary"
            aria-label={`${props.activeWork} active ${props.activeWork === 1 ? "delegation" : "delegations"}`}
            title={`${props.activeWork} active ${props.activeWork === 1 ? "delegation" : "delegations"}`}
          >
            {props.activeWork}
          </span>
        ) : null}
        <span
          aria-hidden="true"
          title={agent.status}
          className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[agent.status])}
        />
        {/* Collapsed out of layout while hidden, not made transparent: a
            reserved-but-invisible box left the status dot sitting beside a
            hole at the row's edge. When the X appears the dot simply yields
            left; when it is away the dot holds the edge. Undrawn on touch
            rather than unmounted, because sliding is a gesture assistive tech
            cannot perform, so the control stays reachable where it is not
            painted. On pointer devices focus-within does the revealing — a
            display-collapsed element cannot be tabbed to, so focusing the row
            is what materialises the X, and the next tab stop is the X itself. */}
        <span
          role="button"
          tabIndex={0}
          aria-label={`Delete ${agent.name}`}
          title={`Delete ${agent.name}`}
          className={cn(
            "-mr-1 size-5 shrink-0 cursor-pointer items-center justify-center rounded text-sidebar-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive",
            usesTouch
              ? "sr-only"
              : "hidden group-hover/agent-row:inline-flex group-focus-within/agent-row:inline-flex",
          )}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRequestDelete();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            onRequestDelete();
          }}
        >
          <XIcon className="size-3.5" />
        </span>
      </SidebarMenuButton>
    </div>
  );
}

function NewAgentButton(props: { readonly onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="New agent"
            data-testid="agents-add"
            // The 44px target is for touch; on a fine pointer it is just a
            // tall band beside a one-line header.
            className="inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded-md px-[calc(--spacing(1)-1px)] text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground pointer-fine:min-h-7 pointer-fine:min-w-7"
            onClick={props.onClick}
          />
        }
      >
        <PlusIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="right">New agent</TooltipPopup>
    </Tooltip>
  );
}

function AgentEnvironmentSection(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly showEnvironmentLabel: boolean;
  readonly createOpen: boolean;
  readonly onCreateOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const environment = useEnvironment(props.environmentId);
  const agentsAtom = useMemo(
    () => vmAgentEnvironment.agents({ environmentId: props.environmentId, input: {} }),
    [props.environmentId],
  );
  const collaborationAtom = useMemo(
    () => vmAgentEnvironment.collaboration({ environmentId: props.environmentId, input: {} }),
    [props.environmentId],
  );
  // Held as the agent rather than an id so the dialog can name it even if the
  // row disappears from the list mid-confirmation.
  const [pendingDelete, setPendingDelete] = useState<VmAgent | null>(null);
  const activeAgentId = useParams({
    strict: false,
    select: (params) => (params as { agentId?: string }).agentId ?? null,
  });
  const activeEnvironmentId = useParams({
    strict: false,
    select: (params) =>
      environmentIdFromUnknown((params as { environmentId?: unknown }).environmentId),
  });
  const result = useAtomValue(agentsAtom);
  const collaborationResult = useAtomValue(collaborationAtom);
  const failureCause = AsyncResult.isFailure(result) ? result.cause : null;
  const latest = Option.getOrNull(AsyncResult.value(result));
  const snapshot = latest && latest.type === "snapshot" ? latest : null;
  const agents: ReadonlyArray<VmAgent> = snapshot?.agents ?? [];
  const collaborationItem = Option.getOrNull(AsyncResult.value(collaborationResult));
  const collaborationSnapshot = collaborationItem?.type === "snapshot" ? collaborationItem : null;
  const notice = resolveAgentRegistryNotice({
    hasSnapshot: snapshot !== null,
    agentCount: agents.length,
    failureCause,
    connectionPhase: environment?.connection.phase ?? null,
  });

  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-agent-environment={props.environmentId}>
      {/* Only when there is a host name to attach it to. With a single host
          the label is hidden, which left this row holding nothing but the
          button — a band of empty sidebar between the section header and the
          first agent. The header carries the button in that case. */}
      {props.showEnvironmentLabel ? (
        <div className="flex min-w-0 items-center justify-between pl-2 pr-1">
          <span
            className="min-w-0 truncate text-[11px] text-sidebar-muted-foreground/65"
            title={props.environmentLabel}
          >
            {props.environmentLabel}
          </span>
          <NewAgentButton onClick={() => props.onCreateOpenChange(true)} />
        </div>
      ) : null}

      {agents.length === 0 && notice !== null && notice !== "stale" ? (
        <p className="min-w-0 break-words px-2 py-1 text-xs leading-relaxed text-sidebar-muted-foreground/60">
          {agentRegistryNoticeCopy(notice)}
        </p>
      ) : (
        agents.map((agent) => {
          const activeWork = activeDelegationsForAgent(
            collaborationSnapshot?.agents ?? [],
            agent.vmAgentId,
          );
          return (
            <AgentSidebarRow
              key={agent.vmAgentId}
              agent={agent}
              activeWork={activeWork}
              environmentId={props.environmentId}
              environmentLabel={props.environmentLabel}
              isActive={
                agent.vmAgentId === activeAgentId && props.environmentId === activeEnvironmentId
              }
              onOpen={() =>
                void router.navigate({
                  to: "/agents/$environmentId/$agentId",
                  params: {
                    environmentId: props.environmentId,
                    agentId: agent.vmAgentId,
                  },
                })
              }
              onRequestDelete={() => setPendingDelete(agent)}
            />
          );
        })
      )}

      {agents.length > 0 && notice === "stale" ? (
        <p className="min-w-0 break-words px-2 py-1 text-[11px] leading-relaxed text-sidebar-muted-foreground/55">
          Reconnecting… showing last-known agents.
        </p>
      ) : null}

      <CreateAgentDialog
        open={props.createOpen}
        onOpenChange={props.onCreateOpenChange}
        environmentId={props.environmentId}
      />

      {pendingDelete ? (
        <DeleteAgentDialog
          open
          onOpenChange={(next) => {
            if (!next) setPendingDelete(null);
          }}
          environmentId={props.environmentId}
          agentId={pendingDelete.vmAgentId}
          agentName={pendingDelete.name}
        />
      ) : null}
    </div>
  );
}
