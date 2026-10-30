import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { Suspense, useEffect, useMemo } from "react";

import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import {
  buildThreadRouteParams,
  canonicalizeOrchestratorThreadRef,
  resolveThreadRouteRef,
  resolveThreadRouteRenderState,
} from "../threadRoutes";
import { resolveThreadSyncPhase } from "../threadSync";
import { SidebarInset } from "~/components/ui/sidebar";
import {
  useEnvironmentThreadRefs,
  useThreadDetail,
  useThreadShell,
  useThreadStatus,
} from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import { usePrimaryEnvironmentId } from "../state/environments";
import { LazyChatView } from "../lazyChatView";
import { PaneLoadingState } from "../components/PaneLoadingState";
import { useRightPanelStore } from "../rightPanelStore";
import {
  sideChatDisplayTitle,
  sideChatParentThreadIdOf,
  wasSideChatPromotedHere,
} from "../sideChat";

function ChatThreadRouteView() {
  const navigate = useNavigate();
  const artifact = useLocation({
    select: (location) => {
      const value = (location.search as Record<string, unknown>).artifact;
      return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 128
        ? value.trim()
        : undefined;
    },
  });
  const requestedThreadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const threadRef = canonicalizeOrchestratorThreadRef(requestedThreadRef, primaryEnvironmentId);
  const routeNeedsCanonicalEnvironment =
    requestedThreadRef !== null &&
    threadRef !== null &&
    requestedThreadRef.environmentId !== threadRef.environmentId;
  const shell = useEnvironmentQuery(
    threadRef === null ? null : environmentShell.stateAtom(threadRef.environmentId),
  );
  const serverThreadShell = useThreadShell(threadRef);
  const serverThreadDetail = useThreadDetail(threadRef);
  const serverThreadStatus = useThreadStatus(threadRef);
  const environmentThreadRefs = useEnvironmentThreadRefs(threadRef?.environmentId ?? null);
  const bootstrapComplete = shell.data?.snapshot._tag === "Some";
  const environmentHasServerThreads = environmentThreadRefs.length > 0;
  const draftThreadExists = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) !== null : false,
  );
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const environmentHasDraftThreads = useComposerDraftStore((store) => {
    if (!threadRef) {
      return false;
    }
    return store.hasDraftThreadsInEnvironment(threadRef.environmentId);
  });
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadShellExists: serverThreadShell !== null,
    serverThreadDetailExists: serverThreadDetail !== null,
    serverThreadDetailDeleted: serverThreadStatus === "deleted",
    draftThreadExists,
  });
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: serverThreadDetail !== null,
    shellExists: serverThreadShell !== null,
    status: serverThreadStatus,
  });
  const serverThreadExists = serverThreadDetail !== null || serverThreadShell !== null;
  // A side chat lives in its main chat's panel. Links from the Live Inspector,
  // notifications or anywhere else name the side chat itself, so open the
  // parent with that side chat's tab instead of showing it as a main chat.
  const sideChatParentThreadId =
    threadRef !== null &&
    serverThreadShell !== null &&
    serverThreadShell.archivedAt === null &&
    !wasSideChatPromotedHere(threadRef.environmentId, threadRef.threadId)
      ? sideChatParentThreadIdOf(serverThreadShell)
      : null;
  const sideChatParentRef = useMemo(
    () =>
      threadRef !== null && sideChatParentThreadId !== null
        ? scopeThreadRef(threadRef.environmentId, ThreadId.make(sideChatParentThreadId))
        : null,
    [sideChatParentThreadId, threadRef],
  );
  const sideChatParentShell = useThreadShell(sideChatParentRef);
  // Without the parent there is no panel to open, and the panel drops archived
  // side chats, so those show on their own rather than leading nowhere.
  const redirectToSideChatParent = sideChatParentRef !== null && sideChatParentShell !== null;
  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;

  useEffect(() => {
    if (!routeNeedsCanonicalEnvironment || threadRef === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      ...(artifact ? { search: { artifact } } : {}),
      replace: true,
    });
  }, [artifact, navigate, routeNeedsCanonicalEnvironment, threadRef]);

  useEffect(() => {
    if (!redirectToSideChatParent || !sideChatParentRef || !threadRef || !serverThreadShell) return;
    useRightPanelStore
      .getState()
      .openSideChat(
        sideChatParentRef,
        threadRef.threadId,
        sideChatDisplayTitle(serverThreadShell.title),
      );
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(sideChatParentRef),
      replace: true,
    });
  }, [navigate, redirectToSideChatParent, serverThreadShell, sideChatParentRef, threadRef]);

  useEffect(() => {
    if (!threadRef || !bootstrapComplete) {
      return;
    }

    if (renderState === "missing" && environmentHasAnyThreads) {
      void navigate({ to: "/", replace: true });
    }
  }, [bootstrapComplete, environmentHasAnyThreads, navigate, renderState, threadRef]);

  useEffect(() => {
    if (!threadRef || !serverThreadExists || !draftThread) {
      return;
    }
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread, serverThreadExists, threadRef]);

  if (!threadRef) {
    return null;
  }

  if (redirectToSideChatParent) {
    return (
      <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
        <PaneLoadingState label="Opening side chat…" />
      </SidebarInset>
    );
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      {renderState === "ready" || (renderState === "loading" && serverThreadShell !== null) ? (
        <Suspense fallback={<PaneLoadingState label="Opening conversation…" />}>
          <LazyChatView
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            routeKind="server"
            threadSyncPhase={threadSyncPhase}
            {...(artifact ? { artifactId: artifact } : {})}
          />
        </Suspense>
      ) : renderState === "loading" ? (
        <PaneLoadingState label="Loading conversation…" />
      ) : null}
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: ChatThreadRouteView,
});
