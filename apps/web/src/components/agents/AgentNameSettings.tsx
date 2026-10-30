import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, VmAgent } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { vmAgentEnvironment } from "../../state/vmAgents";
import { Button } from "../ui/button";
import { RenameAgentDialog } from "./RenameAgentDialog";

export function AgentNameSettings() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const hosts = environments.map((environment) => ({
    environmentId: environment.environmentId,
    label: environment.label,
  }));
  if (primaryEnvironmentId && !hosts.some((host) => host.environmentId === primaryEnvironmentId)) {
    hosts.unshift({ environmentId: primaryEnvironmentId, label: "Local host" });
  }
  return hosts.length === 0 ? (
    <p className="text-sm text-muted-foreground">Connect an environment to manage agent names.</p>
  ) : (
    <div className="flex flex-col gap-4">
      {hosts.map((host) => (
        <EnvironmentAgentNames key={host.environmentId} {...host} />
      ))}
    </div>
  );
}

function EnvironmentAgentNames(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const atom = useMemo(
    () => vmAgentEnvironment.agents({ environmentId: props.environmentId, input: {} }),
    [props.environmentId],
  );
  const result = useAtomValue(atom);
  const latest = Option.getOrNull(AsyncResult.value(result));
  const [target, setTarget] = useState<VmAgent | null>(null);
  const agents = latest?.type === "snapshot" ? latest.agents : [];
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{props.label}</h3>
      {AsyncResult.isFailure(result) ? (
        <p role="status" className="text-sm text-muted-foreground">
          Agent names are unavailable. Reconnect this environment to rename an agent.
        </p>
      ) : latest === null ? (
        <p className="text-sm text-muted-foreground">Loading agents…</p>
      ) : agents.length === 0 ? (
        <p className="text-sm text-muted-foreground">No agents on this environment.</p>
      ) : (
        agents.map((agent) => (
          <div key={agent.vmAgentId} className="flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm">{agent.name}</p>
              <p className="truncate text-xs text-muted-foreground">@{agent.handle}</p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Rename ${agent.name}`}
              onClick={() => setTarget(agent)}
            >
              Rename
            </Button>
          </div>
        ))
      )}
      {target ? (
        <RenameAgentDialog
          environmentId={props.environmentId}
          agent={target}
          onClose={() => setTarget(null)}
        />
      ) : null}
    </div>
  );
}
