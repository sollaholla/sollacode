/**
 * Whether a composer send should queue behind the running turn.
 *
 * Sending into a turn that is already running hands the message to the live
 * agent loop, and that loop abandons the background work it started for the
 * previous request. A long test run or build dies because a follow-up was
 * typed. The alternative - sitting on the message until the turn ends - means
 * remembering to send it, and forgetting is routine.
 *
 * So a send during a running turn queues by default and is delivered when the
 * thread goes idle. `sendNow` is the explicit override behind the send-anyway
 * control, which carries the warning about what it costs.
 */
export function shouldQueueComposerSend(input: {
  readonly turnRunning: boolean;
  readonly sendNow: boolean;
}): boolean {
  if (!input.turnRunning) return false;
  return !input.sendNow;
}

export interface QueuedComposerMessage {
  readonly id: string;
  readonly text: string;
}

/**
 * Which queued messages to release now that the thread is idle.
 *
 * Everything queued goes, in the order it was typed: several follow-ups can
 * pile up during one long turn and they are all still wanted. Releasing them
 * as one batch rather than one-per-idle avoids a queue that drains a message
 * per turn and never empties.
 */
export function releaseQueuedComposerMessages(input: {
  readonly turnRunning: boolean;
  readonly queued: readonly QueuedComposerMessage[];
}): readonly QueuedComposerMessage[] {
  if (input.turnRunning) return [];
  return input.queued;
}

/** Drop a queued message the user removed before it was ever sent. */
export function removeQueuedComposerMessage(
  queued: readonly QueuedComposerMessage[],
  id: string,
): readonly QueuedComposerMessage[] {
  return queued.filter((message) => message.id !== id);
}
