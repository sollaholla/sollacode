import { useAtomValue } from "@effect/atom-react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection/model";
import { createEnvironmentSessionAtoms } from "@t3tools/client-runtime/state/session";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const environmentSession = createEnvironmentSessionAtoms(connectionAtomRuntime);

const EMPTY_PREPARED_CONNECTION_ATOM = Atom.make(Option.none()).pipe(
  Atom.withLabel("web-prepared-connection:empty"),
);

export function usePreparedConnection(environmentId: EnvironmentId | null) {
  return useAtomValue(
    environmentId === null
      ? EMPTY_PREPARED_CONNECTION_ATOM
      : environmentSession.preparedConnectionValueAtom(environmentId),
  );
}

export function readPreparedConnection(environmentId: EnvironmentId) {
  return Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
}

/**
 * The environment's prepared connection, waiting up to `timeoutMs` for it.
 * The atom follows its environment only while something subscribes, so a
 * plain read comes back empty on a screen that shows nothing of that
 * environment (a call answered from its notification) or while the host is
 * still connecting. Null when it is not ready in time.
 */
export function awaitPreparedConnection(
  environmentId: EnvironmentId,
  timeoutMs: number,
): Promise<PreparedConnection | null> {
  const atom = environmentSession.preparedConnectionValueAtom(environmentId);
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const settle = (value: PreparedConnection | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Released after this tick: the listener can run inside subscribe(),
      // before its unsubscribe exists.
      queueMicrotask(() => unsubscribe?.());
      resolve(value);
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    unsubscribe = appAtomRegistry.subscribe(
      atom,
      (value) => {
        if (Option.isSome(value)) settle(value.value);
      },
      { immediate: true },
    );
  });
}
