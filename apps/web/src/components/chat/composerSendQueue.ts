/**
 * Whether sending right now would stop background work the user can see.
 *
 * The one predicate behind the hold, its release, and the send-anyway
 * confirmation, so the three cannot drift apart.
 *
 * Only a send that interrupts a *live turn* destroys anything: that is where
 * "sending cancels the running tasks" comes from. With no turn to interrupt
 * there is nothing to take the tasks down with it - a backgrounded task
 * outliving the turn that launched it is the entire point of backgrounding
 * one, and the harness re-invokes the agent when it exits, which is why the
 * server holds a continuation open for it (`BACKGROUND_TASK_CONTINUATION_GRACE_MS`).
 * Asking about tasks alone made every send on an idle thread stop work it had
 * no reason to touch, and left a task whose completion never arrived holding
 * messages for the thirty minutes it takes the panel to call that task stale.
 *
 * A running Grok session is excluded for the opposite reason: it queues the
 * message itself and keeps its tasks, so a send there destroys nothing even
 * mid-turn.
 */
export function sendWouldStopBackgroundWork(input: {
  readonly hasRunningBackgroundTask: boolean;
  readonly turnRunning: boolean;
  readonly providerDriver: string | null;
}): boolean {
  if (!input.hasRunningBackgroundTask) return false;
  if (!input.turnRunning) return false;
  return input.providerDriver !== "grok";
}

export function shouldHoldComposerSend(input: {
  readonly backgroundTasksRunning: boolean;
  readonly hasSendableContent: boolean;
  readonly sendNow: boolean;
}): boolean {
  if (!input.backgroundTasksRunning) return false;
  if (!input.hasSendableContent) return false;
  return !input.sendNow;
}
