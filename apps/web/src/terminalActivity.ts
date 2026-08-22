import type { KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";
import type { ProviderDriverKind } from "@t3tools/contracts";
import {
  terminalCommandProviderDriver,
  terminalSubprocessIsWorking,
} from "@t3tools/shared/terminalProvider";

export interface WorkingTerminalActivity {
  readonly count: number;
  readonly terminalIds: readonly string[];
  readonly startedAt: string | null;
  /** Set when every working pane is the same provider CLI. */
  readonly driverKind: ProviderDriverKind | null;
  readonly displayName: string | null;
}

function firstValidIso(...candidates: ReadonlyArray<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined && !Number.isNaN(Date.parse(candidate))) {
      return candidate;
    }
  }
  return null;
}

export function deriveWorkingTerminalActivity(
  sessions: ReadonlyArray<KnownTerminalSession>,
): WorkingTerminalActivity | null {
  const working = sessions.filter((session) =>
    terminalSubprocessIsWorking({
      hasRunningSubprocess: session.state.hasRunningSubprocess,
      command: session.state.summary?.label,
      history: session.state.buffer,
      working: session.state.working,
    }),
  );
  if (working.length === 0) {
    return null;
  }

  const startedAt =
    working
      .map((session) =>
        // `updatedAt` bumps on every output chunk, so alone it renders a
        // "Working 2s" clock that resets forever; workingSince is the actual
        // start of the pane's current turn.
        firstValidIso(
          session.state.summary?.workingSince,
          session.state.updatedAt,
          session.state.summary?.updatedAt,
        ),
      )
      .filter((value): value is string => value !== null)
      .toSorted((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;

  const drivers = new Set<ProviderDriverKind>();
  let displayName: string | null = null;
  for (const session of working) {
    const label = session.state.summary?.label ?? null;
    const driver = terminalCommandProviderDriver(label);
    if (driver === null) {
      continue;
    }
    drivers.add(driver);
    displayName = label;
  }

  return {
    count: working.length,
    terminalIds: working.map((session) => session.target.terminalId),
    startedAt,
    driverKind: drivers.size === 1 ? (drivers.values().next().value ?? null) : null,
    displayName: drivers.size === 1 ? displayName : null,
  };
}
