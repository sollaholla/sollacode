/**
 * The `released` detail the web call page posts to the phone app's native
 * call screen (`AgentCallNativeMessage`) when it hangs a call up to move the
 * person to another agent: the screen then waits for the page's next call
 * instead of closing, and can cancel that call's ring if it is left before
 * the page learns the new call's id.
 */
const TRANSFER_DETAIL_PREFIX = "transfer:";

/** The detail for a call hung up to transfer the person to `vmAgentId`. */
export const agentCallTransferDetail = (vmAgentId: string): string =>
  `${TRANSFER_DETAIL_PREFIX}${vmAgentId}`;

/** The agent a `released` detail says the call is moving to, or null. */
export function agentCallTransferTarget(detail: string | null | undefined): string | null {
  if (!detail?.startsWith(TRANSFER_DETAIL_PREFIX)) return null;
  const vmAgentId = detail.slice(TRANSFER_DETAIL_PREFIX.length).trim();
  return vmAgentId.length > 0 ? vmAgentId : null;
}
