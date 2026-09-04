/**
 * Holding a composer send until the background work it would destroy is done.
 *
 * Sending while background tasks are running stops them: the send interrupts
 * the turn that owns them, so a long test run or build dies because a
 * follow-up was typed. Asking "stop 3 tasks?" every time only offered the
 * user a choice between losing the work and losing their place.
 *
 * So the send is *held*: the message stays exactly where it was typed, in the
 * composer, and goes out by itself the moment the tasks finish. Nothing is
 * moved into a side buffer, which is what makes this safe — a held message is
 * still a draft, so it survives a thread switch, a reload, and any send that
 * turns out to be refused downstream. The only state kept here is a per-thread
 * "this draft is waiting" flag; losing that flag costs an automatic send, not
 * the message.
 *
 * `sendNow` is the explicit override behind the send-anyway control, which
 * still routes through the confirmation that says what it will stop.
 */
export function shouldHoldComposerSend(input: {
  readonly backgroundTasksRunning: boolean;
  readonly hasSendableContent: boolean;
  readonly sendNow: boolean;
}): boolean {
  if (!input.backgroundTasksRunning) return false;
  if (!input.hasSendableContent) return false;
  return !input.sendNow;
}

/**
 * Whether a held send goes out now.
 *
 * Only for the thread the hold belongs to: the flag is keyed by thread and
 * this is asked about the thread on screen, so a hold placed in one
 * conversation can never fire into another one the user happens to be reading.
 */
export function shouldReleaseHeldComposerSend(input: {
  readonly heldThreadKeys: ReadonlySet<string>;
  readonly activeThreadKey: string | null;
  readonly backgroundTasksRunning: boolean;
}): boolean {
  if (input.activeThreadKey === null) return false;
  if (!input.heldThreadKeys.has(input.activeThreadKey)) return false;
  return !input.backgroundTasksRunning;
}

/** Mark this thread's draft as waiting for its background tasks. */
export function holdComposerSend(
  heldThreadKeys: ReadonlySet<string>,
  threadKey: string,
): ReadonlySet<string> {
  if (heldThreadKeys.has(threadKey)) return heldThreadKeys;
  const next = new Set(heldThreadKeys);
  next.add(threadKey);
  return next;
}

/**
 * Stop waiting on this thread.
 *
 * Returns the same set when nothing changes so the effect that watches it does
 * not re-run on every unrelated render.
 */
export function releaseComposerSendHold(
  heldThreadKeys: ReadonlySet<string>,
  threadKey: string,
): ReadonlySet<string> {
  if (!heldThreadKeys.has(threadKey)) return heldThreadKeys;
  const next = new Set(heldThreadKeys);
  next.delete(threadKey);
  return next;
}
