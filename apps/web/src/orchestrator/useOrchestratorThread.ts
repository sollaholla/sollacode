import { useMemo } from "react";
import {
  isOrchestratorThreadId,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { useThreadShells } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";

export interface OrchestratorThreadTarget {
  readonly ref: ScopedThreadRef;
  readonly shell: EnvironmentThreadShell;
}

/**
 * Resolves the singleton orchestrator thread on the primary environment.
 *
 * A thread physically lives in exactly one environment's database, but the user
 * may be connected to several (a local host plus a remote one). Every server
 * seeds a physical copy, but only the primary environment's copy represents the
 * app-wide orchestrator. Falling back to another server makes the singleton
 * appear remote and routes its tools to the wrong machine.
 *
 * Returns null while the primary environment or its shell is unavailable —
 * callers should render nothing rather than silently selecting a remote copy.
 */
export function resolvePrimaryOrchestratorThread(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  primaryEnvironmentId: EnvironmentId | null,
): OrchestratorThreadTarget | null {
  if (primaryEnvironmentId === null) return null;
  const shell = shells.find(
    (candidate) =>
      candidate.environmentId === primaryEnvironmentId && isOrchestratorThreadId(candidate.id),
  );
  if (!shell) return null;
  return {
    ref: scopeThreadRef(shell.environmentId, shell.id),
    shell,
  };
}

export function useOrchestratorThread(): OrchestratorThreadTarget | null {
  const shells = useThreadShells();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  return useMemo(
    () => resolvePrimaryOrchestratorThread(shells, primaryEnvironmentId),
    [shells, primaryEnvironmentId],
  );
}
