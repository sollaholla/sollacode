"use client";

import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type PreviewEvent, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useRef } from "react";

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
  return Atom.make((get) => {
    let disposed = false;
    let eventsVersion = 0;
    const applyEvent = (result: Atom.Type<typeof eventsAtom>) => {
      if (AsyncResult.isSuccess(result)) {
        applyPreviewEventForEnvironment(environmentId, result.value);
      }
    };

    const initialEvent = get.once(eventsAtom);
    get.subscribe(eventsAtom, (result) => {
      eventsVersion += 1;
      applyEvent(result);
    });
    queueMicrotask(() => {
      if (disposed) return;
      if (eventsVersion === 0) applyEvent(initialEvent);
    });
    get.addFinalizer(() => {
      disposed = true;
    });
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`preview:event-host:${environmentId}`));
});

function PreviewEventHost({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const sessionsAtom = previewEnvironment.list({ environmentId, input: {} });
  const sessionsResult = useAtomValue(sessionsAtom);
  const refreshSessions = useAtomRefresh(sessionsAtom);
  const catchupRequestedRef = useRef(false);

  useEffect(() => {
    if (!catchupRequestedRef.current) {
      // Mount the list query directly in React. A derived atom that only
      // subscribes to it can remain dormant during connection bootstrap,
      // which otherwise leaves restored background guests unloaded until the
      // user focuses one of their threads.
      catchupRequestedRef.current = true;
      void refreshSessions();
      return;
    }
    // Never adopt the cached or waiting SWR value: it may predate a remote
    // close or background open. The query reruns for every connection
    // generation, and only its settled result is an authoritative catch-up.
    if (AsyncResult.isSuccess(sessionsResult) && !sessionsResult.waiting) {
      applyPreviewListForEnvironment(environmentId, sessionsResult.value);
    }
  }, [environmentId, refreshSessions, sessionsResult]);

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
