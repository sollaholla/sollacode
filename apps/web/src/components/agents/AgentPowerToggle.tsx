import type { EnvironmentId, VmAgent, VmAgentStatus } from "@t3tools/contracts";
import { agentPresence } from "@t3tools/client-runtime/state/agent-appearance";
import { LoaderCircleIcon, PowerIcon } from "lucide-react";
import { useState } from "react";

import { chooseInApp } from "../ui/appConfirm";
import { ToolbarControl } from "../ui/toolbar-control";

import { cn } from "../../lib/utils";
import { useEnvironment } from "../../state/environments";
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
      if (agent.status === "running") {
        await stopAgent({ environmentId, input: { vmAgentId: agent.vmAgentId } });
        return;
      }
      const result = await startAgent({ environmentId, input: { vmAgentId: agent.vmAgentId } });
      if (result._tag !== "Success" || !("backlogCount" in result.value)) return;
      const choice = await chooseInApp(
        `${result.value.backlogCount} overdue tasks are waiting. Combine them into one catch-up message, or skip those occurrences and resume future schedules. Original task instructions are retained.`,
        {
          confirmLabel: "Combine and start",
          alternateLabel: "Skip backlog and start",
          cancelLabel: "Cancel",
        },
      );
      if (choice === "cancel") return;
      await startAgent({
        environmentId,
        input: { vmAgentId: agent.vmAgentId, backlog: choice === "confirm" ? "combine" : "skip" },
      });
    } finally {
      setBusyAgentId(null);
    }
  };
  return { toggle, busyAgentId };
}

/**
 * The header switch: a pill reading "● Running · Stop" or "○ Stopped · Start".
 * The stopped state carries a gold outline so the way back on is the thing
 * that stands out.
 */
export function AgentPowerToggle(props: {
  readonly agent: VmAgent;
  readonly environmentId: EnvironmentId;
  readonly className?: string;
}) {
  const { agent } = props;
  const environment = useEnvironment(props.environmentId);
  const connected = environment?.connection.phase === "connected";
  const presence = agentPresence(agent.status, connected);
  const { toggle, busyAgentId } = useAgentPowerToggle(props.environmentId);
  const busy = busyAgentId === agent.vmAgentId;
  const running = agent.status === "running";
  const switchable = agentPowerSwitchable(agent.status);
  return (
    <ToolbarControl
      type="button"
      aria-pressed={running}
      aria-label={`${agentPowerActionLabel(agent.status)} ${agent.name}`}
      aria-busy={busy || undefined}
      title={`${presence.description}. ${agentPowerTitle(agent)}`}
      data-agent-power={agent.status}
      disabled={busy || !switchable || !connected}
      onClick={() => void toggle(agent)}
      className={cn(
        running
          ? "border-[var(--line)] bg-transparent text-foreground hover:border-foreground/40"
          : "border-[var(--gold-line)] bg-transparent text-foreground hover:border-gold-500",
        props.className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          presence.online ? "bg-ok" : "bg-muted-foreground/50",
        )}
      />
      <span>{connected ? agentStatusLabel(agent.status) : "Offline"}</span>
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
    </ToolbarControl>
  );
}
