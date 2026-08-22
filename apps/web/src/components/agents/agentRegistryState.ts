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

export interface AgentEnvironmentEntry {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/**
 * Stable display order for the Agent Stack's per-host sections.
 *
 * Deliberately independent of whatever thread is focused. Ranking the focused
 * route's host first made the whole list re-sort the moment you opened a thread
 * on a remote host, so hosts swapped places underneath the pointer. Focus is
 * communicated by highlighting the active agent row, not by moving hosts: the
 * primary host stays pinned to the top and the rest stay alphabetical, so a
 * given host sits in the same place no matter where you navigate.
 */
export function sortAgentEnvironments(
  entries: ReadonlyArray<AgentEnvironmentEntry>,
  primaryEnvironmentId: EnvironmentId | null,
): ReadonlyArray<AgentEnvironmentEntry> {
  const rank = (entry: AgentEnvironmentEntry): number =>
    entry.environmentId === primaryEnvironmentId ? 0 : 1;
  return entries.toSorted(
    (left, right) =>
      rank(left) - rank(right) ||
      left.label.localeCompare(right.label) ||
      // Two hosts can share a label (same machine name, two pairings). Falling
      // through to the id keeps the comparator total, so the order is the same
      // on every render instead of depending on the input order.
      left.environmentId.localeCompare(right.environmentId),
  );
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
