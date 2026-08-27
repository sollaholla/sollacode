import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, PreviewTabId, ScopedThreadRef } from "@t3tools/contracts";

import type { BrowserSurfacePresentation } from "~/browser/browserSurfaceStore";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import type { ThreadPreviewState } from "~/previewStateStore";

interface PresentedPreviewTarget {
  readonly threadRef: ScopedThreadRef;
  readonly presentation: BrowserSurfacePresentation;
}

/**
 * Resolve automation against the browser the user is actually presenting.
 *
 * A provider's pinned tab remains stable across its multi-step interaction.
 * Before that pin exists, the visible interactive guest is the browser the
 * user means by "the browser" even when its tab is owned by another thread.
 */
export function resolvePreviewAutomationThreadTarget(input: {
  readonly environmentId: EnvironmentId;
  readonly requestThreadRef: ScopedThreadRef;
  readonly requestedTabId: PreviewTabId | undefined;
  readonly previewByThreadKey: Readonly<Record<string, ThreadPreviewState>>;
  readonly presentationsByRuntimeTabId: Readonly<Record<string, BrowserSurfacePresentation>>;
}): ScopedThreadRef {
  const candidates = Object.entries(input.previewByThreadKey).flatMap(
    ([threadKey, state]): Array<{
      readonly threadRef: ScopedThreadRef;
      readonly state: ThreadPreviewState;
    }> => {
      const threadRef = parseScopedThreadKey(threadKey);
      return threadRef?.environmentId === input.environmentId ? [{ threadRef, state }] : [];
    },
  );

  const requestedTabId = input.requestedTabId;
  if (requestedTabId !== undefined) {
    const owner = candidates.find(({ state }) => state.sessions[requestedTabId] !== undefined);
    if (owner) return owner.threadRef;
  }

  const presented = candidates.flatMap(({ threadRef, state }): PresentedPreviewTarget[] =>
    Object.keys(state.sessions).flatMap((tabId) => {
      const runtimeTabId = previewRuntimeTabId(threadRef, state.serverEpoch, tabId);
      const presentation = input.presentationsByRuntimeTabId[runtimeTabId];
      return presentation?.visible ? [{ threadRef, presentation }] : [];
    }),
  );
  const visible = presented.toSorted(
    (left, right) =>
      Number(right.presentation.interactive) - Number(left.presentation.interactive) ||
      right.presentation.updatedAt - left.presentation.updatedAt,
  )[0];
  return visible?.threadRef ?? input.requestThreadRef;
}
