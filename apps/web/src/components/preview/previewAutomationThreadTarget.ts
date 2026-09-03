import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAgentsProjectId,
  PreviewTabId,
  type PreviewAutomationTabSummary,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";

import type { BrowserSurfacePresentation } from "~/browser/browserSurfaceStore";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import type { ThreadPreviewState } from "~/previewStateStore";

interface PresentedPreviewTarget {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly presentation: BrowserSurfacePresentation;
}

export interface PreviewAutomationThreadProfile {
  readonly profileRootThreadId: ThreadId;
  readonly exclusiveAgentBrowser: boolean;
}

export interface PreviewAutomationThreadTarget {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: PreviewTabId | undefined;
  readonly foreignAgentTabId?: PreviewTabId;
}

export function previewAutomationBrowserProfileRoot(
  threadId: ThreadId,
  browserProfileThreadId: ThreadId | null | undefined,
): ThreadId {
  return browserProfileThreadId ?? threadId;
}

export function isExclusiveAgentBrowserProfile(
  projectId: string,
  browserProfileThreadId: ThreadId | null | undefined,
): boolean {
  return isAgentsProjectId(projectId) && browserProfileThreadId == null;
}

/** Preview automation is owned by the thread, never by a provider session. */
export function canReusePreviewAutomationBrowser(input: {
  readonly requestThreadId: ThreadId;
  readonly ownerThreadId: ThreadId;
  readonly profiles?: Readonly<Record<string, PreviewAutomationThreadProfile>>;
}): boolean {
  return input.requestThreadId === input.ownerThreadId;
}

/**
 * Resolve automation against the browser the user is actually presenting.
 *
 * A provider's pinned tab remains stable across its multi-step interaction
 * only when that tab belongs to the same browser profile. Another custom
 * agent's dedicated guest is never a default or explicit reuse target.
 * Before a valid pin exists, the visible interactive guest is the browser the
 * user means by "the browser" even when another ordinary thread owns that tab.
 * The returned `tabId` is that visible tab so later open/status/snapshot calls
 * without an explicit id do not fall through to a hidden agent snapshot.
 */
export function previewAutomationThreadTabs(input: {
  readonly threadRef: ScopedThreadRef;
  readonly state: ThreadPreviewState;
  readonly presentationsByRuntimeTabId: Readonly<Record<string, BrowserSurfacePresentation>>;
}): ReadonlyArray<PreviewAutomationTabSummary> {
  const snapshots = { ...input.state.sessions, ...input.state.hostedSessions };
  return Object.values(snapshots)
    .filter((snapshot) => !input.state.suppressedTabIds.has(snapshot.tabId))
    .map((snapshot) => {
      const runtimeTabId = previewRuntimeTabId(
        input.threadRef,
        input.state.serverEpoch,
        snapshot.tabId,
      );
      const visible = input.presentationsByRuntimeTabId[runtimeTabId]?.visible ?? false;
      const navStatus = snapshot.navStatus;
      return {
        tabId: snapshot.tabId,
        url: navStatus._tag === "Idle" ? null : navStatus.url,
        title: navStatus._tag === "Idle" ? null : navStatus.title,
        loading: navStatus._tag === "Loading",
        visible,
        active: input.state.activeTabId === snapshot.tabId,
        updatedAt: snapshot.updatedAt,
      } satisfies PreviewAutomationTabSummary;
    })
    .toSorted(
      (left, right) =>
        Number(right.active) - Number(left.active) ||
        Number(right.visible) - Number(left.visible) ||
        right.updatedAt.localeCompare(left.updatedAt),
    );
}

export function resolvePreviewAutomationThreadTarget(input: {
  readonly environmentId: EnvironmentId;
  readonly requestThreadRef: ScopedThreadRef;
  readonly requestedTabId: PreviewTabId | undefined;
  readonly previewByThreadKey: Readonly<Record<string, ThreadPreviewState>>;
  readonly presentationsByRuntimeTabId: Readonly<Record<string, BrowserSurfacePresentation>>;
  readonly profiles?: Readonly<Record<string, PreviewAutomationThreadProfile>>;
}): PreviewAutomationThreadTarget {
  const candidates = Object.entries(input.previewByThreadKey).flatMap(
    ([threadKey, state]): Array<{
      readonly threadRef: ScopedThreadRef;
      readonly state: ThreadPreviewState;
    }> => {
      const threadRef = parseScopedThreadKey(threadKey);
      return threadRef?.environmentId === input.environmentId ? [{ threadRef, state }] : [];
    },
  );
  const canReuse = (ownerThreadId: ThreadId) =>
    canReusePreviewAutomationBrowser({
      requestThreadId: input.requestThreadRef.threadId,
      ownerThreadId,
      ...(input.profiles === undefined ? {} : { profiles: input.profiles }),
    });

  const requestedTabId = input.requestedTabId;
  if (requestedTabId !== undefined) {
    const owner = candidates.find(
      ({ state }) =>
        state.sessions[requestedTabId] !== undefined ||
        state.hostedSessions[requestedTabId] !== undefined,
    );
    if (owner && canReuse(owner.threadRef.threadId)) {
      return { threadRef: owner.threadRef, tabId: requestedTabId };
    }
    if (owner) {
      return {
        threadRef: input.requestThreadRef,
        tabId: undefined,
        foreignAgentTabId: requestedTabId,
      };
    }
  }

  const presented = candidates.flatMap(({ threadRef, state }): PresentedPreviewTarget[] => {
    if (!canReuse(threadRef.threadId)) return [];
    return Object.keys(state.hostedSessions).flatMap((tabId) => {
      const runtimeTabId = previewRuntimeTabId(threadRef, state.serverEpoch, tabId);
      const presentation = input.presentationsByRuntimeTabId[runtimeTabId];
      return presentation?.visible ? [{ threadRef, tabId, presentation }] : [];
    });
  });
  const visible = presented.toSorted(
    (left, right) =>
      Number(right.presentation.interactive) - Number(left.presentation.interactive) ||
      right.presentation.updatedAt - left.presentation.updatedAt,
  )[0];
  return {
    threadRef: visible?.threadRef ?? input.requestThreadRef,
    // Bind to the tab the user is actually looking at. Returning undefined
    // here used to fall through to the agent's last snapshot tab, which could
    // be a hidden guest on a login page while the panel still showed Gmail or
    // YouTube Studio.
    tabId: visible ? PreviewTabId.make(visible.tabId) : undefined,
  };
}
