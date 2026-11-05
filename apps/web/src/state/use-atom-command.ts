import { RegistryContext } from "@effect/atom-react";
import {
  type AtomCommand,
  type AtomCommandOptions,
  type AtomCommandResult,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useContext } from "react";

export function useAtomCommand<A, E, W>(
  command: AtomCommand<W, A, E>,
  options?: string | AtomCommandOptions,
): (value: W) => Promise<AtomCommandResult<A, E>> {
  const registry = useContext(RegistryContext);
  const label = typeof options === "string" ? options : (options?.label ?? command.label);
  const reportFailure = typeof options === "string" ? true : (options?.reportFailure ?? true);
  const reportDefect = typeof options === "string" ? true : (options?.reportDefect ?? true);

  // Stable on purpose: callers hand this to memoised values, and a fresh function
  // each render rebuilt every markdown message's components, remounting its nodes.
  return useCallback(
    (value: W) => runAtomCommand(registry, command, value, { label, reportFailure, reportDefect }),
    [command, label, registry, reportDefect, reportFailure],
  );
}
