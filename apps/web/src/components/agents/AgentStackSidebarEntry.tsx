import { useAtomValue } from "@effect/atom-react";
import { useParams, useRouter } from "@tanstack/react-router";
import type {
  EnvironmentId,
  VmAgent,
  VmAgentCollaborationAgentSummary,
  VmAgentStatus,
} from "@t3tools/contracts";
import { BotIcon, PlusIcon } from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { vmAgentEnvironment } from "../../state/vmAgents";
import { cn } from "../../lib/utils";
import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CreateAgentDialog } from "./CreateAgentDialog";
import {
  agentRegistryNoticeCopy,
  environmentIdFromUnknown,
  resolveAgentRegistryNotice,
} from "./agentRegistryState";

const STATUS_DOT: Record<VmAgentStatus, string> = {
  provisioning: "bg-amber-500",
  starting: "bg-amber-500",
  running: "bg-emerald-500",
  stopping: "bg-amber-500",
  stopped: "bg-muted-foreground/40",
  failed: "bg-destructive",
};

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
  const routeEnvironmentId = useParams({
    strict: false,
    select: (params) =>
      environmentIdFromUnknown((params as { environmentId?: unknown }).environmentId),
  });
  const orderedEnvironments = useMemo(() => {
    const entries = environments.map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
    }));
    if (
      primaryEnvironmentId !== null &&
      !entries.some((entry) => entry.environmentId === primaryEnvironmentId)
    ) {
      entries.unshift({ environmentId: primaryEnvironmentId, label: "Local host" });
    }
    return entries.toSorted((left, right) => {
      if (left.environmentId === routeEnvironmentId) return -1;
      if (right.environmentId === routeEnvironmentId) return 1;
      if (left.environmentId === primaryEnvironmentId) return -1;
      if (right.environmentId === primaryEnvironmentId) return 1;
      return left.label.localeCompare(right.label);
    });
  }, [environments, primaryEnvironmentId, routeEnvironmentId]);

  if (!enabled || orderedEnvironments.length === 0) return null;

  return (
    <div className="mt-1 flex min-w-0 flex-col gap-1" data-agent-environment-list>
      <div className="px-2 text-xs font-medium text-sidebar-muted-foreground/80">Agents</div>
      {orderedEnvironments.map((environment) => (
        <AgentEnvironmentSection
          key={environment.environmentId}
          environmentId={environment.environmentId}
          environmentLabel={environment.label}
          showEnvironmentLabel={orderedEnvironments.length > 1}
        />
      ))}
    </div>
  );
}

function AgentEnvironmentSection(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly showEnvironmentLabel: boolean;
}) {
  const router = useRouter();
  const environment = useEnvironment(props.environmentId);
  const [createOpen, setCreateOpen] = useState(false);
  const agentsAtom = useMemo(
    () => vmAgentEnvironment.agents({ environmentId: props.environmentId, input: {} }),
    [props.environmentId],
  );
  const collaborationAtom = useMemo(
    () => vmAgentEnvironment.collaboration({ environmentId: props.environmentId, input: {} }),
    [props.environmentId],
  );
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
      <div className="flex min-w-0 items-center justify-between pl-2 pr-1">
        <span
          className={cn(
            "min-w-0 truncate text-[11px] text-sidebar-muted-foreground/65",
            !props.showEnvironmentLabel && "sr-only",
          )}
          title={props.environmentLabel}
        >
          {props.environmentLabel}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="New agent"
                data-testid="agents-add"
                className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md px-[calc(--spacing(1)-1px)] text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                onClick={() => setCreateOpen(true)}
              />
            }
          >
            <PlusIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="right">New agent</TooltipPopup>
        </Tooltip>
      </div>

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
            <SidebarMenuButton
              key={agent.vmAgentId}
              type="button"
              isActive={
                agent.vmAgentId === activeAgentId && props.environmentId === activeEnvironmentId
              }
              onClick={() =>
                void router.navigate({
                  to: "/agents/$environmentId/$agentId",
                  params: {
                    environmentId: props.environmentId,
                    agentId: agent.vmAgentId,
                  },
                })
              }
              aria-label={`Open ${agent.name} on ${props.environmentLabel}`}
              data-testid="agent-sidebar-entry"
            >
              <BotIcon />
              <span className="flex-1 truncate text-left">{agent.name}</span>
              {activeWork > 0 ? (
                <span
                  className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-primary/12 px-1.5 text-[10px] font-medium tabular-nums text-primary"
                  aria-label={`${activeWork} active ${activeWork === 1 ? "delegation" : "delegations"}`}
                  title={`${activeWork} active ${activeWork === 1 ? "delegation" : "delegations"}`}
                >
                  {activeWork}
                </span>
              ) : null}
              <span
                aria-hidden="true"
                title={agent.status}
                className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[agent.status])}
              />
            </SidebarMenuButton>
          );
        })
      )}

      {agents.length > 0 && notice === "stale" ? (
        <p className="min-w-0 break-words px-2 py-1 text-[11px] leading-relaxed text-sidebar-muted-foreground/55">
          Reconnecting… showing last-known agents.
        </p>
      ) : null}

      <CreateAgentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        environmentId={props.environmentId}
      />
    </div>
  );
}
