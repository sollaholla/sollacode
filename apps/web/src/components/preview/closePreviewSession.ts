import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PreviewCloseInput,
  PreviewCloseResult,
  PreviewListResult,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";

import {
  applyPreviewServerSnapshot,
  beginPreviewSessionClose,
  cancelPreviewSessionClose,
  reconcilePreviewServerSessions,
} from "~/previewStateStore";

interface ClosePreviewSessionInput<E> {
  readonly closePreview: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: PreviewCloseInput;
  }) => Promise<AtomCommandResult<PreviewCloseResult | undefined, E>>;
  readonly snapshot: PreviewSessionSnapshot | null;
  readonly tabId: string;
  readonly threadRef: ScopedThreadRef;
}

/**
 * Optimistically closes a preview while suppressing stale list responses for
 * the same tab. A failed close restores the last known snapshot.
 */
export async function closePreviewSession<E>(
  input: ClosePreviewSessionInput<E>,
): Promise<AtomCommandResult<PreviewCloseResult | undefined, E>> {
  beginPreviewSessionClose(input.threadRef, input.tabId);
  const result = await input.closePreview({
    environmentId: input.threadRef.environmentId,
    input: { threadId: input.threadRef.threadId, tabId: input.tabId },
  });
  if (result._tag === "Failure") {
    cancelPreviewSessionClose(input.threadRef, input.snapshot, input.tabId);
  } else if (result.value !== undefined) {
    reconcilePreviewServerSessions(input.threadRef, result.value);
  }
  return result;
}

interface ReconcileLegacyPreviewCloseInput<ListError, OpenError> {
  readonly closeResult: PreviewCloseResult | undefined;
  readonly listPreviews: () => Promise<AtomCommandResult<PreviewListResult, ListError>>;
  readonly openBlankPreview: () => Promise<AtomCommandResult<PreviewSessionSnapshot, OpenError>>;
  readonly threadRef: ScopedThreadRef;
}

/** Restores the one-tab invariant for servers whose close RPC still returns void. */
export async function reconcileLegacyPreviewClose<ListError, OpenError>(
  input: ReconcileLegacyPreviewCloseInput<ListError, OpenError>,
): Promise<boolean> {
  if (input.closeResult !== undefined) return false;

  const listed = await input.listPreviews();
  if (listed._tag === "Failure") return false;
  reconcilePreviewServerSessions(input.threadRef, listed.value);
  if (listed.value.sessions.length > 0) return false;

  const opened = await input.openBlankPreview();
  if (opened._tag === "Failure") return false;
  applyPreviewServerSnapshot(input.threadRef, opened.value);
  return true;
}
