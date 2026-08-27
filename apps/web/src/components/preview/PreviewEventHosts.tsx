"use client";

import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type PreviewEvent, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { isElectron } from "~/env";
import { applyPreviewServerEvent, reconcilePreviewEnvironmentSessions } from "~/previewStateStore";
import { useEnvironments } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";

export function applyPreviewEventForEnvironment(
  environmentId: EnvironmentId,
  event: PreviewEvent,
): void {
  applyPreviewServerEvent(scopeThreadRef(environmentId, ThreadId.make(event.threadId)), event);
}

export function applyPreviewListForEnvironment(
  environmentId: EnvironmentId,
  result: Parameters<typeof reconcilePreviewEnvironmentSessions>[1],
): void {
  reconcilePreviewEnvironmentSessions(environmentId, result);
}

const previewEventHostAtom = Atom.family((environmentId: EnvironmentId) => {
  const eventsAtom = previewEnvironment.events({ environmentId, input: {} });
  const sessionsAtom = previewEnvironment.list({ environmentId, input: {} });
  return Atom.make((get) => {
    let disposed = false;
    let eventsVersion = 0;
    let catchupRequested = false;
    const applyEvent = (result: Atom.Type<typeof eventsAtom>) => {
      if (AsyncResult.isSuccess(result)) {
        applyPreviewEventForEnvironment(environmentId, result.value);
      }
    };
    const reconcileSessions = (result: Atom.Type<typeof sessionsAtom>) => {
      if (catchupRequested && AsyncResult.isSuccess(result) && !result.waiting) {
        applyPreviewListForEnvironment(environmentId, result.value);
      }
    };

    const initialEvent = get.once(eventsAtom);
    get.subscribe(eventsAtom, (result) => {
      eventsVersion += 1;
      applyEvent(result);
    });
    get.subscribe(sessionsAtom, reconcileSessions);
    queueMicrotask(() => {
      if (disposed) return;
      if (eventsVersion === 0) applyEvent(initialEvent);
      // Never adopt the cached SWR value: it may predate a remote close or
      // background open. This fresh query also reruns automatically for every
      // connection generation.
      catchupRequested = true;
      get.refresh(sessionsAtom);
    });
    get.addFinalizer(() => {
      disposed = true;
    });
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`preview:event-host:${environmentId}`));
});

function PreviewEventHost({ environmentId }: { readonly environmentId: EnvironmentId }) {
  useAtomValue(previewEventHostAtom(environmentId));
  return null;
}

/** Keep every environment's live browser events independent of the routed thread. */
export function PreviewEventHosts() {
  const { environments } = useEnvironments();
  if (!isElectron) return null;
  return environments.map((environment) => (
    <PreviewEventHost key={environment.environmentId} environmentId={environment.environmentId} />
  ));
}
