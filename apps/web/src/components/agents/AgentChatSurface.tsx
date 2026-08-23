import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import ChatView from "../ChatView";
import { useThreadDetail, useThreadShell, useThreadStatus } from "../../state/entities";
import { resolveThreadSyncPhase } from "../../threadSync";

/**
 * The agent's chat, rendered with the exact same {@link ChatView} the normal
 * chat and the orchestrator use — model switcher, composer, message timeline,
 * everything — pointed at the agent's dedicated thread. Mirrors the mounting in
 * `_chat.$environmentId.$threadId`.
 */
export function AgentChatSurface(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
  const serverThreadShell = useThreadShell(threadRef);
  const serverThreadDetail = useThreadDetail(threadRef);
  const serverThreadStatus = useThreadStatus(threadRef);
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: serverThreadDetail !== null,
    shellExists: serverThreadShell !== null,
    status: serverThreadStatus,
  });

  return (
    <ChatView
      environmentId={props.environmentId}
      threadId={props.threadId}
      routeKind="server"
      threadSyncPhase={threadSyncPhase}
      hideWorkspaceHeader
      browserOnlySurfaces
    />
  );
}
