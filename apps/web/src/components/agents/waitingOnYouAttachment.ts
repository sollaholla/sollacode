import type { VmAgentBlockerId, VmAgentId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

/**
 * A waiting-on-you request tagged onto the composer.
 *
 * "Follow up" used to only drop a lead-in sentence into the composer and focus
 * it, which read as doing nothing: the request card stayed open, and answering
 * it was still a separate click. Tagging it instead makes the reply and the
 * request one action — the tag is visible, can be taken off, and sending the
 * message is what closes the request out.
 */
export interface WaitingOnYouAttachment {
  readonly vmAgentId: VmAgentId;
  readonly blockerId: VmAgentBlockerId;
  readonly title: string;
}

const attachmentByThreadKey = new Map<string, WaitingOnYouAttachment>();
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

export function attachWaitingOnYou(threadKey: string, attachment: WaitingOnYouAttachment): void {
  attachmentByThreadKey.set(threadKey, attachment);
  emit();
}

/**
 * Takes the tag off. Idempotent so the send path can clear unconditionally
 * without first checking whether the user already detached it.
 */
export function detachWaitingOnYou(threadKey: string): void {
  if (!attachmentByThreadKey.delete(threadKey)) return;
  emit();
}

export function getWaitingOnYouAttachment(threadKey: string): WaitingOnYouAttachment | null {
  return attachmentByThreadKey.get(threadKey) ?? null;
}

/**
 * Drops a tag whose request is no longer open — resolved from another window,
 * dismissed, or answered by the agent itself. A tag for a request that no
 * longer exists would promise a close-out that can never happen.
 */
export function pruneWaitingOnYouAttachment(
  threadKey: string,
  openBlockerIds: ReadonlySet<string>,
): void {
  const attached = attachmentByThreadKey.get(threadKey);
  if (!attached || openBlockerIds.has(attached.blockerId)) return;
  attachmentByThreadKey.delete(threadKey);
  emit();
}

export function useWaitingOnYouAttachment(threadKey: string | null): WaitingOnYouAttachment | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (threadKey === null ? null : getWaitingOnYouAttachment(threadKey)),
    () => null,
  );
}
