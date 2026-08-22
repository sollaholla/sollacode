/**
 * Two-way sync between this client's terminal pane layout and the server's
 * per-thread layout document.
 *
 * Remote → local: a document with a revision this client has not applied is
 * projected onto the local terminal ids and adopted wholesale.
 *
 * Local → remote: when the local groups diverge from the projection of the
 * latest document (i.e. the user actually rearranged something — not just a
 * difference in which terminal ids this client knows about), the local
 * groups are pushed after a short debounce. Last write wins server-side;
 * the accepted revision is recorded so our own broadcast is not re-applied.
 */
import { type ScopedThreadRef, type TerminalThreadLayout } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { useEnvironmentQuery } from "../state/query";
import { terminalEnvironment } from "../state/terminal";
import { useAtomCommand } from "../state/use-atom-command";
import {
  localTerminalGroupsToRemote,
  projectRemoteTerminalGroups,
  terminalGroupsSyncKey,
  useTerminalUiStateStore,
} from "../terminalUiStateStore";
import type { ThreadTerminalGroup } from "../types";

export const TERMINAL_LAYOUT_PUSH_DEBOUNCE_MS = 400;

function documentMayPublishLayout(): boolean {
  return (
    typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus()
  );
}

export function useTerminalLayoutSync(input: {
  readonly threadRef: ScopedThreadRef;
  readonly terminalIds: ReadonlyArray<string>;
  readonly terminalGroups: ReadonlyArray<ThreadTerminalGroup>;
}): void {
  const { threadRef, terminalIds, terminalGroups } = input;
  const environmentId = threadRef.environmentId;
  const threadId = threadRef.threadId;
  const layouts = useEnvironmentQuery(
    threadId.length > 0 ? terminalEnvironment.layouts({ environmentId, input: null }) : null,
  );
  const doc: TerminalThreadLayout | null = useMemo(
    () => layouts.data?.find((layout) => layout.threadId === threadId) ?? null,
    [layouts.data, threadId],
  );
  const setLayoutMutation = useAtomCommand(terminalEnvironment.setLayout, {
    reportFailure: false,
  });
  const applyRemoteTerminalLayout = useTerminalUiStateStore(
    (state) => state.applyRemoteTerminalLayout,
  );
  const lastAppliedRevisionRef = useRef(0);
  const [mayPublishLayout, setMayPublishLayout] = useState(documentMayPublishLayout);

  useEffect(() => {
    const update = () => setMayPublishLayout(documentMayPublishLayout());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  useEffect(() => {
    // Thread switches reuse the hook instance; a stale revision watermark
    // from another thread must not suppress the new thread's document.
    lastAppliedRevisionRef.current = 0;
  }, [environmentId, threadId]);

  useEffect(() => {
    if (doc === null || doc.revision <= lastAppliedRevisionRef.current) {
      return;
    }
    lastAppliedRevisionRef.current = doc.revision;
    applyRemoteTerminalLayout(threadRef, doc.groups);
  }, [applyRemoteTerminalLayout, doc, threadRef]);

  useEffect(() => {
    if (threadId.length === 0) {
      return;
    }
    // Background clients remain mirrors. The server independently arbitrates
    // focused clients and gives the desktop host priority, so two visible
    // machines cannot continuously overwrite one another.
    if (!mayPublishLayout) {
      return;
    }
    if (terminalIds.length === 0 && doc === null) {
      return;
    }
    // Only genuine layout edits push: a document restricted to our ids that
    // already matches the local groups means there is nothing new to say.
    const projected = doc === null ? null : projectRemoteTerminalGroups(doc.groups, terminalIds);
    if (
      projected !== null &&
      terminalGroupsSyncKey(projected) === terminalGroupsSyncKey(terminalGroups)
    ) {
      return;
    }
    if (projected === null && terminalGroups.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      void setLayoutMutation({
        environmentId,
        input: {
          threadId,
          groups: localTerminalGroupsToRemote(terminalGroups),
          ...(doc !== null ? { baseRevision: doc.revision } : {}),
        },
      }).then((result) => {
        if (result._tag === "Success") {
          lastAppliedRevisionRef.current = Math.max(
            lastAppliedRevisionRef.current,
            result.value.revision,
          );
          // A lower-priority client receives the current authoritative layout
          // unchanged. Adopt that response immediately rather than leaving a
          // divergent local document ready to retry on its next render.
          const acceptedProjection = projectRemoteTerminalGroups(result.value.groups, terminalIds);
          if (terminalGroupsSyncKey(acceptedProjection) !== terminalGroupsSyncKey(terminalGroups)) {
            applyRemoteTerminalLayout(threadRef, result.value.groups);
          }
        }
      });
    }, TERMINAL_LAYOUT_PUSH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [
    applyRemoteTerminalLayout,
    doc,
    environmentId,
    mayPublishLayout,
    setLayoutMutation,
    terminalGroups,
    terminalIds,
    threadId,
    threadRef,
  ]);
}
