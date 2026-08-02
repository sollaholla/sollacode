import type { MessageId, OrchestrationThreadActivity } from "@t3tools/contracts";

/**
 * Delivery state for a user message, rendered as WhatsApp-style checkmarks.
 *
 * The distinction only matters because a message sent while a turn is running
 * is a *steer*: it waits in the provider's prompt queue until the agent loop
 * pulls it, which can take many seconds. Before this indicator existed there
 * was no way to tell a steer that had landed from one the CLI had not reached
 * yet.
 *
 * - `pending` — not yet acknowledged by the server (still a local echo).
 * - `sent` — persisted by the orchestrator, but the provider has not taken it.
 * - `read` — the provider pulled it into the agent loop.
 */
export type MessageDeliveryState = "pending" | "sent" | "read";

export const MESSAGE_DELIVERED_ACTIVITY_KIND = "message.delivered";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Collects the ids the provider has confirmed consuming.
 *
 * Deliberately a positive signal: nothing here infers delivery from assistant
 * output, because a running turn keeps producing output from work that predates
 * the steer. Inferring would light the second checkmark before the provider had
 * seen the message — the exact question the indicator exists to answer.
 */
export function deriveDeliveredMessageIds(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlySet<string> {
  const delivered = new Set<string>();
  for (const activity of activities) {
    if (activity.kind !== MESSAGE_DELIVERED_ACTIVITY_KIND) continue;
    const messageId = asRecord(activity.payload).messageId;
    if (typeof messageId === "string" && messageId.length > 0) {
      delivered.add(messageId);
    }
  }
  return delivered;
}

/**
 * Resolves the state for a single message.
 *
 * `isOptimistic` means the row is still the client's own echo and the server
 * has not confirmed it, so it cannot yet claim to have been sent.
 */
export function messageDeliveryState(input: {
  readonly isOptimistic: boolean;
  readonly isDelivered: boolean;
}): MessageDeliveryState {
  if (input.isOptimistic) return "pending";
  return input.isDelivered ? "read" : "sent";
}

/**
 * Whether a thread's provider reports delivery at all.
 *
 * Providers without a prompt queue never emit the receipt, and a permanently
 * single check there would read as "nothing is getting through" rather than
 * "this provider does not report". Threads that have never seen a receipt hide
 * the indicator instead of showing a misleading one.
 */
export function threadReportsDelivery(delivered: ReadonlySet<string>): boolean {
  return delivered.size > 0;
}

/**
 * Whether to draw the indicator for a given message at all.
 *
 * A confirmed receipt is always worth showing. An *un*confirmed message is only
 * worth showing while it could still plausibly be in flight — that is, when it
 * is the newest thing the user sent. Without that second condition every
 * message predating this feature would render a single check forever, since no
 * receipt was ever recorded for it, and "sent but never read" is a much more
 * alarming claim than the truth ("we weren't tracking yet").
 */
export function shouldShowDeliveryIndicator(input: {
  readonly isDelivered: boolean;
  readonly isNewestUserMessage: boolean;
  /**
   * Whether this thread has ever produced a receipt — see
   * {@link threadReportsDelivery}.
   */
  readonly threadReportsDelivery: boolean;
}): boolean {
  // A confirmed receipt is always worth showing.
  if (input.isDelivered) return true;
  // An unconfirmed one is only honest when receipts are known to arrive here.
  // A server that never emits them — an older build, which for a remote
  // environment is the *remote* machine's server rather than this one — would
  // otherwise leave the newest message sitting on a single check reading
  // "waiting for the CLI" forever, describing a stall that is not happening.
  return input.isNewestUserMessage && input.threadReportsDelivery;
}

export function messageDeliveryLabel(state: MessageDeliveryState): string {
  switch (state) {
    case "pending":
      return "Sending…";
    case "sent":
      return "Sent — waiting for the CLI to pick it up";
    case "read":
      return "Read by the CLI";
  }
}

export function isMessageDeliveredId(
  delivered: ReadonlySet<string>,
  messageId: MessageId | string,
): boolean {
  return delivered.has(messageId);
}
