import type { MessageId, OrchestrationThreadActivity } from "@t3tools/contracts";

/**
 * Delivery state for a user message, rendered as WhatsApp-style checkmarks.
 *
 * The distinction only matters because a message sent while a turn is running
 * is a *steer*: the provider may admit it to a native prompt queue before the
 * agent loop can act on it. Before this indicator existed there was no way to
 * tell a steer the CLI had accepted from one it had not reached yet.
 *
 * - `pending` — not yet acknowledged by the server (still a local echo).
 * - `sent` — persisted by the orchestrator, but the provider has not accepted it.
 * - `read` — consumed by the provider's active model turn.
 */
export type MessageDeliveryState = "pending" | "sent" | "read";

export const MESSAGE_DELIVERED_ACTIVITY_KIND = "message.delivered";
export const QUEUED_MESSAGES_PROMOTED_ACTIVITY_KIND = "provider.queue.promoted";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Collects the ids the provider has confirmed consuming.
 *
 * Deliberately a positive signal: nothing here infers delivery from assistant
 * output, because a running turn keeps producing output from work that predates
 * the steer. Inferring would light the second checkmark while the message was
 * merely waiting in a native queue — the exact failure this indicator exists
 * to make visible.
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

export function derivePromotedQueuedMessageIds(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlySet<string> {
  const promoted = new Set<string>();
  for (const activity of activities) {
    if (activity.kind !== QUEUED_MESSAGES_PROMOTED_ACTIVITY_KIND) continue;
    const messageIds = asRecord(activity.payload).messageIds;
    if (!Array.isArray(messageIds)) continue;
    for (const messageId of messageIds) {
      if (typeof messageId === "string" && messageId.length > 0) promoted.add(messageId);
    }
  }
  return promoted;
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
 * Expands the receipt set using send order.
 *
 * The server coalesces messages sent while a turn is running: it joins the
 * still-undelivered predecessors' text into the next provider prompt and sends
 * one turn, tagged with only the newest message's id. The predecessors really
 * are delivered — their text is in that same prompt — but only the newest one
 * ever gets a receipt, so they sat on a single check reading "Queued" forever
 * even after the agent had plainly answered them.
 *
 * Ordering settles it without a provider-contract change. A provider consumes
 * prompts in order, so anything the user sent before a message that has been
 * delivered was necessarily already in the loop. Everything at or before the
 * newest receipt is therefore delivered too.
 *
 * @param orderedUserMessageIds User message ids in send order, oldest first.
 */
export function expandDeliveredMessageIds(
  orderedUserMessageIds: readonly string[],
  delivered: ReadonlySet<string>,
): ReadonlySet<string> {
  if (delivered.size === 0) return delivered;
  let newestDeliveredIndex = -1;
  for (const [index, messageId] of orderedUserMessageIds.entries()) {
    if (delivered.has(messageId)) newestDeliveredIndex = index;
  }
  if (newestDeliveredIndex < 0) return delivered;
  const expanded = new Set(delivered);
  for (let index = 0; index < newestDeliveredIndex; index += 1) {
    const messageId = orderedUserMessageIds[index];
    if (messageId !== undefined) expanded.add(messageId);
  }
  return expanded;
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
  readonly isOptimistic: boolean;
  readonly isDelivered: boolean;
  readonly isNewestUserMessage: boolean;
  /** Whether the selected provider emits explicit consumption receipts. */
  readonly providerReportsDelivery?: boolean;
  /**
   * Whether this thread has ever produced a receipt — see
   * {@link threadReportsDelivery}.
   */
  readonly threadReportsDelivery: boolean;
}): boolean {
  // A confirmed receipt is always worth showing.
  if (input.isDelivered) return true;
  // The local echo is authoritative evidence that this client is still
  // handing the message to the server. Showing "Sending…" does not depend on
  // whether the remote server is new enough to emit provider receipts.
  if (input.isOptimistic) return input.isNewestUserMessage;
  // An unconfirmed one is only honest when this provider is known to emit
  // receipts, or this thread has already demonstrated that it does. The
  // provider capability closes the first-message gap: a queued Codex, Claude,
  // or Grok send remains explained even before the thread has produced its first
  // receipt.
  return (
    input.isNewestUserMessage &&
    (input.providerReportsDelivery === true || input.threadReportsDelivery)
  );
}

export function messageDeliveryLabel(
  state: MessageDeliveryState,
  providerName = "provider CLI",
): string {
  switch (state) {
    case "pending":
      return "Sending…";
    case "sent":
      return `Queued for ${providerName}`;
    case "read":
      return `Received by ${providerName}`;
  }
}

export function isMessageDeliveredId(
  delivered: ReadonlySet<string>,
  messageId: MessageId | string,
): boolean {
  return delivered.has(messageId);
}
