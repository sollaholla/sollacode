import type { EnvironmentId, VmAgent, VmAgentStatus } from "@t3tools/contracts";
import { LoaderCircleIcon, PowerIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { vmAgentEnvironment } from "../../state/vmAgents";

const STATUS_LABEL: Record<VmAgentStatus, string> = {
  provisioning: "Provisioning",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed",
};

export function agentStatusLabel(status: VmAgentStatus): string {
  return STATUS_LABEL[status];
}

/** Whether the user can flip the switch right now (not mid-transition). */
export function agentPowerSwitchable(status: VmAgentStatus): boolean {
  return status === "running" || status === "stopped" || status === "failed";
}

/** The status dot: green while running, grey when off, red when failed. */
export function agentStatusDotClass(status: VmAgentStatus): string {
  switch (status) {
    case "running":
      return "bg-ok";
    case "failed":
      return "bg-destructive";
    case "stopped":
      return "bg-muted-foreground/40";
    case "provisioning":
    case "starting":
    case "stopping":
      return "bg-warning";
  }
}

export function agentPowerActionLabel(status: VmAgentStatus): "Stop" | "Start" {
  return status === "running" ? "Stop" : "Start";
}

export function agentPowerTitle(agent: Pick<VmAgent, "name" | "status">): string {
  return agent.status === "running"
    ? `Stop ${agent.name}: interrupts its current turn and pauses scheduled tasks`
    : `Start ${agent.name}: scheduled tasks resume`;
}

/**
 * One hook for every start/stop control. Returns the command to run for the
 * agent's current state and whether a request is in flight.
 */
export function useAgentPowerToggle(environmentId: EnvironmentId) {
  const startAgent = useAtomCommand(vmAgentEnvironment.start);
  const stopAgent = useAtomCommand(vmAgentEnvironment.stop);
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);
  const toggle = async (agent: Pick<VmAgent, "vmAgentId" | "status">) => {
    if (busyAgentId !== null || !agentPowerSwitchable(agent.status)) return;
    setBusyAgentId(agent.vmAgentId);
    try {
      await (agent.status === "running" ? stopAgent : startAgent)({
        environmentId,
        input: { vmAgentId: agent.vmAgentId },
      });
    } finally {
      setBusyAgentId(null);
    }
  };
  return { toggle, busyAgentId };
}

/**
 * The header switch: a pill reading "● Running · Stop" or "○ Stopped · Start".
 * The stopped state carries the gold tint so the way back on is the thing
 * that stands out.
 */
export function AgentPowerToggle(props: {
  readonly agent: VmAgent;
  readonly environmentId: EnvironmentId;
  readonly className?: string;
}) {
  const { agent } = props;
  const { toggle, busyAgentId } = useAgentPowerToggle(props.environmentId);
  const busy = busyAgentId === agent.vmAgentId;
  const running = agent.status === "running";
  const switchable = agentPowerSwitchable(agent.status);
  return (
    <button
      type="button"
      aria-pressed={running}
      aria-label={`${agentPowerActionLabel(agent.status)} ${agent.name}`}
      aria-busy={busy || undefined}
      title={agentPowerTitle(agent)}
      data-agent-power={agent.status}
      disabled={busy || !switchable}
      onClick={() => void toggle(agent)}
      className={cn(
        "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[12px] font-medium outline-hidden transition-[background-color,border-color,color] duration-150 focus-visible:ring-2 focus-visible:ring-gold-500/40 disabled:cursor-default disabled:opacity-60",
        running
          ? "border-[var(--line)] bg-surface-row text-foreground hover:bg-surface-hover"
          : "border-[var(--gold-line)] bg-[var(--gold-tint)] text-foreground hover:bg-gold-500/20",
        props.className,
      )}
    >
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", agentStatusDotClass(agent.status))}
      />
      <span>{agentStatusLabel(agent.status)}</span>
      {switchable ? (
        <>
          <span aria-hidden className="text-muted-foreground/70">
            ·
          </span>
          <span className="inline-flex items-center gap-1">
            {busy ? (
              <LoaderCircleIcon className="size-3 animate-spin" aria-hidden />
            ) : (
              <PowerIcon className="size-3" aria-hidden />
            )}
            {agentPowerActionLabel(agent.status)}
          </span>
        </>
      ) : null}
    </button>
  );
}
