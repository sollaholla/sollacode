"use client";

import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useRef } from "react";

import {
  applyPreviewServerEvent,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
} from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";

class PreviewSessionThreadKeyParseError extends Schema.TaggedErrorClass<PreviewSessionThreadKeyParseError>()(
  "PreviewSessionThreadKeyParseError",
  { threadKey: Schema.String },
) {
  override get message(): string {
    return `Invalid scoped preview thread key: ${this.threadKey}`;
  }
}

const previewSessionSyncAtom = Atom.family((threadKey: string) => {
  const threadRef = parseScopedThreadKey(threadKey);
  if (threadRef === null) {
    throw new PreviewSessionThreadKeyParseError({ threadKey });
  }

  const sessionsAtom = previewEnvironment.list({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  const eventsAtom = previewEnvironment.events({
    environmentId: threadRef.environmentId,
    input: {},
  });

  return Atom.make((get) => {
    let disposed = false;
    let eventsVersion = 0;

    const reconcileSessions = (result: Atom.Type<typeof sessionsAtom>) => {
      if (!AsyncResult.isSuccess(result)) return;
      reconcilePreviewServerSessions(threadRef, result.value);
    };

    const applyLatestEvent = (result: Atom.Type<typeof eventsAtom>) => {
      if (!AsyncResult.isSuccess(result) || result.value.threadId !== threadRef.threadId) return;
      const currentEpoch = readThreadPreviewState(threadRef).serverEpoch;
      if (currentEpoch !== null && currentEpoch !== result.value.serverEpoch) {
        get.refresh(sessionsAtom);
        return;
      }
      applyPreviewServerEvent(threadRef, result.value);
    };

    get.addFinalizer(() => {
      disposed = true;
    });
    const initialEvent = get.once(eventsAtom);
    get.subscribe(sessionsAtom, (result) => {
      reconcileSessions(result);
    });
    get.subscribe(eventsAtom, (result) => {
      eventsVersion += 1;
      applyLatestEvent(result);
    });
    queueMicrotask(() => {
      if (disposed) return;
      // The cached list can predate an automation-created tab. Keep the local
      // snapshot visible until an authoritative refresh arrives instead of
      // reconciling against a stale empty result when the panel first mounts.
      get.refresh(sessionsAtom);
      if (eventsVersion === 0) applyLatestEvent(initialEvent);
    });
  }).pipe(Atom.setIdleTTL(1_000), Atom.withLabel(`preview:session-sync:${threadKey}`));
});

export function usePreviewSession(threadRef: ScopedThreadRef): void {
  const threadKey = scopedThreadKey(threadRef);
  const sessionsAtom = previewEnvironment.list({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  const sessionsResult = useAtomValue(sessionsAtom);
  const mountedListStateRef = useRef<{
    threadKey: string;
    result: typeof sessionsResult;
    deferred: boolean;
  } | null>(null);

  // Mount the list query directly in React. A derived atom that only subscribes
  // to the query can remain dormant during connection bootstrap, which leaves
  // restored tabs invisible until an automation request lists them explicitly.
  useEffect(() => {
    const mountedListState =
      mountedListStateRef.current?.threadKey === threadKey
        ? mountedListStateRef.current
        : { threadKey, result: sessionsResult, deferred: false };
    mountedListStateRef.current = mountedListState;
    if (!AsyncResult.isSuccess(sessionsResult)) return;
    const current = readThreadPreviewState(threadRef);
    if (sessionsResult === mountedListState.result && Object.keys(current.sessions).length > 0) {
      // A mounted SWR value can predate a tab created by background automation.
      // Keep that newer local tab until the forced refresh below completes.
      mountedListState.deferred = true;
      return;
    }
    if (mountedListState.deferred && sessionsResult.waiting) return;
    reconcilePreviewServerSessions(threadRef, sessionsResult.value);
  }, [sessionsResult, threadKey, threadRef]);

  useAtomValue(previewSessionSyncAtom(threadKey));
}
