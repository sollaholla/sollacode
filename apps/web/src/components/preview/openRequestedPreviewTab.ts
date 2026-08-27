import type { ScopedThreadRef } from "@t3tools/contracts";

import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import { useRightPanelStore } from "~/rightPanelStore";

import { openPreviewSession } from "./openPreviewSession";

export interface HostedPreviewSessionLocator {
  readonly runtimeTabId: string;
  readonly threadRef: ScopedThreadRef;
}

/**
 * Turns a desktop guest's target=_blank request into a durable sibling
 * preview tab owned by the same thread, then selects it in the Browser panel.
 */
export async function openRequestedPreviewTab<E>(input: {
  readonly sourceRuntimeTabId: string;
  readonly url: string;
  readonly sessions: ReadonlyArray<HostedPreviewSessionLocator>;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<"opened" | "source-missing" | "failed"> {
  const source = input.sessions.find(
    (session) => session.runtimeTabId === input.sourceRuntimeTabId,
  );
  if (!source) return "source-missing";

  const result = await openPreviewSession({
    openPreview: input.openPreview,
    threadRef: source.threadRef,
    url: input.url,
  });
  if (result._tag === "Failure") return "failed";

  useRightPanelStore.getState().openBrowser(source.threadRef, result.value.tabId);
  return "opened";
}
