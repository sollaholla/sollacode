import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Whether the machine an environment runs on is somewhere other than in front
 * of the user, so its battery, disk, and screen are worth surfacing.
 *
 * The one case that is not remote is the desktop app viewing its own primary
 * environment. A phone or browser viewing its *primary* environment is still a
 * remote device (that environment's desktop is elsewhere), which is why the
 * environment id alone cannot decide this. An unknown primary is not evidence
 * of anything, so it answers no.
 */
export function isRemoteDeviceEnvironment(input: {
  readonly activeEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
  /** True when this client IS the desktop app — i.e. the machine itself. */
  readonly isDesktopApp: boolean;
}): boolean {
  if (input.primaryEnvironmentId === null) return false;
  return !(input.activeEnvironmentId === input.primaryEnvironmentId && input.isDesktopApp);
}
