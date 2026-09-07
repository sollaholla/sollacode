import type { ProviderAccountSwitchState } from "@t3tools/contracts";

const activeStatuses = new Set<ProviderAccountSwitchState["status"]>([
  "logging_out",
  "starting_login",
  "waiting_for_authentication",
  "waiting_for_code",
  "refreshing_account",
]);

export function isProviderAccountSwitchActive(state: ProviderAccountSwitchState): boolean {
  return activeStatuses.has(state.status);
}

/** Apply a reply only to the flow that requested it, without reviving a finished login. */
export function reconcileProviderAccountSwitch(
  current: ProviderAccountSwitchState | null,
  switchId: string,
  next: ProviderAccountSwitchState | null,
): ProviderAccountSwitchState | null {
  if (!current || current.id !== switchId) return current;
  if (!next) return null;
  if (next.id !== switchId || next.instanceId !== current.instanceId) return current;
  if (!isProviderAccountSwitchActive(current) && isProviderAccountSwitchActive(next))
    return current;
  if (next.updatedAt < current.updatedAt) return current;
  return next;
}
