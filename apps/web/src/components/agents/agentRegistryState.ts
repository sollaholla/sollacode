import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import * as Cause from "effect/Cause";

export type AgentRegistryNotice =
  | "loading"
  | "empty"
  | "disconnected"
  | "unauthorized"
  | "unavailable"
  | "stale";

export function environmentIdFromUnknown(value: unknown): EnvironmentId | null {
  return typeof value === "string" && value.trim().length > 0
    ? (value.trim() as EnvironmentId)
    : null;
}

export function resolveAgentEnvironmentId(input: {
  readonly routeEnvironmentId: EnvironmentId | null;
  readonly searchEnvironmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): EnvironmentId | null {
  return input.routeEnvironmentId ?? input.searchEnvironmentId ?? input.primaryEnvironmentId;
}

function isAgentAuthorizationFailure(cause: Cause.Cause<unknown> | null): boolean {
  if (cause === null) return false;
  const error = Cause.squash(cause);
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "EnvironmentAuthorizationError"
  );
}

export function resolveAgentRegistryNotice(input: {
  readonly hasSnapshot: boolean;
  readonly agentCount: number;
  readonly failureCause: Cause.Cause<unknown> | null;
  readonly connectionPhase: EnvironmentConnectionPhase | null;
}): AgentRegistryNotice | null {
  const hasFailure = input.failureCause !== null;
  const disconnected = input.connectionPhase !== null && input.connectionPhase !== "connected";

  if (input.hasSnapshot && input.agentCount > 0) {
    return hasFailure || disconnected ? "stale" : null;
  }
  if (isAgentAuthorizationFailure(input.failureCause)) return "unauthorized";
  if (hasFailure) return "unavailable";
  if (disconnected) return "disconnected";
  return input.hasSnapshot ? "empty" : "loading";
}

export function agentRegistryNoticeCopy(notice: Exclude<AgentRegistryNotice, "stale">): string {
  switch (notice) {
    case "loading":
      return "Loading agents…";
    case "empty":
      return "No agents yet.";
    case "disconnected":
      return "Agents are unavailable while this host is disconnected.";
    case "unauthorized":
      return "Agent access is not granted for this device. Re-pair it or grant vm:operate.";
    case "unavailable":
      return "Agents are unavailable. Try reconnecting to the host.";
  }
}
