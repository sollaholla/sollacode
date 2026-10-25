import type {
  DesktopPreviewTabState,
  PreviewAgentPointer,
  PreviewDownloadApproval,
  PreviewRemoteFramePageState,
  PreviewSessionSnapshot,
} from "@t3tools/contracts";

/**
 * What a remote viewer shows around a watched tab's picture: its address and
 * title, whether it is loading, the downloads it holds for an answer, and
 * where the agent's cursor is. The desktop's own tab state is the freshest
 * source; the server's session record covers a tab the desktop has not
 * reported on yet.
 */
export function remoteFramePageState(input: {
  readonly desktop: DesktopPreviewTabState | undefined;
  readonly session: PreviewSessionSnapshot | undefined;
  readonly pendingDownloadApprovals: ReadonlyArray<PreviewDownloadApproval> | undefined;
  readonly agentPointer: PreviewAgentPointer | null;
}): PreviewRemoteFramePageState | null {
  const desktopNav = input.desktop?.navStatus;
  const sessionNav = input.session?.navStatus;
  let url: string;
  let title: string;
  let loading: boolean;
  if (desktopNav !== undefined) {
    url = desktopNav.kind === "Idle" ? "about:blank" : desktopNav.url;
    title = desktopNav.kind === "Idle" ? "" : desktopNav.title;
    loading = desktopNav.kind === "Loading";
  } else if (sessionNav !== undefined) {
    url = sessionNav._tag === "Idle" ? "about:blank" : sessionNav.url;
    title = sessionNav._tag === "Idle" ? "" : sessionNav.title;
    loading = sessionNav._tag === "Loading";
  } else {
    return null;
  }
  const approvals = input.desktop?.pendingDownloadApprovals ?? input.pendingDownloadApprovals ?? [];
  return {
    url,
    title,
    loading,
    ...(approvals.length === 0
      ? {}
      : {
          pendingDownloadApprovals: approvals.map((approval) => ({
            id: approval.id,
            domain: approval.domain,
            fileName: approval.fileName,
          })),
        }),
    ...(input.agentPointer === null ? {} : { agentPointer: input.agentPointer }),
  };
}
