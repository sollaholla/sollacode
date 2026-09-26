import {
  projectDeferredThreadSnapshot,
  rememberThreadShells,
} from "../operations/deferredThreadCommandState.ts";
import type { DeferredThreadCommandEntry } from "../platform/persistence.ts";
import { EnvironmentId, type OrchestrationShellSnapshot } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

export interface ArchivedSnapshotEntry {
  readonly environmentId: EnvironmentId;
  readonly snapshot: OrchestrationShellSnapshot;
}

export interface ArchivedThreadSnapshotsState {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
}

const ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR = "\u001f";
const environmentIdOrder = Order.String as Order.Order<EnvironmentId>;

export function makeArchivedThreadsEnvironmentKey(
  environmentIds: ReadonlyArray<EnvironmentId>,
): string {
  return pipe(environmentIds, Arr.sort(environmentIdOrder), (sortedEnvironmentIds) =>
    sortedEnvironmentIds.join(ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR),
  );
}

export function parseArchivedThreadsEnvironmentKey(key: string): ReadonlyArray<EnvironmentId> {
  if (key.length === 0) {
    return [];
  }
  return pipe(
    key.split(ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR),
    Arr.map((environmentId) => EnvironmentId.make(environmentId)),
  );
}

export function createArchivedThreadSnapshotsAtomFamily<E>(options: {
  readonly getSnapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationShellSnapshot, E>>;
  readonly labelPrefix: string;
  readonly getPendingAtom?: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<readonly DeferredThreadCommandEntry[], unknown>>;
  readonly getActiveSnapshotAtom?: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationShellSnapshot | null>;
}) {
  return Atom.family((environmentKey: string) =>
    Atom.make((get): ArchivedThreadSnapshotsState => {
      const snapshots: ArchivedSnapshotEntry[] = [];
      let error: string | null = null;
      let isLoading = false;

      for (const environmentId of parseArchivedThreadsEnvironmentKey(environmentKey)) {
        const result = get(options.getSnapshotAtom(environmentId));

        const pending = options.getPendingAtom
          ? Option.getOrElse(
              AsyncResult.value(get(options.getPendingAtom(environmentId))),
              () => [],
            )
          : [];
        isLoading ||= result.waiting && pending.length === 0;
        const remoteSnapshot = Option.getOrNull(AsyncResult.value(result));
        if (remoteSnapshot) rememberThreadShells(environmentId, remoteSnapshot.threads);
        const active = options.getActiveSnapshotAtom
          ? get(options.getActiveSnapshotAtom(environmentId))
          : null;
        const snapshot =
          remoteSnapshot ?? (active && pending.length ? { ...active, threads: [] } : null);
        if (snapshot !== null) {
          snapshots.push({
            environmentId,
            snapshot: projectDeferredThreadSnapshot(snapshot, pending, true),
          });
        }

        if (error === null && result._tag === "Failure" && !pending.length) {
          error = "Failed to load archived threads.";
        }
      }

      return { snapshots, error, isLoading };
    }).pipe(Atom.withLabel(`${options.labelPrefix}:${environmentKey}`)),
  );
}
